"""Command-line interface for liquid-regression-finder search and replay."""

from __future__ import annotations

import argparse
import json
import signal
import sys
import threading
from pathlib import Path
from typing import Any, Sequence

from .engine import SearchEngine, build_compare_request
from .generator import GENERATOR_VERSION, canonical_json
from .replay import ReplayRunner
from .shrinker import validate_fixture_dict
from .worker_client import make_diagnostic

EXIT_NO_DIFFERENCE = 0
EXIT_REPLAY_OK = 0
EXIT_DIFFERENCE_FOUND = 1
EXIT_FAILED = 2


def build_parser() -> argparse.ArgumentParser:
    """Construct the CLI argument parser for `compare` and `replay`."""
    parser = argparse.ArgumentParser(
        prog="python -m search",
        description="Shopify Liquid regression counterexample search and replay CLI.",
    )
    subparsers = parser.add_subparsers(dest="subcommand", required=True)

    compare_parser = subparsers.add_parser(
        "compare",
        help="Search for a product fixture causing an observer difference between before and after Liquid snippets.",
    )
    compare_parser.add_argument("--before", required=True, help="Path to the baseline Liquid snippet.")
    compare_parser.add_argument("--after", required=True, help="Path to the modified Liquid snippet.")
    compare_parser.add_argument("--observer", default="sale_badge", help="HTML observer name (default: sale_badge).")
    compare_parser.add_argument("--seed", type=int, default=0, help="Deterministic PRNG seed (0..4294967295).")
    compare_parser.add_argument(
        "--search-pairs",
        type=int,
        default=256,
        help="Maximum unique fixture pairs evaluated during search (1..5000).",
    )
    compare_parser.add_argument(
        "--shrink-pairs",
        type=int,
        default=128,
        help="Maximum unique shrink candidate pairs evaluated after confirmation (0..1000).",
    )
    compare_parser.add_argument(
        "--replay-out",
        default=None,
        help="Optional path to write canonical sorted-key compact UTF-8 ReplayBundle JSON on finding.",
    )
    compare_parser.add_argument(
        "--priority-fixture",
        action="append",
        default=[],
        dest="priority_fixtures",
        help="Optional path to a JSON fixture file to test before generated candidates (repeatable).",
    )

    replay_parser = subparsers.add_parser(
        "replay",
        help="Deterministically replay a saved ReplayBundle JSON file without search or shrink.",
    )
    replay_parser.add_argument("--bundle", required=True, help="Path to the saved ReplayBundle JSON file.")
    return parser


def _read_utf8_exact(path_str: str, label: str) -> str:
    path = Path(path_str)
    try:
        raw = path.read_bytes()
    except OSError as exc:
        raise OSError(f"Failed reading --{label} file '{path_str}': {exc}") from exc

    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise UnicodeDecodeError(
            exc.encoding,
            exc.object,
            exc.start,
            exc.end,
            f"--{label} file '{path_str}' is not valid UTF-8: {exc.reason}",
        ) from exc


def _emit_report(report: dict[str, Any]) -> None:
    payload = json.dumps(report, indent=2, ensure_ascii=False, allow_nan=False)
    sys.stdout.write(payload + "\n")
    sys.stdout.flush()


class _PriorityFixtureInputError(Exception):
    def __init__(self, code: str, message: str) -> None:
        self.code = code
        self.message = message
        super().__init__(message)


def _reject_nonfinite_json(token: str) -> Any:
    raise ValueError(f"Non-finite JSON constant {token!r} is not allowed")


def _load_priority_fixtures(paths: Sequence[str]) -> list[dict[str, Any]]:
    loaded: list[dict[str, Any]] = []
    for path_str in paths:
        path = Path(path_str)
        try:
            raw = path.read_bytes()
        except OSError as exc:
            raise _PriorityFixtureInputError(
                "input_file_error",
                f"Failed reading --priority-fixture file '{path_str}': {exc}",
            ) from exc

        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise _PriorityFixtureInputError(
                "input_file_error",
                f"--priority-fixture file '{path_str}' is not valid UTF-8: {exc.reason}",
            ) from exc

        try:
            parsed = json.loads(text, parse_constant=_reject_nonfinite_json)
        except (json.JSONDecodeError, ValueError) as exc:
            raise _PriorityFixtureInputError(
                "invalid_fixture",
                f"--priority-fixture file '{path_str}' contains invalid JSON: {exc}",
            ) from exc

        try:
            validate_fixture_dict(parsed)
        except ValueError as exc:
            raise _PriorityFixtureInputError(
                "invalid_fixture",
                f"--priority-fixture file '{path_str}' is invalid: {exc}",
            ) from exc

        loaded.append(parsed)
    return loaded


def _input_error_report(
    args: argparse.Namespace,
    code: str,
    message: str,
    *,
    request: dict[str, Any] | None = None,
) -> dict[str, Any]:
    diag = make_diagnostic(code, message, span=None)
    return {
        "schema_version": 1,
        "status": "failed",
        "generator_version": GENERATOR_VERSION,
        "seed": args.seed,
        "candidate_index": None,
        "direction": None,
        "reference_status": "not_run",
        "message": message,
        "request": request,
        "finding": None,
        "shrink": None,
        "stats": {
            "search_pairs": 0,
            "shrink_pairs": 0,
            "parity_rejections": 0,
            "exhausted_by": None,
            "first_difference_ms": None,
            "elapsed_ms": 0,
        },
        "error": diag,
    }


def _run_with_signal_cleanup(fn: Any) -> int:
    is_main_thread = threading.current_thread() is threading.main_thread()
    installed: list[tuple[int, Any]] = []

    def _on_term(signum: int, _frame: Any) -> None:
        signal.signal(signum, signal.SIG_IGN)
        raise SystemExit(128 + signum)

    if is_main_thread:
        for sig_name in ("SIGTERM", "SIGHUP"):
            sig = getattr(signal, sig_name, None)
            if sig is not None:
                prev = signal.getsignal(sig)
                installed.append((sig, prev))
                signal.signal(sig, _on_term)

    try:
        return int(fn())
    finally:
        for sig, prev in installed:
            signal.signal(sig, prev)


def main(
    argv: Sequence[str] | None = None,
    *,
    engine: SearchEngine | None = None,
    replay_runner: ReplayRunner | None = None,
) -> int:
    """CLI entrypoint returning exit code 0 (negative/replay ok), 1 (difference found), or 2 (failed/usage)."""
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8")

    parser = build_parser()
    args = parser.parse_args(list(argv) if argv is not None else None)

    def _dispatch() -> int:
        if args.subcommand == "replay":
            active_runner = replay_runner if replay_runner is not None else ReplayRunner()
            report = active_runner.replay_file(args.bundle)
            _emit_report(report)
            if report.get("status") == "replayed":
                return EXIT_REPLAY_OK
            err = report.get("error") or {}
            print(f"error [{err.get('code', 'failed')}]: {err.get('message', 'Replay failed')}", file=sys.stderr)
            return EXIT_FAILED

        if args.subcommand != "compare":
            print(f"error [cli_usage]: Unsupported subcommand {args.subcommand!r}", file=sys.stderr)
            return EXIT_FAILED

        try:
            before_source = _read_utf8_exact(args.before, "before")
            after_source = _read_utf8_exact(args.after, "after")
        except (OSError, UnicodeDecodeError) as exc:
            report = _input_error_report(args, "input_file_error", str(exc))
            _emit_report(report)
            print(f"error [input_file_error]: {exc}", file=sys.stderr)
            return EXIT_FAILED

        request = build_compare_request(
            before_source,
            after_source,
            observer=args.observer,
            seed=args.seed,
            search_pairs=args.search_pairs,
            shrink_pairs=args.shrink_pairs,
        )

        try:
            loaded_priority = _load_priority_fixtures(args.priority_fixtures)
        except _PriorityFixtureInputError as exc:
            report = _input_error_report(args, exc.code, exc.message, request=request)
            _emit_report(report)
            print(f"error [{exc.code}]: {exc.message}", file=sys.stderr)
            return EXIT_FAILED

        active_engine = engine if engine is not None else SearchEngine()
        if loaded_priority:
            report = active_engine.compare(request, priority_fixtures=loaded_priority)
        else:
            report = active_engine.compare(request)
        status = report.get("status")

        if status == "difference_found" and args.replay_out is not None:
            replay_path = Path(args.replay_out)
            try:
                replay_path.parent.mkdir(parents=True, exist_ok=True)
                replay_bytes = canonical_json(report["finding"]["replay"]).encode("utf-8")
                replay_path.write_bytes(replay_bytes)
            except OSError as exc:
                err_msg = f"Failed writing --replay-out '{args.replay_out}': {exc}"
                fail_report = {
                    **report,
                    "status": "failed",
                    "finding": None,
                    "message": err_msg,
                    "error": make_diagnostic("replay_write_error", err_msg, span=None),
                }
                _emit_report(fail_report)
                print(f"error [replay_write_error]: {err_msg}", file=sys.stderr)
                return EXIT_FAILED

        _emit_report(report)

        if status == "no_difference_found":
            return EXIT_NO_DIFFERENCE
        if status == "difference_found":
            return EXIT_DIFFERENCE_FOUND

        err = report.get("error") or {}
        print(f"error [{err.get('code', 'failed')}]: {err.get('message', 'Search failed')}", file=sys.stderr)
        return EXIT_FAILED

    return _run_with_signal_cleanup(_dispatch)

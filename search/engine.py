"""Counterexample search engine orchestrating generation, parity verification, and findings."""

from __future__ import annotations

import hashlib
import random
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Sequence

from .generator import (
    GENERATOR_VERSION,
    MAX_DUPLICATE_ATTEMPTS,
    CandidateGenerator,
)
from .worker_client import (
    DEFAULT_JOB_DEADLINE_S,
    DEFAULT_REQUEST_TIMEOUT_S,
    JobDeadlineError,
    WorkerClient,
    WorkerError,
    WorkerProtocolError,
    default_repo_root,
    make_diagnostic,
)

MAX_SNIPPET_BYTES = 16 * 1024
MAX_SEED = 4_294_967_295
MAX_SEARCH_PAIRS = 5_000
MAX_SHRINK_PAIRS = 1_000
SUPPORTED_OBSERVERS = ("sale_badge",)

_COMPARE_REQUEST_KEYS = frozenset({"schema_version", "before", "after", "observer", "seed", "budget"})
_SNIPPET_KEYS = frozenset({"source"})
_BUDGET_KEYS = frozenset({"search_pairs", "shrink_pairs"})

_RUBY_VERSION_CONST_RE = re.compile(r'VERSION\s*=\s*"([^"]+)"')
_PROJECTION_VERSION_CONST_RE = re.compile(r'PROJECTION_VERSION\s*=\s*"([^"]+)"')
_GEMFILE_LOCK_LIQUID_RE = re.compile(r"^    liquid \(([^)]+)\)$", re.MULTILINE)


@dataclass(frozen=True)
class RuntimeVersions:
    """Pinned engine and projection versions recorded in ReplayBundle."""

    interpreter_version: str
    liquid_version: str
    projection_version: str


class InvalidCompareRequestError(Exception):
    """Raised when a CompareRequest fails schema or resource-bound validation."""

    def __init__(self, code: str, message: str) -> None:
        self.diagnostic = make_diagnostic(code, message, span=None)
        super().__init__(message)


def _is_strict_int(value: Any) -> bool:
    return type(value) is int


def resolve_runtime_versions(repo_root: Path | None = None) -> RuntimeVersions:
    """Read pinned interpreter, official Liquid, and projection versions from the repo."""
    root = repo_root if repo_root is not None else default_repo_root()

    interp_path = root / "interpreter" / "lib" / "liquid_interpreter" / "version.rb"
    ref_path = root / "reference" / "lib" / "liquid_reference" / "version.rb"
    lock_path = root / "Gemfile.lock"

    interp_text = interp_path.read_text(encoding="utf-8")
    ref_text = ref_path.read_text(encoding="utf-8")
    lock_text = lock_path.read_text(encoding="utf-8")

    interp_match = _RUBY_VERSION_CONST_RE.search(interp_text)
    proj_match = _PROJECTION_VERSION_CONST_RE.search(ref_text)
    liquid_match = _GEMFILE_LOCK_LIQUID_RE.search(lock_text)

    if not interp_match:
        raise WorkerProtocolError(f"Unable to parse LiquidInterpreter::VERSION from {interp_path}")
    if not proj_match:
        raise WorkerProtocolError(f"Unable to parse LiquidReference::PROJECTION_VERSION from {ref_path}")
    if not liquid_match:
        raise WorkerProtocolError(f"Unable to parse liquid version from {lock_path}")

    return RuntimeVersions(
        interpreter_version=interp_match.group(1),
        liquid_version=liquid_match.group(1),
        projection_version=proj_match.group(1),
    )


def build_compare_request(
    before_source: str,
    after_source: str,
    *,
    observer: str = "sale_badge",
    seed: int = 0,
    search_pairs: int = 256,
    shrink_pairs: int = 128,
) -> dict[str, Any]:
    """Build a CompareRequest dictionary."""
    return {
        "schema_version": 1,
        "before": {"source": before_source},
        "after": {"source": after_source},
        "observer": observer,
        "seed": seed,
        "budget": {
            "search_pairs": search_pairs,
            "shrink_pairs": shrink_pairs,
        },
    }


def validate_compare_request(request: Any) -> dict[str, Any]:
    """Validate a CompareRequest against contract bounds and snippet size limits."""
    if not isinstance(request, dict) or frozenset(request.keys()) != _COMPARE_REQUEST_KEYS:
        raise InvalidCompareRequestError(
            "invalid_request",
            "CompareRequest must be an object with keys schema_version, before, after, observer, seed, budget",
        )

    if not _is_strict_int(request["schema_version"]) or request["schema_version"] != 1:
        raise InvalidCompareRequestError("invalid_request", "CompareRequest.schema_version must be integer 1")

    for side in ("before", "after"):
        snippet = request[side]
        if not isinstance(snippet, dict) or frozenset(snippet.keys()) != _SNIPPET_KEYS:
            raise InvalidCompareRequestError("invalid_request", f"CompareRequest.{side} must have exact key 'source'")
        source = snippet["source"]
        if not isinstance(source, str):
            raise InvalidCompareRequestError("invalid_request", f"CompareRequest.{side}.source must be a string")
        try:
            source_bytes = source.encode("utf-8")
        except UnicodeEncodeError as exc:
            raise InvalidCompareRequestError(
                "invalid_utf8",
                f"CompareRequest.{side}.source is not valid UTF-8: {exc}",
            ) from exc
        if len(source_bytes) > MAX_SNIPPET_BYTES:
            raise InvalidCompareRequestError(
                "snippet_too_large",
                f"CompareRequest.{side}.source ({len(source_bytes)} bytes) exceeds {MAX_SNIPPET_BYTES} byte limit",
            )

    observer = request["observer"]
    if not isinstance(observer, str) or observer not in SUPPORTED_OBSERVERS:
        raise InvalidCompareRequestError(
            "unsupported_observer",
            f"Unsupported observer {observer!r}; expected one of {SUPPORTED_OBSERVERS}",
        )

    seed = request["seed"]
    if not _is_strict_int(seed) or seed < 0 or seed > MAX_SEED:
        raise InvalidCompareRequestError(
            "invalid_request",
            f"CompareRequest.seed must be an integer in 0..{MAX_SEED}",
        )

    budget = request["budget"]
    if not isinstance(budget, dict) or frozenset(budget.keys()) != _BUDGET_KEYS:
        raise InvalidCompareRequestError(
            "invalid_request",
            "CompareRequest.budget must have exact keys search_pairs and shrink_pairs",
        )

    search_pairs = budget["search_pairs"]
    if not _is_strict_int(search_pairs) or search_pairs < 1 or search_pairs > MAX_SEARCH_PAIRS:
        raise InvalidCompareRequestError(
            "invalid_request",
            f"budget.search_pairs must be an integer in 1..{MAX_SEARCH_PAIRS}",
        )

    shrink_pairs = budget["shrink_pairs"]
    if not _is_strict_int(shrink_pairs) or shrink_pairs < 0 or shrink_pairs > MAX_SHRINK_PAIRS:
        raise InvalidCompareRequestError(
            "invalid_request",
            f"budget.shrink_pairs must be an integer in 0..{MAX_SHRINK_PAIRS}",
        )

    return request


def _elapsed_ms(start_monotonic: float) -> int:
    return max(0, int((time.monotonic() - start_monotonic) * 1000))


def _make_stats(
    *,
    search_pairs: int,
    shrink_pairs: int,
    parity_rejections: int,
    exhausted_by: str | None,
    first_difference_ms: int | None,
    elapsed_ms: int,
) -> dict[str, Any]:
    return {
        "search_pairs": search_pairs,
        "shrink_pairs": shrink_pairs,
        "parity_rejections": parity_rejections,
        "exhausted_by": exhausted_by,
        "first_difference_ms": first_difference_ms,
        "elapsed_ms": elapsed_ms,
    }


def _failed_report(
    *,
    request: Any,
    seed: int | None,
    error: dict[str, Any],
    stats: dict[str, Any],
    reference_status: str,
) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "status": "failed",
        "generator_version": GENERATOR_VERSION,
        "seed": seed,
        "candidate_index": None,
        "direction": None,
        "reference_status": reference_status,
        "message": error["message"],
        "request": request,
        "finding": None,
        "stats": stats,
        "error": error,
    }


class SearchEngine:
    """Executes Stage 4 counterexample search with reference parity verification."""

    def __init__(
        self,
        *,
        repo_root: Path | None = None,
        versions: RuntimeVersions | None = None,
        worker_factory: Callable[[], Any] | None = None,
        request_timeout_s: float = DEFAULT_REQUEST_TIMEOUT_S,
        job_deadline_s: float = DEFAULT_JOB_DEADLINE_S,
        max_duplicate_attempts: int = MAX_DUPLICATE_ATTEMPTS,
        phase1_fixtures: Sequence[dict[str, Any]] | None = None,
        phase2_sampler: Callable[[random.Random], dict[str, Any]] | None = None,
    ) -> None:
        self._repo_root = repo_root if repo_root is not None else default_repo_root()
        self._versions = versions
        self._worker_factory = worker_factory
        self._request_timeout_s = float(request_timeout_s)
        self._job_deadline_s = float(job_deadline_s)
        self._max_duplicate_attempts = int(max_duplicate_attempts)
        self._phase1_fixtures = phase1_fixtures
        self._phase2_sampler = phase2_sampler

    def _runtime_versions(self) -> RuntimeVersions:
        if self._versions is not None:
            return self._versions
        return resolve_runtime_versions(self._repo_root)

    def compare(self, request: dict[str, Any], *, worker: Any | None = None) -> dict[str, Any]:
        """Run deterministic counterexample search for `request` and return a structured report."""
        start_monotonic = time.monotonic()

        try:
            validated = validate_compare_request(request)
        except InvalidCompareRequestError as exc:
            seed_val = request.get("seed") if isinstance(request, dict) and _is_strict_int(request.get("seed")) else None
            return _failed_report(
                request=request,
                seed=seed_val,
                error=exc.diagnostic,
                stats=_make_stats(
                    search_pairs=0,
                    shrink_pairs=0,
                    parity_rejections=0,
                    exhausted_by=None,
                    first_difference_ms=None,
                    elapsed_ms=_elapsed_ms(start_monotonic),
                ),
                reference_status="not_run",
            )

        before_src: str = validated["before"]["source"]
        after_src: str = validated["after"]["source"]
        observer: str = validated["observer"]
        seed: int = validated["seed"]
        search_budget: int = validated["budget"]["search_pairs"]

        before_sha256 = hashlib.sha256(before_src.encode("utf-8")).hexdigest()
        after_sha256 = hashlib.sha256(after_src.encode("utf-8")).hexdigest()
        versions = self._runtime_versions()

        deadline_monotonic = start_monotonic + self._job_deadline_s
        search_pairs = 0
        parity_rejections = 0

        if worker is not None:
            active_worker = worker
            owns_worker = False
        elif self._worker_factory is not None:
            active_worker = self._worker_factory()
            owns_worker = True
        else:
            active_worker = WorkerClient(
                cwd=self._repo_root,
                request_timeout_s=self._request_timeout_s,
                job_deadline_s=self._job_deadline_s,
            )
            owns_worker = True

        try:
            self._check_deadline(deadline_monotonic)
            compile_res = active_worker.compile(before_src, after_src, observer=observer)
            if (
                compile_res.get("before_sha256") != before_sha256
                or compile_res.get("after_sha256") != after_sha256
            ):
                raise WorkerProtocolError("Worker compile SHA-256 digest does not match request UTF-8 bytes")

            generator = CandidateGenerator(
                seed=seed,
                max_pairs=search_budget,
                max_duplicate_attempts=self._max_duplicate_attempts,
                phase1_fixtures=self._phase1_fixtures,
                phase2_sampler=self._phase2_sampler,
            )

            for candidate_index, fixture in enumerate(generator):
                self._check_deadline(deadline_monotonic)

                search_pairs += 1
                custom_pair = active_worker.render_pair(fixture, engine="custom", trace=False)
                custom_before = custom_pair["before"]
                custom_after = custom_pair["after"]

                if custom_before["status"] == "error":
                    return _failed_report(
                        request=validated,
                        seed=seed,
                        error=custom_before["error"],
                        stats=_make_stats(
                            search_pairs=search_pairs,
                            shrink_pairs=0,
                            parity_rejections=parity_rejections,
                            exhausted_by=None,
                            first_difference_ms=None,
                            elapsed_ms=_elapsed_ms(start_monotonic),
                        ),
                        reference_status="not_run",
                    )

                if custom_after["status"] == "error":
                    return _failed_report(
                        request=validated,
                        seed=seed,
                        error=custom_after["error"],
                        stats=_make_stats(
                            search_pairs=search_pairs,
                            shrink_pairs=0,
                            parity_rejections=parity_rejections,
                            exhausted_by=None,
                            first_difference_ms=None,
                            elapsed_ms=_elapsed_ms(start_monotonic),
                        ),
                        reference_status="not_run",
                    )

                if custom_before["observed"] == custom_after["observed"]:
                    continue

                self._check_deadline(deadline_monotonic)
                ref_pair = active_worker.render_pair(fixture, engine="reference", trace=False)
                ref_before = ref_pair["before"]
                ref_after = ref_pair["after"]

                if ref_before["status"] != "ok" or ref_after["status"] != "ok":
                    parity_rejections += 1
                    continue

                if (
                    ref_before["observed"] != custom_before["observed"]
                    or ref_after["observed"] != custom_after["observed"]
                ):
                    parity_rejections += 1
                    continue

                first_difference_ms = _elapsed_ms(start_monotonic)
                direction = "before_only" if custom_before["observed"] else "after_only"

                self._check_deadline(deadline_monotonic)
                traced_custom = active_worker.render_pair(fixture, engine="custom", trace=True)
                traced_before = traced_custom["before"]
                traced_after = traced_custom["after"]

                if traced_before["status"] != "ok" or traced_after["status"] != "ok":
                    raise WorkerProtocolError("Tracing render failed after untraced render succeeded")
                if traced_before["html"] != custom_before["html"] or traced_after["html"] != custom_after["html"]:
                    raise WorkerProtocolError("Tracing altered rendered HTML output")
                if (
                    traced_before["observed"] != custom_before["observed"]
                    or traced_after["observed"] != custom_after["observed"]
                ):
                    raise WorkerProtocolError("Tracing altered observer result")
                if traced_custom["product"] != ref_pair["product"]:
                    raise WorkerProtocolError("Product projection mismatch between custom and reference renders")
                if ref_before["events"] or ref_after["events"]:
                    raise WorkerProtocolError("Reference render unexpectedly emitted trace events")

                replay_bundle = {
                    "request": validated,
                    "fixture": fixture,
                    "before_sha256": before_sha256,
                    "after_sha256": after_sha256,
                    "interpreter_version": versions.interpreter_version,
                    "liquid_version": versions.liquid_version,
                    "projection_version": versions.projection_version,
                }
                finding = {
                    "product": traced_custom["product"],
                    "replay": replay_bundle,
                    "before": traced_before,
                    "after": traced_after,
                    "reference": {
                        "before": ref_before,
                        "after": ref_after,
                    },
                    "explanation": {
                        "kind": "undetermined",
                        "before": None,
                        "after": None,
                        "summary": "Trace explanation pending Stage 5 shrink/alignment.",
                    },
                }

                elapsed_ms = max(first_difference_ms, _elapsed_ms(start_monotonic))
                stats = _make_stats(
                    search_pairs=search_pairs,
                    shrink_pairs=0,
                    parity_rejections=parity_rejections,
                    exhausted_by=None,
                    first_difference_ms=first_difference_ms,
                    elapsed_ms=elapsed_ms,
                )

                return {
                    "schema_version": 1,
                    "status": "difference_found",
                    "generator_version": GENERATOR_VERSION,
                    "seed": seed,
                    "candidate_index": candidate_index,
                    "direction": direction,
                    "reference_status": "confirmed",
                    "message": (
                        f"Confirmed {observer} difference ({direction}) at candidate index "
                        f"{candidate_index} after {search_pairs} search pair(s)."
                    ),
                    "request": validated,
                    "finding": finding,
                    "stats": stats,
                    "error": None,
                }

            exhausted_by = "candidate_space" if generator.exhausted_space else "pair_limit"
            elapsed_ms = _elapsed_ms(start_monotonic)

            if parity_rejections > 0:
                diag = make_diagnostic(
                    "reference_mismatch",
                    f"Encountered {parity_rejections} custom difference(s) rejected by the reference Liquid engine "
                    f"with no confirmed finding across {search_pairs} search pair(s).",
                    span=None,
                )
                return _failed_report(
                    request=validated,
                    seed=seed,
                    error=diag,
                    stats=_make_stats(
                        search_pairs=search_pairs,
                        shrink_pairs=0,
                        parity_rejections=parity_rejections,
                        exhausted_by=exhausted_by,
                        first_difference_ms=None,
                        elapsed_ms=elapsed_ms,
                    ),
                    reference_status="mismatch",
                )

            return {
                "schema_version": 1,
                "status": "no_difference_found",
                "generator_version": GENERATOR_VERSION,
                "seed": seed,
                "candidate_index": None,
                "direction": None,
                "reference_status": "not_triggered",
                "message": "no difference found within this search",
                "request": validated,
                "finding": None,
                "stats": _make_stats(
                    search_pairs=search_pairs,
                    shrink_pairs=0,
                    parity_rejections=0,
                    exhausted_by=exhausted_by,
                    first_difference_ms=None,
                    elapsed_ms=elapsed_ms,
                ),
                "error": None,
            }

        except WorkerError as exc:
            return _failed_report(
                request=validated,
                seed=seed,
                error=exc.diagnostic,
                stats=_make_stats(
                    search_pairs=search_pairs,
                    shrink_pairs=0,
                    parity_rejections=parity_rejections,
                    exhausted_by=None,
                    first_difference_ms=None,
                    elapsed_ms=_elapsed_ms(start_monotonic),
                ),
                reference_status="mismatch" if parity_rejections > 0 else "not_run",
            )
        finally:
            if owns_worker:
                try:
                    active_worker.close()
                except Exception:
                    pass

    def _check_deadline(self, deadline_monotonic: float) -> None:
        if time.monotonic() >= deadline_monotonic:
            raise JobDeadlineError(f"Job deadline of {self._job_deadline_s:.1f}s exceeded")

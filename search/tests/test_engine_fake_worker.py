"""Unit tests for WorkerClient and SearchEngine using fake workers and subprocess scripts."""

from __future__ import annotations

import hashlib
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from typing import Any, Callable

from search.engine import (
    MAX_SNIPPET_BYTES,
    RuntimeVersions,
    SearchEngine,
    build_compare_request,
)
from search.generator import build_fixture
from search.worker_client import (
    DEFAULT_MAX_RESPONSE_BYTES,
    JobDeadlineError,
    WorkerClient,
    WorkerCompileError,
    WorkerProtocolError,
    WorkerTimeoutError,
)


def _ok_render(html: str, observed: bool, events: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    return {
        "status": "ok",
        "html": html,
        "observed": observed,
        "events": events or [],
        "error": None,
    }


def _err_render(code: str, message: str, span: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "status": "error",
        "html": None,
        "observed": None,
        "events": [],
        "error": {"code": code, "message": message, "span": span},
    }


def _sample_projection(fixture: dict[str, Any]) -> dict[str, Any]:
    prices = [v["price"] for v in fixture["variants"]]
    caps = [v["compare_at_price"] for v in fixture["variants"] if v["compare_at_price"] is not None]
    return {
        "price": min(prices),
        "price_min": min(prices),
        "price_max": max(prices),
        "price_varies": min(prices) != max(prices),
        "compare_at_price": min(caps) if caps else None,
        "compare_at_price_min": min(caps) if caps else None,
        "compare_at_price_max": max(caps) if caps else None,
        "compare_at_price_varies": len(set(caps)) >= 2,
        "available": any(v["available"] for v in fixture["variants"]),
    }


class FakeWorker:
    """In-memory programmable worker stub matching the WorkerClient interface."""

    def __init__(
        self,
        *,
        compile_error: dict[str, Any] | None = None,
        render_handler: Callable[[dict[str, Any], str, bool, int], dict[str, Any]] | None = None,
    ) -> None:
        self.compile_error = compile_error
        self.render_handler = render_handler
        self.compile_calls: list[tuple[str, str, str]] = []
        self.render_calls: list[tuple[dict[str, Any], str, bool]] = []
        self.closed = False

    def compile(self, before: str, after: str, observer: str = "sale_badge") -> dict[str, str]:
        self.compile_calls.append((before, after, observer))
        if self.compile_error is not None:
            raise WorkerCompileError(self.compile_error["message"], diagnostic=self.compile_error)
        return {
            "before_sha256": hashlib.sha256(before.encode("utf-8")).hexdigest(),
            "after_sha256": hashlib.sha256(after.encode("utf-8")).hexdigest(),
        }

    def render_pair(self, fixture: dict[str, Any], engine: str, trace: bool = False) -> dict[str, Any]:
        call_idx = len(self.render_calls)
        self.render_calls.append((fixture, engine, trace))
        if self.render_handler is not None:
            return self.render_handler(fixture, engine, trace, call_idx)
        return {
            "before": _ok_render("", False, [{"seq": 0, "node_id": "n0", "scope": [], "span": {"start_byte": 0, "end_byte": 1, "line": 1, "column": 1}, "data": {"kind": "assignment", "name": "x", "value": False}}] if (trace and engine == "custom") else []),
            "after": _ok_render("", False),
            "product": _sample_projection(fixture),
        }

    def close(self) -> None:
        self.closed = True


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def _wait_pid_dead(pid: int, timeout_s: float = 2.0) -> bool:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if not _pid_alive(pid):
            return True
        time.sleep(0.02)
    return not _pid_alive(pid)


class EngineAndFakeWorkerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.versions = RuntimeVersions("0.1.0", "5.14.0", "1.0.0")

    def _engine(self, **kwargs: Any) -> SearchEngine:
        return SearchEngine(versions=self.versions, **kwargs)

    def test_compile_error_returns_failed_diagnostic(self) -> None:
        span = {"start_byte": 0, "end_byte": 11, "line": 1, "column": 1}
        worker = FakeWorker(compile_error={"code": "unsupported_tag", "message": "Unknown tag 'bogus'", "span": span})
        req = build_compare_request("{% bogus %}", "ok", search_pairs=16)

        report = self._engine().compare(req, worker=worker)
        self.assertEqual(report["status"], "failed")
        self.assertIsNone(report["finding"])
        self.assertEqual(report["error"], {"code": "unsupported_tag", "message": "Unknown tag 'bogus'", "span": span})
        self.assertEqual(report["stats"]["search_pairs"], 0)
        self.assertEqual(report["reference_status"], "not_run")

    def test_request_validation_bounds_and_snippet_byte_limit(self) -> None:
        worker = FakeWorker()
        engine = self._engine()

        bad_observer = build_compare_request("ok", "ok", observer="sold_out_badge")
        res_obs = engine.compare(bad_observer, worker=worker)
        self.assertEqual(res_obs["status"], "failed")
        self.assertEqual(res_obs["error"]["code"], "unsupported_observer")
        self.assertEqual(worker.compile_calls, [])

        # Multi-byte UTF-8 exceeding 16384 bytes even if len(str) < 16384
        oversized_utf8 = "é" * ((MAX_SNIPPET_BYTES // 2) + 1)
        self.assertLess(len(oversized_utf8), MAX_SNIPPET_BYTES)
        self.assertGreater(len(oversized_utf8.encode("utf-8")), MAX_SNIPPET_BYTES)
        res_big = engine.compare(build_compare_request(oversized_utf8, "ok"), worker=worker)
        self.assertEqual(res_big["status"], "failed")
        self.assertEqual(res_big["error"]["code"], "snippet_too_large")

        res_seed = engine.compare(build_compare_request("ok", "ok", seed=4_294_967_296), worker=worker)
        self.assertEqual(res_seed["status"], "failed")
        self.assertEqual(res_seed["error"]["code"], "invalid_request")

        res_budget = engine.compare(build_compare_request("ok", "ok", search_pairs=5001), worker=worker)
        self.assertEqual(res_budget["status"], "failed")
        self.assertEqual(res_budget["error"]["code"], "invalid_request")

        res_shrink = engine.compare(build_compare_request("ok", "ok", shrink_pairs=1001), worker=worker)
        self.assertEqual(res_shrink["status"], "failed")
        self.assertEqual(res_shrink["error"]["code"], "invalid_request")

    def test_custom_render_error_stops_immediately_with_diagnostic(self) -> None:
        diag = {
            "code": "comparison_error",
            "message": "Cannot compare Integer with String",
            "span": {"start_byte": 6, "end_byte": 24, "line": 1, "column": 7},
        }
        seen_custom_calls = 0

        def handler(fixture: dict[str, Any], engine: str, trace: bool, _: int) -> dict[str, Any]:
            nonlocal seen_custom_calls
            seen_custom_calls += 1
            if seen_custom_calls == 1:
                return {"before": _ok_render("", False), "after": _ok_render("", False), "product": _sample_projection(fixture)}
            return {"before": _err_render(**diag), "after": _ok_render("", False), "product": _sample_projection(fixture)}

        worker = FakeWorker(render_handler=handler)
        report = self._engine().compare(build_compare_request("a", "b", search_pairs=16), worker=worker)
        self.assertEqual(report["status"], "failed")
        self.assertEqual(report["error"], diag)
        self.assertEqual(report["stats"]["search_pairs"], 2)
        self.assertIsNone(report["finding"])

    def test_parity_rejection_followed_by_confirmed_match(self) -> None:
        custom_step = 0
        trace_event = {
            "seq": 0,
            "node_id": "n0:branch",
            "scope": [],
            "span": {"start_byte": 0, "end_byte": 10, "line": 1, "column": 1},
            "data": {"kind": "branch", "expression": "true", "condition": True, "taken": True},
        }

        def handler(fixture: dict[str, Any], engine: str, trace: bool, _: int) -> dict[str, Any]:
            nonlocal custom_step
            product = _sample_projection(fixture)
            if engine == "custom" and not trace:
                custom_step += 1
                if custom_step in (1, 2):
                    # Differing custom observation that reference will reject
                    return {
                        "before": _ok_render("<span data-regression-badge='sale'>Sale</span>", True),
                        "after": _ok_render("", False),
                        "product": product,
                    }
                if custom_step == 3:
                    return {
                        "before": _ok_render("", False),
                        "after": _ok_render("<span data-regression-badge='sale'>Sale</span>", True),
                        "product": product,
                    }
                return {"before": _ok_render("", False), "after": _ok_render("", False), "product": product}

            if engine == "reference":
                if custom_step == 1:
                    # Reference disagrees with custom
                    return {"before": _ok_render("", False), "after": _ok_render("", False), "product": product}
                if custom_step == 2:
                    # Reference errors while custom succeeded -> treated as parity rejection
                    return {
                        "before": _err_render("reference_render_error", "Liquid error"),
                        "after": _ok_render("", False),
                        "product": product,
                    }
                # Step 3 confirms!
                return {
                    "before": _ok_render("", False),
                    "after": _ok_render("<span data-regression-badge='sale'>Sale</span>", True),
                    "product": product,
                }

            # trace == True on custom
            return {
                "before": _ok_render("", False, [trace_event]),
                "after": _ok_render("<span data-regression-badge='sale'>Sale</span>", True, [trace_event]),
                "product": product,
            }

        worker = FakeWorker(render_handler=handler)
        report = self._engine().compare(build_compare_request("before", "after", search_pairs=16), worker=worker)

        self.assertEqual(report["status"], "difference_found")
        self.assertEqual(report["candidate_index"], 2)
        self.assertEqual(report["direction"], "after_only")
        self.assertEqual(report["reference_status"], "confirmed")
        self.assertEqual(report["stats"]["search_pairs"], 3)
        self.assertEqual(report["stats"]["parity_rejections"], 2)
        self.assertIsNone(report["stats"]["exhausted_by"])
        self.assertIsNotNone(report["stats"]["first_difference_ms"])

        finding = report["finding"]
        self.assertEqual(finding["explanation"]["kind"], "undetermined")
        self.assertEqual(finding["before"]["events"], [trace_event])
        self.assertEqual(finding["reference"]["after"]["observed"], True)
        self.assertEqual(finding["reference"]["after"]["events"], [])

    def test_parity_rejection_exhaustion_returns_reference_mismatch(self) -> None:
        def handler(fixture: dict[str, Any], engine: str, trace: bool, idx: int) -> dict[str, Any]:
            product = _sample_projection(fixture)
            if engine == "custom" and idx == 0:
                return {
                    "before": _ok_render("<span data-regression-badge='sale'>Sale</span>", True),
                    "after": _ok_render("", False),
                    "product": product,
                }
            return {"before": _ok_render("", False), "after": _ok_render("", False), "product": product}

        worker = FakeWorker(render_handler=handler)
        report = self._engine().compare(build_compare_request("before", "after", search_pairs=5), worker=worker)
        self.assertEqual(report["status"], "failed")
        self.assertEqual(report["error"]["code"], "reference_mismatch")
        self.assertIsNone(report["error"]["span"])
        self.assertEqual(report["stats"]["search_pairs"], 5)
        self.assertEqual(report["stats"]["parity_rejections"], 1)
        self.assertEqual(report["stats"]["exhausted_by"], "pair_limit")
        self.assertEqual(report["reference_status"], "mismatch")

    def test_identical_snippets_pair_limit_and_candidate_space_exhaustion(self) -> None:
        worker = FakeWorker()
        report = self._engine().compare(build_compare_request("same", "same", search_pairs=16), worker=worker)
        self.assertEqual(report["status"], "no_difference_found")
        self.assertEqual(report["message"], "no difference found within this search")
        self.assertEqual(report["stats"]["search_pairs"], 16)
        self.assertEqual(report["stats"]["parity_rejections"], 0)
        self.assertEqual(report["stats"]["exhausted_by"], "pair_limit")
        self.assertEqual(report["reference_status"], "not_triggered")
        self.assertIsNone(report["finding"])
        self.assertIsNone(report["error"])

        tiny_pool = [build_fixture([(100, None, True)]), build_fixture([(200, 300, False)])]
        space_engine = self._engine(
            max_duplicate_attempts=4,
            phase1_fixtures=[],
            phase2_sampler=lambda rng: rng.choice(tiny_pool),
        )
        space_report = space_engine.compare(build_compare_request("same", "same", search_pairs=50), worker=FakeWorker())
        self.assertEqual(space_report["status"], "no_difference_found")
        self.assertEqual(space_report["stats"]["search_pairs"], 2)
        self.assertEqual(space_report["stats"]["exhausted_by"], "candidate_space")

    def test_tracing_mismatch_raises_protocol_failure(self) -> None:
        def handler(fixture: dict[str, Any], engine: str, trace: bool, _: int) -> dict[str, Any]:
            product = _sample_projection(fixture)
            if trace:
                return {
                    "before": _ok_render("<span data-regression-badge='sale'>CHANGED</span>", True),
                    "after": _ok_render("", False),
                    "product": product,
                }
            return {
                "before": _ok_render("<span data-regression-badge='sale'>Sale</span>", True),
                "after": _ok_render("", False),
                "product": product,
            }

        report = self._engine().compare(build_compare_request("a", "b", search_pairs=4), worker=FakeWorker(render_handler=handler))
        self.assertEqual(report["status"], "failed")
        self.assertEqual(report["error"]["code"], "protocol_error")

    def test_subprocess_timeout_reaps_process_group_and_grandchildren(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            pid_file = Path(tmpdir) / "pids.json"
            worker_script = f"""
import json, os, subprocess, sys, time
child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
with open({str(pid_file)!r}, "w", encoding="utf-8") as fh:
    json.dump({{"leader": os.getpid(), "grandchild": child.pid}}, fh)
for line in sys.stdin:
    req = json.loads(line)
    if req["op"] == "compile":
        sys.stdout.write(json.dumps({{"id": req["id"], "result": {{"before_sha256": "a"*64, "after_sha256": "b"*64}}}}) + "\\n")
        sys.stdout.flush()
    else:
        time.sleep(60)
"""
            before = "before"
            after = "after"
            # Override sha check via matching strings? No, engine checks actual sha256!
            sha_b = hashlib.sha256(before.encode("utf-8")).hexdigest()
            sha_a = hashlib.sha256(after.encode("utf-8")).hexdigest()
            worker_script = worker_script.replace('"a"*64', repr(sha_b)).replace('"b"*64', repr(sha_a))

            client = WorkerClient(
                command=[sys.executable, "-c", worker_script],
                request_timeout_s=0.15,
                job_deadline_s=5.0,
            )
            engine = self._engine(worker_factory=lambda: client)
            report = engine.compare(build_compare_request(before, after, search_pairs=4))

            self.assertEqual(report["status"], "failed")
            self.assertEqual(report["error"]["code"], "worker_timeout")
            self.assertEqual(report["stats"]["search_pairs"], 1)

            pids = json.loads(pid_file.read_text(encoding="utf-8"))
            self.assertTrue(_wait_pid_dead(pids["leader"]), "Worker leader process was not reaped")
            self.assertTrue(_wait_pid_dead(pids["grandchild"]), "Grandchild process was not reaped by killpg")

    def test_subprocess_job_deadline_watchdog(self) -> None:
        before = "before"
        after = "after"
        sha_b = hashlib.sha256(before.encode("utf-8")).hexdigest()
        sha_a = hashlib.sha256(after.encode("utf-8")).hexdigest()
        worker_script = f"""
import json, sys, time
for line in sys.stdin:
    req = json.loads(line)
    time.sleep(0.09)
    if req["op"] == "compile":
        resp = {{"id": req["id"], "result": {{"before_sha256": {sha_b!r}, "after_sha256": {sha_a!r}}}}}
    elif req["op"] == "render_pair":
        resp = {{
            "id": req["id"],
            "result": {{
                "before": {{"status": "ok", "html": "", "observed": False, "events": [], "error": None}},
                "after": {{"status": "ok", "html": "", "observed": False, "events": [], "error": None}},
                "product": {{
                    "price": 0, "price_min": 0, "price_max": 0, "price_varies": False,
                    "compare_at_price": None, "compare_at_price_min": None, "compare_at_price_max": None,
                    "compare_at_price_varies": False, "available": True
                }}
            }}
        }}
    else:
        resp = {{"id": req["id"], "result": {{"ok": True}}}}
    sys.stdout.write(json.dumps(resp) + "\\n")
    sys.stdout.flush()
"""
        engine = self._engine(
            job_deadline_s=0.25,
            request_timeout_s=2.0,
            worker_factory=lambda: WorkerClient(
                command=[sys.executable, "-c", worker_script],
                request_timeout_s=2.0,
                job_deadline_s=0.25,
            ),
        )
        report = engine.compare(build_compare_request(before, after, search_pairs=20))
        self.assertEqual(report["status"], "failed")
        self.assertEqual(report["error"]["code"], "job_deadline_exceeded")

    def test_subprocess_16mib_response_limit_and_streaming_limit(self) -> None:
        self.assertEqual(DEFAULT_MAX_RESPONSE_BYTES, 16 * 1024 * 1024)

        # 1. Exact default 16 MiB limit exceeded by 1 byte
        oversized_script = f"""
import sys
# Emit 16 MiB + 1 byte before newline
sys.stdout.buffer.write(b"{{" + b" " * ({DEFAULT_MAX_RESPONSE_BYTES}) + b"}}\\n")
sys.stdout.buffer.flush()
"""
        with self.assertRaises(WorkerProtocolError) as ctx:
            with WorkerClient(command=[sys.executable, "-c", oversized_script], request_timeout_s=5.0) as client:
                client.compile("a", "b")
        self.assertEqual(ctx.exception.code, "response_too_large")

        # 2. Unterminated stream exceeding custom limit aborts immediately without waiting for newline
        unterminated_script = """
import sys, time
sys.stdout.buffer.write(b"x" * 200)
sys.stdout.buffer.flush()
time.sleep(60)
"""
        with self.assertRaises(WorkerProtocolError) as ctx2:
            with WorkerClient(
                command=[sys.executable, "-c", unterminated_script],
                request_timeout_s=2.0,
                max_response_bytes=128,
            ) as client:
                client.compile("a", "b")
        self.assertEqual(ctx2.exception.code, "response_too_large")

    def test_subprocess_malformed_json_id_mismatch_and_quit_hang_reap(self) -> None:
        # Malformed JSON response
        with self.assertRaises(WorkerProtocolError):
            with WorkerClient(command=[sys.executable, "-c", "import sys; sys.stdin.readline(); print('not-json', flush=True)"]) as c:
                c.compile("a", "b")

        # Mismatched response ID
        with self.assertRaises(WorkerProtocolError):
            with WorkerClient(
                command=[
                    sys.executable,
                    "-c",
                    'import sys, json; sys.stdin.readline(); print(json.dumps({"id":"wrong","result":{"before_sha256":"'
                    + "0" * 64
                    + '","after_sha256":"'
                    + "0" * 64
                    + '"}}), flush=True)',
                ]
            ) as c:
                c.compile("a", "b")

        # Subprocess ignores quit -> close() reaps process group
        before = "a"
        sha = hashlib.sha256(before.encode("utf-8")).hexdigest()
        hang_quit_script = f"""
import json, sys, time
for line in sys.stdin:
    req = json.loads(line)
    if req["op"] == "compile":
        print(json.dumps({{"id": req["id"], "result": {{"before_sha256": {sha!r}, "after_sha256": {sha!r}}}}}), flush=True)
    elif req["op"] == "quit":
        time.sleep(60)
"""
        client = WorkerClient(
            command=[sys.executable, "-c", hang_quit_script],
            request_timeout_s=2.0,
            quit_timeout_s=0.15,
        )
        client.start()
        pid = client.pid
        assert pid is not None
        client.compile(before, before)
        client.close()
        self.assertTrue(_wait_pid_dead(pid), "close() did not reap hung worker process")


if __name__ == "__main__":
    unittest.main()

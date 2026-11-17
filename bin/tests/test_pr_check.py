"""Unit and subprocess integration tests for bin/pr-check."""

from __future__ import annotations

import ast
import hashlib
import importlib.machinery
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
PR_CHECK_PATH = REPO_ROOT / "bin" / "pr-check"


def load_pr_check_module():
    loader = importlib.machinery.SourceFileLoader("pr_check_mod", str(PR_CHECK_PATH))
    spec = importlib.util.spec_from_loader("pr_check_mod", loader)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["pr_check_mod"] = module
    spec.loader.exec_module(module)
    return module


pr_check = load_pr_check_module()


def _git(repo_dir: Path, *args: str) -> str:
    proc = subprocess.run(
        ["git", "-C", str(repo_dir), *args],
        capture_output=True,
        text=True,
        check=True,
    )
    return proc.stdout.strip()


def _init_temp_repo(root: Path) -> Path:
    repo = root / "repo"
    repo.mkdir()
    _git(repo, "init")
    _git(repo, "config", "user.email", "test@example.com")
    _git(repo, "config", "user.name", "Test User")
    return repo


def _commit_file(repo: Path, rel_path: str, content: bytes | str, message: str) -> str:
    target = repo / rel_path
    target.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(content, bytes):
        target.write_bytes(content)
    else:
        target.write_bytes(content.encode("utf-8"))
    _git(repo, "add", rel_path)
    _git(repo, "commit", "-m", message)
    return _git(repo, "rev-parse", "HEAD")


def _write_manifest(path: Path, **overrides: Any) -> Path:
    manifest = {
        "schema_version": 1,
        "snippet_path": "snippets/card-product.liquid",
        "observer": "sale_badge",
        "marker": '[data-regression-badge="sale"]',
        "seed": 0,
        "budget": {"search_pairs": 256, "shrink_pairs": 128},
        "poll_timeout_seconds": 90,
    }
    manifest.update(overrides)
    path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return path


class _MockApiState:
    def __init__(
        self,
        *,
        post_status: int = 202,
        post_body: dict[str, Any] | None = None,
        get_sequence: list[tuple[int, dict[str, Any]]] | None = None,
        require_token: str | None = None,
    ) -> None:
        self.post_status = post_status
        self.post_body = post_body
        self.get_sequence = list(get_sequence or [])
        self.require_token = require_token
        self.requests: list[dict[str, Any]] = []
        self._lock = threading.Lock()

    def record(self, method: str, path: str, headers: dict[str, str], body: bytes) -> None:
        with self._lock:
            self.requests.append(
                {
                    "method": method,
                    "path": path,
                    "headers": {k.lower(): v for k, v in headers.items()},
                    "body": body.decode("utf-8", errors="replace"),
                }
            )

    def next_get(self) -> tuple[int, dict[str, Any]]:
        with self._lock:
            if len(self.get_sequence) > 1:
                return self.get_sequence.pop(0)
            if self.get_sequence:
                return self.get_sequence[0]
            return 404, {"error": {"code": "not_found", "message": "not found", "span": None}}


def _start_mock_server(state: _MockApiState) -> tuple[ThreadingHTTPServer, str]:
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
            return

        def _send_json(self, code: int, payload: dict[str, Any]) -> None:
            raw = json.dumps(payload).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def do_POST(self) -> None:  # noqa: N802
            length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(length) if length > 0 else b""
            state.record("POST", self.path, dict(self.headers.items()), body)

            if state.require_token is not None:
                auth = self.headers.get("Authorization", "")
                if auth != f"Bearer {state.require_token}":
                    self._send_json(
                        401,
                        {"error": {"code": "unauthorized", "message": "Missing or invalid bearer token", "span": None}},
                    )
                    return

            if state.post_body is not None:
                self._send_json(state.post_status, state.post_body)
            else:
                self._send_json(
                    500,
                    {"error": {"code": "server_error", "message": "No mock POST body configured", "span": None}},
                )

        def do_GET(self) -> None:  # noqa: N802
            state.record("GET", self.path, dict(self.headers.items()), b"")
            code, payload = state.next_get()
            self._send_json(code, payload)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    host, port = server.server_address
    return server, f"http://{host}:{port}"


def _sample_job(
    *,
    job_id: str = "11111111-2222-4333-8444-555555555555",
    status: str = "queued",
    finding: dict[str, Any] | None = None,
    stats: dict[str, Any] | None = None,
    error: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "id": job_id,
        "status": status,
        "request": {
            "schema_version": 1,
            "before": {"source": "before"},
            "after": {"source": "after"},
            "observer": "sale_badge",
            "seed": 0,
            "budget": {"search_pairs": 256, "shrink_pairs": 128},
        },
        "finding": finding,
        "stats": stats,
        "error": error,
        "result_url": f"/comparisons/{job_id}",
        "created_at": "2026-11-17T06:00:00.000Z",
        "completed_at": None if status in ("queued", "running") else "2026-11-17T06:00:01.000Z",
    }


def _sample_finding() -> dict[str, Any]:
    return {
        "product": {
            "price": 0,
            "price_min": 0,
            "price_max": 0,
            "price_varies": False,
            "compare_at_price": 0,
            "compare_at_price_min": 0,
            "compare_at_price_max": 1,
            "compare_at_price_varies": True,
            "available": False,
        },
        "replay": {
            "request": {
                "schema_version": 1,
                "before": {"source": "before"},
                "after": {"source": "after"},
                "observer": "sale_badge",
                "seed": 0,
                "budget": {"search_pairs": 256, "shrink_pairs": 128},
            },
            "fixture": {
                "schema_version": 1,
                "currency": "USD",
                "variants": [
                    {"id": "v1", "price": 0, "compare_at_price": 0, "available": False},
                    {"id": "v2", "price": 0, "compare_at_price": 1, "available": False},
                ],
            },
            "before_sha256": "a" * 64,
            "after_sha256": "b" * 64,
            "interpreter_version": "0.1.0",
            "liquid_version": "5.14.0",
            "projection_version": "1.0.0",
        },
        "before": {"status": "ok", "html": '<span data-regression-badge="sale">Sale</span>', "observed": True, "events": [], "error": None},
        "after": {"status": "ok", "html": "", "observed": False, "events": [], "error": None},
        "reference": {
            "before": {"status": "ok", "html": '<span data-regression-badge="sale">Sale</span>', "observed": True, "events": [], "error": None},
            "after": {"status": "ok", "html": "", "observed": False, "events": [], "error": None},
        },
        "explanation": {
            "kind": "structural_change",
            "before": {"line": 3, "event_seq": 13},
            "after": {"line": 1, "event_seq": 5},
            "summary": "Structural change: before at line 3 vs after at line 1.",
        },
    }


class PrCheckTests(unittest.TestCase):
    def test_pr_check_is_python_stdlib_only_and_repo_manifest_valid(self) -> None:
        tree = ast.parse(PR_CHECK_PATH.read_text(encoding="utf-8"), filename=str(PR_CHECK_PATH))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    top = alias.name.split(".", 1)[0]
                    self.assertIn(top, sys.stdlib_module_names, f"Non-stdlib import {alias.name!r}")
            elif isinstance(node, ast.ImportFrom):
                if node.level == 0 and node.module:
                    top = node.module.split(".", 1)[0]
                    self.assertIn(top, sys.stdlib_module_names, f"Non-stdlib import {node.module!r}")

        manifest, digest = pr_check.load_and_validate_manifest(REPO_ROOT / "comparison-manifest.json")
        self.assertEqual(manifest["schema_version"], 1)
        self.assertEqual(manifest["snippet_path"], "snippets/card-product.liquid")
        self.assertEqual(manifest["observer"], "sale_badge")
        self.assertEqual(manifest["marker"], '[data-regression-badge="sale"]')
        self.assertEqual(manifest["seed"], 0)
        self.assertEqual(manifest["budget"], {"search_pairs": 256, "shrink_pairs": 128})
        self.assertEqual(manifest["poll_timeout_seconds"], 90.0)
        self.assertEqual(len(digest), 64)
        self.assertTrue((REPO_ROOT / manifest["snippet_path"]).is_file())

    def test_manifest_validation_rejects_invalid_inputs(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            with self.assertRaises(pr_check.PrCheckDiagnosticError) as ctx:
                pr_check.load_and_validate_manifest(root / "missing.json")
            self.assertEqual(ctx.exception.code, "invalid_manifest")

            bad_path = _write_manifest(root / "traversal.json", snippet_path="../outside.liquid")
            with self.assertRaises(pr_check.PrCheckDiagnosticError) as ctx:
                pr_check.load_and_validate_manifest(bad_path)
            self.assertEqual(ctx.exception.code, "invalid_manifest")

            bad_observer = _write_manifest(root / "obs.json", observer="price_range")
            with self.assertRaises(pr_check.PrCheckDiagnosticError) as ctx:
                pr_check.load_and_validate_manifest(bad_observer)
            self.assertEqual(ctx.exception.code, "invalid_manifest")

    def test_exact_git_blob_reading_preserves_utf8_and_shell_metacharacters(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            repo = _init_temp_repo(root)
            sentinel = root / "pwned"

            # Include shell metacharacters, backticks, quotes, UTF-8, and NO trailing newline.
            before_src = (
                f"<!-- $(touch {sentinel}) `touch {sentinel}` ' \" \\ $HOME äöü -->\n"
                '<span data-regression-badge="sale">Sale</span>'
            )
            after_src = (
                f"<!-- $(touch {sentinel}) `touch {sentinel}` -->\n"
                "<span>Regular</span>"
            )
            base_sha = _commit_file(repo, "snippets/card-product.liquid", before_src, "base")
            head_sha = _commit_file(repo, "snippets/card-product.liquid", after_src, "head")

            got_before, got_after, b_sha, a_sha = pr_check.read_git_snippet_blobs(
                git_dir=str(repo),
                base_sha=base_sha,
                head_sha=head_sha,
                snippet_path="snippets/card-product.liquid",
            )
            self.assertEqual(got_before, before_src)
            self.assertEqual(got_after, after_src)
            self.assertEqual(b_sha, hashlib.sha256(before_src.encode("utf-8")).hexdigest())
            self.assertEqual(a_sha, hashlib.sha256(after_src.encode("utf-8")).hexdigest())
            self.assertFalse(sentinel.exists(), "Shell metacharacters inside Liquid must never execute!")

    def test_missing_and_renamed_blob_diagnostics(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            repo = _init_temp_repo(root)
            snippet = (
                "line 1\n"
                "line 2\n"
                "line 3\n"
                '<span data-regression-badge="sale">Sale</span>\n'
            )
            base_sha = _commit_file(repo, "snippets/card-product.liquid", snippet, "base")

            # Rename blob
            _git(repo, "mv", "snippets/card-product.liquid", "snippets/product-card-v2.liquid")
            _git(repo, "commit", "-m", "rename")
            rename_sha = _git(repo, "rev-parse", "HEAD")

            with self.assertRaises(pr_check.PrCheckDiagnosticError) as rename_ctx:
                pr_check.read_git_snippet_blobs(
                    git_dir=str(repo),
                    base_sha=base_sha,
                    head_sha=rename_sha,
                    snippet_path="snippets/card-product.liquid",
                )
            self.assertEqual(rename_ctx.exception.code, "renamed_blob")
            self.assertIn("snippets/product-card-v2.liquid", rename_ctx.exception.message)

            # Delete blob (from a fresh branch off base)
            _git(repo, "checkout", "-b", "delete-branch", base_sha)
            _git(repo, "rm", "snippets/card-product.liquid")
            _git(repo, "commit", "-m", "delete")
            delete_sha = _git(repo, "rev-parse", "HEAD")

            with self.assertRaises(pr_check.PrCheckDiagnosticError) as miss_ctx:
                pr_check.read_git_snippet_blobs(
                    git_dir=str(repo),
                    base_sha=base_sha,
                    head_sha=delete_sha,
                    snippet_path="snippets/card-product.liquid",
                )
            self.assertEqual(miss_ctx.exception.code, "missing_blob")
            self.assertIn("head", miss_ctx.exception.message)

            # Invalid UTF-8 blob
            _git(repo, "checkout", "-b", "bad-utf8", base_sha)
            bad_utf8_sha = _commit_file(repo, "snippets/card-product.liquid", b"\xff\xfe{{ bad }}", "bad utf8")
            with self.assertRaises(pr_check.PrCheckDiagnosticError) as utf_ctx:
                pr_check.read_git_snippet_blobs(
                    git_dir=str(repo),
                    base_sha=base_sha,
                    head_sha=bad_utf8_sha,
                    snippet_path="snippets/card-product.liquid",
                )
            self.assertEqual(utf_ctx.exception.code, "invalid_utf8_blob")

    def test_deterministic_idempotency_key(self) -> None:
        k1 = pr_check.compute_idempotency_key("owner/repo", "aaa", "bbb", "ccc")
        k2 = pr_check.compute_idempotency_key("owner/repo", "aaa", "bbb", "ccc")
        self.assertEqual(k1, k2)
        self.assertEqual(len(k1), 64)
        self.assertNotEqual(k1, pr_check.compute_idempotency_key("owner/other", "aaa", "bbb", "ccc"))
        self.assertNotEqual(k1, pr_check.compute_idempotency_key("owner/repo", "aab", "bbb", "ccc"))
        self.assertNotEqual(k1, pr_check.compute_idempotency_key("owner/repo", "aaa", "bbc", "ccc"))
        self.assertNotEqual(k1, pr_check.compute_idempotency_key("owner/repo", "aaa", "bbb", "ccd"))

    def test_cli_no_difference_found_bearer_token_and_step_summary(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            repo = _init_temp_repo(root)
            manifest_path = _write_manifest(root / "comparison-manifest.json")
            manifest_digest = hashlib.sha256(manifest_path.read_bytes()).hexdigest()
            summary_path = root / "step_summary.md"
            json_out = root / "report.json"

            base_sha = _commit_file(repo, "snippets/card-product.liquid", '<span data-regression-badge="sale">Sale</span>', "base")
            head_sha = _commit_file(repo, "snippets/card-product.liquid", '<span class="x" data-regression-badge="sale">Sale</span>', "head")

            stats = {
                "search_pairs": 256,
                "shrink_pairs": 0,
                "parity_rejections": 0,
                "exhausted_by": "pair_limit",
                "first_difference_ms": None,
                "elapsed_ms": 42,
            }
            state = _MockApiState(
                post_status=202,
                post_body=_sample_job(status="queued"),
                get_sequence=[
                    (200, _sample_job(status="running")),
                    (200, _sample_job(status="no_difference_found", stats=stats)),
                ],
                require_token="secret-ci-token",
            )
            server, base_url = _start_mock_server(state)
            try:
                env = {
                    **os.environ,
                    "LIQUID_REGRESSION_API_TOKEN": "secret-ci-token",
                    "GITHUB_STEP_SUMMARY": str(summary_path),
                }
                proc = subprocess.run(
                    [
                        sys.executable,
                        str(PR_CHECK_PATH),
                        "--manifest",
                        str(manifest_path),
                        "--base-sha",
                        base_sha,
                        "--head-sha",
                        head_sha,
                        "--repo",
                        "acme/storefront",
                        "--api-url",
                        base_url,
                        "--web-url",
                        "https://ui.example.com",
                        "--git-dir",
                        str(repo),
                        "--poll-timeout",
                        "5",
                        "--poll-interval",
                        "0.02",
                        "--json-out",
                        str(json_out),
                    ],
                    capture_output=True,
                    text=True,
                    env=env,
                    check=False,
                )
            finally:
                server.shutdown()
                server.server_close()

            self.assertEqual(proc.returncode, 0, f"stderr={proc.stderr}")
            report = json.loads(proc.stdout)
            self.assertEqual(report, json.loads(json_out.read_text(encoding="utf-8")))
            self.assertEqual(report["status"], "no_difference_found")
            self.assertEqual(report["result_url"], "https://ui.example.com/comparisons/11111111-2222-4333-8444-555555555555")

            expected_key = pr_check.compute_idempotency_key("acme/storefront", base_sha, head_sha, manifest_digest)
            post_req = [r for r in state.requests if r["method"] == "POST"][0]
            self.assertEqual(post_req["headers"].get("idempotency-key"), expected_key)
            self.assertEqual(post_req["headers"].get("authorization"), "Bearer secret-ci-token")

            summary = summary_path.read_text(encoding="utf-8")
            self.assertIn("no difference found within this search", summary)
            self.assertIn("https://ui.example.com/comparisons/11111111-2222-4333-8444-555555555555", summary)
            self.assertIn("`search_pairs` | `256`", summary)
            self.assertIn("`seed` | `0`", summary)

    def test_cli_difference_found_and_terminal_failed_exit_1(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            repo = _init_temp_repo(root)
            manifest_path = _write_manifest(root / "comparison-manifest.json")
            summary_path = root / "summary.md"

            sentinel = root / "should_not_exist"
            before_src = f"{{%- comment %}} $(touch {sentinel}) {{%- endcomment -%}}\n" + '<span data-regression-badge="sale">Sale</span>'
            after_src = "<span>No sale</span>"
            base_sha = _commit_file(repo, "snippets/card-product.liquid", before_src, "base")
            head_sha = _commit_file(repo, "snippets/card-product.liquid", after_src, "head")

            stats = {
                "search_pairs": 56,
                "shrink_pairs": 28,
                "parity_rejections": 0,
                "exhausted_by": None,
                "first_difference_ms": 110,
                "elapsed_ms": 120,
            }
            state = _MockApiState(
                post_status=202,
                post_body=_sample_job(status="difference_found", finding=_sample_finding(), stats=stats),
            )
            server, base_url = _start_mock_server(state)
            try:
                proc = subprocess.run(
                    [
                        sys.executable,
                        str(PR_CHECK_PATH),
                        "--manifest",
                        str(manifest_path),
                        "--base-sha",
                        base_sha,
                        "--head-sha",
                        head_sha,
                        "--repo",
                        "acme/storefront",
                        "--api-url",
                        base_url,
                        "--git-dir",
                        str(repo),
                    ],
                    capture_output=True,
                    text=True,
                    env={**os.environ, "GITHUB_STEP_SUMMARY": str(summary_path)},
                    check=False,
                )
            finally:
                server.shutdown()
                server.server_close()

            self.assertEqual(proc.returncode, 1)
            self.assertFalse(sentinel.exists())
            summary = summary_path.read_text(encoding="utf-8")
            self.assertIn("difference_found", summary)
            self.assertIn("structural_change", summary)
            self.assertIn(f"{base_url}/comparisons/11111111-2222-4333-8444-555555555555", summary)
            self.assertIn("`search_pairs` | `56`", summary)
            self.assertIn("`shrink_pairs` | `28`", summary)

            # Terminal job failed -> exit 1
            fail_state = _MockApiState(
                post_status=202,
                post_body=_sample_job(
                    status="failed",
                    stats={"search_pairs": 12, "shrink_pairs": 0, "parity_rejections": 3, "exhausted_by": None, "first_difference_ms": None, "elapsed_ms": 15},
                    error={"code": "reference_mismatch", "message": "Engine divergence", "span": None},
                ),
            )
            server2, base_url2 = _start_mock_server(fail_state)
            try:
                proc2 = subprocess.run(
                    [
                        sys.executable,
                        str(PR_CHECK_PATH),
                        "--manifest",
                        str(manifest_path),
                        "--base-sha",
                        base_sha,
                        "--head-sha",
                        head_sha,
                        "--repo",
                        "acme/storefront",
                        "--api-url",
                        base_url2,
                        "--git-dir",
                        str(repo),
                    ],
                    capture_output=True,
                    text=True,
                    check=False,
                )
            finally:
                server2.shutdown()
                server2.server_close()
            self.assertEqual(proc2.returncode, 1)
            self.assertEqual(json.loads(proc2.stdout)["status"], "failed")

    def test_untrusted_fork_suppresses_token_in_public_and_token_gated_modes(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            repo = _init_temp_repo(root)
            manifest_path = _write_manifest(root / "comparison-manifest.json")
            base_sha = _commit_file(repo, "snippets/card-product.liquid", "<span>A</span>", "base")
            head_sha = _commit_file(repo, "snippets/card-product.liquid", "<span>B</span>", "head")

            stats = {
                "search_pairs": 10,
                "shrink_pairs": 0,
                "parity_rejections": 0,
                "exhausted_by": "pair_limit",
                "first_difference_ms": None,
                "elapsed_ms": 5,
            }

            # Case 1: --is-fork against public API (no token required) -> suppresses token and runs normally
            pub_state = _MockApiState(
                post_status=202,
                post_body=_sample_job(status="no_difference_found", stats=stats),
                require_token=None,
            )
            srv1, url1 = _start_mock_server(pub_state)
            try:
                p1 = subprocess.run(
                    [
                        sys.executable,
                        str(PR_CHECK_PATH),
                        "--manifest",
                        str(manifest_path),
                        "--base-sha",
                        base_sha,
                        "--head-sha",
                        head_sha,
                        "--repo",
                        "acme/storefront",
                        "--api-url",
                        url1,
                        "--git-dir",
                        str(repo),
                        "--is-fork",
                    ],
                    capture_output=True,
                    text=True,
                    env={**os.environ, "LIQUID_REGRESSION_API_TOKEN": "top-secret-token"},
                    check=False,
                )
            finally:
                srv1.shutdown()
                srv1.server_close()

            self.assertEqual(p1.returncode, 0, p1.stderr)
            self.assertNotIn("authorization", pub_state.requests[0]["headers"])

            # Case 2: GITHUB_EVENT_HEAD_FORK=true against token-gated API -> skips cleanly with exit 0 and never sends token
            gated_state = _MockApiState(require_token="top-secret-token")
            srv2, url2 = _start_mock_server(gated_state)
            summary_path = root / "fork_summary.md"
            try:
                p2 = subprocess.run(
                    [
                        sys.executable,
                        str(PR_CHECK_PATH),
                        "--manifest",
                        str(manifest_path),
                        "--base-sha",
                        base_sha,
                        "--head-sha",
                        head_sha,
                        "--repo",
                        "acme/storefront",
                        "--api-url",
                        url2,
                        "--git-dir",
                        str(repo),
                    ],
                    capture_output=True,
                    text=True,
                    env={
                        **os.environ,
                        "LIQUID_REGRESSION_API_TOKEN": "top-secret-token",
                        "GITHUB_EVENT_HEAD_FORK": "true",
                        "GITHUB_STEP_SUMMARY": str(summary_path),
                    },
                    check=False,
                )
            finally:
                srv2.shutdown()
                srv2.server_close()

            self.assertEqual(p2.returncode, 0, p2.stderr)
            self.assertNotIn("authorization", gated_state.requests[0]["headers"])
            self.assertEqual(json.loads(p2.stdout)["status"], "skipped_untrusted_fork")
            self.assertIn("skipped_untrusted_fork", summary_path.read_text(encoding="utf-8"))

    def test_poll_timeout_http_error_and_missing_blob_exit_2(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            repo = _init_temp_repo(root)
            manifest_path = _write_manifest(root / "comparison-manifest.json")
            base_sha = _commit_file(repo, "snippets/card-product.liquid", "<span>A</span>", "base")
            head_sha = _commit_file(repo, "snippets/card-product.liquid", "<span>B</span>", "head")

            # Poll timeout
            timeout_state = _MockApiState(
                post_status=202,
                post_body=_sample_job(status="queued"),
                get_sequence=[(200, _sample_job(status="running"))],
            )
            srv, url = _start_mock_server(timeout_state)
            summary_path = root / "timeout_summary.md"
            try:
                p_timeout = subprocess.run(
                    [
                        sys.executable,
                        str(PR_CHECK_PATH),
                        "--manifest",
                        str(manifest_path),
                        "--base-sha",
                        base_sha,
                        "--head-sha",
                        head_sha,
                        "--repo",
                        "acme/storefront",
                        "--api-url",
                        url,
                        "--git-dir",
                        str(repo),
                        "--poll-timeout",
                        "0.15",
                        "--poll-interval",
                        "0.04",
                    ],
                    capture_output=True,
                    text=True,
                    env={**os.environ, "GITHUB_STEP_SUMMARY": str(summary_path)},
                    check=False,
                )
            finally:
                srv.shutdown()
                srv.server_close()

            self.assertEqual(p_timeout.returncode, 2)
            timeout_report = json.loads(p_timeout.stdout)
            self.assertEqual(timeout_report["error"]["code"], "poll_timeout")
            self.assertIn("poll_timeout", summary_path.read_text(encoding="utf-8"))

            # HTTP 500 error
            err_state = _MockApiState(
                post_status=500,
                post_body={"error": {"code": "internal_error", "message": "boom", "span": None}},
            )
            srv2, url2 = _start_mock_server(err_state)
            try:
                p_http = subprocess.run(
                    [
                        sys.executable,
                        str(PR_CHECK_PATH),
                        "--manifest",
                        str(manifest_path),
                        "--base-sha",
                        base_sha,
                        "--head-sha",
                        head_sha,
                        "--repo",
                        "acme/storefront",
                        "--api-url",
                        url2,
                        "--git-dir",
                        str(repo),
                    ],
                    capture_output=True,
                    text=True,
                    check=False,
                )
            finally:
                srv2.shutdown()
                srv2.server_close()
            self.assertEqual(p_http.returncode, 2)
            self.assertEqual(json.loads(p_http.stdout)["error"]["code"], "internal_error")

            # Missing blob via CLI subprocess -> exit 2 + summary written
            _git(repo, "rm", "snippets/card-product.liquid")
            _git(repo, "commit", "-m", "delete")
            del_sha = _git(repo, "rev-parse", "HEAD")
            miss_summary = root / "miss_summary.md"
            p_miss = subprocess.run(
                [
                    sys.executable,
                    str(PR_CHECK_PATH),
                    "--manifest",
                    str(manifest_path),
                    "--base-sha",
                    base_sha,
                    "--head-sha",
                    del_sha,
                    "--repo",
                    "acme/storefront",
                    "--api-url",
                    "http://127.0.0.1:9",
                    "--git-dir",
                    str(repo),
                ],
                capture_output=True,
                text=True,
                env={**os.environ, "GITHUB_STEP_SUMMARY": str(miss_summary)},
                check=False,
            )
            self.assertEqual(p_miss.returncode, 2)
            self.assertEqual(json.loads(p_miss.stdout)["error"]["code"], "missing_blob")
            self.assertIn("missing_blob", miss_summary.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()

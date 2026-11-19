"""Persistent JSON Lines client for the Ruby reference/custom render worker."""

from __future__ import annotations

import json
import os
import re
import selectors
import shutil
import signal
import subprocess
import time
from pathlib import Path
from typing import Any, Sequence

DEFAULT_REQUEST_TIMEOUT_S = 5.0
DEFAULT_JOB_DEADLINE_S = 90.0
DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024
DEFAULT_QUIT_TIMEOUT_S = 1.0
MAX_STDERR_CAPTURE_BYTES = 65_536

_SHA256_HEX_RE = re.compile(r"^[0-9a-f]{64}$")

_SPAN_KEYS = frozenset({"start_byte", "end_byte", "line", "column"})
_DIAGNOSTIC_KEYS = frozenset({"code", "message", "span"})
_RENDER_RESULT_KEYS = frozenset({"status", "html", "observed", "events", "error"})
_RENDER_PAIR_RESULT_KEYS = frozenset({"before", "after", "product"})
_COMPILE_RESULT_KEYS = frozenset({"before_sha256", "after_sha256"})
_QUIT_RESULT_KEYS = frozenset({"ok"})
_PROJECTION_KEYS = frozenset(
    {
        "price",
        "price_min",
        "price_max",
        "price_varies",
        "compare_at_price",
        "compare_at_price_min",
        "compare_at_price_max",
        "compare_at_price_varies",
        "available",
    }
)
_TRACE_EVENT_KEYS = frozenset({"seq", "node_id", "scope", "span", "data"})


def _is_strict_int(value: Any) -> bool:
    return type(value) is int


def make_diagnostic(
    code: str,
    message: str,
    span: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build a schema-valid Diagnostic dict."""
    return {
        "code": str(code),
        "message": str(message),
        "span": span,
    }


class WorkerError(Exception):
    """Base error raised by WorkerClient carrying a structured Diagnostic."""

    default_code = "worker_error"

    def __init__(
        self,
        message: str,
        *,
        code: str | None = None,
        span: dict[str, Any] | None = None,
        diagnostic: dict[str, Any] | None = None,
    ) -> None:
        if diagnostic is not None:
            self.diagnostic = {
                "code": str(diagnostic["code"]),
                "message": str(diagnostic["message"]),
                "span": diagnostic.get("span"),
            }
        else:
            self.diagnostic = make_diagnostic(code or self.default_code, message, span)
        self.code = self.diagnostic["code"]
        self.span = self.diagnostic["span"]
        super().__init__(self.diagnostic["message"])


class WorkerProtocolError(WorkerError):
    """Raised when the worker violates the JSONL framing or contract."""

    default_code = "protocol_error"


class WorkerTimeoutError(WorkerError):
    """Raised when a single JSONL request exceeds the per-request timeout."""

    default_code = "worker_timeout"


class JobDeadlineError(WorkerError):
    """Raised when the overall job deadline watchdog expires."""

    default_code = "job_deadline_exceeded"


class WorkerCompileError(WorkerError):
    """Raised when template compilation or observer validation fails."""

    default_code = "compile_error"


def default_repo_root() -> Path:
    """Return the engine/repository root from LRF_ENGINE_ROOT or inferred from search/worker_client.py."""
    env_root = os.environ.get("LRF_ENGINE_ROOT", "").strip()
    if env_root:
        candidate = Path(env_root)
        if candidate.is_dir():
            return candidate.resolve()
    return Path(__file__).resolve().parent.parent


def resolve_bundle_executable() -> str:
    """Resolve `bundle` from LRF_RUBY_BUNDLE or PATH (ignoring macOS /usr/bin/bundle stub when Homebrew Ruby 3.3 exists)."""
    env_bundle = os.environ.get("LRF_RUBY_BUNDLE", "").strip()
    if env_bundle:
        if os.path.isfile(env_bundle) and os.access(env_bundle, os.X_OK):
            return env_bundle
        found_override = shutil.which(env_bundle)
        if found_override:
            return found_override
        raise WorkerProtocolError(
            f"LRF_RUBY_BUNDLE={env_bundle!r} is not an executable file or command on PATH",
            code="worker_launch_error",
        )

    homebrew_bundle = "/opt/homebrew/opt/ruby@3.3/bin/bundle"
    found = shutil.which("bundle")
    if found:
        if found != "/usr/bin/bundle" or not (
            os.path.isfile(homebrew_bundle) and os.access(homebrew_bundle, os.X_OK)
        ):
            return found

    if os.path.isfile(homebrew_bundle) and os.access(homebrew_bundle, os.X_OK):
        return homebrew_bundle

    raise WorkerProtocolError(
        "Could not locate 'bundle' executable on PATH or at /opt/homebrew/opt/ruby@3.3/bin/bundle",
        code="worker_launch_error",
    )


def _validate_span(span: Any, context: str) -> None:
    if span is None:
        return
    if not isinstance(span, dict) or frozenset(span.keys()) != _SPAN_KEYS:
        raise WorkerProtocolError(f"{context}.span must be null or a valid Span object")
    if (
        not _is_strict_int(span["start_byte"])
        or span["start_byte"] < 0
        or not _is_strict_int(span["end_byte"])
        or span["end_byte"] < 0
        or not _is_strict_int(span["line"])
        or span["line"] < 1
        or not _is_strict_int(span["column"])
        or span["column"] < 1
    ):
        raise WorkerProtocolError(f"{context}.span has out-of-range fields")


def _validate_diagnostic(diag: Any, context: str) -> dict[str, Any]:
    if not isinstance(diag, dict) or frozenset(diag.keys()) != _DIAGNOSTIC_KEYS:
        raise WorkerProtocolError(f"{context} must be a Diagnostic object")
    if not isinstance(diag["code"], str) or not isinstance(diag["message"], str):
        raise WorkerProtocolError(f"{context}.code and message must be strings")
    _validate_span(diag["span"], context)
    return diag


def _validate_render_result(result: Any, context: str) -> None:
    if not isinstance(result, dict) or frozenset(result.keys()) != _RENDER_RESULT_KEYS:
        raise WorkerProtocolError(f"{context} must be a valid RenderResult object")

    status = result["status"]
    if status not in ("ok", "error"):
        raise WorkerProtocolError(f"{context}.status must be 'ok' or 'error'")

    events = result["events"]
    if not isinstance(events, list):
        raise WorkerProtocolError(f"{context}.events must be an array")
    for idx, event in enumerate(events):
        if not isinstance(event, dict) or frozenset(event.keys()) != _TRACE_EVENT_KEYS:
            raise WorkerProtocolError(f"{context}.events[{idx}] is not a valid TraceEvent")

    if status == "ok":
        if not isinstance(result["html"], str):
            raise WorkerProtocolError(f"{context}.html must be a string when status is 'ok'")
        if type(result["observed"]) is not bool:
            raise WorkerProtocolError(f"{context}.observed must be a boolean when status is 'ok'")
        if result["error"] is not None:
            raise WorkerProtocolError(f"{context}.error must be null when status is 'ok'")
    else:
        if result["html"] is not None or result["observed"] is not None:
            raise WorkerProtocolError(f"{context}.html and observed must be null when status is 'error'")
        _validate_diagnostic(result["error"], f"{context}.error")


def _validate_projection(product: Any) -> None:
    if not isinstance(product, dict) or frozenset(product.keys()) != _PROJECTION_KEYS:
        raise WorkerProtocolError("render_pair result.product must be a valid Projection object")

    for int_field in ("price", "price_min", "price_max"):
        val = product[int_field]
        if not _is_strict_int(val) or val < 0 or val > 10_000_000:
            raise WorkerProtocolError(f"product.{int_field} must be an integer in 0..10000000")

    for opt_int_field in ("compare_at_price", "compare_at_price_min", "compare_at_price_max"):
        val = product[opt_int_field]
        if val is not None and (not _is_strict_int(val) or val < 0 or val > 10_000_000):
            raise WorkerProtocolError(f"product.{opt_int_field} must be null or integer in 0..10000000")

    for bool_field in ("price_varies", "compare_at_price_varies", "available"):
        if type(product[bool_field]) is not bool:
            raise WorkerProtocolError(f"product.{bool_field} must be a boolean")


class WorkerClient:
    """Manages one persistent JSONL render worker subprocess with strict timeouts and reaping."""

    def __init__(
        self,
        *,
        command: Sequence[str] | None = None,
        cwd: str | Path | None = None,
        request_timeout_s: float = DEFAULT_REQUEST_TIMEOUT_S,
        job_deadline_s: float | None = DEFAULT_JOB_DEADLINE_S,
        max_response_bytes: int = DEFAULT_MAX_RESPONSE_BYTES,
        quit_timeout_s: float = DEFAULT_QUIT_TIMEOUT_S,
        env: dict[str, str] | None = None,
        benchmark: bool = False,
    ) -> None:
        if request_timeout_s <= 0:
            raise ValueError("request_timeout_s must be positive")
        if job_deadline_s is not None and job_deadline_s <= 0:
            raise ValueError("job_deadline_s must be positive or None")
        if max_response_bytes <= 0:
            raise ValueError("max_response_bytes must be positive")
        if quit_timeout_s <= 0:
            raise ValueError("quit_timeout_s must be positive")

        self._command = tuple(command) if command is not None else None
        self._cwd = Path(cwd) if cwd is not None else default_repo_root()
        self._request_timeout_s = float(request_timeout_s)
        self._job_deadline_s = float(job_deadline_s) if job_deadline_s is not None else None
        self._max_response_bytes = int(max_response_bytes)
        self._quit_timeout_s = float(quit_timeout_s)
        self._env = dict(env) if env is not None else None
        self._benchmark = bool(benchmark)

        self._proc: subprocess.Popen[bytes] | None = None
        self._read_buf = bytearray()
        self._stderr_buf = bytearray()
        self._next_request_num = 0
        self._job_deadline: float | None = None
        self._quit_sent = False
        self._closed = False
        self._broken = False

    def __enter__(self) -> WorkerClient:
        self.start()
        return self

    def __exit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
        self.close()

    @property
    def pid(self) -> int | None:
        """Return the active subprocess PID if running."""
        return self._proc.pid if self._proc is not None else None

    @property
    def job_deadline_monotonic(self) -> float | None:
        """Return the monotonic deadline timestamp once started."""
        return self._job_deadline

    def start(self) -> WorkerClient:
        """Launch the persistent worker subprocess in its own process group."""
        if self._proc is not None:
            return self
        if self._closed:
            raise WorkerProtocolError("Cannot start a WorkerClient that has already been closed")

        child_env = dict(self._env) if self._env is not None else None
        if self._command is not None:
            cmd = list(self._command)
        else:
            bundle_exe = resolve_bundle_executable()
            worker_path = self._cwd / "reference" / "bin" / "worker"
            if not worker_path.is_file() and (self._cwd.parent / "reference" / "bin" / "worker").is_file():
                worker_arg = str((self._cwd.parent / "reference" / "bin" / "worker").resolve())
            else:
                worker_arg = "reference/bin/worker"
            cmd = [bundle_exe, "exec", "ruby", worker_arg]
            if self._benchmark:
                cmd.append("--benchmark")

            base_env = dict(os.environ) if child_env is None else child_env
            bundle_dir = os.path.dirname(bundle_exe)
            if bundle_dir:
                existing_path = base_env.get("PATH", "")
                path_parts = existing_path.split(os.pathsep) if existing_path else []
                if bundle_dir not in path_parts:
                    base_env["PATH"] = f"{bundle_dir}{os.pathsep}{existing_path}" if existing_path else bundle_dir

            if not base_env.get("BUNDLE_GEMFILE"):
                engine_gemfile = self._cwd / "engine" / "Gemfile"
                engine_vendor = self._cwd / "engine" / "vendor" / "bundle"
                cwd_gemfile = self._cwd / "Gemfile"
                cwd_vendor = self._cwd / "vendor" / "bundle"
                if engine_gemfile.is_file() and engine_vendor.is_dir():
                    base_env["BUNDLE_GEMFILE"] = str(engine_gemfile)
                    if not base_env.get("BUNDLE_PATH"):
                        base_env["BUNDLE_PATH"] = str(engine_vendor)
                    engine_bundle_cfg = self._cwd / "engine" / ".bundle"
                    if not base_env.get("BUNDLE_APP_CONFIG") and engine_bundle_cfg.is_dir():
                        base_env["BUNDLE_APP_CONFIG"] = str(engine_bundle_cfg)
                elif cwd_gemfile.is_file():
                    base_env["BUNDLE_GEMFILE"] = str(cwd_gemfile)
                    if not base_env.get("BUNDLE_PATH") and cwd_vendor.is_dir():
                        base_env["BUNDLE_PATH"] = str(cwd_vendor)
                    cwd_bundle_cfg = self._cwd / ".bundle"
                    if not base_env.get("BUNDLE_APP_CONFIG") and cwd_bundle_cfg.is_dir():
                        base_env["BUNDLE_APP_CONFIG"] = str(cwd_bundle_cfg)

            child_env = base_env

        try:
            proc = subprocess.Popen(
                cmd,
                cwd=str(self._cwd),
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                bufsize=0,
                start_new_session=True,
                env=child_env,
            )
        except OSError as exc:
            raise WorkerProtocolError(
                f"Failed to launch worker process {cmd!r}: {exc}",
                code="worker_launch_error",
            ) from exc

        if proc.stdin is None or proc.stdout is None or proc.stderr is None:
            self._proc = proc
            self._reap_process_group()
            raise WorkerProtocolError("Worker subprocess pipes were not created", code="worker_launch_error")

        os.set_blocking(proc.stdin.fileno(), False)
        os.set_blocking(proc.stdout.fileno(), False)
        os.set_blocking(proc.stderr.fileno(), False)

        self._proc = proc
        self._read_buf = bytearray()
        self._stderr_buf = bytearray()
        self._quit_sent = False
        self._broken = False
        if self._job_deadline_s is not None:
            self._job_deadline = time.monotonic() + self._job_deadline_s
        return self

    def compile(
        self,
        before: str,
        after: str,
        observer: str = "sale_badge",
        *,
        benchmark: bool = False,
        selector: str | None = None,
        fixed_context: dict[str, Any] | None = None,
    ) -> dict[str, str]:
        """Compile both snippets once in the persistent worker."""
        req_body: dict[str, Any] = {
            "op": "compile",
            "before": before,
            "after": after,
            "observer": observer,
        }
        if benchmark:
            req_body["benchmark"] = True
            if selector is not None:
                req_body["selector"] = selector
            if fixed_context is not None:
                req_body["fixed_context"] = fixed_context

        resp_kind, payload = self._rpc(req_body)
        if resp_kind == "error":
            raise WorkerCompileError(payload["message"], diagnostic=payload)

        if not isinstance(payload, dict) or frozenset(payload.keys()) != _COMPILE_RESULT_KEYS:
            self._reap_process_group()
            raise WorkerProtocolError("Invalid compile result structure from worker")

        before_sha = payload["before_sha256"]
        after_sha = payload["after_sha256"]
        if (
            not isinstance(before_sha, str)
            or not _SHA256_HEX_RE.match(before_sha)
            or not isinstance(after_sha, str)
            or not _SHA256_HEX_RE.match(after_sha)
        ):
            self._reap_process_group()
            raise WorkerProtocolError("Worker returned invalid SHA-256 hex digest in compile result")

        return {"before_sha256": before_sha, "after_sha256": after_sha}

    def render_pair(
        self,
        fixture: dict[str, Any],
        engine: str,
        trace: bool = False,
    ) -> dict[str, Any]:
        """Render the compiled snippet pair against one product fixture."""
        resp_kind, payload = self._rpc(
            {
                "op": "render_pair",
                "fixture": fixture,
                "engine": engine,
                "trace": bool(trace),
            }
        )
        if resp_kind == "error":
            raise WorkerProtocolError(payload["message"], diagnostic=payload)

        if not isinstance(payload, dict) or frozenset(payload.keys()) != _RENDER_PAIR_RESULT_KEYS:
            self._reap_process_group()
            raise WorkerProtocolError("Invalid render_pair result structure from worker")

        _validate_render_result(payload["before"], "render_pair.before")
        _validate_render_result(payload["after"], "render_pair.after")
        _validate_projection(payload["product"])
        return payload

    def quit(self) -> dict[str, Any]:
        """Send `quit` and wait briefly for clean worker termination."""
        if self._quit_sent:
            return {"ok": True}

        resp_kind, payload = self._rpc({"op": "quit"}, timeout_s=min(self._quit_timeout_s, self._request_timeout_s))
        if resp_kind == "error":
            self._reap_process_group()
            raise WorkerProtocolError(payload["message"], diagnostic=payload)

        if not isinstance(payload, dict) or frozenset(payload.keys()) != _QUIT_RESULT_KEYS or payload["ok"] is not True:
            self._reap_process_group()
            raise WorkerProtocolError("Invalid quit result from worker")

        self._quit_sent = True
        if self._proc is not None:
            try:
                self._proc.wait(timeout=self._quit_timeout_s)
            except subprocess.TimeoutExpired:
                self._reap_process_group()
                raise WorkerTimeoutError("Worker failed to exit promptly after quit")
            finally:
                self._cleanup_closed_proc()
        return payload

    def close(self) -> None:
        """Close the worker cleanly if healthy, or reap its process group on failure."""
        if self._closed:
            return

        try:
            if self._proc is not None and not self._broken and not self._quit_sent:
                if self._proc.poll() is None:
                    try:
                        self.quit()
                        return
                    except WorkerError:
                        pass
            self._reap_process_group()
        finally:
            self._closed = True

    def _next_id(self) -> str:
        self._next_request_num += 1
        return f"req-{self._next_request_num}"

    def _rpc(
        self,
        body: dict[str, Any],
        *,
        timeout_s: float | None = None,
    ) -> tuple[str, Any]:
        self.start()
        assert self._proc is not None

        if self._broken or self._proc.poll() is not None:
            self._reap_process_group()
            raise WorkerProtocolError("Worker process exited unexpectedly before request")

        req_id = self._next_id()
        request_payload = {"id": req_id, **body}
        encoded = (
            json.dumps(request_payload, separators=(",", ":"), ensure_ascii=False, allow_nan=False) + "\n"
        ).encode("utf-8")

        line_bytes = self._exchange_line(encoded, timeout_s or self._request_timeout_s)

        try:
            line_text = line_bytes.decode("utf-8")
        except UnicodeDecodeError as exc:
            self._reap_process_group()
            raise WorkerProtocolError(f"Worker emitted invalid UTF-8 bytes: {exc}") from exc

        try:
            resp = json.loads(line_text)
        except json.JSONDecodeError as exc:
            self._reap_process_group()
            raise WorkerProtocolError(f"Worker emitted invalid JSON: {exc}") from exc

        if not isinstance(resp, dict):
            self._reap_process_group()
            raise WorkerProtocolError("Worker JSONL response must be a JSON object")

        resp_id = resp.get("id")
        if not isinstance(resp_id, str) or not resp_id:
            self._reap_process_group()
            raise WorkerProtocolError("Worker JSONL response missing valid string 'id'")

        if resp_id != req_id:
            if "error" in resp and isinstance(resp["error"], dict):
                err = resp["error"]
                self._reap_process_group()
                raise WorkerProtocolError(
                    f"Worker response id mismatch (expected {req_id!r}, got {resp_id!r}): "
                    f"[{err.get('code')}] {err.get('message')}",
                )
            self._reap_process_group()
            raise WorkerProtocolError(f"Worker response id mismatch: expected {req_id!r}, got {resp_id!r}")

        keys = frozenset(resp.keys())
        if keys == frozenset({"id", "result"}):
            return ("result", resp["result"])
        if keys == frozenset({"id", "error"}):
            try:
                diag = _validate_diagnostic(resp["error"], "response.error")
            except WorkerProtocolError:
                self._reap_process_group()
                raise
            return ("error", diag)

        self._reap_process_group()
        raise WorkerProtocolError(f"Worker response has invalid keys: {sorted(resp.keys())}")

    def _exchange_line(self, payload_bytes: bytes, request_timeout_s: float) -> bytes:
        proc = self._proc
        assert proc is not None and proc.stdin is not None and proc.stdout is not None and proc.stderr is not None

        if self._read_buf:
            self._reap_process_group()
            raise WorkerProtocolError("Worker emitted unsolicited bytes on stdout before request")

        now = time.monotonic()
        if self._job_deadline is not None and now >= self._job_deadline:
            self._reap_process_group()
            raise JobDeadlineError(f"Job deadline of {self._job_deadline_s:.1f}s exceeded")

        req_deadline = now + request_timeout_s
        deadline = req_deadline if self._job_deadline is None else min(req_deadline, self._job_deadline)

        stdin_fd = proc.stdin.fileno()
        stdout_fd = proc.stdout.fileno()
        stderr_fd = proc.stderr.fileno()

        write_offset = 0
        pending_line: bytes | None = None
        stdin_registered = True
        stderr_open = True

        selector = selectors.DefaultSelector()
        try:
            selector.register(stdin_fd, selectors.EVENT_WRITE, data="stdin")
            selector.register(stdout_fd, selectors.EVENT_READ, data="stdout")
            selector.register(stderr_fd, selectors.EVENT_READ, data="stderr")

            while True:
                if pending_line is not None and not stdin_registered:
                    return pending_line

                now = time.monotonic()
                remaining = deadline - now
                if remaining <= 0:
                    self._reap_process_group()
                    if self._job_deadline is not None and now >= self._job_deadline:
                        raise JobDeadlineError(f"Job deadline of {self._job_deadline_s:.1f}s exceeded")
                    raise WorkerTimeoutError(f"Worker request timed out after {request_timeout_s:.2f}s")

                events = selector.select(timeout=remaining)
                if not events:
                    now = time.monotonic()
                    self._reap_process_group()
                    if self._job_deadline is not None and now >= self._job_deadline:
                        raise JobDeadlineError(f"Job deadline of {self._job_deadline_s:.1f}s exceeded")
                    raise WorkerTimeoutError(f"Worker request timed out after {request_timeout_s:.2f}s")

                for key, _ in events:
                    if key.data == "stdin":
                        try:
                            written = os.write(stdin_fd, memoryview(payload_bytes)[write_offset:])
                        except BlockingIOError:
                            continue
                        except (BrokenPipeError, OSError) as exc:
                            if pending_line is not None:
                                selector.unregister(stdin_fd)
                                stdin_registered = False
                                continue
                            self._reap_process_group()
                            raise WorkerProtocolError(f"Failed writing to worker stdin: {exc}") from exc

                        write_offset += written
                        if write_offset >= len(payload_bytes):
                            selector.unregister(stdin_fd)
                            stdin_registered = False

                    elif key.data == "stderr":
                        try:
                            chunk = os.read(stderr_fd, 4096)
                        except BlockingIOError:
                            continue
                        except OSError:
                            selector.unregister(stderr_fd)
                            stderr_open = False
                            continue

                        if not chunk:
                            selector.unregister(stderr_fd)
                            stderr_open = False
                        elif len(self._stderr_buf) < MAX_STDERR_CAPTURE_BYTES:
                            take = MAX_STDERR_CAPTURE_BYTES - len(self._stderr_buf)
                            self._stderr_buf.extend(chunk[:take])

                    elif key.data == "stdout":
                        try:
                            chunk = os.read(stdout_fd, 65536)
                        except BlockingIOError:
                            continue
                        except OSError as exc:
                            self._reap_process_group()
                            raise WorkerProtocolError(f"Failed reading worker stdout: {exc}") from exc

                        if not chunk:
                            if pending_line is not None and not stdin_registered:
                                return pending_line
                            stderr_tail = self._stderr_tail()
                            self._reap_process_group()
                            msg = "Worker closed stdout unexpectedly before completing response"
                            if stderr_tail:
                                msg = f"{msg} (stderr: {stderr_tail})"
                            raise WorkerProtocolError(msg)

                        self._read_buf.extend(chunk)
                        if pending_line is None:
                            nl_idx = self._read_buf.find(b"\n")
                            if nl_idx == -1:
                                if len(self._read_buf) > self._max_response_bytes + 1 or (
                                    len(self._read_buf) == self._max_response_bytes + 1
                                    and self._read_buf[-1:] != b"\r"
                                ):
                                    self._reap_process_group()
                                    raise WorkerProtocolError(
                                        f"Worker response frame exceeded {self._max_response_bytes} byte limit",
                                        code="response_too_large",
                                    )
                            else:
                                line = bytes(self._read_buf[:nl_idx])
                                del self._read_buf[: nl_idx + 1]
                                if line.endswith(b"\r"):
                                    line = line[:-1]
                                if len(line) > self._max_response_bytes:
                                    self._reap_process_group()
                                    raise WorkerProtocolError(
                                        f"Worker response frame ({len(line)} bytes) exceeded "
                                        f"{self._max_response_bytes} byte limit",
                                        code="response_too_large",
                                    )
                                pending_line = line
                                if not stdin_registered:
                                    return pending_line

                if not stderr_open and pending_line is not None and not stdin_registered:
                    return pending_line
        finally:
            selector.close()

    def _stderr_tail(self) -> str:
        if not self._stderr_buf:
            return ""
        return self._stderr_buf.decode("utf-8", errors="replace").strip()[-512:]

    def _cleanup_closed_proc(self) -> None:
        proc = self._proc
        if proc is None:
            return
        self._proc = None
        for stream in (proc.stdin, proc.stdout, proc.stderr):
            if stream is not None:
                try:
                    stream.close()
                except OSError:
                    pass

    def _reap_process_group(self) -> None:
        proc = self._proc
        if proc is None:
            return
        self._broken = True
        self._proc = None

        for stream in (proc.stdin, proc.stdout, proc.stderr):
            if stream is not None:
                try:
                    stream.close()
                except OSError:
                    pass

        try:
            pgid = os.getpgid(proc.pid)
        except OSError:
            pgid = proc.pid

        if proc.poll() is None:
            try:
                os.killpg(pgid, signal.SIGTERM)
            except OSError:
                pass
            try:
                proc.wait(timeout=0.2)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(pgid, signal.SIGKILL)
                except OSError:
                    pass
                try:
                    proc.wait(timeout=2.0)
                except subprocess.TimeoutExpired:
                    pass
        else:
            # Reap any lingering descendant in the session group and collect exit status.
            try:
                os.killpg(pgid, signal.SIGKILL)
            except OSError:
                pass
            try:
                proc.wait(timeout=0.5)
            except subprocess.TimeoutExpired:
                pass

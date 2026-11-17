"""Deterministic fresh-process ReplayBundle verification and reproduction."""

from __future__ import annotations

import hashlib
import json
import re
import time
from pathlib import Path
from typing import Any, Callable

from .engine import (
    InvalidCompareRequestError,
    RuntimeVersions,
    resolve_runtime_versions,
    validate_compare_request,
)
from .explain import build_explanation
from .shrinker import validate_fixture_dict
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

_REPLAY_BUNDLE_KEYS = frozenset(
    {
        "request",
        "fixture",
        "before_sha256",
        "after_sha256",
        "interpreter_version",
        "liquid_version",
        "projection_version",
    }
)
_SHA256_HEX_RE = re.compile(r"^[0-9a-f]{64}$")


class ReplayValidationError(Exception):
    """Raised when a ReplayBundle fails structural, hash, version, or parity checks."""

    def __init__(self, code: str, message: str, *, span: dict[str, Any] | None = None) -> None:
        self.diagnostic = make_diagnostic(code, message, span=span)
        super().__init__(message)


def _elapsed_ms(start_monotonic: float) -> int:
    return max(0, int((time.monotonic() - start_monotonic) * 1000))


def validate_fixture(fixture: Any) -> dict[str, Any]:
    """Validate a Fixture contract object, raising ReplayValidationError on failure."""
    try:
        return validate_fixture_dict(fixture)
    except ValueError as exc:
        raise ReplayValidationError("invalid_fixture", str(exc)) from exc


def validate_replay_bundle(
    bundle: Any,
    *,
    versions: RuntimeVersions,
) -> dict[str, Any]:
    """Validate ReplayBundle schema fields, exact source SHA-256 digests, and runtime versions."""
    if not isinstance(bundle, dict) or frozenset(bundle.keys()) != _REPLAY_BUNDLE_KEYS:
        raise ReplayValidationError(
            "invalid_replay_bundle",
            "ReplayBundle must be an object with exact keys request, fixture, before_sha256, "
            "after_sha256, interpreter_version, liquid_version, projection_version",
        )

    try:
        validated_req = validate_compare_request(bundle["request"])
    except InvalidCompareRequestError as exc:
        raise ReplayValidationError(exc.diagnostic["code"], exc.diagnostic["message"]) from exc

    validate_fixture(bundle["fixture"])

    for key in ("before_sha256", "after_sha256"):
        digest = bundle[key]
        if not isinstance(digest, str) or not _SHA256_HEX_RE.match(digest):
            raise ReplayValidationError(
                "invalid_replay_bundle",
                f"ReplayBundle.{key} must be a 64-char lowercase hex SHA-256",
            )

    for key in ("interpreter_version", "liquid_version", "projection_version"):
        ver = bundle[key]
        if not isinstance(ver, str) or not ver:
            raise ReplayValidationError("invalid_replay_bundle", f"ReplayBundle.{key} must be a non-empty string")

    actual_before_sha = hashlib.sha256(validated_req["before"]["source"].encode("utf-8")).hexdigest()
    actual_after_sha = hashlib.sha256(validated_req["after"]["source"].encode("utf-8")).hexdigest()
    if bundle["before_sha256"] != actual_before_sha:
        raise ReplayValidationError(
            "replay_hash_mismatch",
            f"ReplayBundle.before_sha256 mismatch: bundle={bundle['before_sha256']}, actual={actual_before_sha}",
        )
    if bundle["after_sha256"] != actual_after_sha:
        raise ReplayValidationError(
            "replay_hash_mismatch",
            f"ReplayBundle.after_sha256 mismatch: bundle={bundle['after_sha256']}, actual={actual_after_sha}",
        )

    if bundle["interpreter_version"] != versions.interpreter_version:
        raise ReplayValidationError(
            "replay_version_mismatch",
            f"interpreter_version mismatch: bundle={bundle['interpreter_version']!r}, "
            f"runtime={versions.interpreter_version!r}",
        )
    if bundle["liquid_version"] != versions.liquid_version:
        raise ReplayValidationError(
            "replay_version_mismatch",
            f"liquid_version mismatch: bundle={bundle['liquid_version']!r}, "
            f"runtime={versions.liquid_version!r}",
        )
    if bundle["projection_version"] != versions.projection_version:
        raise ReplayValidationError(
            "replay_version_mismatch",
            f"projection_version mismatch: bundle={bundle['projection_version']!r}, "
            f"runtime={versions.projection_version!r}",
        )

    return bundle


def load_replay_bundle_file(bundle_path: str | Path) -> dict[str, Any]:
    """Read and parse a UTF-8 ReplayBundle JSON file from disk."""
    path = Path(bundle_path)
    try:
        raw_bytes = path.read_bytes()
    except OSError as exc:
        raise ReplayValidationError(
            "bundle_read_error",
            f"Failed reading --bundle file '{bundle_path}': {exc}",
        ) from exc

    try:
        text = raw_bytes.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ReplayValidationError(
            "bundle_read_error",
            f"--bundle file '{bundle_path}' is not valid UTF-8: {exc.reason}",
        ) from exc

    try:
        payload = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ReplayValidationError(
            "bundle_json_error",
            f"--bundle file '{bundle_path}' contains invalid JSON: {exc}",
        ) from exc

    return payload


def _failed_replay_report(
    diagnostic: dict[str, Any],
    *,
    elapsed_ms: int,
    reference_status: str = "not_run",
) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "status": "failed",
        "direction": None,
        "reference_status": reference_status,
        "finding": None,
        "product": None,
        "before": None,
        "after": None,
        "reference": None,
        "explanation": None,
        "replay": None,
        "provenance": None,
        "error": diagnostic,
        "timings": {"elapsed_ms": elapsed_ms},
    }


class ReplayRunner:
    """Executes deterministic fresh-process ReplayBundle verification without search or shrinking."""

    def __init__(
        self,
        *,
        repo_root: Path | None = None,
        versions: RuntimeVersions | None = None,
        worker_factory: Callable[[], Any] | None = None,
        request_timeout_s: float = DEFAULT_REQUEST_TIMEOUT_S,
        job_deadline_s: float = DEFAULT_JOB_DEADLINE_S,
    ) -> None:
        self._repo_root = repo_root if repo_root is not None else default_repo_root()
        self._versions = versions
        self._worker_factory = worker_factory
        self._request_timeout_s = float(request_timeout_s)
        self._job_deadline_s = float(job_deadline_s)

    def _runtime_versions(self) -> RuntimeVersions:
        if self._versions is not None:
            return self._versions
        return resolve_runtime_versions(self._repo_root)

    def replay_file(self, bundle_path: str | Path, *, worker: Any | None = None) -> dict[str, Any]:
        """Load a ReplayBundle JSON file from disk and replay it."""
        start_monotonic = time.monotonic()
        try:
            payload = load_replay_bundle_file(bundle_path)
        except ReplayValidationError as exc:
            return _failed_replay_report(exc.diagnostic, elapsed_ms=_elapsed_ms(start_monotonic))
        return self.replay_bundle(payload, worker=worker, _start_monotonic=start_monotonic)

    def replay_bundle(
        self,
        bundle: Any,
        *,
        worker: Any | None = None,
        _start_monotonic: float | None = None,
    ) -> dict[str, Any]:
        """Reproduce a Finding directly from a validated ReplayBundle without search or shrinking."""
        start_monotonic = _start_monotonic if _start_monotonic is not None else time.monotonic()
        active_versions = self._runtime_versions()

        try:
            valid_bundle = validate_replay_bundle(bundle, versions=active_versions)
        except ReplayValidationError as exc:
            return _failed_replay_report(exc.diagnostic, elapsed_ms=_elapsed_ms(start_monotonic))

        req = valid_bundle["request"]
        before_src = req["before"]["source"]
        after_src = req["after"]["source"]
        observer = req["observer"]
        fixture = valid_bundle["fixture"]

        deadline_monotonic = start_monotonic + self._job_deadline_s

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
            if time.monotonic() >= deadline_monotonic:
                raise JobDeadlineError(f"Job deadline of {self._job_deadline_s:.1f}s exceeded")

            t0 = time.monotonic()
            compile_res = active_worker.compile(before_src, after_src, observer=observer)
            compile_ms = _elapsed_ms(t0)

            if (
                compile_res.get("before_sha256") != valid_bundle["before_sha256"]
                or compile_res.get("after_sha256") != valid_bundle["after_sha256"]
            ):
                raise ReplayValidationError(
                    "replay_hash_mismatch",
                    "Worker compile SHA-256 digest does not match ReplayBundle",
                )

            if time.monotonic() >= deadline_monotonic:
                raise JobDeadlineError(f"Job deadline of {self._job_deadline_s:.1f}s exceeded")

            t1 = time.monotonic()
            custom_res = active_worker.render_pair(fixture, engine="custom", trace=True)
            custom_render_ms = _elapsed_ms(t1)
            custom_before = custom_res["before"]
            custom_after = custom_res["after"]

            if custom_before["status"] != "ok":
                err = custom_before["error"]
                raise ReplayValidationError(err["code"], err["message"], span=err.get("span"))
            if custom_after["status"] != "ok":
                err = custom_after["error"]
                raise ReplayValidationError(err["code"], err["message"], span=err.get("span"))

            if custom_before["observed"] == custom_after["observed"]:
                raise ReplayValidationError(
                    "replay_no_difference",
                    "Replay bundle did not reproduce an observer difference between before and after",
                )

            if time.monotonic() >= deadline_monotonic:
                raise JobDeadlineError(f"Job deadline of {self._job_deadline_s:.1f}s exceeded")

            t2 = time.monotonic()
            ref_res = active_worker.render_pair(fixture, engine="reference", trace=False)
            reference_render_ms = _elapsed_ms(t2)
            ref_before = ref_res["before"]
            ref_after = ref_res["after"]

            if ref_before["status"] != "ok":
                err = ref_before["error"]
                raise ReplayValidationError(
                    "reference_mismatch",
                    f"Reference before render failed: {err['message']}",
                    span=err.get("span"),
                )
            if ref_after["status"] != "ok":
                err = ref_after["error"]
                raise ReplayValidationError(
                    "reference_mismatch",
                    f"Reference after render failed: {err['message']}",
                    span=err.get("span"),
                )

            if ref_before["events"] or ref_after["events"]:
                raise WorkerProtocolError("Reference render unexpectedly emitted trace events")
            if custom_res["product"] != ref_res["product"]:
                raise WorkerProtocolError("Product projection mismatch between custom and reference renders")
            if (
                ref_before["observed"] != custom_before["observed"]
                or ref_after["observed"] != custom_after["observed"]
            ):
                raise ReplayValidationError(
                    "reference_mismatch",
                    "Reference Liquid observation does not match custom engine during replay",
                )

            explanation = build_explanation(
                before_src,
                after_src,
                custom_before,
                custom_after,
                observer=observer,
            )
            direction = "before_only" if custom_before["observed"] else "after_only"
            finding = {
                "product": custom_res["product"],
                "replay": valid_bundle,
                "before": custom_before,
                "after": custom_after,
                "reference": {
                    "before": ref_before,
                    "after": ref_after,
                },
                "explanation": explanation,
            }
            provenance = {
                "before_sha256": valid_bundle["before_sha256"],
                "after_sha256": valid_bundle["after_sha256"],
                "interpreter_version": valid_bundle["interpreter_version"],
                "liquid_version": valid_bundle["liquid_version"],
                "projection_version": valid_bundle["projection_version"],
            }
            return {
                "schema_version": 1,
                "status": "replayed",
                "direction": direction,
                "reference_status": "confirmed",
                "finding": finding,
                "product": finding["product"],
                "before": finding["before"],
                "after": finding["after"],
                "reference": finding["reference"],
                "explanation": finding["explanation"],
                "replay": finding["replay"],
                "provenance": provenance,
                "error": None,
                "timings": {
                    "compile_ms": compile_ms,
                    "custom_render_ms": custom_render_ms,
                    "reference_render_ms": reference_render_ms,
                    "elapsed_ms": _elapsed_ms(start_monotonic),
                },
            }

        except ReplayValidationError as exc:
            ref_status = "mismatch" if exc.diagnostic["code"] == "reference_mismatch" else "not_run"
            return _failed_replay_report(
                exc.diagnostic,
                elapsed_ms=_elapsed_ms(start_monotonic),
                reference_status=ref_status,
            )
        except WorkerError as exc:
            return _failed_replay_report(exc.diagnostic, elapsed_ms=_elapsed_ms(start_monotonic))
        finally:
            if owns_worker:
                try:
                    active_worker.close()
                except Exception:
                    pass

"""Counterexample search, shrink, explanation, and replay package for liquid-regression-finder."""

from __future__ import annotations

from .engine import (
    InvalidCompareRequestError,
    RuntimeVersions,
    SearchEngine,
    build_compare_request,
    resolve_runtime_versions,
    validate_compare_request,
)
from .explain import (
    HtmlTagSpan,
    build_explanation,
    find_sale_badge_opening_tags,
)
from .generator import (
    GENERATOR_VERSION,
    MAX_DUPLICATE_ATTEMPTS,
    CandidateGenerator,
    canonical_json,
    generate_candidates,
)
from .replay import (
    ReplayRunner,
    ReplayValidationError,
    load_replay_bundle_file,
    validate_fixture,
    validate_replay_bundle,
)
from .shrinker import (
    ShrinkResult,
    fixture_measure,
    shrink_confirmed_case,
)
from .worker_client import (
    JobDeadlineError,
    WorkerClient,
    WorkerCompileError,
    WorkerError,
    WorkerProtocolError,
    WorkerTimeoutError,
)

__all__ = [
    "CandidateGenerator",
    "GENERATOR_VERSION",
    "HtmlTagSpan",
    "InvalidCompareRequestError",
    "JobDeadlineError",
    "MAX_DUPLICATE_ATTEMPTS",
    "ReplayRunner",
    "ReplayValidationError",
    "RuntimeVersions",
    "SearchEngine",
    "ShrinkResult",
    "WorkerClient",
    "WorkerCompileError",
    "WorkerError",
    "WorkerProtocolError",
    "WorkerTimeoutError",
    "build_compare_request",
    "build_explanation",
    "canonical_json",
    "find_sale_badge_opening_tags",
    "fixture_measure",
    "generate_candidates",
    "load_replay_bundle_file",
    "resolve_runtime_versions",
    "shrink_confirmed_case",
    "validate_compare_request",
    "validate_fixture",
    "validate_replay_bundle",
]

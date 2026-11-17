"""Ordered counterexample fixture shrinker preserving cross-engine regression parity."""

from __future__ import annotations

import copy
import time
from dataclasses import dataclass
from typing import Any, Callable, Iterator

from .generator import MAX_PRICE_CENTS, MAX_VARIANTS, canonical_json
from .worker_client import JobDeadlineError, WorkerProtocolError

_FIXTURE_KEYS = frozenset({"schema_version", "currency", "variants"})
_VARIANT_KEYS = frozenset({"id", "price", "compare_at_price", "available"})


def _is_strict_int(value: Any) -> bool:
    return type(value) is int


def validate_fixture_dict(fixture: Any) -> dict[str, Any]:
    """Validate that `fixture` satisfies the Fixture contract and unique variant IDs."""
    if not isinstance(fixture, dict) or frozenset(fixture.keys()) != _FIXTURE_KEYS:
        raise ValueError("Fixture must be an object with exact keys schema_version, currency, variants")
    if not _is_strict_int(fixture["schema_version"]) or fixture["schema_version"] != 1:
        raise ValueError("Fixture.schema_version must be integer 1")
    if fixture["currency"] != "USD":
        raise ValueError("Fixture.currency must be 'USD'")

    variants = fixture["variants"]
    if not isinstance(variants, list) or not (1 <= len(variants) <= MAX_VARIANTS):
        raise ValueError(f"Fixture.variants must be an array of 1..{MAX_VARIANTS} variants")

    seen_ids: set[str] = set()
    for idx, variant in enumerate(variants):
        if not isinstance(variant, dict) or frozenset(variant.keys()) != _VARIANT_KEYS:
            raise ValueError(f"Fixture.variants[{idx}] must have keys id, price, compare_at_price, available")
        vid = variant["id"]
        if not isinstance(vid, str) or not (1 <= len(vid) <= 32):
            raise ValueError(f"Fixture.variants[{idx}].id must be a string of length 1..32")
        if vid in seen_ids:
            raise ValueError(f"Duplicate variant id {vid!r} at index {idx}")
        seen_ids.add(vid)

        price = variant["price"]
        if not _is_strict_int(price) or not (0 <= price <= MAX_PRICE_CENTS):
            raise ValueError(f"Fixture.variants[{idx}].price must be an integer in 0..{MAX_PRICE_CENTS}")

        cap = variant["compare_at_price"]
        if cap is not None and (not _is_strict_int(cap) or not (0 <= cap <= MAX_PRICE_CENTS)):
            raise ValueError(
                f"Fixture.variants[{idx}].compare_at_price must be null or integer in 0..{MAX_PRICE_CENTS}"
            )

        if type(variant["available"]) is not bool:
            raise ValueError(f"Fixture.variants[{idx}].available must be a boolean")

    return fixture


def fixture_measure(fixture: dict[str, Any]) -> tuple[int, int, int, int, int]:
    """Compute the strict descending lexicographic size/complexity measure for `fixture`."""
    variants = fixture["variants"]
    non_null_compare_at_count = sum(1 for v in variants if v["compare_at_price"] is not None)
    total_cents = sum(v["price"] + (v["compare_at_price"] or 0) for v in variants)
    true_availability_count = sum(1 for v in variants if v["available"] is True)
    canonical_bytes = len(canonical_json(fixture).encode("utf-8"))
    return (
        len(variants),
        non_null_compare_at_count,
        total_cents,
        true_availability_count,
        canonical_bytes,
    )


def _with_variants(base: dict[str, Any], variants: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "schema_version": base["schema_version"],
        "currency": base["currency"],
        "variants": [dict(v) for v in variants],
    }


def _iter_variant_deletions(fixture: dict[str, Any]) -> Iterator[dict[str, Any]]:
    variants = fixture["variants"]
    n = len(variants)
    if n <= 1:
        return

    # 1a. Ordered chunk deletions: halves first, then prefix/suffix/interior slices from largest chunk down to 2.
    mid = n // 2
    if mid >= 1:
        yield _with_variants(fixture, variants[:mid])
        yield _with_variants(fixture, variants[mid:])
    if n % 2 == 1 and n > 2:
        yield _with_variants(fixture, variants[: mid + 1])
        yield _with_variants(fixture, variants[mid + 1 :])

    for chunk_size in range(n - 1, 1, -1):
        yield _with_variants(fixture, variants[chunk_size:])
        yield _with_variants(fixture, variants[:-chunk_size])
        for start in range(1, n - chunk_size):
            yield _with_variants(fixture, variants[:start] + variants[start + chunk_size :])

    # 1b. Single-variant deletions (preserving original IDs on all surviving variants).
    for idx in range(n):
        yield _with_variants(fixture, variants[:idx] + variants[idx + 1 :])


def _iter_single_field_simplifications(fixture: dict[str, Any]) -> Iterator[dict[str, Any]]:
    variants = fixture["variants"]

    for idx, variant in enumerate(variants):
        price = variant["price"]
        cap = variant["compare_at_price"]

        # compare_at_price simplifications
        if cap is not None:
            cap_targets: list[int | None] = [None]
            if cap > 0:
                cap_targets.append(0)
            cap_targets.append(price)
            if price > 0:
                cap_targets.append(price - 1)
            if price + 1 <= MAX_PRICE_CENTS:
                cap_targets.append(price + 1)
            cap_targets.extend([1, 100, cap // 2])
            if cap > price:
                cap_targets.append(price + (cap - price) // 2)
            for other_idx, other in enumerate(variants):
                if other_idx != idx:
                    cap_targets.append(other["price"])
                    if other["price"] + 1 <= MAX_PRICE_CENTS:
                        cap_targets.append(other["price"] + 1)
                    if other["compare_at_price"] is not None:
                        cap_targets.append(other["compare_at_price"])
                        if other["compare_at_price"] + 1 <= MAX_PRICE_CENTS:
                            cap_targets.append(other["compare_at_price"] + 1)

            for target in cap_targets:
                if target is None or (0 <= target <= MAX_PRICE_CENTS and target != cap):
                    updated = [dict(v) for v in variants]
                    updated[idx]["compare_at_price"] = target
                    yield _with_variants(fixture, updated)

        # price simplifications
        other_vals: list[int] = []
        for other_idx, other in enumerate(variants):
            if other_idx != idx:
                other_vals.append(other["price"])
                if other["price"] + 1 <= MAX_PRICE_CENTS:
                    other_vals.append(other["price"] + 1)
                if other["compare_at_price"] is not None:
                    other_vals.append(other["compare_at_price"])
                    if other["compare_at_price"] + 1 <= MAX_PRICE_CENTS:
                        other_vals.append(other["compare_at_price"] + 1)

        price_targets: list[int] = [0, 1]
        price_targets.extend(sorted(v for v in other_vals if v < 100))
        price_targets.append(100)
        if cap is not None:
            price_targets.append(cap)
            if cap > 0:
                price_targets.append(cap - 1)
            if cap + 1 <= MAX_PRICE_CENTS:
                price_targets.append(cap + 1)
        price_targets.append(price // 2)
        price_targets.extend(v for v in other_vals if v >= 100)

        for target_p in price_targets:
            if 0 <= target_p <= MAX_PRICE_CENTS and target_p != price:
                updated = [dict(v) for v in variants]
                updated[idx]["price"] = target_p
                yield _with_variants(fixture, updated)

        # available simplification
        if variant["available"] is True:
            updated = [dict(v) for v in variants]
            updated[idx]["available"] = False
            yield _with_variants(fixture, updated)


def _iter_paired_simplifications(fixture: dict[str, Any]) -> Iterator[dict[str, Any]]:
    variants = fixture["variants"]

    # 3a. Per-variant paired (price, compare_at_price) simplifications
    for idx, variant in enumerate(variants):
        price = variant["price"]
        cap = variant["compare_at_price"]
        if cap is None:
            continue

        pairs: list[tuple[int, int]] = [(price // 2, cap // 2)]
        deltas = [min(price, cap), price, cap, min(price, cap) // 2, max(price, cap) // 2, 100, 10, 1]
        for delta in deltas:
            if delta > 0:
                pairs.append((max(0, price - delta), max(0, cap - delta)))
        pairs.extend([(0, 0), (0, 1), (1, 0), (1, 2), (100, 200)])

        for new_p, new_cap in pairs:
            if 0 <= new_p <= MAX_PRICE_CENTS and 0 <= new_cap <= MAX_PRICE_CENTS and (new_p != price or new_cap != cap):
                updated = [dict(v) for v in variants]
                updated[idx]["price"] = new_p
                updated[idx]["compare_at_price"] = new_cap
                yield _with_variants(fixture, updated)

    # 3b. Simultaneous scaling and shifting across all variants
    halved = []
    for v in variants:
        nv = dict(v)
        nv["price"] = v["price"] // 2
        if v["compare_at_price"] is not None:
            nv["compare_at_price"] = v["compare_at_price"] // 2
        halved.append(nv)
    yield _with_variants(fixture, halved)

    positives = [v["price"] for v in variants if v["price"] > 0] + [
        v["compare_at_price"] for v in variants if v["compare_at_price"] is not None and v["compare_at_price"] > 0
    ]
    if positives:
        min_pos = min(positives)
        max_pos = max(positives)
        all_deltas: list[int] = [min_pos]
        if min_pos > 1:
            all_deltas.append(min_pos - 1)
        all_deltas.extend([min_pos // 2, max_pos // 2, 100, 10, 1])

        for delta in all_deltas:
            if delta <= 0:
                continue
            shifted = []
            for v in variants:
                nv = dict(v)
                nv["price"] = max(0, v["price"] - delta)
                if v["compare_at_price"] is not None:
                    nv["compare_at_price"] = max(0, v["compare_at_price"] - delta)
                shifted.append(nv)
            yield _with_variants(fixture, shifted)


def iter_shrink_neighbors(fixture: dict[str, Any]) -> Iterator[dict[str, Any]]:
    """Yield candidate shrink neighbors in strict Stage 5 neighborhood order."""
    yield from _iter_variant_deletions(fixture)
    yield from _iter_single_field_simplifications(fixture)
    yield from _iter_paired_simplifications(fixture)


@dataclass(frozen=True)
class ShrinkResult:
    """Outcome of ordered shrinking on a confirmed regression fixture."""

    fixture: dict[str, Any]
    pre_measure: tuple[int, int, int, int, int]
    post_measure: tuple[int, int, int, int, int]
    shrink_pairs: int
    accepted_steps: int
    parity_rejections: int
    local_fixed_point: bool
    final_custom_before: dict[str, Any] | None
    final_custom_after: dict[str, Any] | None
    final_reference_before: dict[str, Any] | None
    final_reference_after: dict[str, Any] | None


def _confirm_initial(
    worker: Any,
    fixture: dict[str, Any],
    before_observed: bool,
    after_observed: bool,
    deadline_check: Callable[[], None] | None,
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any], dict[str, Any]]:
    if deadline_check is not None:
        deadline_check()
    custom_pair = worker.render_pair(fixture, engine="custom", trace=False)
    cb, ca = custom_pair["before"], custom_pair["after"]
    if (
        cb["status"] != "ok"
        or ca["status"] != "ok"
        or cb["observed"] != before_observed
        or ca["observed"] != after_observed
    ):
        raise ValueError("Initial fixture does not reproduce expected custom observations")

    if deadline_check is not None:
        deadline_check()
    ref_pair = worker.render_pair(fixture, engine="reference", trace=False)
    rb, ra = ref_pair["before"], ref_pair["after"]
    if (
        rb["status"] != "ok"
        or ra["status"] != "ok"
        or rb["observed"] != before_observed
        or ra["observed"] != after_observed
    ):
        raise ValueError("Initial fixture does not reproduce expected reference observations")
    if rb["events"] or ra["events"]:
        raise WorkerProtocolError("Reference render unexpectedly emitted trace events")
    if custom_pair["product"] != ref_pair["product"]:
        raise WorkerProtocolError("Product projection mismatch between custom and reference renders")

    return cb, ca, rb, ra


def shrink_confirmed_case(
    *,
    worker: Any,
    fixture: dict[str, Any],
    before_observed: bool,
    after_observed: bool,
    shrink_budget: int = 128,
    tested_cache: dict[str, bool] | None = None,
    deadline_check: Callable[[], None] | None = None,
    deadline_monotonic: float | None = None,
    initial_custom_before: dict[str, Any] | None = None,
    initial_custom_after: dict[str, Any] | None = None,
    initial_reference_before: dict[str, Any] | None = None,
    initial_reference_after: dict[str, Any] | None = None,
) -> ShrinkResult:
    """Minimize an already-confirmed regression fixture while preserving both engines' observations."""
    validate_fixture_dict(fixture)
    if type(before_observed) is not bool or type(after_observed) is not bool:
        raise ValueError("before_observed and after_observed must be strict booleans")
    if before_observed == after_observed:
        raise ValueError("Cannot shrink a fixture whose before and after observations are identical")
    if not _is_strict_int(shrink_budget) or shrink_budget < 0:
        raise ValueError(f"shrink_budget must be a nonnegative integer, got {shrink_budget!r}")

    best_fixture = copy.deepcopy(fixture)
    pre_measure = fixture_measure(best_fixture)
    best_measure = pre_measure

    best_cb = initial_custom_before
    best_ca = initial_custom_after
    best_rb = initial_reference_before
    best_ra = initial_reference_after

    def _ensure_within_deadline() -> None:
        if deadline_check is not None:
            deadline_check()
        if deadline_monotonic is not None and time.monotonic() >= deadline_monotonic:
            raise JobDeadlineError("Job deadline exceeded during shrinking")

    cache: dict[str, bool] = dict(tested_cache) if tested_cache is not None else {}
    cache[canonical_json(best_fixture)] = True

    shrink_pairs = 0
    accepted_steps = 0
    parity_rejections = 0

    while True:
        improved = False
        seen_in_pass: set[str] = set()

        for cand in iter_shrink_neighbors(best_fixture):
            cand_measure = fixture_measure(cand)
            if cand_measure >= best_measure:
                continue

            cand_key = canonical_json(cand)
            if cand_key in seen_in_pass or cand_key in cache:
                continue
            seen_in_pass.add(cand_key)

            if shrink_pairs >= shrink_budget:
                return ShrinkResult(
                    fixture=best_fixture,
                    pre_measure=pre_measure,
                    post_measure=best_measure,
                    shrink_pairs=shrink_pairs,
                    accepted_steps=accepted_steps,
                    parity_rejections=parity_rejections,
                    local_fixed_point=False,
                    final_custom_before=best_cb,
                    final_custom_after=best_ca,
                    final_reference_before=best_rb,
                    final_reference_after=best_ra,
                )

            _ensure_within_deadline()
            shrink_pairs += 1
            custom_pair = worker.render_pair(cand, engine="custom", trace=False)
            cb, ca = custom_pair["before"], custom_pair["after"]

            if (
                cb["status"] != "ok"
                or ca["status"] != "ok"
                or cb["observed"] != before_observed
                or ca["observed"] != after_observed
            ):
                cache[cand_key] = False
                continue

            _ensure_within_deadline()
            ref_pair = worker.render_pair(cand, engine="reference", trace=False)
            rb, ra = ref_pair["before"], ref_pair["after"]

            if rb["events"] or ra["events"]:
                raise WorkerProtocolError("Reference render unexpectedly emitted trace events")

            if (
                rb["status"] != "ok"
                or ra["status"] != "ok"
                or rb["observed"] != before_observed
                or ra["observed"] != after_observed
                or custom_pair["product"] != ref_pair["product"]
            ):
                parity_rejections += 1
                cache[cand_key] = False
                continue

            cache[cand_key] = True
            best_fixture = cand
            best_measure = cand_measure
            best_cb = cb
            best_ca = ca
            best_rb = rb
            best_ra = ra
            accepted_steps += 1
            improved = True
            break

        if not improved:
            return ShrinkResult(
                fixture=best_fixture,
                pre_measure=pre_measure,
                post_measure=best_measure,
                shrink_pairs=shrink_pairs,
                accepted_steps=accepted_steps,
                parity_rejections=parity_rejections,
                local_fixed_point=True,
                final_custom_before=best_cb,
                final_custom_after=best_ca,
                final_reference_before=best_rb,
                final_reference_after=best_ra,
            )

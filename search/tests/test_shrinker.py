"""Unit and real-worker tests for the Stage 5 ordered shrinker (search/shrinker.py)."""

from __future__ import annotations

import hashlib
import unittest
from pathlib import Path
from typing import Any

from search.engine import RuntimeVersions, SearchEngine, build_compare_request
from search.generator import canonical_json
from search.shrinker import fixture_measure, shrink_confirmed_case
from search.worker_client import JobDeadlineError, WorkerClient

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
DEMO_DIR = REPO_ROOT / "fixtures" / "demo"


def _ok(observed: bool, html: str | None = None) -> dict[str, Any]:
    if html is None:
        html = '<span data-regression-badge="sale">Sale</span>' if observed else ""
    return {"status": "ok", "html": html, "observed": observed, "events": [], "error": None}


def _err(code: str = "err", msg: str = "boom") -> dict[str, Any]:
    return {"status": "error", "html": None, "observed": None, "events": [], "error": {"code": code, "message": msg, "span": None}}


def _proj(fixture: dict[str, Any]) -> dict[str, Any]:
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


class PredicateWorker:
    """Fake worker driving custom & reference behavior from arbitrary fixture predicates."""

    def __init__(self, custom_pred, ref_pred=None) -> None:
        self.custom_pred = custom_pred
        self.ref_pred = ref_pred if ref_pred is not None else custom_pred
        self.custom_calls: list[dict[str, Any]] = []
        self.ref_calls: list[dict[str, Any]] = []

    def compile(self, before: str, after: str, observer: str = "sale_badge") -> dict[str, str]:
        return {
            "before_sha256": hashlib.sha256(before.encode("utf-8")).hexdigest(),
            "after_sha256": hashlib.sha256(after.encode("utf-8")).hexdigest(),
        }

    def render_pair(self, fixture: dict[str, Any], engine: str, trace: bool = False) -> dict[str, Any]:
        if engine == "custom":
            self.custom_calls.append(fixture)
            res = self.custom_pred(fixture)
        else:
            self.ref_calls.append(fixture)
            res = self.ref_pred(fixture)

        if isinstance(res, tuple) and len(res) == 2 and isinstance(res[0], bool):
            b_res = _ok(res[0])
            a_res = _ok(res[1])
        else:
            b_res, a_res = res
        return {"before": b_res, "after": a_res, "product": _proj(fixture)}


class ShrinkerTests(unittest.TestCase):
    def test_measure_ordering_and_total_cents(self) -> None:
        f_two_var = {
            "schema_version": 1,
            "currency": "USD",
            "variants": [
                {"id": "v1", "price": 0, "compare_at_price": None, "available": False},
                {"id": "v2", "price": 0, "compare_at_price": None, "available": False},
            ],
        }
        f_one_var_cap = {
            "schema_version": 1,
            "currency": "USD",
            "variants": [
                {"id": "v1", "price": 1000, "compare_at_price": 2000, "available": True},
            ],
        }
        f_one_var_null = {
            "schema_version": 1,
            "currency": "USD",
            "variants": [
                {"id": "v1", "price": 1000, "compare_at_price": None, "available": True},
            ],
        }
        f_one_var_low_cents = {
            "schema_version": 1,
            "currency": "USD",
            "variants": [
                {"id": "v1", "price": 1, "compare_at_price": None, "available": True},
            ],
        }
        f_one_var_unavail = {
            "schema_version": 1,
            "currency": "USD",
            "variants": [
                {"id": "v1", "price": 1, "compare_at_price": None, "available": False},
            ],
        }
        self.assertLess(fixture_measure(f_one_var_cap), fixture_measure(f_two_var))
        self.assertLess(fixture_measure(f_one_var_null), fixture_measure(f_one_var_cap))
        self.assertLess(fixture_measure(f_one_var_low_cents), fixture_measure(f_one_var_null))
        self.assertLess(fixture_measure(f_one_var_unavail), fixture_measure(f_one_var_low_cents))
        self.assertEqual(fixture_measure(f_one_var_cap)[2], 3000)

    def test_chunk_and_single_variant_deletion_preserves_original_ids(self) -> None:
        # 8-variant oversized fixture where only v3 and v7 are needed.
        oversized = {
            "schema_version": 1,
            "currency": "USD",
            "variants": [
                {"id": "v1", "price": 1500, "compare_at_price": 2000, "available": True},
                {"id": "v2", "price": 1800, "compare_at_price": 2500, "available": True},
                {"id": "v3", "price": 900, "compare_at_price": 0, "available": True},
                {"id": "v4", "price": 1400, "compare_at_price": 1600, "available": True},
                {"id": "v5", "price": 1200, "compare_at_price": 1500, "available": True},
                {"id": "v6", "price": 1100, "compare_at_price": 1200, "available": True},
                {"id": "v7", "price": 500, "compare_at_price": 750, "available": True},
                {"id": "v8", "price": 2000, "compare_at_price": 3000, "available": True},
            ],
        }

        def pred(f: dict[str, Any]) -> tuple[bool, bool]:
            ids = {v["id"] for v in f["variants"]}
            # Only fires when both v3 and v7 are present and v7 has compare_at > price and v3 has compare_at == 0.
            v3_ok = any(v["id"] == "v3" and v["compare_at_price"] == 0 for v in f["variants"])
            v7_ok = any(
                v["id"] == "v7" and v["compare_at_price"] is not None and v["compare_at_price"] > v["price"]
                for v in f["variants"]
            )
            return (ids >= {"v3", "v7"} and v3_ok and v7_ok, False)

        worker = PredicateWorker(pred)
        res = shrink_confirmed_case(
            worker=worker,
            fixture=oversized,
            before_observed=True,
            after_observed=False,
            shrink_budget=200,
        )
        self.assertTrue(res.local_fixed_point)
        self.assertLess(res.post_measure, res.pre_measure)
        self.assertEqual([v["id"] for v in res.fixture["variants"]], ["v3", "v7"])
        self.assertEqual(
            res.fixture["variants"],
            [
                {"id": "v3", "price": 0, "compare_at_price": 0, "available": False},
                {"id": "v7", "price": 0, "compare_at_price": 1, "available": False},
            ],
        )

    def test_single_field_simplifications_to_nil_zero_and_boundary(self) -> None:
        initial = {
            "schema_version": 1,
            "currency": "USD",
            "variants": [
                {"id": "v1", "price": 4321, "compare_at_price": 9876, "available": True},
            ],
        }
        # Requires price >= 50, compare_at_price > price + 5, available irrelevant.
        def pred(f: dict[str, Any]) -> tuple[bool, bool]:
            v = f["variants"][0]
            ok = v["price"] >= 50 and v["compare_at_price"] is not None and v["compare_at_price"] > v["price"] + 5
            return (ok, False)

        worker = PredicateWorker(pred)
        res = shrink_confirmed_case(
            worker=worker,
            fixture=initial,
            before_observed=True,
            after_observed=False,
            shrink_budget=300,
        )
        self.assertTrue(res.local_fixed_point)
        self.assertEqual(
            res.fixture["variants"][0],
            {"id": "v1", "price": 50, "compare_at_price": 56, "available": False},
        )

    def test_paired_price_and_compare_at_simplification(self) -> None:
        # Requires price == compare_at_price and price > 0: single-field edits break equality,
        # so only paired (price, compare_at_price) simplification shrinks (1500, 1500) -> (1, 1)!
        initial = {
            "schema_version": 1,
            "currency": "USD",
            "variants": [
                {"id": "v1", "price": 1500, "compare_at_price": 1500, "available": True},
            ],
        }

        def pred_equal_pos(f: dict[str, Any]) -> tuple[bool, bool]:
            v = f["variants"][0]
            return (v["compare_at_price"] == v["price"] and v["price"] > 0, False)

        res1 = shrink_confirmed_case(
            worker=PredicateWorker(pred_equal_pos),
            fixture=initial,
            before_observed=True,
            after_observed=False,
            shrink_budget=128,
        )
        self.assertTrue(res1.local_fixed_point)
        self.assertEqual(
            res1.fixture["variants"][0],
            {"id": "v1", "price": 1, "compare_at_price": 1, "available": False},
        )

        # Tight monotonic chain across two variants: v1.price < v1.cap < v2.price < v2.cap
        # where shifting down together / rank compression reduces (1000,1001),(1002,1003) -> (0,1),(2,3).
        tight = {
            "schema_version": 1,
            "currency": "USD",
            "variants": [
                {"id": "v1", "price": 1000, "compare_at_price": 1001, "available": False},
                {"id": "v2", "price": 1002, "compare_at_price": 1003, "available": False},
            ],
        }

        def pred_chain(f: dict[str, Any]) -> tuple[bool, bool]:
            vs = f["variants"]
            if len(vs) != 2:
                return (False, False)
            c0, c1 = vs[0]["compare_at_price"], vs[1]["compare_at_price"]
            if c0 is None or c1 is None:
                return (False, False)
            return (vs[0]["price"] < c0 < vs[1]["price"] < c1, False)

        res2 = shrink_confirmed_case(
            worker=PredicateWorker(pred_chain),
            fixture=tight,
            before_observed=True,
            after_observed=False,
            shrink_budget=128,
        )
        self.assertTrue(res2.local_fixed_point)
        self.assertEqual(
            res2.fixture["variants"],
            [
                {"id": "v1", "price": 0, "compare_at_price": 1, "available": False},
                {"id": "v2", "price": 2, "compare_at_price": 3, "available": False},
            ],
        )

    def test_zero_and_tiny_budget_termination_and_cache_deduplication(self) -> None:
        initial = {
            "schema_version": 1,
            "currency": "USD",
            "variants": [
                {"id": "v1", "price": 1000, "compare_at_price": 0, "available": True},
                {"id": "v2", "price": 1000, "compare_at_price": 1500, "available": True},
            ],
        }

        # Zero budget performs 0 worker calls and local_fixed_point=False.
        w_zero = PredicateWorker(lambda f: (True, False))
        res_zero = shrink_confirmed_case(
            worker=w_zero,
            fixture=initial,
            before_observed=True,
            after_observed=False,
            shrink_budget=0,
        )
        self.assertEqual(res_zero.shrink_pairs, 0)
        self.assertEqual(res_zero.accepted_steps, 0)
        self.assertFalse(res_zero.local_fixed_point)
        self.assertEqual(res_zero.fixture, initial)
        self.assertEqual(len(w_zero.custom_calls), 0)

        # Tiny budget=2 terminates cleanly with shrink_pairs <= 2 and local_fixed_point=False.
        w_tiny = PredicateWorker(lambda f: (len(f["variants"]) == 2, False))
        res_tiny = shrink_confirmed_case(
            worker=w_tiny,
            fixture=initial,
            before_observed=True,
            after_observed=False,
            shrink_budget=2,
        )
        self.assertEqual(res_tiny.shrink_pairs, 2)
        self.assertFalse(res_tiny.local_fixed_point)
        self.assertEqual(len(w_tiny.custom_calls), 2)

        # Shared tested_cache prevents re-evaluating previously rejected fixtures.
        first_deletion = {
            "schema_version": 1,
            "currency": "USD",
            "variants": [initial["variants"][0]],
        }
        cache = {canonical_json(first_deletion): False}
        w_cached = PredicateWorker(lambda f: (len(f["variants"]) == 2, False))
        shrink_confirmed_case(
            worker=w_cached,
            fixture=initial,
            before_observed=True,
            after_observed=False,
            shrink_budget=1,
            tested_cache=cache,
        )
        tested_keys = [canonical_json(c) for c in w_cached.custom_calls]
        self.assertNotIn(canonical_json(first_deletion), tested_keys)

    def test_reference_parity_rejection_and_error_rejection_during_shrink(self) -> None:
        initial = {
            "schema_version": 1,
            "currency": "USD",
            "variants": [
                {"id": "v1", "price": 100, "compare_at_price": 200, "available": True},
            ],
        }

        def custom_pred(f: dict[str, Any]) -> tuple[bool, bool]:
            v = f["variants"][0]
            return (v["compare_at_price"] is not None, False)

        def ref_pred(f: dict[str, Any]):
            v = f["variants"][0]
            # Reference disagrees when compare_at_price == 0 and errors when compare_at_price == 1!
            if v["compare_at_price"] == 0:
                return (False, False)
            if v["compare_at_price"] == 1:
                return (_err("ref_err", "boom"), _ok(False))
            return (v["compare_at_price"] is not None, False)

        worker = PredicateWorker(custom_pred, ref_pred)
        res = shrink_confirmed_case(
            worker=worker,
            fixture=initial,
            before_observed=True,
            after_observed=False,
            shrink_budget=128,
        )
        self.assertTrue(res.local_fixed_point)
        self.assertGreaterEqual(res.parity_rejections, 2)
        # Should shrink to price=0, compare_at_price=2 (since 0 and 1 failed reference parity).
        self.assertEqual(
            res.fixture["variants"][0],
            {"id": "v1", "price": 0, "compare_at_price": 2, "available": False},
        )

    def test_deadline_exceeded_propagates_during_shrink(self) -> None:
        initial = {
            "schema_version": 1,
            "currency": "USD",
            "variants": [{"id": "v1", "price": 100, "compare_at_price": 200, "available": True}],
        }
        calls = 0

        def check() -> None:
            nonlocal calls
            calls += 1
            if calls >= 2:
                raise JobDeadlineError("deadline hit")

        with self.assertRaises(JobDeadlineError):
            shrink_confirmed_case(
                worker=PredicateWorker(lambda f: (False, False)),
                fixture=initial,
                before_observed=True,
                after_observed=False,
                shrink_budget=10,
                deadline_check=check,
            )

    def test_oversized_demo_fixture_strictly_improves_on_real_worker(self) -> None:
        before_src = (DEMO_DIR / "before.liquid").read_text(encoding="utf-8")
        after_src = (DEMO_DIR / "after.liquid").read_text(encoding="utf-8")

        oversized_demo = {
            "schema_version": 1,
            "currency": "USD",
            "variants": [
                {"id": "v1", "price": 2500, "compare_at_price": None, "available": True},
                {"id": "v2", "price": 2000, "compare_at_price": 0, "available": True},
                {"id": "v3", "price": 3000, "compare_at_price": 2500, "available": True},
                {"id": "v4", "price": 4000, "compare_at_price": 3000, "available": True},
                {"id": "v5", "price": 2200, "compare_at_price": 5000, "available": True},
                {"id": "v6", "price": 6000, "compare_at_price": None, "available": True},
                {"id": "v7", "price": 7000, "compare_at_price": 6000, "available": True},
                {"id": "v8", "price": 8000, "compare_at_price": 9500, "available": True},
            ],
        }

        with WorkerClient(cwd=REPO_ROOT) as client:
            client.compile(before_src, after_src, observer="sale_badge")
            init_custom = client.render_pair(oversized_demo, engine="custom", trace=False)
            init_ref = client.render_pair(oversized_demo, engine="reference", trace=False)
            self.assertTrue(init_custom["before"]["observed"])
            self.assertFalse(init_custom["after"]["observed"])
            self.assertTrue(init_ref["before"]["observed"])
            self.assertFalse(init_ref["after"]["observed"])

            res = shrink_confirmed_case(
                worker=client,
                fixture=oversized_demo,
                before_observed=True,
                after_observed=False,
                shrink_budget=128,
                initial_custom_before=init_custom["before"],
                initial_custom_after=init_custom["after"],
                initial_reference_before=init_ref["before"],
                initial_reference_after=init_ref["after"],
            )

        self.assertTrue(res.local_fixed_point)
        self.assertLess(res.post_measure, res.pre_measure)
        self.assertEqual(len(res.fixture["variants"]), 2)
        # Surviving IDs must come from the original fixture without renumbering.
        orig_ids = [v["id"] for v in oversized_demo["variants"]]
        surviving_ids = [v["id"] for v in res.fixture["variants"]]
        self.assertEqual(len(surviving_ids), 2)
        for vid in surviving_ids:
            self.assertIn(vid, orig_ids)
        self.assertEqual(res.fixture["variants"][0]["compare_at_price"], 0)
        self.assertEqual(res.fixture["variants"][1]["compare_at_price"], 1)
        self.assertEqual(res.fixture["variants"][0]["price"], 0)
        self.assertEqual(res.fixture["variants"][1]["price"], 0)

    def test_search_engine_zero_shrink_budget_skips_shrinking(self) -> None:
        before_src = (DEMO_DIR / "before.liquid").read_text(encoding="utf-8")
        after_src = (DEMO_DIR / "after.liquid").read_text(encoding="utf-8")
        req = build_compare_request(before_src, after_src, seed=0, search_pairs=256, shrink_pairs=0)
        report = SearchEngine(repo_root=REPO_ROOT, versions=RuntimeVersions("0.1.0", "5.14.0", "1.0.0")).compare(req)
        self.assertEqual(report["status"], "difference_found")
        self.assertEqual(report["stats"]["shrink_pairs"], 0)
        self.assertFalse(report["shrink"]["local_fixed_point"])
        self.assertEqual(report["shrink"]["pre_shrink_measure"], report["shrink"]["post_shrink_measure"])
        self.assertEqual(report["finding"]["explanation"]["kind"], "structural_change")


if __name__ == "__main__":
    unittest.main()

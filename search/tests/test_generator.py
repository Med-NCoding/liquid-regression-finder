"""Unit tests for deterministic candidate generation (search/generator.py)."""

from __future__ import annotations

import ast
import sys
import unittest
from pathlib import Path

from search.generator import (
    BOUNDARY_PRICES,
    GENERATOR_VERSION,
    MAX_DUPLICATE_ATTEMPTS,
    MAX_PRICE_CENTS,
    MAX_VARIANTS,
    CandidateGenerator,
    build_fixture,
    build_phase1_boundary_fixtures,
    canonical_json,
    generate_candidates,
)


def assert_valid_fixture_shape(test: unittest.TestCase, fixture: dict) -> None:
    test.assertEqual(set(fixture.keys()), {"schema_version", "currency", "variants"})
    test.assertIs(type(fixture["schema_version"]), int)
    test.assertEqual(fixture["schema_version"], 1)
    test.assertEqual(fixture["currency"], "USD")
    variants = fixture["variants"]
    test.assertIsInstance(variants, list)
    test.assertGreaterEqual(len(variants), 1)
    test.assertLessEqual(len(variants), MAX_VARIANTS)

    seen_ids: set[str] = set()
    for idx, variant in enumerate(variants, start=1):
        test.assertEqual(set(variant.keys()), {"id", "price", "compare_at_price", "available"})
        vid = variant["id"]
        test.assertIsInstance(vid, str)
        test.assertEqual(vid, f"v{idx}")
        test.assertGreaterEqual(len(vid), 1)
        test.assertLessEqual(len(vid), 32)
        test.assertNotIn(vid, seen_ids)
        seen_ids.add(vid)

        price = variant["price"]
        test.assertIs(type(price), int)
        test.assertGreaterEqual(price, 0)
        test.assertLessEqual(price, MAX_PRICE_CENTS)

        cap = variant["compare_at_price"]
        if cap is not None:
            test.assertIs(type(cap), int)
            test.assertGreaterEqual(cap, 0)
            test.assertLessEqual(cap, MAX_PRICE_CENTS)

        test.assertIs(type(variant["available"]), bool)


class GeneratorTests(unittest.TestCase):
    def test_version_and_canonical_json_invariants(self) -> None:
        self.assertEqual(GENERATOR_VERSION, "1.0.0")
        self.assertEqual(MAX_DUPLICATE_ATTEMPTS, 10_000)

        payload = {"b": [2, 1], "a": {"z": "äöü", "x": None}}
        self.assertEqual(canonical_json(payload), '{"a":{"x":null,"z":"äöü"},"b":[2,1]}')

        with self.assertRaises(ValueError):
            canonical_json({"bad": float("nan")})
        with self.assertRaises(ValueError):
            canonical_json({"bad": float("inf")})

    def test_seed_determinism_and_phase_separation(self) -> None:
        phase1 = build_phase1_boundary_fixtures()
        self.assertGreater(len(phase1), 100)
        self.assertLess(len(phase1), 256)

        seq_0a = generate_candidates(seed=0, max_pairs=256)
        seq_0b = generate_candidates(seed=0, max_pairs=256)
        seq_1 = generate_candidates(seed=1, max_pairs=256)
        seq_42 = generate_candidates(seed=42, max_pairs=256)

        self.assertEqual(len(seq_0a), 256)
        self.assertEqual([canonical_json(f) for f in seq_0a], [canonical_json(f) for f in seq_0b])
        self.assertEqual(
            [canonical_json(f) for f in generate_candidates(seed=7, max_pairs=100)],
            [canonical_json(f) for f in generate_candidates(seed=7, max_pairs=300)[:100]],
        )

        # Phase 1 prefix is deterministic and identical across seeds; Phase 2 diverges by seed.
        p1_len = len(phase1)
        self.assertEqual(seq_0a[:p1_len], phase1)
        self.assertEqual(seq_1[:p1_len], phase1)
        self.assertEqual(seq_42[:p1_len], phase1)

        self.assertNotEqual(
            [canonical_json(f) for f in seq_0a[p1_len:]],
            [canonical_json(f) for f in seq_1[p1_len:]],
        )
        self.assertNotEqual(
            [canonical_json(f) for f in seq_1[p1_len:]],
            [canonical_json(f) for f in seq_42[p1_len:]],
        )

    def test_canonical_deduplication_and_schema_validity(self) -> None:
        candidates = generate_candidates(seed=0, max_pairs=500)
        self.assertEqual(len(candidates), 500)

        keys = [canonical_json(f) for f in candidates]
        self.assertEqual(len(set(keys)), len(keys))

        for fixture in candidates:
            assert_valid_fixture_shape(self, fixture)

    def test_phase1_boundary_coverage_categories_and_permutations(self) -> None:
        phase1 = build_phase1_boundary_fixtures()
        counts = {len(f["variants"]) for f in phase1}
        self.assertEqual(counts, {1, 2, 3})

        one_var = [f["variants"][0] for f in phase1 if len(f["variants"]) == 1]
        prices_seen = {v["price"] for v in one_var}
        for bp in BOUNDARY_PRICES:
            self.assertIn(bp, prices_seen)

        # Verify all five compare-at categories at price=1000 in 1-variant fixtures.
        p1000 = [v for v in one_var if v["price"] == 1000]
        self.assertTrue(any(v["compare_at_price"] is None for v in p1000))
        self.assertTrue(any(v["compare_at_price"] == 0 for v in p1000))
        self.assertTrue(any(v["compare_at_price"] is not None and 0 < v["compare_at_price"] < 1000 for v in p1000))
        self.assertTrue(any(v["compare_at_price"] == 1000 for v in p1000))
        self.assertTrue(any(v["compare_at_price"] is not None and v["compare_at_price"] > 1000 for v in p1000))
        self.assertEqual({v["available"] for v in p1000}, {True, False})

        # Verify 2-variant equal vs varied prices, availability masks, and position reversals.
        two_var = [f["variants"] for f in phase1 if len(f["variants"]) == 2]
        self.assertTrue(any(vs[0]["price"] == vs[1]["price"] for vs in two_var))
        self.assertTrue(any(vs[0]["price"] != vs[1]["price"] for vs in two_var))
        self.assertTrue(any((vs[0]["available"], vs[1]["available"]) == (True, False) for vs in two_var))
        self.assertTrue(any((vs[0]["available"], vs[1]["available"]) == (False, True) for vs in two_var))
        self.assertTrue(any((vs[0]["available"], vs[1]["available"]) == (False, False) for vs in two_var))

        # [sale, non-sale] vs [non-sale, sale]
        self.assertTrue(
            any(
                vs[0]["compare_at_price"] is not None
                and vs[0]["compare_at_price"] > vs[0]["price"]
                and vs[1]["compare_at_price"] is None
                for vs in two_var
            )
        )
        self.assertTrue(
            any(
                vs[0]["compare_at_price"] is None
                and vs[1]["compare_at_price"] is not None
                and vs[1]["compare_at_price"] > vs[1]["price"]
                for vs in two_var
            )
        )

        # [below, null] vs [null, below]
        self.assertTrue(
            any(
                vs[0]["compare_at_price"] is not None
                and 0 < vs[0]["compare_at_price"] < vs[0]["price"]
                and vs[1]["compare_at_price"] is None
                for vs in two_var
            )
        )
        self.assertTrue(
            any(
                vs[0]["compare_at_price"] is None
                and vs[1]["compare_at_price"] is not None
                and 0 < vs[1]["compare_at_price"] < vs[1]["price"]
                for vs in two_var
            )
        )

    def test_phase2_samples_1_to_8_variants_with_shared_and_mixed_states(self) -> None:
        phase1_len = len(build_phase1_boundary_fixtures())
        candidates = generate_candidates(seed=0, max_pairs=phase1_len + 300)
        phase2 = candidates[phase1_len:]
        self.assertEqual(len(phase2), 300)

        variant_counts = {len(f["variants"]) for f in phase2}
        self.assertEqual(variant_counts, set(range(1, MAX_VARIANTS + 1)))

        multi = [f["variants"] for f in phase2 if len(f["variants"]) >= 2]
        self.assertTrue(any(len({v["price"] for v in vs}) == 1 for vs in multi))
        self.assertTrue(any(len({v["price"] for v in vs}) > 1 for vs in multi))
        self.assertTrue(
            any(
                any(v["compare_at_price"] is not None and v["compare_at_price"] > v["price"] for v in vs)
                and any(v["compare_at_price"] is None or v["compare_at_price"] <= v["price"] for v in vs)
                for vs in multi
            )
        )

    def test_candidate_space_exhaustion_cap(self) -> None:
        tiny_pool = [
            build_fixture([(100, None, True)]),
            build_fixture([(100, 200, True)]),
        ]
        gen = CandidateGenerator(
            seed=0,
            max_pairs=50,
            max_duplicate_attempts=5,
            phase1_fixtures=[],
            phase2_sampler=lambda rng: rng.choice(tiny_pool),
        )
        results = list(gen)
        self.assertEqual(len(results), 2)
        self.assertEqual(gen.yielded_count, 2)
        self.assertGreaterEqual(gen.duplicate_skips, 5)
        self.assertTrue(gen.exhausted_space)

        gen_exact = CandidateGenerator(
            seed=0,
            max_pairs=2,
            max_duplicate_attempts=5,
            phase1_fixtures=[],
            phase2_sampler=lambda rng: rng.choice(tiny_pool),
        )
        results_exact = list(gen_exact)
        self.assertEqual(len(results_exact), 2)
        self.assertFalse(gen_exact.exhausted_space)

    def test_search_package_uses_python_stdlib_only(self) -> None:
        search_dir = Path(__file__).resolve().parent.parent
        allowed_roots = set(sys.stdlib_module_names) | {"search"}
        for py_file in sorted(search_dir.rglob("*.py")):
            tree = ast.parse(py_file.read_text(encoding="utf-8"), filename=str(py_file))
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    for alias in node.names:
                        top = alias.name.split(".", 1)[0]
                        self.assertIn(top, allowed_roots, f"Non-stdlib import {alias.name!r} in {py_file}")
                elif isinstance(node, ast.ImportFrom):
                    if node.level == 0 and node.module:
                        top = node.module.split(".", 1)[0]
                        self.assertIn(top, allowed_roots, f"Non-stdlib import {node.module!r} in {py_file}")


if __name__ == "__main__":
    unittest.main()

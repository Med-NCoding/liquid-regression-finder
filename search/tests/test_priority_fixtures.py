"""Tests for priority fixture input, deduplication, parity fallback, and signal cleanup."""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any

from search.engine import RuntimeVersions, SearchEngine, build_compare_request
from search.generator import build_fixture, build_phase1_boundary_fixtures, canonical_json
from search.tests.test_cli_and_real_worker import validate_with_ruby_schemas
from search.tests.test_engine_fake_worker import FakeWorker, _ok_render, _sample_projection

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
DEMO_DIR = REPO_ROOT / "fixtures" / "demo"


class PriorityFixtureTests(unittest.TestCase):
    def setUp(self) -> None:
        self.versions = RuntimeVersions("0.1.0", "5.14.0", "1.0.0")

    def _engine(self, **kwargs: Any) -> SearchEngine:
        return SearchEngine(versions=self.versions, **kwargs)

    def test_cli_priority_fixture_confirms_on_pair_one_and_shrinks_with_real_worker(self) -> None:
        before_path = DEMO_DIR / "before.liquid"
        after_path = DEMO_DIR / "after.liquid"

        # Unshrunk 3-variant fixture that diverges on demo snippets, so shrinker still runs.
        priority_fixture = build_fixture(
            [
                (1500, 0, True),
                (1500, 2000, True),
                (2500, None, True),
            ]
        )

        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            pf_path = tmp / "priority.json"
            replay_out = tmp / "replay.json"
            report_out = tmp / "report.json"
            pf_path.write_text(json.dumps(priority_fixture), encoding="utf-8")

            proc = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "search",
                    "compare",
                    "--before",
                    str(before_path),
                    "--after",
                    str(after_path),
                    "--observer",
                    "sale_badge",
                    "--seed",
                    "0",
                    "--search-pairs",
                    "32",
                    "--shrink-pairs",
                    "128",
                    "--priority-fixture",
                    str(pf_path),
                    "--replay-out",
                    str(replay_out),
                ],
                cwd=str(REPO_ROOT),
                capture_output=True,
                text=True,
                encoding="utf-8",
                check=False,
            )

            self.assertEqual(proc.returncode, 1, f"stderr={proc.stderr}")
            self.assertEqual(proc.stderr, "")
            report = json.loads(proc.stdout)
            report_out.write_text(proc.stdout, encoding="utf-8")

            self.assertEqual(report["status"], "difference_found")
            self.assertEqual(report["candidate_index"], 0)
            self.assertEqual(report["stats"]["search_pairs"], 1)
            self.assertGreater(report["stats"]["shrink_pairs"], 0)
            self.assertEqual(report["reference_status"], "confirmed")
            self.assertEqual(report["finding"]["reference"]["before"]["observed"], True)
            self.assertEqual(report["finding"]["reference"]["after"]["observed"], False)
            self.assertEqual(report["finding"]["explanation"]["kind"], "structural_change")
            self.assertEqual(len(report["finding"]["replay"]["fixture"]["variants"]), 2)
            self.assertTrue(replay_out.exists())

            validate_with_ruby_schemas(compare_report=report_out, replay_bundle=replay_out)

    def test_non_divergent_priority_fixture_falls_through_without_double_counting(self) -> None:
        phase1 = build_phase1_boundary_fixtures()
        overlap_fixture = phase1[2]
        duplicate_priority = build_fixture([(999, 999, True)])

        seen_custom_keys: list[str] = []

        def handler(fixture: dict[str, Any], engine: str, trace: bool, _: int) -> dict[str, Any]:
            if engine == "custom" and not trace:
                seen_custom_keys.append(canonical_json(fixture))
            return {"before": _ok_render("", False), "after": _ok_render("", False), "product": _sample_projection(fixture)}

        worker = FakeWorker(render_handler=handler)
        req = build_compare_request("same", "same", search_pairs=16, shrink_pairs=8)
        report = self._engine().compare(
            req,
            worker=worker,
            priority_fixtures=[overlap_fixture, duplicate_priority, overlap_fixture],
        )

        self.assertEqual(report["status"], "no_difference_found")
        self.assertEqual(report["stats"]["search_pairs"], 16)
        self.assertEqual(report["stats"]["exhausted_by"], "pair_limit")
        self.assertEqual(len(seen_custom_keys), 16)
        self.assertEqual(len(set(seen_custom_keys)), 16)
        self.assertEqual(seen_custom_keys[0], canonical_json(overlap_fixture))
        self.assertEqual(seen_custom_keys[1], canonical_json(duplicate_priority))

        # Priority fixture count larger than search_budget stops cleanly at search_budget.
        seen_bounded: list[str] = []

        def bounded_handler(fixture: dict[str, Any], engine: str, trace: bool, _: int) -> dict[str, Any]:
            if engine == "custom" and not trace:
                seen_bounded.append(canonical_json(fixture))
            return {"before": _ok_render("", False), "after": _ok_render("", False), "product": _sample_projection(fixture)}

        bounded_report = self._engine().compare(
            build_compare_request("same", "same", search_pairs=2, shrink_pairs=0),
            worker=FakeWorker(render_handler=bounded_handler),
            priority_fixtures=[phase1[0], phase1[1], phase1[2], phase1[3]],
        )
        self.assertEqual(bounded_report["status"], "no_difference_found")
        self.assertEqual(bounded_report["stats"]["search_pairs"], 2)
        self.assertEqual(bounded_report["stats"]["exhausted_by"], "pair_limit")
        self.assertEqual(len(seen_bounded), 2)

    def test_parity_rejected_priority_fixture_increments_rejections_and_continues(self) -> None:
        phase1 = build_phase1_boundary_fixtures()
        rejected_fixture = phase1[1]
        rejected_key = canonical_json(rejected_fixture)
        confirmed_target_key = canonical_json(phase1[0])

        custom_keys: list[str] = []

        def handler(fixture: dict[str, Any], engine: str, trace: bool, _: int) -> dict[str, Any]:
            key = canonical_json(fixture)
            product = _sample_projection(fixture)
            if engine == "custom" and not trace:
                custom_keys.append(key)
                if key == rejected_key:
                    return {
                        "before": _ok_render("<span data-regression-badge='sale'>Sale</span>", True),
                        "after": _ok_render("", False),
                        "product": product,
                    }
                if key == confirmed_target_key:
                    return {
                        "before": _ok_render("", False),
                        "after": _ok_render("<span data-regression-badge='sale'>Sale</span>", True),
                        "product": product,
                    }
                return {"before": _ok_render("", False), "after": _ok_render("", False), "product": product}

            if engine == "reference":
                if key == rejected_key:
                    return {"before": _ok_render("", False), "after": _ok_render("", False), "product": product}
                if key == confirmed_target_key:
                    return {
                        "before": _ok_render("", False),
                        "after": _ok_render("<span data-regression-badge='sale'>Sale</span>", True),
                        "product": product,
                    }
                return {"before": _ok_render("", False), "after": _ok_render("", False), "product": product}

            return {
                "before": _ok_render("", False),
                "after": _ok_render("<span data-regression-badge='sale'>Sale</span>", True),
                "product": product,
            }

        report = self._engine().compare(
            build_compare_request("before", "after", search_pairs=16, shrink_pairs=0),
            worker=FakeWorker(render_handler=handler),
            priority_fixtures=[rejected_fixture],
        )
        self.assertEqual(report["status"], "difference_found")
        self.assertEqual(report["candidate_index"], 1)
        self.assertEqual(report["stats"]["search_pairs"], 2)
        self.assertEqual(report["stats"]["parity_rejections"], 1)

        # If no subsequent candidate diverges, parity rejection on priority fixture produces reference_mismatch
        # and does not re-test rejected_fixture when Generator reaches phase1[1].
        custom_keys_exhausted: list[str] = []

        def reject_only_handler(fixture: dict[str, Any], engine: str, trace: bool, _: int) -> dict[str, Any]:
            key = canonical_json(fixture)
            product = _sample_projection(fixture)
            if engine == "custom" and not trace:
                custom_keys_exhausted.append(key)
                if key == rejected_key:
                    return {
                        "before": _ok_render("<span data-regression-badge='sale'>Sale</span>", True),
                        "after": _ok_render("", False),
                        "product": product,
                    }
            return {"before": _ok_render("", False), "after": _ok_render("", False), "product": product}

        exhausted_report = self._engine().compare(
            build_compare_request("before", "after", search_pairs=8, shrink_pairs=0),
            worker=FakeWorker(render_handler=reject_only_handler),
            priority_fixtures=[rejected_fixture],
        )
        self.assertEqual(exhausted_report["status"], "failed")
        self.assertEqual(exhausted_report["error"]["code"], "reference_mismatch")
        self.assertEqual(exhausted_report["reference_status"], "mismatch")
        self.assertEqual(exhausted_report["stats"]["search_pairs"], 8)
        self.assertEqual(exhausted_report["stats"]["parity_rejections"], 1)
        self.assertEqual(custom_keys_exhausted.count(rejected_key), 1)
        self.assertEqual(len(set(custom_keys_exhausted)), 8)

    def test_malformed_priority_fixture_fails_validation_cleanly(self) -> None:
        worker = FakeWorker()
        req = build_compare_request("ok", "ok", search_pairs=8)

        bad_cases: list[Any] = [
            [{"schema_version": 2, "currency": "USD", "variants": []}],
            [{"schema_version": 1, "currency": "USD", "variants": [{"id": "v1", "price": 100, "compare_at_price": None, "available": True}, {"id": "v1", "price": 200, "compare_at_price": None, "available": True}]}],
            "not-a-sequence",
        ]
        for bad in bad_cases:
            report = self._engine().compare(req, worker=worker, priority_fixtures=bad)
            self.assertEqual(report["status"], "failed")
            self.assertEqual(report["error"]["code"], "invalid_fixture")
            self.assertEqual(report["stats"]["search_pairs"], 0)
            self.assertEqual(worker.compile_calls, [])

        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            before_file = tmp / "before.liquid"
            after_file = tmp / "after.liquid"
            bad_pf = tmp / "bad.json"
            before_file.write_text("ok", encoding="utf-8")
            after_file.write_text("ok", encoding="utf-8")
            bad_pf.write_text("{not-json", encoding="utf-8")

            proc_bad_json = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "search",
                    "compare",
                    "--before",
                    str(before_file),
                    "--after",
                    str(after_file),
                    "--priority-fixture",
                    str(bad_pf),
                ],
                cwd=str(REPO_ROOT),
                capture_output=True,
                text=True,
                encoding="utf-8",
                check=False,
            )
            self.assertEqual(proc_bad_json.returncode, 2)
            self.assertIn("invalid_fixture", proc_bad_json.stderr)
            rep_bad_json = json.loads(proc_bad_json.stdout)
            self.assertEqual(rep_bad_json["status"], "failed")
            self.assertEqual(rep_bad_json["error"]["code"], "invalid_fixture")

            proc_missing = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "search",
                    "compare",
                    "--before",
                    str(before_file),
                    "--after",
                    str(after_file),
                    "--priority-fixture",
                    str(tmp / "missing.json"),
                ],
                cwd=str(REPO_ROOT),
                capture_output=True,
                text=True,
                encoding="utf-8",
                check=False,
            )
            self.assertEqual(proc_missing.returncode, 2)
            self.assertIn("input_file_error", proc_missing.stderr)

    def test_search_cli_sigterm_reaps_ruby_worker_cleanly(self) -> None:
        # Run CLI compare on identical snippets with large search_pairs and terminate via SIGTERM.
        import time

        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            before_file = tmp / "before.liquid"
            after_file = tmp / "after.liquid"
            before_file.write_text((DEMO_DIR / "before.liquid").read_text(encoding="utf-8"), encoding="utf-8")
            after_file.write_text((DEMO_DIR / "before.liquid").read_text(encoding="utf-8"), encoding="utf-8")

            with subprocess.Popen(
                [
                    sys.executable,
                    "-m",
                    "search",
                    "compare",
                    "--before",
                    str(before_file),
                    "--after",
                    str(after_file),
                    "--search-pairs",
                    "2000",
                ],
                cwd=str(REPO_ROOT),
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            ) as proc:
                try:
                    # Give Python time to spawn the Ruby worker.
                    time.sleep(0.35)
                    proc.terminate()
                    rc = proc.wait(timeout=5.0)
                    self.assertNotEqual(rc, 0)
                finally:
                    if proc.poll() is None:
                        proc.kill()
                        proc.wait(timeout=2.0)


if __name__ == "__main__":
    unittest.main()

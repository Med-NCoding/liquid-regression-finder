"""Stage 7 benchmark, sample baseline, parity, and reproducibility tests (Python 3.11 stdlib-only)."""

from __future__ import annotations

import ast
import csv
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from bench.run import (
    CONFORMANCE_MANIFEST_PATH,
    CORPUS_MANIFEST_PATH,
    DEFAULT_CSV_PATH,
    DEFAULT_JSON_PATH,
    DEFAULT_MD_PATH,
    SAMPLE_PRODUCTS_PATH,
    run_benchmark,
)
from bench.sample_baseline.convert_csvs import PINNED_COMMIT_SHA, convert_raw_csvs
from search.engine import SearchEngine, build_compare_request
from search.worker_client import WorkerClient

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
FIXTURE_SCHEMA_PATH = REPO_ROOT / "contracts" / "schemas" / "fixture.schema.json"

DETERMINISTIC_RUN_FIELDS = (
    "case_id",
    "observable",
    "corpus_direction",
    "supported_for_benchmark",
    "method",
    "seed",
    "status",
    "detected",
    "evaluated_pairs",
    "shrink_pairs",
    "pre_shrink_variants",
    "pre_shrink_bytes",
    "post_shrink_variants",
    "post_shrink_bytes",
    "direction",
    "explanation_kind",
    "fixture",
    "parity_rejections",
)


def _resolve_bundle_cmd() -> str:
    found = shutil.which("bundle")
    hb = "/opt/homebrew/opt/ruby@3.3/bin/bundle"
    if found and (found != "/usr/bin/bundle" or not os.path.isfile(hb)):
        return found
    if os.path.isfile(hb) and os.access(hb, os.X_OK):
        return hb
    raise RuntimeError("bundle executable not found")


class BenchmarkTests(unittest.TestCase):
    def test_bench_python_files_use_stdlib_only(self) -> None:
        stdlib_modules = set(sys.stdlib_module_names)
        allowed_local_roots = {"search", "bench"}
        py_files = list((REPO_ROOT / "bench").rglob("*.py"))
        self.assertGreaterEqual(len(py_files), 3)

        for path in py_files:
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    for alias in node.names:
                        top = alias.name.split(".")[0]
                        self.assertIn(
                            top,
                            stdlib_modules | allowed_local_roots,
                            f"Non-stdlib import {alias.name!r} in {path}",
                        )
                elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                    top = node.module.split(".")[0]
                    self.assertIn(
                        top,
                        stdlib_modules | allowed_local_roots,
                        f"Non-stdlib import {node.module!r} in {path}",
                    )

    def test_sample_baseline_conversion_deterministic_and_schema_valid(self) -> None:
        on_disk = json.loads(SAMPLE_PRODUCTS_PATH.read_text(encoding="utf-8"))
        regenerated = convert_raw_csvs(REPO_ROOT / "bench" / "sample_baseline")
        self.assertEqual(on_disk, regenerated)
        self.assertEqual(on_disk["pinned_commit_sha"], PINNED_COMMIT_SHA)
        self.assertEqual(on_disk["product_count"], 60)
        self.assertEqual(on_disk["variant_count"], 66)
        self.assertEqual(on_disk["truncated_handles"], [])

        # Validate all 60 fixtures against contracts/schemas/fixture.schema.json via JSONSchemer
        ruby_check = """
require "json"
require "json_schemer"
schema = JSONSchemer.schema(JSON.parse(File.read(ARGV[0], encoding: Encoding::UTF_8)))
products = JSON.parse(File.read(ARGV[1], encoding: Encoding::UTF_8)).fetch("products")
raise "Expected 60 products" unless products.size == 60
products.each do |p|
  errs = schema.validate(p.fetch("fixture")).to_a
  raise "Invalid fixture #{p['id']}: #{errs.inspect}" unless errs.empty?
end
puts "VALID #{products.size} sample_baseline fixtures"
"""
        proc = subprocess.run(
            [_resolve_bundle_cmd(), "exec", "ruby", "-e", ruby_check, str(FIXTURE_SCHEMA_PATH), str(SAMPLE_PRODUCTS_PATH)],
            cwd=str(REPO_ROOT),
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=False,
        )
        self.assertEqual(proc.returncode, 0, f"stderr={proc.stderr}\nstdout={proc.stdout}")
        self.assertIn("VALID 60 sample_baseline fixtures", proc.stdout)

    def test_benchmark_observers_and_fixed_context_parity_across_all_10_supported_cases(self) -> None:
        manifest = json.loads(CORPUS_MANIFEST_PATH.read_text(encoding="utf-8"))
        supported = [c for c in manifest["cases"] if c["supported_for_benchmark"]]
        self.assertEqual(len(supported), 10)

        with WorkerClient(cwd=REPO_ROOT, benchmark=True) as client:
            for case in supported:
                before_src = (REPO_ROOT / case["before_path"]).read_text(encoding="utf-8")
                after_src = (REPO_ROOT / case["after_path"]).read_text(encoding="utf-8")
                witness = json.loads((REPO_ROOT / case["witness_fixture_path"]).read_text(encoding="utf-8"))

                client.compile(
                    before_src,
                    after_src,
                    observer=case["observable"],
                    benchmark=True,
                    selector=case["observer_selector"],
                    fixed_context=case["fixed_context"],
                )
                custom_res = client.render_pair(witness, engine="custom", trace=True)
                ref_res = client.render_pair(witness, engine="reference", trace=False)

                self.assertEqual(custom_res["before"]["status"], "ok", case["id"])
                self.assertEqual(custom_res["after"]["status"], "ok", case["id"])
                self.assertEqual(ref_res["before"]["status"], "ok", case["id"])
                self.assertEqual(ref_res["after"]["status"], "ok", case["id"])
                self.assertEqual(custom_res["before"]["html"], ref_res["before"]["html"], case["id"])
                self.assertEqual(custom_res["after"]["html"], ref_res["after"]["html"], case["id"])
                self.assertEqual(custom_res["before"]["observed"], case["expected_before_observed"], case["id"])
                self.assertEqual(custom_res["after"]["observed"], case["expected_after_observed"], case["id"])
                self.assertEqual(ref_res["before"]["observed"], case["expected_before_observed"], case["id"])
                self.assertEqual(ref_res["after"]["observed"], case["expected_after_observed"], case["id"])
                self.assertEqual(custom_res["product"], ref_res["product"], case["id"])

        # Public SearchEngine mode remains strictly scoped to sale_badge without benchmark args
        engine = SearchEngine(repo_root=REPO_ROOT)
        for bad_obs in ("sold_out_badge", "price_range"):
            res = engine.compare(build_compare_request("ok", "ok", observer=bad_obs))
            self.assertEqual(res["status"], "failed")
            self.assertEqual(res["error"]["code"], "unsupported_observer")

        res_ctx = engine.compare(
            build_compare_request("ok", "ok", observer="sale_badge"),
            fixed_context={"quick_add": "bulk"},
        )
        self.assertEqual(res_ctx["status"], "failed")
        self.assertEqual(res_ctx["error"]["code"], "invalid_request")

    def test_generated_benchmark_reports_account_for_all_15_cases_and_conformance(self) -> None:
        self.assertTrue(DEFAULT_CSV_PATH.is_file(), f"Missing {DEFAULT_CSV_PATH}")
        self.assertTrue(DEFAULT_JSON_PATH.is_file(), f"Missing {DEFAULT_JSON_PATH}")
        self.assertTrue(DEFAULT_MD_PATH.is_file(), f"Missing {DEFAULT_MD_PATH}")

        details = json.loads(DEFAULT_JSON_PATH.read_text(encoding="utf-8"))
        cfg = details["experiment_config"]
        self.assertEqual(cfg["total_cases"], 15)
        self.assertEqual(cfg["supported_cases"], 10)
        self.assertEqual(cfg["unsupported_cases"], 5)
        self.assertEqual(cfg["seeds"], [0, 1, 2, 3, 4])
        self.assertEqual(cfg["search_pairs"], 256)
        self.assertEqual(cfg["shrink_pairs"], 128)
        self.assertEqual(cfg["sample_product_count"], 60)

        runs = details["runs"]
        sb_runs = [r for r in runs if r["method"] == "sample_baseline"]
        gs_runs = [r for r in runs if r["method"] == "generated_search"]
        self.assertEqual(len(sb_runs), 15)
        self.assertEqual(len(gs_runs), 75)

        valid_statuses = {"detected", "budget_exhausted", "unsupported", "error"}
        for r in runs:
            self.assertIn(r["status"], valid_statuses)

        # Accounting sums cleanly to 15 cases for sample_baseline and 15 cases per seed for generated_search
        sb_sum = sum(1 for r in sb_runs if r["status"] in valid_statuses)
        self.assertEqual(sb_sum, 15)
        self.assertEqual(sum(1 for r in sb_runs if r["status"] == "unsupported"), 5)
        for seed in (0, 1, 2, 3, 4):
            seed_rows = [r for r in gs_runs if r["seed"] == seed]
            self.assertEqual(len(seed_rows), 15)
            self.assertEqual(sum(1 for r in seed_rows if r["status"] == "unsupported"), 5)

        # CSV rows match details["runs"]
        with DEFAULT_CSV_PATH.open("r", encoding="utf-8", newline="") as fh:
            csv_rows = list(csv.DictReader(fh))
        self.assertEqual(len(csv_rows), 90)
        self.assertEqual(sum(1 for row in csv_rows if row["status"] in valid_statuses), 90)

        # Conformance before (359) vs after (399) and IPC overhead recorded
        conf = details["conformance_coverage"]
        manifest = json.loads(CONFORMANCE_MANIFEST_PATH.read_text(encoding="utf-8"))
        self.assertEqual(conf["before_stage7"]["selected"], 359)
        self.assertEqual(conf["after_stage7"]["selected"], manifest["totals"]["selected"])
        self.assertGreater(conf["after_stage7"]["selected"], 359)

        ipc = details["ipc_overhead"]
        self.assertIsNotNone(ipc)
        self.assertGreater(ipc["engines"]["custom"]["ipc"]["total_ms"], 0.0)
        self.assertGreater(ipc["engines"]["custom"]["in_process"]["total_ms"], 0.0)

        md_text = DEFAULT_MD_PATH.read_text(encoding="utf-8")
        self.assertIn("All 15 Verified Cases", md_text)
        self.assertIn("Supported-Only 10 Cases", md_text)
        self.assertIn("359/359", md_text)
        self.assertIn(f"{manifest['totals']['selected']}/{manifest['totals']['selected']}", md_text)
        self.assertIn("Instrumented Render-Process Subprocess Overhead", md_text)

    def test_deterministic_fields_reproducible_across_repeated_runs(self) -> None:
        subset_ids = {
            "dawn_pr_589_card_badge_aria_hidden",
            "dawn_pr_1610_quick_add_single_variant_sold_out",
            "dawn_pr_662_compare_at_price_varies",
            "dawn_pr_1938_horizontal_card_badge_suppressed",
        }

        run1 = run_benchmark(seeds=(0, 1), case_ids=subset_ids, include_ipc_probe=False)
        run2 = run_benchmark(seeds=(0, 1), case_ids=subset_ids, include_ipc_probe=False)

        def project_det(details: dict) -> list[dict]:
            return [{k: row[k] for k in DETERMINISTIC_RUN_FIELDS} for row in details["runs"]]

        det1 = project_det(run1)
        det2 = project_det(run2)
        self.assertEqual(det1, det2)
        self.assertEqual(len(det1), 12)  # 4 sample_baseline + 4 * 2 generated_search


if __name__ == "__main__":
    unittest.main()

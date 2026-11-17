"""Integration tests executing real `python -m search compare` against the Ruby worker."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from search.generator import build_phase1_boundary_fixtures, canonical_json

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
DEMO_DIR = REPO_ROOT / "fixtures" / "demo"
SCHEMA_VALIDATOR = REPO_ROOT / "search" / "tests" / "validate_stage4_schemas.rb"


def resolve_bundle_cmd() -> str:
    found = shutil.which("bundle")
    hb = "/opt/homebrew/opt/ruby@3.3/bin/bundle"
    if found and (found != "/usr/bin/bundle" or not os.path.isfile(hb)):
        return found
    if os.path.isfile(hb) and os.access(hb, os.X_OK):
        return hb
    raise RuntimeError("bundle executable not found")


def validate_with_ruby_schemas(*, compare_report: Path | None = None, replay_bundle: Path | None = None) -> None:
    cmd = [resolve_bundle_cmd(), "exec", "ruby", str(SCHEMA_VALIDATOR)]
    if compare_report is not None:
        cmd.extend(["--compare-report", str(compare_report)])
    if replay_bundle is not None:
        cmd.extend(["--replay-bundle", str(replay_bundle)])
    proc = subprocess.run(cmd, cwd=str(REPO_ROOT), capture_output=True, text=True, check=False)
    if proc.returncode != 0:
        raise AssertionError(f"Schema validation failed:\nstdout={proc.stdout}\nstderr={proc.stderr}")


class CliAndRealWorkerTests(unittest.TestCase):
    def test_demo_directory_contains_only_liquid_sources(self) -> None:
        entries = sorted(p.name for p in DEMO_DIR.iterdir())
        self.assertEqual(entries, ["after.liquid", "before.liquid"])

    def test_demo_compare_succeeds_across_pinned_seeds_and_validates_schemas(self) -> None:
        before_path = DEMO_DIR / "before.liquid"
        after_path = DEMO_DIR / "after.liquid"
        expected_before_sha = hashlib.sha256(before_path.read_bytes()).hexdigest()
        expected_after_sha = hashlib.sha256(after_path.read_bytes()).hexdigest()

        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            for seed in (0, 1, 2, 42):
                replay_out = tmp / f"replay-seed-{seed}.json"
                report_out = tmp / f"compare-seed-{seed}.json"

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
                        str(seed),
                        "--search-pairs",
                        "256",
                        "--shrink-pairs",
                        "128",
                        "--replay-out",
                        str(replay_out),
                    ],
                    cwd=str(REPO_ROOT),
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    check=False,
                )

                self.assertEqual(proc.returncode, 1, f"Expected exit code 1 for seed={seed}; stderr={proc.stderr}")
                self.assertEqual(proc.stderr, "", f"Unexpected stderr for seed={seed}: {proc.stderr}")

                report = json.loads(proc.stdout)
                report_out.write_text(proc.stdout, encoding="utf-8")

                self.assertEqual(report["status"], "difference_found")
                self.assertEqual(report["seed"], seed)
                self.assertEqual(report["reference_status"], "confirmed")
                self.assertIn(report["direction"], ("before_only", "after_only"))
                self.assertGreaterEqual(report["candidate_index"], 0)
                self.assertEqual(report["stats"]["search_pairs"], report["candidate_index"] + 1)
                self.assertEqual(report["stats"]["shrink_pairs"], 0)
                self.assertIsNone(report["stats"]["exhausted_by"])

                finding = report["finding"]
                self.assertNotEqual(finding["before"]["observed"], finding["after"]["observed"])
                self.assertEqual(finding["before"]["observed"], finding["reference"]["before"]["observed"])
                self.assertEqual(finding["after"]["observed"], finding["reference"]["after"]["observed"])
                self.assertGreater(len(finding["before"]["events"]), 0)
                self.assertGreater(len(finding["after"]["events"]), 0)
                self.assertEqual(finding["reference"]["before"]["events"], [])
                self.assertEqual(finding["reference"]["after"]["events"], [])
                self.assertEqual(
                    finding["explanation"],
                    {
                        "kind": "undetermined",
                        "before": None,
                        "after": None,
                        "summary": "Trace explanation pending Stage 5 shrink/alignment.",
                    },
                )

                replay = finding["replay"]
                self.assertEqual(replay["before_sha256"], expected_before_sha)
                self.assertEqual(replay["after_sha256"], expected_after_sha)
                self.assertEqual(replay["interpreter_version"], "0.1.0")
                self.assertEqual(replay["liquid_version"], "5.14.0")
                self.assertEqual(replay["projection_version"], "1.0.0")

                self.assertTrue(replay_out.exists())
                raw_replay_bytes = replay_out.read_bytes()
                self.assertEqual(raw_replay_bytes, canonical_json(replay).encode("utf-8"))

                validate_with_ruby_schemas(compare_report=report_out, replay_bundle=replay_out)

    def test_identical_snippets_return_scoped_negative_and_exit_zero(self) -> None:
        before_path = DEMO_DIR / "before.liquid"
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            replay_out = tmp / "should-not-exist.json"
            report_out = tmp / "identical.json"

            proc = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "search",
                    "compare",
                    "--before",
                    str(before_path),
                    "--after",
                    str(before_path),
                    "--observer",
                    "sale_badge",
                    "--seed",
                    "0",
                    "--search-pairs",
                    "16",
                    "--shrink-pairs",
                    "8",
                    "--replay-out",
                    str(replay_out),
                ],
                cwd=str(REPO_ROOT),
                capture_output=True,
                text=True,
                encoding="utf-8",
                check=False,
            )

            self.assertEqual(proc.returncode, 0, f"stderr={proc.stderr}")
            self.assertEqual(proc.stderr, "")
            self.assertFalse(replay_out.exists())

            report = json.loads(proc.stdout)
            report_out.write_text(proc.stdout, encoding="utf-8")

            self.assertEqual(report["status"], "no_difference_found")
            self.assertEqual(report["message"], "no difference found within this search")
            self.assertEqual(report["stats"]["search_pairs"], 16)
            self.assertEqual(report["stats"]["exhausted_by"], "pair_limit")
            self.assertEqual(report["stats"]["parity_rejections"], 0)
            self.assertEqual(report["reference_status"], "not_triggered")
            self.assertIsNone(report["finding"])
            self.assertIsNone(report["error"])

            validate_with_ruby_schemas(compare_report=report_out)

    def test_phase2_real_worker_discovery_on_four_variant_threshold_snippet(self) -> None:
        # Pure-Liquid 4-variant detector that Phase 1 (1..3 variants) cannot trigger,
        # exercising seeded Phase 2 discovery against the real Ruby worker.
        four_plus_snippet = (
            "{%- assign a = false -%}{%- assign b = false -%}"
            "{%- assign c = false -%}{%- assign d = false -%}"
            "{%- for variant in product.variants -%}"
            "{%- if c -%}{%- assign d = true -%}{%- endif -%}"
            "{%- if b -%}{%- assign c = true -%}{%- endif -%}"
            "{%- if a -%}{%- assign b = true -%}{%- endif -%}"
            "{%- assign a = true -%}"
            "{%- endfor -%}"
            '{%- if d -%}<span data-regression-badge="sale">Sale</span>{%- endif -%}'
        )
        phase1_len = len(build_phase1_boundary_fixtures())

        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            before_file = tmp / "four_plus.liquid"
            after_file = tmp / "empty.liquid"
            report_out = tmp / "phase2.json"
            before_file.write_text(four_plus_snippet, encoding="utf-8")
            after_file.write_text("", encoding="utf-8")

            proc = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "search",
                    "compare",
                    "--before",
                    str(before_file),
                    "--after",
                    str(after_file),
                    "--observer",
                    "sale_badge",
                    "--seed",
                    "0",
                    "--search-pairs",
                    "256",
                    "--shrink-pairs",
                    "0",
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
            self.assertGreaterEqual(report["candidate_index"], phase1_len)
            self.assertGreaterEqual(len(report["finding"]["replay"]["fixture"]["variants"]), 4)
            validate_with_ruby_schemas(compare_report=report_out)

    def test_cli_compile_error_and_invalid_observer_exit_two(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            bad_tpl = tmp / "bad.liquid"
            good_tpl = tmp / "good.liquid"
            bad_tpl.write_text("{% bogus %}", encoding="utf-8")
            good_tpl.write_text("ok", encoding="utf-8")

            proc_compile = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "search",
                    "compare",
                    "--before",
                    str(bad_tpl),
                    "--after",
                    str(good_tpl),
                ],
                cwd=str(REPO_ROOT),
                capture_output=True,
                text=True,
                encoding="utf-8",
                check=False,
            )
            self.assertEqual(proc_compile.returncode, 2)
            self.assertIn("unsupported_tag", proc_compile.stderr)
            report_compile = json.loads(proc_compile.stdout)
            self.assertEqual(report_compile["status"], "failed")
            self.assertEqual(report_compile["error"]["code"], "unsupported_tag")

            proc_obs = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "search",
                    "compare",
                    "--before",
                    str(good_tpl),
                    "--after",
                    str(good_tpl),
                    "--observer",
                    "bogus",
                ],
                cwd=str(REPO_ROOT),
                capture_output=True,
                text=True,
                encoding="utf-8",
                check=False,
            )
            self.assertEqual(proc_obs.returncode, 2)
            self.assertIn("unsupported_observer", proc_obs.stderr)
            report_obs = json.loads(proc_obs.stdout)
            self.assertEqual(report_obs["status"], "failed")
            self.assertEqual(report_obs["error"]["code"], "unsupported_observer")


if __name__ == "__main__":
    unittest.main()

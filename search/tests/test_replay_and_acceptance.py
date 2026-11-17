"""Fresh-process CLI replay and Stage 5 end-to-end acceptance tests."""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any

from search.engine import RuntimeVersions, build_compare_request
from search.generator import canonical_json
from search.replay import ReplayRunner
from search.shrinker import fixture_measure

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
DEMO_DIR = REPO_ROOT / "fixtures" / "demo"


class ReplaySpyWorker:
    """Fake worker verifying ReplayRunner performs only compile + 2 render_pair calls."""

    def __init__(self, *, ref_mismatch: bool = False) -> None:
        self.calls: list[tuple[str, Any]] = []
        self.ref_mismatch = ref_mismatch

    def compile(self, before: str, after: str, observer: str = "sale_badge") -> dict[str, str]:
        self.calls.append(("compile", (before, after, observer)))
        return {
            "before_sha256": hashlib.sha256(before.encode("utf-8")).hexdigest(),
            "after_sha256": hashlib.sha256(after.encode("utf-8")).hexdigest(),
        }

    def render_pair(self, fixture: dict[str, Any], engine: str, trace: bool = False) -> dict[str, Any]:
        self.calls.append(("render_pair", (engine, trace)))
        product = {
            "price": 0,
            "price_min": 0,
            "price_max": 0,
            "price_varies": False,
            "compare_at_price": 0,
            "compare_at_price_min": 0,
            "compare_at_price_max": 1,
            "compare_at_price_varies": True,
            "available": False,
        }
        if engine == "custom":
            return {
                "before": {
                    "status": "ok",
                    "html": '<span data-regression-badge="sale">Sale</span>',
                    "observed": True,
                    "events": [
                        {
                            "seq": 0,
                            "node_id": "n0:conditional.a0:branch",
                            "scope": [],
                            "span": {"start_byte": 0, "end_byte": 10, "line": 1, "column": 1},
                            "data": {"kind": "branch", "expression": "true", "condition": True, "taken": True},
                        },
                        {
                            "seq": 1,
                            "node_id": "n0:conditional.a0.b0:text",
                            "scope": [],
                            "span": {"start_byte": 10, "end_byte": 54, "line": 1, "column": 11},
                            "data": {
                                "kind": "emit",
                                "output_start_byte": 0,
                                "output_end_byte": 44,
                                "active_branch_seqs": [0],
                            },
                        },
                    ],
                    "error": None,
                },
                "after": {
                    "status": "ok",
                    "html": "",
                    "observed": False,
                    "events": [
                        {
                            "seq": 0,
                            "node_id": "n0:conditional.a0:branch",
                            "scope": [],
                            "span": {"start_byte": 0, "end_byte": 11, "line": 1, "column": 1},
                            "data": {"kind": "branch", "expression": "false", "condition": False, "taken": False},
                        }
                    ],
                    "error": None,
                },
                "product": product,
            }

        # Reference engine
        after_obs = True if self.ref_mismatch else False
        return {
            "before": {"status": "ok", "html": '<span data-regression-badge="sale">Sale</span>', "observed": True, "events": [], "error": None},
            "after": {"status": "ok", "html": "", "observed": after_obs, "events": [], "error": None},
            "product": product,
        }


class ReplayAndAcceptanceTests(unittest.TestCase):
    def _sample_bundle(self) -> dict[str, Any]:
        before_src = "{% if true %}<span data-regression-badge=\"sale\">Sale</span>{% endif %}"
        after_src = "{% if false %}<span data-regression-badge=\"sale\">Sale</span>{% endif %}"
        req = build_compare_request(before_src, after_src, seed=0, search_pairs=16, shrink_pairs=8)
        return {
            "request": req,
            "fixture": {
                "schema_version": 1,
                "currency": "USD",
                "variants": [{"id": "v1", "price": 0, "compare_at_price": 0, "available": False}],
            },
            "before_sha256": hashlib.sha256(before_src.encode("utf-8")).hexdigest(),
            "after_sha256": hashlib.sha256(after_src.encode("utf-8")).hexdigest(),
            "interpreter_version": "0.1.0",
            "liquid_version": "5.14.0",
            "projection_version": "1.0.0",
        }

    def test_replay_runner_bypasses_search_and_shrink_and_detects_ref_mismatch(self) -> None:
        runner = ReplayRunner(versions=RuntimeVersions("0.1.0", "5.14.0", "1.0.0"))
        bundle = self._sample_bundle()

        spy = ReplaySpyWorker()
        out = runner.replay_bundle(bundle, worker=spy)
        self.assertEqual(out["status"], "replayed")
        self.assertEqual(
            spy.calls,
            [
                ("compile", (bundle["request"]["before"]["source"], bundle["request"]["after"]["source"], "sale_badge")),
                ("render_pair", ("custom", True)),
                ("render_pair", ("reference", False)),
            ],
        )
        self.assertIn("provenance", out)
        self.assertIn("timings", out)
        self.assertIsInstance(out["timings"]["elapsed_ms"], int)

        spy_bad = ReplaySpyWorker(ref_mismatch=True)
        out_bad = runner.replay_bundle(bundle, worker=spy_bad)
        self.assertEqual(out_bad["status"], "failed")
        self.assertEqual(out_bad["error"]["code"], "reference_mismatch")

    def test_fresh_process_replay_deterministic_and_tamper_rejection(self) -> None:
        before_path = DEMO_DIR / "before.liquid"
        after_path = DEMO_DIR / "after.liquid"

        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            bundle_path = tmp / "demo-replay.json"

            cmp_proc = subprocess.run(
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
                    "256",
                    "--shrink-pairs",
                    "128",
                    "--replay-out",
                    str(bundle_path),
                ],
                cwd=str(REPO_ROOT),
                capture_output=True,
                text=True,
                encoding="utf-8",
                check=False,
            )
            self.assertEqual(cmp_proc.returncode, 1, f"stderr={cmp_proc.stderr}")
            self.assertEqual(cmp_proc.stderr, "")
            cmp_report = json.loads(cmp_proc.stdout)
            self.assertIn("minimized fixture", cmp_report["message"])
            self.assertLess(
                tuple(cmp_report["shrink"]["post_shrink_measure"]),
                tuple(cmp_report["shrink"]["pre_shrink_measure"]),
            )
            self.assertEqual(
                fixture_measure(cmp_report["finding"]["replay"]["fixture"]),
                tuple(cmp_report["shrink"]["post_shrink_measure"]),
            )

            # Run two independent fresh-process replays of the same bundle.
            rep1 = subprocess.run(
                [sys.executable, "-m", "search", "replay", "--bundle", str(bundle_path)],
                cwd=str(REPO_ROOT),
                capture_output=True,
                text=True,
                encoding="utf-8",
                check=False,
            )
            rep2 = subprocess.run(
                [sys.executable, "-m", "search", "replay", "--bundle", str(bundle_path)],
                cwd=str(REPO_ROOT),
                capture_output=True,
                text=True,
                encoding="utf-8",
                check=False,
            )
            self.assertEqual(rep1.returncode, 0, f"stderr={rep1.stderr}")
            self.assertEqual(rep2.returncode, 0, f"stderr={rep2.stderr}")
            self.assertEqual(rep1.stderr, "")
            self.assertEqual(rep2.stderr, "")

            d1 = json.loads(rep1.stdout)
            d2 = json.loads(rep2.stdout)
            det_keys = (
                "schema_version",
                "status",
                "direction",
                "reference_status",
                "finding",
                "product",
                "before",
                "after",
                "reference",
                "explanation",
                "replay",
                "provenance",
                "error",
            )
            for key in det_keys:
                self.assertEqual(d1[key], d2[key], f"Mismatch across fresh replays on {key}")
            self.assertEqual(d1["finding"], cmp_report["finding"])
            self.assertEqual(d1["before"]["html"], cmp_report["finding"]["before"]["html"])
            self.assertEqual(d1["after"]["html"], cmp_report["finding"]["after"]["html"])
            self.assertEqual(d1["before"]["events"], cmp_report["finding"]["before"]["events"])
            self.assertEqual(d1["after"]["events"], cmp_report["finding"]["after"]["events"])
            self.assertEqual(d1["reference"]["before"]["observed"], d1["before"]["observed"])
            self.assertEqual(d1["reference"]["after"]["observed"], d1["after"]["observed"])
            self.assertEqual(d1["reference"]["before"]["events"], [])
            self.assertEqual(d1["reference"]["after"]["events"], [])
            self.assertEqual(d1["replay"]["liquid_version"], "5.14.0")
            self.assertEqual(d1["explanation"]["kind"], "structural_change")
            self.assertEqual(d1["explanation"]["before"]["line"], 3)
            self.assertEqual(d1["explanation"]["after"]["line"], 1)

            # Tampering checks (must exit 2)
            base_bundle = json.loads(bundle_path.read_text(encoding="utf-8"))

            tamper_cases = [
                ("before_sha256", "0" * 64, "replay_hash_mismatch"),
                ("after_sha256", "f" * 64, "replay_hash_mismatch"),
                ("interpreter_version", "9.9.9", "replay_version_mismatch"),
                ("liquid_version", "4.0.0", "replay_version_mismatch"),
                ("projection_version", "2.0.0", "replay_version_mismatch"),
            ]
            for field, bad_val, expected_code in tamper_cases:
                bad_bundle = dict(base_bundle)
                bad_bundle[field] = bad_val
                bad_path = tmp / f"tamper-{field}.json"
                bad_path.write_text(canonical_json(bad_bundle), encoding="utf-8")
                t_proc = subprocess.run(
                    [sys.executable, "-m", "search", "replay", "--bundle", str(bad_path)],
                    cwd=str(REPO_ROOT),
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    check=False,
                )
                self.assertEqual(t_proc.returncode, 2, f"Expected exit 2 for {field}")
                self.assertIn(expected_code, t_proc.stderr)
                t_out = json.loads(t_proc.stdout)
                self.assertEqual(t_out["status"], "failed")
                self.assertEqual(t_out["error"]["code"], expected_code)

            # Missing file & malformed JSON -> exit 2
            missing_proc = subprocess.run(
                [sys.executable, "-m", "search", "replay", "--bundle", str(tmp / "missing.json")],
                cwd=str(REPO_ROOT),
                capture_output=True,
                text=True,
                encoding="utf-8",
                check=False,
            )
            self.assertEqual(missing_proc.returncode, 2)
            self.assertIn("bundle_read_error", missing_proc.stderr)

            bad_json_path = tmp / "bad.json"
            bad_json_path.write_text("{not-json", encoding="utf-8")
            bad_json_proc = subprocess.run(
                [sys.executable, "-m", "search", "replay", "--bundle", str(bad_json_path)],
                cwd=str(REPO_ROOT),
                capture_output=True,
                text=True,
                encoding="utf-8",
                check=False,
            )
            self.assertEqual(bad_json_proc.returncode, 2)
            self.assertIn("bundle_json_error", bad_json_proc.stderr)

    def test_acceptance_identical_snippets_negative_and_demo_without_witness(self) -> None:
        # Core acceptance check 1 & 2: fixtures/demo contains only Liquid snippets (no witness),
        # and identical snippets return scoped negative with exit 0.
        self.assertEqual(sorted(p.name for p in DEMO_DIR.iterdir()), ["after.liquid", "before.liquid"])
        before_path = DEMO_DIR / "before.liquid"
        ident_proc = subprocess.run(
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
                "128",
            ],
            cwd=str(REPO_ROOT),
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=False,
        )
        self.assertEqual(ident_proc.returncode, 0, f"stderr={ident_proc.stderr}")
        self.assertEqual(ident_proc.stderr, "")
        ident_report = json.loads(ident_proc.stdout)
        self.assertEqual(ident_report["status"], "no_difference_found")
        self.assertEqual(ident_report["message"], "no difference found within this search")
        self.assertEqual(ident_report["stats"]["search_pairs"], 16)
        self.assertEqual(ident_report["stats"]["shrink_pairs"], 0)
        self.assertEqual(ident_report["stats"]["exhausted_by"], "pair_limit")
        self.assertIsNone(ident_report["finding"])


if __name__ == "__main__":
    unittest.main()

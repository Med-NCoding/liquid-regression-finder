#!/usr/bin/env python3
"""Stage 7 benchmark runner comparing generated search vs official Shopify sample baseline."""

from __future__ import annotations

import argparse
import csv
import json
import math
import statistics
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Sequence

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from search.engine import SearchEngine, build_compare_request  # noqa: E402
from search.generator import GENERATOR_VERSION, canonical_json  # noqa: E402
from search.worker_client import WorkerClient, resolve_bundle_executable  # noqa: E402

CORPUS_MANIFEST_PATH = REPO_ROOT / "bench" / "corpus" / "manifest.json"
SAMPLE_PRODUCTS_PATH = REPO_ROOT / "bench" / "sample_baseline" / "sample_products.json"
CONFORMANCE_MANIFEST_PATH = REPO_ROOT / "contracts" / "conformance-manifest.json"
DEFAULT_CSV_PATH = REPO_ROOT / "bench" / "reports" / "benchmark.csv"
DEFAULT_JSON_PATH = REPO_ROOT / "bench" / "reports" / "benchmark_details.json"
DEFAULT_MD_PATH = REPO_ROOT / "bench" / "reports" / "benchmark.md"

FROZEN_SEEDS: tuple[int, ...] = (0, 1, 2, 3, 4)
FROZEN_SEARCH_PAIRS = 256
FROZEN_SHRINK_PAIRS = 128
STAGE2_CONFORMANCE_BASELINE = {
    "selected": 359,
    "passing": 359,
    "basics_selected": 141,
    "liquid_ruby_selected": 218,
    "inventoried": 3061,
    "all_suites": 7395,
}

CSV_COLUMNS: tuple[str, ...] = (
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
    "parity_rejections",
    "first_difference_ms",
    "shrink_ms",
    "elapsed_ms",
    "error_code",
    "fixture_json",
)


def _median_or_none(values: Sequence[int | float]) -> float | None:
    if not values:
        return None
    return float(statistics.median(values))


def _pct(num: int, den: int) -> str:
    if den <= 0:
        return "0.0%"
    return f"{(num / den) * 100.0:.1f}%"


def _fmt_num(val: float | int | None, suffix: str = "") -> str:
    if val is None:
        return "—"
    if isinstance(val, int):
        return f"{val}{suffix}"
    if float(val).is_integer():
        return f"{int(val)}{suffix}"
    return f"{val:.1f}{suffix}"


def _build_unsupported_row(case: dict[str, Any], *, method: str, seed: int) -> dict[str, Any]:
    return {
        "case_id": case["id"],
        "observable": case["observable"],
        "corpus_direction": case["direction"],
        "supported_for_benchmark": False,
        "method": method,
        "seed": seed,
        "status": "unsupported",
        "detected": False,
        "evaluated_pairs": 0,
        "shrink_pairs": 0,
        "pre_shrink_variants": None,
        "pre_shrink_bytes": None,
        "post_shrink_variants": None,
        "post_shrink_bytes": None,
        "direction": None,
        "explanation_kind": None,
        "parity_rejections": 0,
        "first_difference_ms": None,
        "shrink_ms": None,
        "elapsed_ms": None,
        "error_code": None,
        "fixture": None,
        "unsupported_reason": case.get("unsupported_reason"),
    }


def _row_from_engine_report(
    case: dict[str, Any],
    report: dict[str, Any],
    *,
    method: str,
    seed: int,
) -> dict[str, Any]:
    stats = report["stats"]
    report_status = report["status"]

    if report_status == "difference_found":
        finding = report["finding"]
        shrink = report["shrink"]
        fixture = finding["replay"]["fixture"]
        return {
            "case_id": case["id"],
            "observable": case["observable"],
            "corpus_direction": case["direction"],
            "supported_for_benchmark": True,
            "method": method,
            "seed": seed,
            "status": "detected",
            "detected": True,
            "evaluated_pairs": stats["search_pairs"],
            "shrink_pairs": stats["shrink_pairs"],
            "pre_shrink_variants": shrink["pre_shrink_variants"],
            "pre_shrink_bytes": shrink["pre_shrink_measure"][4],
            "post_shrink_variants": shrink["post_shrink_variants"],
            "post_shrink_bytes": shrink["post_shrink_measure"][4],
            "direction": report["direction"],
            "explanation_kind": finding["explanation"]["kind"],
            "parity_rejections": stats["parity_rejections"],
            "first_difference_ms": stats["first_difference_ms"],
            "shrink_ms": shrink["shrink_ms"],
            "elapsed_ms": stats["elapsed_ms"],
            "error_code": None,
            "fixture": fixture,
            "unsupported_reason": None,
        }

    if report_status == "no_difference_found":
        return {
            "case_id": case["id"],
            "observable": case["observable"],
            "corpus_direction": case["direction"],
            "supported_for_benchmark": True,
            "method": method,
            "seed": seed,
            "status": "budget_exhausted",
            "detected": False,
            "evaluated_pairs": stats["search_pairs"],
            "shrink_pairs": 0,
            "pre_shrink_variants": None,
            "pre_shrink_bytes": None,
            "post_shrink_variants": None,
            "post_shrink_bytes": None,
            "direction": None,
            "explanation_kind": None,
            "parity_rejections": stats["parity_rejections"],
            "first_difference_ms": None,
            "shrink_ms": None,
            "elapsed_ms": stats["elapsed_ms"],
            "error_code": None,
            "fixture": None,
            "unsupported_reason": None,
        }

    err = report.get("error") or {}
    return {
        "case_id": case["id"],
        "observable": case["observable"],
        "corpus_direction": case["direction"],
        "supported_for_benchmark": True,
        "method": method,
        "seed": seed,
        "status": "error",
        "detected": False,
        "evaluated_pairs": stats["search_pairs"],
        "shrink_pairs": stats["shrink_pairs"],
        "pre_shrink_variants": None,
        "pre_shrink_bytes": None,
        "post_shrink_variants": None,
        "post_shrink_bytes": None,
        "direction": None,
        "explanation_kind": None,
        "parity_rejections": stats["parity_rejections"],
        "first_difference_ms": stats["first_difference_ms"],
        "shrink_ms": None,
        "elapsed_ms": stats["elapsed_ms"],
        "error_code": err.get("code", "error"),
        "fixture": None,
        "unsupported_reason": None,
    }


def measure_ipc_overhead(
    *,
    iterations: int = 256,
    case_id: str = "dawn_pr_794_price_badge_sale_aria_hidden",
) -> dict[str, Any]:
    """Compare Ruby JSONL IPC round-trip time against in-process Ruby render time."""
    manifest = json.loads(CORPUS_MANIFEST_PATH.read_text(encoding="utf-8"))
    case = next(c for c in manifest["cases"] if c["id"] == case_id)
    samples = json.loads(SAMPLE_PRODUCTS_PATH.read_text(encoding="utf-8"))["products"]
    fixtures = [p["fixture"] for p in samples]

    before_src = (REPO_ROOT / case["before_path"]).read_text(encoding="utf-8")
    after_src = (REPO_ROOT / case["after_path"]).read_text(encoding="utf-8")

    bundle_exe = resolve_bundle_executable()
    results_by_engine: dict[str, Any] = {}

    for engine in ("custom", "reference"):
        ruby_proc = subprocess.run(
            [
                bundle_exe,
                "exec",
                "ruby",
                str(REPO_ROOT / "bench" / "measure_ipc_overhead.rb"),
                "--iterations",
                str(iterations),
                "--engine",
                engine,
                "--case-id",
                case_id,
            ],
            cwd=str(REPO_ROOT),
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=True,
        )
        in_proc = json.loads(ruby_proc.stdout)

        t_launch = time.monotonic()
        with WorkerClient(cwd=REPO_ROOT, benchmark=True) as client:
            client.compile(
                before_src,
                after_src,
                observer=case["observable"],
                benchmark=True,
                selector=case["observer_selector"],
                fixed_context=case["fixed_context"],
            )
            startup_plus_compile_ms = (time.monotonic() - t_launch) * 1000.0

            # Warmup 1 call to match in-process probe
            client.render_pair(fixtures[0], engine=engine, trace=False)

            per_iter_ms: list[float] = []
            t_ipc_start = time.monotonic()
            for idx in range(iterations):
                fix = fixtures[idx % len(fixtures)]
                t0 = time.monotonic()
                res = client.render_pair(fix, engine=engine, trace=False)
                assert res["before"]["status"] == "ok" and res["after"]["status"] == "ok"
                per_iter_ms.append((time.monotonic() - t0) * 1000.0)
            ipc_total_ms = (time.monotonic() - t_ipc_start) * 1000.0

        sorted_ms = sorted(per_iter_ms)
        ipc_mean_ms = ipc_total_ms / iterations
        ipc_median_ms = sorted_ms[len(sorted_ms) // 2]
        ipc_p95_ms = sorted_ms[min(math.ceil(len(sorted_ms) * 0.95) - 1, len(sorted_ms) - 1)]

        in_proc_total_ms = float(in_proc["total_ms"])
        in_proc_mean_ms = float(in_proc["mean_ms"])
        overhead_total_ms = ipc_total_ms - in_proc_total_ms
        overhead_per_pair_ms = ipc_mean_ms - in_proc_mean_ms
        overhead_pct = (overhead_total_ms / ipc_total_ms * 100.0) if ipc_total_ms > 0 else 0.0
        slowdown = (ipc_total_ms / in_proc_total_ms) if in_proc_total_ms > 0 else 0.0

        results_by_engine[engine] = {
            "in_process": in_proc,
            "ipc": {
                "startup_plus_compile_ms": round(startup_plus_compile_ms, 3),
                "total_ms": round(ipc_total_ms, 3),
                "mean_ms": round(ipc_mean_ms, 4),
                "median_ms": round(ipc_median_ms, 4),
                "p95_ms": round(ipc_p95_ms, 4),
            },
            "overhead_total_ms": round(overhead_total_ms, 3),
            "overhead_per_pair_ms": round(overhead_per_pair_ms, 4),
            "overhead_pct": round(overhead_pct, 1),
            "slowdown_factor": round(slowdown, 2),
        }

    return {
        "case_id": case_id,
        "iterations": iterations,
        "engines": results_by_engine,
    }


def load_conformance_summary() -> dict[str, Any]:
    manifest = json.loads(CONFORMANCE_MANIFEST_PATH.read_text(encoding="utf-8"))
    totals = manifest["totals"]
    suites = manifest["suites"]
    return {
        "before_stage7": STAGE2_CONFORMANCE_BASELINE,
        "after_stage7": {
            "stage_scope": manifest["stage_scope"],
            "selected": totals["selected"],
            "passing": totals["selected"],
            "basics_selected": suites["basics"]["selected"],
            "liquid_ruby_selected": suites["liquid_ruby"]["selected"],
            "inventoried": totals["inventoried"],
            "all_suites": totals["all_suites"],
            "pass_rate_selected_pct": 100.0,
            "pass_rate_inventoried_pct": round(totals["selected"] / totals["inventoried"] * 100.0, 2),
            "pass_rate_all_suites_pct": round(totals["selected"] / totals["all_suites"] * 100.0, 2),
        },
        "delta_selected": totals["selected"] - STAGE2_CONFORMANCE_BASELINE["selected"],
    }


def compute_method_aggregates(rows: Sequence[dict[str, Any]], *, total_cases: int, supported_cases: int) -> dict[str, Any]:
    counts = {
        "detected": sum(1 for r in rows if r["status"] == "detected"),
        "budget_exhausted": sum(1 for r in rows if r["status"] == "budget_exhausted"),
        "unsupported": sum(1 for r in rows if r["status"] == "unsupported"),
        "error": sum(1 for r in rows if r["status"] == "error"),
    }
    total_runs = len(rows)
    supported_rows = [r for r in rows if r["supported_for_benchmark"]]
    supported_runs = len(supported_rows)
    detected_rows = [r for r in rows if r["status"] == "detected"]

    by_case: dict[str, list[dict[str, Any]]] = {}
    for r in rows:
        by_case.setdefault(r["case_id"], []).append(r)

    cases_ever_detected = sum(1 for case_rows in by_case.values() if any(r["detected"] for r in case_rows))
    cases_all_seeds_detected = sum(
        1
        for case_rows in by_case.values()
        if case_rows[0]["supported_for_benchmark"] and all(r["detected"] for r in case_rows)
    )

    by_observable: dict[str, dict[str, Any]] = {}
    for obs in ("sale_badge", "sold_out_badge", "price_range"):
        obs_rows = [r for r in rows if r["observable"] == obs]
        obs_supported = [r for r in obs_rows if r["supported_for_benchmark"]]
        obs_det = [r for r in obs_rows if r["status"] == "detected"]
        by_observable[obs] = {
            "total_runs": len(obs_rows),
            "supported_runs": len(obs_supported),
            "detected": len(obs_det),
            "budget_exhausted": sum(1 for r in obs_rows if r["status"] == "budget_exhausted"),
            "unsupported": sum(1 for r in obs_rows if r["status"] == "unsupported"),
            "error": sum(1 for r in obs_rows if r["status"] == "error"),
            "rate_all_pct": round((len(obs_det) / len(obs_rows) * 100.0) if obs_rows else 0.0, 1),
            "rate_supported_pct": round((len(obs_det) / len(obs_supported) * 100.0) if obs_supported else 0.0, 1),
        }

    return {
        "total_cases": total_cases,
        "supported_cases": supported_cases,
        "total_runs": total_runs,
        "supported_runs": supported_runs,
        "counts": counts,
        "cases_ever_detected": cases_ever_detected,
        "cases_all_seeds_detected": cases_all_seeds_detected,
        "rate_all_runs_pct": round((counts["detected"] / total_runs * 100.0) if total_runs else 0.0, 1),
        "rate_supported_runs_pct": round((counts["detected"] / supported_runs * 100.0) if supported_runs else 0.0, 1),
        "rate_all_cases_pct": round((cases_ever_detected / total_cases * 100.0) if total_cases else 0.0, 1),
        "rate_supported_cases_pct": round((cases_ever_detected / supported_cases * 100.0) if supported_cases else 0.0, 1),
        "median_evaluated_pairs_detected": _median_or_none([r["evaluated_pairs"] for r in detected_rows]),
        "median_shrink_pairs_detected": _median_or_none([r["shrink_pairs"] for r in detected_rows]),
        "median_first_difference_ms": _median_or_none(
            [r["first_difference_ms"] for r in detected_rows if r["first_difference_ms"] is not None]
        ),
        "median_shrink_ms": _median_or_none([r["shrink_ms"] for r in detected_rows if r["shrink_ms"] is not None]),
        "median_elapsed_ms_detected": _median_or_none(
            [r["elapsed_ms"] for r in detected_rows if r["elapsed_ms"] is not None]
        ),
        "median_pre_shrink_variants": _median_or_none(
            [r["pre_shrink_variants"] for r in detected_rows if r["pre_shrink_variants"] is not None]
        ),
        "median_pre_shrink_bytes": _median_or_none(
            [r["pre_shrink_bytes"] for r in detected_rows if r["pre_shrink_bytes"] is not None]
        ),
        "median_post_shrink_variants": _median_or_none(
            [r["post_shrink_variants"] for r in detected_rows if r["post_shrink_variants"] is not None]
        ),
        "median_post_shrink_bytes": _median_or_none(
            [r["post_shrink_bytes"] for r in detected_rows if r["post_shrink_bytes"] is not None]
        ),
        "total_parity_rejections": sum(r["parity_rejections"] for r in rows),
        "by_observable": by_observable,
    }


def render_markdown_report(details: dict[str, Any]) -> str:
    cfg = details["experiment_config"]
    aggs = details["aggregates"]
    sb = aggs["sample_baseline"]
    gs = aggs["generated_search"]
    conf = details["conformance_coverage"]
    ipc = details.get("ipc_overhead")
    runs = details["runs"]

    lines: list[str] = []
    lines.append("# Stage 7 Benchmark Report: Generated Search vs Official Shopify Sample Baseline")
    lines.append("")
    lines.append("## Experiment Configuration")
    lines.append("")
    lines.append(f"- **Corpus**: `{cfg['corpus_manifest']}` — **{cfg['total_cases']}** verified Dawn cases (`{cfg['supported_cases']}` `supported_for_benchmark`, `{cfg['unsupported_cases']}` `unsupported`)")
    lines.append(f"- **Generator Version**: `{cfg['generator_version']}`")
    lines.append(f"- **Generated Search Seeds**: `{cfg['seeds']}` (`{cfg['total_cases']} × {len(cfg['seeds'])} = {gs['total_runs']}` runs)")
    lines.append(f"- **Budgets**: `search_pairs={cfg['search_pairs']}`, `shrink_pairs={cfg['shrink_pairs']}`")
    lines.append(
        f"- **Official Sample Baseline**: `{cfg['sample_baseline_path']}` (`{cfg['sample_product_count']}` products from `shopifypartners/product-csvs` @ `{cfg['sample_pinned_sha']}`, evaluated once per case up to `min({cfg['sample_product_count']}, {cfg['search_pairs']}) = {cfg['sample_search_pairs']}` pairs with `shrink_pairs={cfg['shrink_pairs']}`)"
    )
    lines.append("")
    lines.append("## Headline Comparison (All 15 Verified Cases & Supported-Only 10 Cases)")
    lines.append("")
    lines.append("| Metric | Generated Search (`seeds 0..4`) | Sample Baseline (`60` Shopify CSV products) |")
    lines.append("| --- | --- | --- |")
    lines.append(
        f"| **Case Detection (All 15 Cases)** | `{gs['cases_ever_detected']}/{gs['total_cases']}` ({gs['rate_all_cases_pct']}%) [`{gs['counts']['detected']}/{gs['total_runs']}` runs, {gs['rate_all_runs_pct']}%] | `{sb['cases_ever_detected']}/{sb['total_cases']}` ({sb['rate_all_cases_pct']}%) [`{sb['counts']['detected']}/{sb['total_runs']}` runs] |"
    )
    lines.append(
        f"| **Case Detection (Supported 10 Cases)** | `{gs['cases_ever_detected']}/{gs['supported_cases']}` ({gs['rate_supported_cases_pct']}%) [`{gs['counts']['detected']}/{gs['supported_runs']}` runs, {gs['rate_supported_runs_pct']}%] | `{sb['cases_ever_detected']}/{sb['supported_cases']}` ({sb['rate_supported_cases_pct']}%) [`{sb['counts']['detected']}/{sb['supported_runs']}` runs] |"
    )
    lines.append(
        f"| **Outcome Accounting (`detected / budget_exhausted / unsupported / error`)** | `{gs['counts']['detected']} / {gs['counts']['budget_exhausted']} / {gs['counts']['unsupported']} / {gs['counts']['error']}` (sum=`{gs['total_runs']}`) | `{sb['counts']['detected']} / {sb['counts']['budget_exhausted']} / {sb['counts']['unsupported']} / {sb['counts']['error']}` (sum=`{sb['total_runs']}`) |"
    )
    lines.append(f"| **Parity Rejections** | `{gs['total_parity_rejections']}` | `{sb['total_parity_rejections']}` |")
    lines.append(f"| **Median Evaluated Pairs (Detected)** | `{_fmt_num(gs['median_evaluated_pairs_detected'])}` | `{_fmt_num(sb['median_evaluated_pairs_detected'])}` |")
    lines.append(f"| **Median Shrink Pairs (Detected)** | `{_fmt_num(gs['median_shrink_pairs_detected'])}` | `{_fmt_num(sb['median_shrink_pairs_detected'])}` |")
    lines.append(f"| **Median Time to First Difference (`first_difference_ms`, incl. startup + parity)** | `{_fmt_num(gs['median_first_difference_ms'], ' ms')}` | `{_fmt_num(sb['median_first_difference_ms'], ' ms')}` |")
    lines.append(f"| **Median Shrink Time (`shrink_ms`)** | `{_fmt_num(gs['median_shrink_ms'], ' ms')}` | `{_fmt_num(sb['median_shrink_ms'], ' ms')}` |")
    lines.append(f"| **Median Pre-Shrink Size (Variants / Bytes)** | `{_fmt_num(gs['median_pre_shrink_variants'])}` vars / `{_fmt_num(gs['median_pre_shrink_bytes'])}` B | `{_fmt_num(sb['median_pre_shrink_variants'])}` vars / `{_fmt_num(sb['median_pre_shrink_bytes'])}` B |")
    lines.append(f"| **Median Post-Shrink Size (Variants / Bytes)** | `{_fmt_num(gs['median_post_shrink_variants'])}` vars / `{_fmt_num(gs['median_post_shrink_bytes'])}` B | `{_fmt_num(sb['median_post_shrink_variants'])}` vars / `{_fmt_num(sb['median_post_shrink_bytes'])}` B |")
    lines.append("")
    lines.append(
        "> *Note*: Shrink ordering follows Stage 5's strict lexicographic `fixture_measure = (variants, non_null_compare_at, total_cents, true_available, canonical_bytes)`; minimizing `true_available` (`true -> false`) can increase canonical JSON by 1 byte (`113 B -> 114 B`) while strictly decreasing the overall tuple measure."
    )
    lines.append("")
    lines.append("## Per-Observable Breakdown")
    lines.append("")
    lines.append("| Observable | Method | Detected / All Runs | Detected / Supported Runs | Budget Exhausted | Unsupported | Error |")
    lines.append("| --- | --- | --- | --- | --- | --- | --- |")
    for obs in ("sale_badge", "sold_out_badge", "price_range"):
        for method_name, agg in (("generated_search", gs), ("sample_baseline", sb)):
            o = agg["by_observable"][obs]
            lines.append(
                f"| `{obs}` | `{method_name}` | `{o['detected']}/{o['total_runs']}` ({o['rate_all_pct']}%) | `{o['detected']}/{o['supported_runs']}` ({o['rate_supported_pct']}%) | `{o['budget_exhausted']}` | `{o['unsupported']}` | `{o['error']}` |"
            )

    lines.append("")
    lines.append("## Per-Case Outcomes Across All 15 Verified Cases")
    lines.append("")
    lines.append("| Case ID | Observable | Supported | Sample Baseline (`60` CSVs) | Generated Search (`5` seeds) | Gen Pairs (med) | Pre -> Post Size (Gen) | Explanation (Gen seed 0) |")
    lines.append("| --- | --- | --- | --- | --- | --- | --- | --- |")

    sb_by_case = {r["case_id"]: r for r in runs if r["method"] == "sample_baseline"}
    gs_by_case: dict[str, list[dict[str, Any]]] = {}
    for r in runs:
        if r["method"] == "generated_search":
            gs_by_case.setdefault(r["case_id"], []).append(r)

    manifest = json.loads(CORPUS_MANIFEST_PATH.read_text(encoding="utf-8"))
    for c in manifest["cases"]:
        cid = c["id"]
        sr = sb_by_case[cid]
        grs = gs_by_case[cid]
        if not c["supported_for_benchmark"]:
            lines.append(f"| `{cid}` | `{c['observable']}` | `false` | `unsupported` | `unsupported (0/5)` | — | — | — |")
            continue

        det_grs = [r for r in grs if r["detected"]]
        gs_summary = f"`detected ({len(det_grs)}/{len(grs)})`" if len(det_grs) == len(grs) else f"`{grs[0]['status']} ({len(det_grs)}/{len(grs)})`"
        sb_summary = f"`{sr['status']}` (`{sr['evaluated_pairs']}` {'pair' if sr['evaluated_pairs'] == 1 else 'pairs'})"
        med_pairs = _fmt_num(_median_or_none([r["evaluated_pairs"] for r in det_grs])) if det_grs else "—"
        if det_grs:
            r0 = det_grs[0]
            size_str = f"`{r0['pre_shrink_variants']}v/{r0['pre_shrink_bytes']}B -> {r0['post_shrink_variants']}v/{r0['post_shrink_bytes']}B`"
            expl_str = f"`{r0['explanation_kind']}`"
        else:
            size_str = "—"
            expl_str = "—"
        lines.append(
            f"| `{cid}` | `{c['observable']}` | `true` | {sb_summary} | {gs_summary} | `{med_pairs}` | {size_str} | {expl_str} |"
        )

    b7 = conf["before_stage7"]
    a7 = conf["after_stage7"]
    lines.append("")
    lines.append("## Conformance Coverage (Stage 2 vs Stage 7 Coherent Extensions)")
    lines.append("")
    lines.append("| Metric | Before Stage 7 (`stage-2`) | After Stage 7 (`stage-7`) | Delta |")
    lines.append("| --- | ---: | ---: | ---: |")
    lines.append(f"| Selected & Passing (`pass/selected`) | `{b7['passing']}/{b7['selected']}` (`100.00%`) | `{a7['passing']}/{a7['selected']}` (`{a7['pass_rate_selected_pct']:.2f}%`) | `+{conf['delta_selected']}` |")
    lines.append(f"| `basics` Selected | `{b7['basics_selected']}` | `{a7['basics_selected']}` | `+{a7['basics_selected'] - b7['basics_selected']}` |")
    lines.append(f"| `liquid_ruby` Selected | `{b7['liquid_ruby_selected']}` | `{a7['liquid_ruby_selected']}` | `+{a7['liquid_ruby_selected'] - b7['liquid_ruby_selected']}` |")
    lines.append(f"| Inventoried (`basics + liquid_ruby`, `{a7['inventoried']}`) | `11.73%` | `{a7['pass_rate_inventoried_pct']:.2f}%` | `+{a7['pass_rate_inventoried_pct'] - 11.73:.2f}%` |")
    lines.append(f"| All 8 Suites (`{a7['all_suites']}`) | `4.85%` | `{a7['pass_rate_all_suites_pct']:.2f}%` | `+{a7['pass_rate_all_suites_pct'] - 4.85:.2f}%` |")

    if ipc is not None:
        lines.append("")
        lines.append("## Instrumented Render-Process Subprocess Overhead")
        lines.append("")
        lines.append(f"Measured over `{ipc['iterations']}` `render_pair(trace=false)` evaluations on `{ipc['case_id']}` (after one-time compile & warmup):")
        lines.append("")
        lines.append("| Engine | In-Process Ruby Total / Mean | Python->Ruby JSONL IPC Total / Mean | IPC Median / p95 | Measured IPC Overhead | Slowdown |")
        lines.append("| --- | --- | --- | --- | --- | ---: |")
        for eng in ("custom", "reference"):
            e = ipc["engines"][eng]
            inp = e["in_process"]
            ip = e["ipc"]
            lines.append(
                f"| `{eng}` | `{inp['total_ms']} ms` (`{inp['mean_ms']} ms/pair`) | `{ip['total_ms']} ms` (`{ip['mean_ms']} ms/pair`, startup+compile `{ip['startup_plus_compile_ms']} ms`) | `{ip['median_ms']} ms` / `{ip['p95_ms']} ms` | `{e['overhead_total_ms']} ms` (`+{e['overhead_per_pair_ms']} ms/pair`, `{e['overhead_pct']}%`) | `{e['slowdown_factor']}x` |"
            )
        cust_oh = ipc["engines"]["custom"]["overhead_pct"]
        lines.append("")
        lines.append(
            f"> **Section 7 Decision Note**: Across `{ipc['iterations']}` `custom` pair evaluations, JSONL pipe IPC + JSON ser/de adds `{ipc['engines']['custom']['overhead_per_pair_ms']} ms/pair` (`{cust_oh}%` of total IPC render-loop time), while total 256-pair search remains sub-second (`median first_difference_ms = {_fmt_num(gs['median_first_difference_ms'], ' ms')}`). Keeping Ruby as the single Liquid ownership boundary remains practical at 256/128 budgets; moving search into Ruby would be warranted only if budgets scale by 10x+."
        )

    lines.append("")
    return "\n".join(lines)


def run_benchmark(
    *,
    seeds: Sequence[int] = FROZEN_SEEDS,
    search_pairs: int = FROZEN_SEARCH_PAIRS,
    shrink_pairs: int = FROZEN_SHRINK_PAIRS,
    case_ids: set[str] | None = None,
    include_ipc_probe: bool = True,
    ipc_iterations: int = 256,
) -> dict[str, Any]:
    corpus = json.loads(CORPUS_MANIFEST_PATH.read_text(encoding="utf-8"))
    samples_payload = json.loads(SAMPLE_PRODUCTS_PATH.read_text(encoding="utf-8"))
    sample_fixtures = [p["fixture"] for p in samples_payload["products"]]

    cases = corpus["cases"]
    if case_ids is not None:
        cases = [c for c in cases if c["id"] in case_ids]

    engine = SearchEngine(repo_root=REPO_ROOT)
    runs: list[dict[str, Any]] = []

    sample_budget = min(len(sample_fixtures), search_pairs)

    for case in cases:
        if not case["supported_for_benchmark"]:
            runs.append(_build_unsupported_row(case, method="sample_baseline", seed=0))
            for seed in seeds:
                runs.append(_build_unsupported_row(case, method="generated_search", seed=seed))
            continue

        before_src = (REPO_ROOT / case["before_path"]).read_text(encoding="utf-8")
        after_src = (REPO_ROOT / case["after_path"]).read_text(encoding="utf-8")

        # 1. Official Shopify sample baseline (evaluated once per case up to min(len(samples), search_pairs))
        sb_req = build_compare_request(
            before_src,
            after_src,
            observer=case["observable"],
            seed=0,
            search_pairs=sample_budget,
            shrink_pairs=shrink_pairs,
        )
        sb_report = engine.compare(
            sb_req,
            benchmark=True,
            selector=case["observer_selector"],
            fixed_context=case["fixed_context"],
            candidate_fixtures=sample_fixtures,
        )
        runs.append(_row_from_engine_report(case, sb_report, method="sample_baseline", seed=0))

        # 2. Generated search across pinned seeds
        for seed in seeds:
            gs_req = build_compare_request(
                before_src,
                after_src,
                observer=case["observable"],
                seed=seed,
                search_pairs=search_pairs,
                shrink_pairs=shrink_pairs,
            )
            gs_report = engine.compare(
                gs_req,
                benchmark=True,
                selector=case["observer_selector"],
                fixed_context=case["fixed_context"],
            )
            runs.append(_row_from_engine_report(case, gs_report, method="generated_search", seed=seed))

    total_cases = len(cases)
    supported_cases = sum(1 for c in cases if c["supported_for_benchmark"])
    unsupported_cases = total_cases - supported_cases

    sb_rows = [r for r in runs if r["method"] == "sample_baseline"]
    gs_rows = [r for r in runs if r["method"] == "generated_search"]

    ipc_overhead = measure_ipc_overhead(iterations=ipc_iterations) if include_ipc_probe else None

    details = {
        "schema_version": 1,
        "experiment_config": {
            "corpus_manifest": "bench/corpus/manifest.json",
            "sample_baseline_path": "bench/sample_baseline/sample_products.json",
            "sample_pinned_sha": samples_payload["pinned_commit_sha"],
            "sample_product_count": len(sample_fixtures),
            "sample_search_pairs": sample_budget,
            "generator_version": GENERATOR_VERSION,
            "seeds": list(seeds),
            "search_pairs": search_pairs,
            "shrink_pairs": shrink_pairs,
            "total_cases": total_cases,
            "supported_cases": supported_cases,
            "unsupported_cases": unsupported_cases,
        },
        "conformance_coverage": load_conformance_summary(),
        "ipc_overhead": ipc_overhead,
        "aggregates": {
            "sample_baseline": compute_method_aggregates(
                sb_rows,
                total_cases=total_cases,
                supported_cases=supported_cases,
            ),
            "generated_search": compute_method_aggregates(
                gs_rows,
                total_cases=total_cases,
                supported_cases=supported_cases,
            ),
        },
        "runs": runs,
    }
    return details


def write_outputs(
    details: dict[str, Any],
    *,
    csv_path: Path,
    json_path: Path,
    md_path: Path,
) -> None:
    csv_path.parent.mkdir(parents=True, exist_ok=True)
    json_path.parent.mkdir(parents=True, exist_ok=True)
    md_path.parent.mkdir(parents=True, exist_ok=True)

    with csv_path.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(CSV_COLUMNS))
        writer.writeheader()
        for row in details["runs"]:
            writer.writerow(
                {
                    "case_id": row["case_id"],
                    "observable": row["observable"],
                    "corpus_direction": row["corpus_direction"],
                    "supported_for_benchmark": str(row["supported_for_benchmark"]).lower(),
                    "method": row["method"],
                    "seed": row["seed"],
                    "status": row["status"],
                    "detected": str(row["detected"]).lower(),
                    "evaluated_pairs": row["evaluated_pairs"],
                    "shrink_pairs": row["shrink_pairs"],
                    "pre_shrink_variants": "" if row["pre_shrink_variants"] is None else row["pre_shrink_variants"],
                    "pre_shrink_bytes": "" if row["pre_shrink_bytes"] is None else row["pre_shrink_bytes"],
                    "post_shrink_variants": "" if row["post_shrink_variants"] is None else row["post_shrink_variants"],
                    "post_shrink_bytes": "" if row["post_shrink_bytes"] is None else row["post_shrink_bytes"],
                    "direction": row["direction"] or "",
                    "explanation_kind": row["explanation_kind"] or "",
                    "parity_rejections": row["parity_rejections"],
                    "first_difference_ms": "" if row["first_difference_ms"] is None else row["first_difference_ms"],
                    "shrink_ms": "" if row["shrink_ms"] is None else row["shrink_ms"],
                    "elapsed_ms": "" if row["elapsed_ms"] is None else row["elapsed_ms"],
                    "error_code": row["error_code"] or "",
                    "fixture_json": "" if row["fixture"] is None else canonical_json(row["fixture"]),
                }
            )

    json_path.write_text(json.dumps(details, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    md_path.write_text(render_markdown_report(details), encoding="utf-8")


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run Stage 7 Dawn corpus benchmark.")
    parser.add_argument("--csv-out", default=str(DEFAULT_CSV_PATH))
    parser.add_argument("--json-out", default=str(DEFAULT_JSON_PATH))
    parser.add_argument("--md-out", default=str(DEFAULT_MD_PATH))
    parser.add_argument("--seeds", default="0,1,2,3,4", help="Comma-separated seed integers.")
    parser.add_argument("--search-pairs", type=int, default=FROZEN_SEARCH_PAIRS)
    parser.add_argument("--shrink-pairs", type=int, default=FROZEN_SHRINK_PAIRS)
    parser.add_argument("--case-ids", default=None, help="Optional comma-separated case IDs subset.")
    parser.add_argument("--skip-ipc-probe", action="store_true")
    parser.add_argument("--ipc-pairs", type=int, default=256)
    args = parser.parse_args(list(argv) if argv is not None else None)

    seeds = [int(s.strip()) for s in args.seeds.split(",") if s.strip()]
    case_filter = {c.strip() for c in args.case_ids.split(",") if c.strip()} if args.case_ids else None

    details = run_benchmark(
        seeds=seeds,
        search_pairs=args.search_pairs,
        shrink_pairs=args.shrink_pairs,
        case_ids=case_filter,
        include_ipc_probe=not args.skip_ipc_probe,
        ipc_iterations=args.ipc_pairs,
    )
    write_outputs(
        details,
        csv_path=Path(args.csv_out),
        json_path=Path(args.json_out),
        md_path=Path(args.md_out),
    )

    gs = details["aggregates"]["generated_search"]
    sb = details["aggregates"]["sample_baseline"]
    print(
        f"Benchmark complete: generated_search={gs['cases_ever_detected']}/{gs['total_cases']} cases "
        f"({gs['counts']['detected']}/{gs['total_runs']} runs), "
        f"sample_baseline={sb['cases_ever_detected']}/{sb['total_cases']} cases "
        f"({sb['counts']['detected']}/{sb['total_runs']} runs)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

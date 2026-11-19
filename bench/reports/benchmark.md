# Stage 7 Benchmark Report: Generated Search vs Official Shopify Sample Baseline

## Experiment Configuration

- **Corpus**: `bench/corpus/manifest.json` — **15** verified Dawn cases (`10` `supported_for_benchmark`, `5` `unsupported`)
- **Generator Version**: `1.0.0`
- **Generated Search Seeds**: `[0, 1, 2, 3, 4]` (`15 × 5 = 75` runs)
- **Budgets**: `search_pairs=256`, `shrink_pairs=128`
- **Official Sample Baseline**: `bench/sample_baseline/sample_products.json` (`60` products from `shopifypartners/product-csvs` @ `045fb432d85dc59d558717208399176d62bf106d`, evaluated once per case up to `min(60, 256) = 60` pairs with `shrink_pairs=128`)

## Headline Comparison (All 15 Verified Cases & Supported-Only 10 Cases)

| Metric | Generated Search (`seeds 0..4`) | Sample Baseline (`60` Shopify CSV products) |
| --- | --- | --- |
| **Case Detection (All 15 Cases)** | `10/15` (66.7%) [`50/75` runs, 66.7%] | `9/15` (60.0%) [`9/15` runs] |
| **Case Detection (Supported 10 Cases)** | `10/10` (100.0%) [`50/50` runs, 100.0%] | `9/10` (90.0%) [`9/10` runs] |
| **Outcome Accounting (`detected / budget_exhausted / unsupported / error`)** | `50 / 0 / 25 / 0` (sum=`75`) | `9 / 1 / 5 / 0` (sum=`15`) |
| **Parity Rejections** | `0` | `0` |
| **Median Evaluated Pairs (Detected)** | `3.5` | `22` |
| **Median Shrink Pairs (Detected)** | `1` | `2` |
| **Median Time to First Difference (`first_difference_ms`, incl. startup + parity)** | `249 ms` | `255 ms` |
| **Median Shrink Time (`shrink_ms`)** | `0 ms` | `1 ms` |
| **Median Pre-Shrink Size (Variants / Bytes)** | `1` vars / `113.5` B | `1` vars / `116` B |
| **Median Post-Shrink Size (Variants / Bytes)** | `1` vars / `114` B | `1` vars / `114` B |

> *Note*: Shrink ordering follows Stage 5's strict lexicographic `fixture_measure = (variants, non_null_compare_at, total_cents, true_available, canonical_bytes)`; minimizing `true_available` (`true -> false`) can increase canonical JSON by 1 byte (`113 B -> 114 B`) while strictly decreasing the overall tuple measure.

## Per-Observable Breakdown

| Observable | Method | Detected / All Runs | Detected / Supported Runs | Budget Exhausted | Unsupported | Error |
| --- | --- | --- | --- | --- | --- | --- |
| `sale_badge` | `generated_search` | `10/20` (50.0%) | `10/10` (100.0%) | `0` | `10` | `0` |
| `sale_badge` | `sample_baseline` | `2/4` (50.0%) | `2/2` (100.0%) | `0` | `2` | `0` |
| `sold_out_badge` | `generated_search` | `15/25` (60.0%) | `15/15` (100.0%) | `0` | `10` | `0` |
| `sold_out_badge` | `sample_baseline` | `3/5` (60.0%) | `3/3` (100.0%) | `0` | `2` | `0` |
| `price_range` | `generated_search` | `25/30` (83.3%) | `25/25` (100.0%) | `0` | `5` | `0` |
| `price_range` | `sample_baseline` | `4/6` (66.7%) | `4/5` (80.0%) | `1` | `1` | `0` |

## Per-Case Outcomes Across All 15 Verified Cases

| Case ID | Observable | Supported | Sample Baseline (`60` CSVs) | Generated Search (`5` seeds) | Gen Pairs (med) | Pre -> Post Size (Gen) | Explanation (Gen seed 0) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `dawn_pr_589_card_badge_aria_hidden` | `sale_badge` | `true` | `detected` (`22` pairs) | `detected (5/5)` | `3` | `1v/112B -> 1v/110B` | `undetermined` |
| `dawn_pr_794_price_badge_sale_aria_hidden` | `sale_badge` | `true` | `detected` (`22` pairs) | `detected (5/5)` | `3` | `1v/112B -> 1v/111B` | `undetermined` |
| `dawn_pr_1938_horizontal_card_badge_suppressed` | `sale_badge` | `false` | `unsupported` | `unsupported (0/5)` | — | — | — |
| `dawn_pr_3144_b2b_card_sale_badge_restricted` | `sale_badge` | `false` | `unsupported` | `unsupported (0/5)` | — | — | — |
| `dawn_pr_3487_quick_add_bulk_sold_out` | `sold_out_badge` | `true` | `detected` (`26` pairs) | `detected (5/5)` | `4` | `1v/114B -> 1v/114B` | `undetermined` |
| `dawn_pr_1610_quick_add_single_variant_sold_out` | `sold_out_badge` | `true` | `detected` (`26` pairs) | `detected (5/5)` | `4` | `1v/114B -> 1v/114B` | `structural_change` |
| `dawn_pr_3293_quick_add_bulk_ghost_sold_out` | `sold_out_badge` | `true` | `detected` (`26` pairs) | `detected (5/5)` | `4` | `1v/114B -> 1v/114B` | `structural_change` |
| `dawn_pr_2255_buy_buttons_untracked_inventory` | `sold_out_badge` | `false` | `unsupported` | `unsupported (0/5)` | — | — | — |
| `dawn_pr_3246_price_nil_target_sold_out` | `sold_out_badge` | `false` | `unsupported` | `unsupported (0/5)` | — | — | — |
| `dawn_pr_3574_use_variant_volume_price_range` | `price_range` | `true` | `detected` (`1` pair) | `detected (5/5)` | `1` | `1v/113B -> 1v/114B` | `structural_change` |
| `dawn_pr_2791_volume_pricing_price_range` | `price_range` | `true` | `detected` (`1` pair) | `detected (5/5)` | `1` | `1v/113B -> 1v/114B` | `undetermined` |
| `dawn_pr_662_compare_at_price_varies` | `price_range` | `true` | `budget_exhausted` (`60` pairs) | `detected (5/5)` | `54` | `2v/178B -> 2v/178B` | `undetermined` |
| `dawn_pr_2858_b2b_sale_price_range_visibility` | `price_range` | `false` | `unsupported` | `unsupported (0/5)` | — | — | — |
| `dawn_pr_3000_volume_pricing_empty_compare_at` | `price_range` | `true` | `detected` (`1` pair) | `detected (5/5)` | `1` | `1v/113B -> 1v/114B` | `structural_change` |
| `dawn_horizon_price_varies_from_price` | `price_range` | `true` | `detected` (`21` pairs) | `detected (5/5)` | `81` | `2v/182B -> 2v/178B` | `undetermined` |

## Conformance Coverage (Stage 2 vs Stage 7 Coherent Extensions)

| Metric | Before Stage 7 (`stage-2`) | After Stage 7 (`stage-7`) | Delta |
| --- | ---: | ---: | ---: |
| Selected & Passing (`pass/selected`) | `359/359` (`100.00%`) | `399/399` (`100.00%`) | `+40` |
| `basics` Selected | `141` | `155` | `+14` |
| `liquid_ruby` Selected | `218` | `244` | `+26` |
| Inventoried (`basics + liquid_ruby`, `3061`) | `11.73%` | `13.03%` | `+1.30%` |
| All 8 Suites (`7395`) | `4.85%` | `5.40%` | `+0.55%` |

## Instrumented Render-Process Subprocess Overhead

Measured over `256` `render_pair(trace=false)` evaluations on `dawn_pr_794_price_badge_sale_aria_hidden` (after one-time compile & warmup):

| Engine | In-Process Ruby Total / Mean | Python->Ruby JSONL IPC Total / Mean | IPC Median / p95 | Measured IPC Overhead | Slowdown |
| --- | --- | --- | --- | --- | ---: |
| `custom` | `57.842 ms` (`0.2259 ms/pair`) | `74.754 ms` (`0.292 ms/pair`, startup+compile `246.399 ms`) | `0.257 ms` / `0.4172 ms` | `16.912 ms` (`+0.0661 ms/pair`, `22.6%`) | `1.29x` |
| `reference` | `65.614 ms` (`0.2563 ms/pair`) | `81.816 ms` (`0.3196 ms/pair`, startup+compile `247.174 ms`) | `0.2832 ms` / `0.4413 ms` | `16.202 ms` (`+0.0633 ms/pair`, `19.8%`) | `1.25x` |

> **Section 7 Decision Note**: Across `256` `custom` pair evaluations, JSONL pipe IPC + JSON ser/de adds `0.0661 ms/pair` (`22.6%` of total IPC render-loop time), while total 256-pair search remains sub-second (`median first_difference_ms = 249 ms`). Keeping Ruby as the single Liquid ownership boundary remains practical at 256/128 budgets; moving search into Ruby would be warranted only if budgets scale by 10x+.

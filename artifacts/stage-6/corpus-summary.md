# Stage 6: Shopify Dawn Corpus Verification Summary

- Status: `passed`
- Official Liquid Engine: `liquid 5.14.0` (`DawnBenchmarkFilters v1.0.0`)
- Verified Cases: **15** (sale_badge: `4`, sold_out_badge: `5`, price_range: `6`)
- Support Breakdown: `supported_in_stage2=3`, `supported_for_benchmark=10`, `unsupported=5`
- Directions: `bug_fixed=12`, `bug_introduced=3`
- Unverified Leads Documented Separately: **7** (`bench/corpus/unverified_candidates.json`)

## Verified Corpus Cases

| Case ID | Observable | Direction | Before -> After | Stage 2 | Benchmark | Selector |
| --- | --- | --- | --- | --- | --- | --- |
| `dawn_pr_589_card_badge_aria_hidden` | `sale_badge` | `bug_fixed` | `false` -> `true` | `matched` | `true` | `[data-regression-badge="sale"]:not([aria-hidden="true"])` |
| `dawn_pr_794_price_badge_sale_aria_hidden` | `sale_badge` | `bug_fixed` | `false` -> `true` | `skipped_unsupported` | `true` | `.price.price--on-sale.price--show-badge [data-regression-badge="sale"]:not([aria-hidden="true"])` |
| `dawn_pr_1938_horizontal_card_badge_suppressed` | `sale_badge` | `bug_introduced` | `true` -> `false` | `skipped_unsupported` | `false` | `.card:not(.card--horizontal) [data-regression-badge="sale"]` |
| `dawn_pr_3144_b2b_card_sale_badge_restricted` | `sale_badge` | `bug_introduced` | `true` -> `false` | `skipped_unsupported` | `false` | `[data-regression-badge="sale"]` |
| `dawn_pr_3487_quick_add_bulk_sold_out` | `sold_out_badge` | `bug_fixed` | `false` -> `true` | `matched` | `true` | `[data-regression-badge="sold_out"]` |
| `dawn_pr_1610_quick_add_single_variant_sold_out` | `sold_out_badge` | `bug_fixed` | `false` -> `true` | `skipped_unsupported` | `true` | `[data-regression-badge="sold_out"]` |
| `dawn_pr_3293_quick_add_bulk_ghost_sold_out` | `sold_out_badge` | `bug_fixed` | `true` -> `false` | `skipped_unsupported` | `true` | `.quick-add [data-regression-badge="sold_out"]` |
| `dawn_pr_2255_buy_buttons_untracked_inventory` | `sold_out_badge` | `bug_fixed` | `true` -> `false` | `skipped_unsupported` | `false` | `[data-regression-badge="sold_out"]` |
| `dawn_pr_3246_price_nil_target_sold_out` | `sold_out_badge` | `bug_fixed` | `true` -> `false` | `skipped_unsupported` | `false` | `.price.price--sold-out.price--show-badge [data-regression-badge="sold_out"]` |
| `dawn_pr_3574_use_variant_volume_price_range` | `price_range` | `bug_fixed` | `false` -> `true` | `matched` | `true` | `[data-regression-price-range]` |
| `dawn_pr_2791_volume_pricing_price_range` | `price_range` | `bug_fixed` | `false` -> `true` | `skipped_unsupported` | `true` | `[data-regression-price-range]` |
| `dawn_pr_662_compare_at_price_varies` | `price_range` | `bug_fixed` | `true` -> `false` | `skipped_unsupported` | `true` | `.price__sale s[data-regression-price-range]` |
| `dawn_pr_2858_b2b_sale_price_range_visibility` | `price_range` | `bug_fixed` | `false` -> `true` | `skipped_unsupported` | `false` | `.price:not(.price--on-sale) [data-regression-price-range]` |
| `dawn_pr_3000_volume_pricing_empty_compare_at` | `price_range` | `bug_fixed` | `true` -> `false` | `skipped_unsupported` | `true` | `.price__regular s[data-regression-price-range]` |
| `dawn_horizon_price_varies_from_price` | `price_range` | `bug_introduced` | `true` -> `false` | `skipped_unsupported` | `true` | `[data-regression-price-range]` |

## Unverified Candidates (Excluded from Verified Benchmark)

- **Sale badge does not appear if there is a variant with a 0 compare_at_price** (closed_not_planned) — https://github.com/Shopify/dawn/issues/3581: No merged fix PR or commit pair exists in Shopify/dawn; HEAD snippets/card-product.liquid lines 139 and 563 retain 'card_product.compare_at_price > card_product.price and card_product.available'.
- **Compare-at price doesn't show if varied across multiple variants** (closed_not_planned) — https://github.com/Shopify/dawn/issues/871: Closed as intentional Dawn design without a fix commit in Shopify/dawn; HEAD snippets/price.liquid preserves 'unless product.price_varies == false and product.compare_at_price_varies'.
- **Strange compare at price logic in price component** (closed_not_planned) — https://github.com/Shopify/dawn/issues/3231: Duplicate report of #871 regarding 'unless product.price_varies == false and product.compare_at_price_varies'; closed as not_planned without a code change.
- **[Bug] price.liquid renders both sale and sold-out badge text into HTML regardless of product availability** (closed_inactive_without_fix) — https://github.com/Shopify/dawn/issues/3924: Closed after going stale without any merged fix PR; HEAD snippets/price.liquid still emits both .price__badge-sale and .price__badge-sold-out inside {% if show_badges %} gated by CSS (.price--on-sale / .price--sold-out).
- **fix(price): render only contextually correct badge in HTML source** (closed_unmerged_cla_needed) — https://github.com/Shopify/dawn/pull/3925: PR closed unmerged with label cla-needed; commit da0c8c097eddb306708a11968f4fd5ad99c3fe12 does not exist in Shopify/dawn git history.
- **card__heading is repeated in card-product snippet** (closed_not_planned) — https://github.com/Shopify/dawn/issues/3616: Closed as not_planned; duplicate .card__badge and .card__heading blocks in card-product.liquid depend on external component-card.css card_style/featured_media layout rules.
- **Fix issue with quantity break price (release/15.0.1 cherry-pick twin of PR #3574)** (merged_excluded_duplicate) — https://github.com/Shopify/dawn/pull/3573: Represents the exact same price_min/price_max bug fix on release/15.0.1 (28b21ab2f50b949d34229db14a990adbcdc04f27) that landed on main via PR #3574 (ce670c575b972768a61c75ed714f8f522f7d1e90).

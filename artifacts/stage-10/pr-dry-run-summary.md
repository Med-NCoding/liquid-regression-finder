<!-- Case 1: Benign Non-Semantic Edit -->
## Liquid Regression Finder — PR Snippet Check

- **Repository**: `Med-NCoding/liquid-regression-finder`
- **Snippet**: `snippets/card-product.liquid`
- **Commits**: `e3afa6de3b04714c03fd453c47c865852b5eb8f8` → `8464f5d83e7bc6b2ac5b912666b58967d7b09bcd`
- **Status**: `no_difference_found`
- **Idempotency Key**: `913d8ad1a4e7d6a28676fa83308bd56db1bc7e64a0f76afde692b9c6548e1995`
- **Result URL**: [http://127.0.0.1:52599/comparisons/648be493-9211-4aa5-9a93-54ccf2dfdc1d](http://127.0.0.1:52599/comparisons/648be493-9211-4aa5-9a93-54ccf2dfdc1d)

### Run Metrics

| Metric | Value |
| --- | --- |
| `seed` | `0` |
| `search_pairs` | `256` |
| `shrink_pairs` | `0` |
| `parity_rejections` | `0` |
| `exhausted_by` | `pair_limit` |
| `elapsed_ms` | `399` |

Result: **no difference found within this search** (`search_pairs=256`, `shrink_pairs=0`, `parity_rejections=0`).
---

<!-- Case 2: Product-Aggregate Sale Badge Regression -->
## Liquid Regression Finder — PR Snippet Check

- **Repository**: `Med-NCoding/liquid-regression-finder`
- **Snippet**: `snippets/card-product.liquid`
- **Commits**: `e3afa6de3b04714c03fd453c47c865852b5eb8f8` → `801d4e8c984b717cf949534b01f021075f78db55`
- **Status**: `difference_found`
- **Idempotency Key**: `2abf4e0ebcbaf4323e7ad5adfb4cb542085466a1ea135363afb05410f53a496a`
- **Result URL**: [http://127.0.0.1:52599/comparisons/cd3550fe-5f5b-45e2-a108-9f9e89c6af72](http://127.0.0.1:52599/comparisons/cd3550fe-5f5b-45e2-a108-9f9e89c6af72)

### Run Metrics

| Metric | Value |
| --- | --- |
| `seed` | `0` |
| `search_pairs` | `56` |
| `shrink_pairs` | `28` |
| `parity_rejections` | `0` |
| `elapsed_ms` | `283` |

### Regression Finding

- **Observer**: `sale_badge` (`before.observed=True`, `after.observed=False`)
- **Official Liquid Reference**: `5.14.0`
- **Minimized Fixture**: `2` variant(s)
- **Explanation Kind**: `structural_change`
- **Explanation Summary**: Structural change: before at line 3 in variant_id="v2" via line 8 (if on_sale=true, assigned at line 4) [variant.compare_at_price != nil and variant.compare_at_price > variant.price] -> true (variant.compare_at_price=1, variant.price=0); after at line 2 in product/context [product.compare_at_price != nil and product.compare_at_price > product.price] -> false (product.compare_at_price=0, product.price=0).
- **Before Anchor**: line `3`, event `#13`
- **After Anchor**: line `2`, event `#9`
---

<!-- Case 3: Untrusted Fork Token Suppression -->
## Liquid Regression Finder — PR Snippet Check

- **Repository**: `Med-NCoding/liquid-regression-finder`
- **Snippet**: `snippets/card-product.liquid`
- **Commits**: `e3afa6de3b04714c03fd453c47c865852b5eb8f8` → `801d4e8c984b717cf949534b01f021075f78db55`
- **Status**: `skipped_untrusted_fork`
- **Idempotency Key**: `2abf4e0ebcbaf4323e7ad5adfb4cb542085466a1ea135363afb05410f53a496a`

> External API token submission skipped for untrusted fork PR (`--is-fork` / `GITHUB_EVENT_HEAD_FORK=true` suppressed `LIQUID_REGRESSION_API_TOKEN`).
---

<!-- Case 4: Renamed Snippet Diagnostic -->
## Liquid Regression Finder — PR Snippet Check

- **Repository**: `Med-NCoding/liquid-regression-finder`
- **Snippet**: `snippets/card-product.liquid`
- **Commits**: `e3afa6de3b04714c03fd453c47c865852b5eb8f8` → `87a95a49b01e35e82a0a5407f3bc00012c9b639b`
- **Status**: `error`
- **Idempotency Key**: `402add246cf22793e0828c17654c8129cbc39879965898085344588c98e1d3a5`

### Run Metrics

| Metric | Value |
| --- | --- |
| `seed` | `0` |

### Diagnostic

- **Code**: `renamed_blob`
- **Message**: Watched snippet 'snippets/card-product.liquid' was renamed between e3afa6de3b04714c03fd453c47c865852b5eb8f8 and 87a95a49b01e35e82a0a5407f3bc00012c9b639b (snippets/card-product.liquid -> snippets/card-product-renamed.liquid, status=R100); update comparison-manifest.json or restore path.
---

<!-- Case 5: Missing Snippet Diagnostic -->
## Liquid Regression Finder — PR Snippet Check

- **Repository**: `Med-NCoding/liquid-regression-finder`
- **Snippet**: `snippets/card-product.liquid`
- **Commits**: `e3afa6de3b04714c03fd453c47c865852b5eb8f8` → `019b1ef8a4b3348f0667491f7dd63b81f821c816`
- **Status**: `error`
- **Idempotency Key**: `e8c5b4434c09af0fa4c5d5ed14b073cef38c5ac6776f748ae7e4bba50eacea33`

### Run Metrics

| Metric | Value |
| --- | --- |
| `seed` | `0` |

### Diagnostic

- **Code**: `missing_blob`
- **Message**: Watched snippet 'snippets/card-product.liquid' is missing on head (019b1ef8a4b3348f0667491f7dd63b81f821c816) (diff status: D).

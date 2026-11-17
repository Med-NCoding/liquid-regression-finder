<!-- Case 1: Benign Non-Semantic Edit -->
## Liquid Regression Finder — PR Snippet Check

- **Repository**: `Med-NCoding/liquid-regression-finder`
- **Snippet**: `snippets/card-product.liquid`
- **Commits**: `0ffe0ebf3e9e2a95768582d79be76c5ca28121cd` → `c5c5e3a477dd062b63d0f556cca5de4676fb0d89`
- **Status**: `no_difference_found`
- **Idempotency Key**: `6e74dbde379dad25200b429abd4635355918762767caacb5cb2a699c2c529249`
- **Result URL**: [http://127.0.0.1:60521/comparisons/18b4921c-3c4e-4f85-9b94-381bcd899b40](http://127.0.0.1:60521/comparisons/18b4921c-3c4e-4f85-9b94-381bcd899b40)

### Run Metrics

| Metric | Value |
| --- | --- |
| `seed` | `0` |
| `search_pairs` | `256` |
| `shrink_pairs` | `0` |
| `parity_rejections` | `0` |
| `exhausted_by` | `pair_limit` |
| `elapsed_ms` | `320` |

Result: **no difference found within this search** (`search_pairs=256`, `shrink_pairs=0`, `parity_rejections=0`).
---

<!-- Case 2: Product-Aggregate Sale Badge Regression -->
## Liquid Regression Finder — PR Snippet Check

- **Repository**: `Med-NCoding/liquid-regression-finder`
- **Snippet**: `snippets/card-product.liquid`
- **Commits**: `0ffe0ebf3e9e2a95768582d79be76c5ca28121cd` → `1458b87421730fdc26550c2aa7847e5eb1e135ed`
- **Status**: `difference_found`
- **Idempotency Key**: `d769e3bd0015471ed6a81a4c79491bd3e7b5fc51184c2d52e10227fce2867316`
- **Result URL**: [http://127.0.0.1:60521/comparisons/257a5774-b2b3-444b-937e-e68643e67639](http://127.0.0.1:60521/comparisons/257a5774-b2b3-444b-937e-e68643e67639)

### Run Metrics

| Metric | Value |
| --- | --- |
| `seed` | `0` |
| `search_pairs` | `56` |
| `shrink_pairs` | `28` |
| `parity_rejections` | `0` |
| `elapsed_ms` | `275` |

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
- **Commits**: `0ffe0ebf3e9e2a95768582d79be76c5ca28121cd` → `1458b87421730fdc26550c2aa7847e5eb1e135ed`
- **Status**: `skipped_untrusted_fork`
- **Idempotency Key**: `d769e3bd0015471ed6a81a4c79491bd3e7b5fc51184c2d52e10227fce2867316`

> External API token submission skipped for untrusted fork PR (`--is-fork` / `GITHUB_EVENT_HEAD_FORK=true` suppressed `LIQUID_REGRESSION_API_TOKEN`).
---

<!-- Case 4: Renamed Snippet Diagnostic -->
## Liquid Regression Finder — PR Snippet Check

- **Repository**: `Med-NCoding/liquid-regression-finder`
- **Snippet**: `snippets/card-product.liquid`
- **Commits**: `0ffe0ebf3e9e2a95768582d79be76c5ca28121cd` → `4e61aaa9d85e2001c1f3c39537624d85410e233f`
- **Status**: `error`
- **Idempotency Key**: `bb16304782f2decb5196727b73bf29cb53e2bd5cd7b4c099f6e018f6b4d3658a`

### Run Metrics

| Metric | Value |
| --- | --- |
| `seed` | `0` |

### Diagnostic

- **Code**: `renamed_blob`
- **Message**: Watched snippet 'snippets/card-product.liquid' was renamed between 0ffe0ebf3e9e2a95768582d79be76c5ca28121cd and 4e61aaa9d85e2001c1f3c39537624d85410e233f (snippets/card-product.liquid -> snippets/card-product-renamed.liquid, status=R100); update comparison-manifest.json or restore path.
---

<!-- Case 5: Missing Snippet Diagnostic -->
## Liquid Regression Finder — PR Snippet Check

- **Repository**: `Med-NCoding/liquid-regression-finder`
- **Snippet**: `snippets/card-product.liquid`
- **Commits**: `0ffe0ebf3e9e2a95768582d79be76c5ca28121cd` → `fa87bc7b03b036a4f53cbe191f2e10786379b9a0`
- **Status**: `error`
- **Idempotency Key**: `82934b1f6baef936aa0fb946a7d701a4c2afb21a846dc469b98d219d4f2d67fa`

### Run Metrics

| Metric | Value |
| --- | --- |
| `seed` | `0` |

### Diagnostic

- **Code**: `missing_blob`
- **Message**: Watched snippet 'snippets/card-product.liquid' is missing on head (fa87bc7b03b036a4f53cbe191f2e10786379b9a0) (diff status: D).

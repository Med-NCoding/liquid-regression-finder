<!-- Case 1: Benign Non-Semantic Edit -->
## Liquid Regression Finder — PR Snippet Check

- **Repository**: `Med-NCoding/liquid-regression-finder`
- **Snippet**: `snippets/card-product.liquid`
- **Commits**: `75d4ee4f8eb780854a1712aa1be305bed9235ec0` → `5c54ecfb61722fa41a70a2663c0e6bea02ea1cda`
- **Status**: `no_difference_found`
- **Idempotency Key**: `52655b125b51af0630b60c41698fc256522dc7ef5f45254f41842e66cb17b9ff`
- **Result URL**: [http://127.0.0.1:60712/comparisons/59146a06-697b-4349-a0ef-802128b0665d](http://127.0.0.1:60712/comparisons/59146a06-697b-4349-a0ef-802128b0665d)

### Run Metrics

| Metric | Value |
| --- | --- |
| `seed` | `0` |
| `search_pairs` | `256` |
| `shrink_pairs` | `0` |
| `parity_rejections` | `0` |
| `exhausted_by` | `pair_limit` |
| `elapsed_ms` | `315` |

Result: **no difference found within this search** (`search_pairs=256`, `shrink_pairs=0`, `parity_rejections=0`).
---

<!-- Case 2: Product-Aggregate Sale Badge Regression -->
## Liquid Regression Finder — PR Snippet Check

- **Repository**: `Med-NCoding/liquid-regression-finder`
- **Snippet**: `snippets/card-product.liquid`
- **Commits**: `75d4ee4f8eb780854a1712aa1be305bed9235ec0` → `1196751d7f2ca2875a107f8ab3143ad9d42d9753`
- **Status**: `difference_found`
- **Idempotency Key**: `fd02efcd22940d5162a54606f60f2db713059337a7219f1e2a31ed17349e2fad`
- **Result URL**: [http://127.0.0.1:60712/comparisons/a8b810d7-f690-4ca4-8e72-f174ad6d0840](http://127.0.0.1:60712/comparisons/a8b810d7-f690-4ca4-8e72-f174ad6d0840)

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
- **Commits**: `75d4ee4f8eb780854a1712aa1be305bed9235ec0` → `1196751d7f2ca2875a107f8ab3143ad9d42d9753`
- **Status**: `skipped_untrusted_fork`
- **Idempotency Key**: `fd02efcd22940d5162a54606f60f2db713059337a7219f1e2a31ed17349e2fad`

> External API token submission skipped for untrusted fork PR (`--is-fork` / `GITHUB_EVENT_HEAD_FORK=true` suppressed `LIQUID_REGRESSION_API_TOKEN`).
---

<!-- Case 4: Renamed Snippet Diagnostic -->
## Liquid Regression Finder — PR Snippet Check

- **Repository**: `Med-NCoding/liquid-regression-finder`
- **Snippet**: `snippets/card-product.liquid`
- **Commits**: `75d4ee4f8eb780854a1712aa1be305bed9235ec0` → `7f7358cbfd5c6952c62cb541ae1921f2dda167bf`
- **Status**: `error`
- **Idempotency Key**: `2197e03ea843a20ebbcd52f3e2c3a217781a0c9ccd98f6059f493563478a4bf3`

### Run Metrics

| Metric | Value |
| --- | --- |
| `seed` | `0` |

### Diagnostic

- **Code**: `renamed_blob`
- **Message**: Watched snippet 'snippets/card-product.liquid' was renamed between 75d4ee4f8eb780854a1712aa1be305bed9235ec0 and 7f7358cbfd5c6952c62cb541ae1921f2dda167bf (snippets/card-product.liquid -> snippets/card-product-renamed.liquid, status=R100); update comparison-manifest.json or restore path.
---

<!-- Case 5: Missing Snippet Diagnostic -->
## Liquid Regression Finder — PR Snippet Check

- **Repository**: `Med-NCoding/liquid-regression-finder`
- **Snippet**: `snippets/card-product.liquid`
- **Commits**: `75d4ee4f8eb780854a1712aa1be305bed9235ec0` → `37dc41fa6ed12255dc17752a6c23515f49096cc8`
- **Status**: `error`
- **Idempotency Key**: `de6661ef51ffb4e3e4bb573532f82e6f35489e1bbbc1e99a0b01cf388f0475be`

### Run Metrics

| Metric | Value |
| --- | --- |
| `seed` | `0` |

### Diagnostic

- **Code**: `missing_blob`
- **Message**: Watched snippet 'snippets/card-product.liquid' is missing on head (37dc41fa6ed12255dc17752a6c23515f49096cc8) (diff status: D).

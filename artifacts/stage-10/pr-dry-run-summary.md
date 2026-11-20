<!-- Case 1: Benign Non-Semantic Edit -->
## Liquid Regression Finder — PR Snippet Check

- **Repository**: `Med-NCoding/liquid-regression-finder`
- **Snippet**: `snippets/card-product.liquid`
- **Commits**: `c9785f8a0833251bd606340652c63eb8b9dd9a28` → `3f5e43af11c24cce0ba76685ccfa862141577250`
- **Status**: `no_difference_found`
- **Idempotency Key**: `61504b3577bfc0c79b25b4bf53da43f66a513d55f9deac16fc1aa82c4be69c5f`
- **Result URL**: [http://127.0.0.1:62133/comparisons/93aee76b-39c1-437f-bc32-aec76f7219cf](http://127.0.0.1:62133/comparisons/93aee76b-39c1-437f-bc32-aec76f7219cf)

### Run Metrics

| Metric | Value |
| --- | --- |
| `seed` | `0` |
| `search_pairs` | `256` |
| `shrink_pairs` | `0` |
| `parity_rejections` | `0` |
| `exhausted_by` | `pair_limit` |
| `elapsed_ms` | `330` |

Result: **no difference found within this search** (`search_pairs=256`, `shrink_pairs=0`, `parity_rejections=0`).
---

<!-- Case 2: Product-Aggregate Sale Badge Regression -->
## Liquid Regression Finder — PR Snippet Check

- **Repository**: `Med-NCoding/liquid-regression-finder`
- **Snippet**: `snippets/card-product.liquid`
- **Commits**: `c9785f8a0833251bd606340652c63eb8b9dd9a28` → `c0acd9a6925dacb00cba1ddb2b12388d3efe697a`
- **Status**: `difference_found`
- **Idempotency Key**: `6e1ab133a3ed16d0e2399106460d7b3205dd64a145d679a678c6da27d19dbb3e`
- **Result URL**: [http://127.0.0.1:62133/comparisons/68d8a6a0-f96e-4225-99d1-55e8811f96e1](http://127.0.0.1:62133/comparisons/68d8a6a0-f96e-4225-99d1-55e8811f96e1)

### Run Metrics

| Metric | Value |
| --- | --- |
| `seed` | `0` |
| `search_pairs` | `9` |
| `shrink_pairs` | `15` |
| `parity_rejections` | `0` |
| `elapsed_ms` | `269` |

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
- **Commits**: `c9785f8a0833251bd606340652c63eb8b9dd9a28` → `c0acd9a6925dacb00cba1ddb2b12388d3efe697a`
- **Status**: `skipped_untrusted_fork`
- **Idempotency Key**: `6e1ab133a3ed16d0e2399106460d7b3205dd64a145d679a678c6da27d19dbb3e`

> External API token submission skipped for untrusted fork PR (`--is-fork` / `GITHUB_EVENT_HEAD_FORK=true` suppressed `LIQUID_REGRESSION_API_TOKEN`).
---

<!-- Case 4: Renamed Snippet Diagnostic -->
## Liquid Regression Finder — PR Snippet Check

- **Repository**: `Med-NCoding/liquid-regression-finder`
- **Snippet**: `snippets/card-product.liquid`
- **Commits**: `c9785f8a0833251bd606340652c63eb8b9dd9a28` → `816c696925d1a50fac1b61feaee2a571c3df38c5`
- **Status**: `error`
- **Idempotency Key**: `f021cf64e2e57209bf986e3ea09343a6258f6f1d607f564da2212e8f88ecb97f`

### Run Metrics

| Metric | Value |
| --- | --- |
| `seed` | `0` |

### Diagnostic

- **Code**: `renamed_blob`
- **Message**: Watched snippet 'snippets/card-product.liquid' was renamed between c9785f8a0833251bd606340652c63eb8b9dd9a28 and 816c696925d1a50fac1b61feaee2a571c3df38c5 (snippets/card-product.liquid -> snippets/card-product-renamed.liquid, status=R100); update comparison-manifest.json or restore path.
---

<!-- Case 5: Missing Snippet Diagnostic -->
## Liquid Regression Finder — PR Snippet Check

- **Repository**: `Med-NCoding/liquid-regression-finder`
- **Snippet**: `snippets/card-product.liquid`
- **Commits**: `c9785f8a0833251bd606340652c63eb8b9dd9a28` → `4d4c2f3388756ea4881607a050f65c554ce091f9`
- **Status**: `error`
- **Idempotency Key**: `98a5fecd2d98d4d857763c64d5888e3464ebb52f6337ef58c134245a3213a282`

### Run Metrics

| Metric | Value |
| --- | --- |
| `seed` | `0` |

### Diagnostic

- **Code**: `missing_blob`
- **Message**: Watched snippet 'snippets/card-product.liquid' is missing on head (4d4c2f3388756ea4881607a050f65c554ce091f9) (diff status: D).

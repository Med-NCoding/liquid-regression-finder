# Shopify Storefront Product Projection Probe

## Current Evidence Status

- **Status**: `storefront_unverified`
- **Local Projection Version**: `1.0.0` (`LiquidReference::PROJECTION_VERSION`)
- **Scope**: Because no live Shopify development store was available during local build verification, all `product.*` aggregate semantics in this repository are explicitly scoped to the versioned local projection model (`1.0.0`) implemented in [`projection.rb`](file:///Users/medhanshnegi/.gemini/antigravity/scratch/liquid-regression-finder/reference/lib/liquid_reference/projection.rb).

## Local Projection Rules (`1.0.0`)

| Field | Local Rule (`1.0.0`) |
|---|---|
| `product.variants` | Variant hashes in fixture order with `id`, `price`, `compare_at_price` (explicit `null` preserved), and `available` |
| `product.price` | Minimum variant `price` |
| `product.price_min` | Minimum variant `price` |
| `product.price_max` | Maximum variant `price` |
| `product.price_varies` | `price_min != price_max` |
| `product.available` | `true` if any variant has `available == true`, else `false` |
| `product.compare_at_price` | Minimum non-`null` variant `compare_at_price` (retaining explicit `0`), or `null` if all variants are `null` |
| `product.compare_at_price_min` | Minimum non-`null` variant `compare_at_price` (retaining explicit `0`), or `null` if all variants are `null` |
| `product.compare_at_price_max` | Maximum non-`null` variant `compare_at_price` (retaining explicit `0`), or `null` if all variants are `null` |
| `product.compare_at_price_varies` | `true` if two or more distinct non-`null` numeric `compare_at_price` values exist; `false` otherwise |

## Step-by-Step Storefront Probe Procedure

1. **Create a draft theme template**:
   - In a Shopify development store, duplicate or open a draft theme in **Online Store → Themes → Edit code**.
   - Create `templates/product.projection-probe.liquid` and paste the contents of [`product-projection-probe.liquid`](file:///Users/medhanshnegi/.gemini/antigravity/scratch/liquid-regression-finder/reference/probe/product-projection-probe.liquid).
   - Do **not** publish the draft theme to live storefront traffic; preview it using the draft theme preview parameter or `?view=projection-probe`.

2. **Create or select the 6 test products**:
   Create six USD products matching the variant tables in [`storefront_probe_matrix.json`](file:///Users/medhanshnegi/.gemini/antigravity/scratch/liquid-regression-finder/fixtures/storefront_probe_matrix.json) (converting integer cents to USD decimal prices, e.g., `2000` -> `20.00`, `0` -> `0.00`, `null` -> blank/empty compare-at price):
   - `all_null`: 2 variants, prices `20.00` and `25.00`, both compare-at blank, both available.
   - `null_plus_positive`: 2 variants, prices `20.00` and `20.00`, compare-at blank and `30.00`, both available.
   - `explicit_zero_plus_positive`: 2 variants, prices `15.00` and `15.00`, compare-at `0.00` and `25.00`, both available.
   - `equal_numeric`: 2 variants, prices `18.00` and `22.00`, compare-at `24.00` and `24.00`, both available.
   - `varied_numeric`: 2 variants, prices `15.00` and `22.00`, compare-at `20.00` and `30.00`, both available.
   - `mixed_availability`: 2 variants, prices `18.00` (`22.00` compare-at, inventory 0 / continue selling unchecked) and `21.00` (compare-at blank, in stock).

3. **Capture storefront JSON outputs**:
   - Request `/products/<handle>?view=projection-probe` on the draft theme preview for each product.
   - Verify the HTTP body parses as valid JSON and inspect `variants[*].compare_at_price` to determine whether Shopify retains explicit `0` or coerces `0` to `null` (especially for `explicit_zero_plus_positive`).

4. **Record observations in [`storefront_probe_matrix.json`](file:///Users/medhanshnegi/.gemini/antigravity/scratch/liquid-regression-finder/fixtures/storefront_probe_matrix.json)**:
   - Fill in `storefront_date` (ISO-8601 date), `currency_market` (e.g., `"USD / United States"`), and `explicit_zero_retained` (`true` or `false`).
   - Populate each case's `observed_storefront` with the observed `product` aggregate and variant fields.
   - Update `status` from `"storefront_unverified"` to `"storefront_verified"` if all 6 cases match `local_projection`, or `"storefront_diverged"` while updating the projection model.

5. **Reconcile if the storefront contradicts `1.0.0`**:
   - If Shopify's live storefront behavior differs (for example, coercing explicit `0` `compare_at_price` to `null`, or computing `compare_at_price_varies` differently when `null` is mixed with numeric values):
     1. Increment `LiquidReference::PROJECTION_VERSION` (e.g., `"1.1.0"` or `"2.0.0"`).
     2. Update `LiquidReference::Projection` and its unit tests (`reference/test/test_projection.rb`).
     3. Update `fixtures/storefront_probe_matrix.json` and re-run `./bin/check stage-3` (plus demo/benchmark gates in later stages).

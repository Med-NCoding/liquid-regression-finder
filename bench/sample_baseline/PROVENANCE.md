# Official Shopify Sample Product Baseline Provenance

- **Source Repository URL**: `https://github.com/shopifypartners/product-csvs`
- **Pinned Commit SHA**: `045fb432d85dc59d558717208399176d62bf106d`
- **Download Date**: `2026-11-17`
- **Conversion Script**: [`convert_csvs.py`](file:///Users/medhanshnegi/.gemini/antigravity/scratch/liquid-regression-finder/bench/sample_baseline/convert_csvs.py)
- **Output Artifact**: [`sample_products.json`](file:///Users/medhanshnegi/.gemini/antigravity/scratch/liquid-regression-finder/bench/sample_baseline/sample_products.json)
- **Total Converted Products**: **60** (`66` variants total; `0` truncated)

## Pinned Source CSV Files

| File | Raw Path | CSV Rows | Unique Products (`Handle`) | Variants | SHA-256 |
| --- | --- | ---: | ---: | ---: | --- |
| `apparel.csv` | `bench/sample_baseline/raw/apparel.csv` | 22 | 20 | 22 | `90291acf9147ab2eeccb7ead518bb5b3dd8900f7285b8cea918403e732c451b3` |
| `home-and-garden.csv` | `bench/sample_baseline/raw/home-and-garden.csv` | 21 | 20 | 21 | `97ebc4140c67c05b35de78f55f555fc3bd0e5ee70558ae2cd4cc141eaddf8d02` |
| `jewelery.csv` | `bench/sample_baseline/raw/jewelery.csv` | 41 | 20 | 23 | `92ed726816ef3f84be43a5b43a8a8faf358dd7584277258d85788e1eed549aa9` |
| **Total** | — | **84** | **60** | **66** | — |

Raw upstream files (including upstream `readme.md`, SHA-256 `d3b08c3011997502c03cea845d7781ba917431c2a18b2c62df10148daa4dc5c0`) are committed unmodified under `bench/sample_baseline/raw/`. Note upstream `jewelery.csv` retains Shopify Partners' original filename spelling.

## Deterministic CSV-to-`Fixture` Mapping Rules

Each unique `Handle` across the three CSVs (preserving file and row order: `apparel.csv` → `home-and-garden.csv` → `jewelery.csv`) maps to one schema-valid `Fixture` (`schema_version: 1`, `currency: "USD"`, `variants: 1..8`):

1. **Multi-row Handle Grouping & Gallery Image Row Filtering**:
   - Rows sharing the same `Handle` are grouped together in CSV appearance order.
   - Secondary product-gallery image rows (which carry `Image Src` / `Image Position` with an empty `Variant Price`, e.g., 18 rows in `jewelery.csv`) are filtered out rather than treated as variants.
   - Across all 60 products, every handle has `1..3` variant rows (well within the `Fixture` schema `1..8` variant limit, so `0` products required truncation or splitting; the deterministic `[:8]` cap is enforced as a guard).
2. **Variant IDs**:
   - Variant IDs are assigned deterministically as `v1`, `v2`, ..., `vN` (`1..32` chars, unique per product).
3. **Price & Compare-at Price (Integer USD Cents)**:
   - `Variant Price` strings (e.g., `"29.99"`, `"60"`) are parsed with exact `decimal.Decimal` arithmetic (`int((Decimal(raw) * 100).to_integral_value())`) into integer cents (`0..10_000_000`) without binary float rounding.
   - `Variant Compare At Price` maps to `null` when empty/blank, or exact integer cents otherwise.
4. **Availability Derivation (`available`)**:
   - Product-level `Published` (`"false"` -> `false`) and `Status` (non-empty value other than `"active"` -> `false`) gate availability when present; in these three CSVs, `Published` is `"true"` (or inherited `""` on continuation rows) and `Status` is empty.
   - At variant level, if `Variant Inventory Policy` is `"continue"`, `available` is `true`; otherwise (`"deny"`, the policy on all 66 variants), `available` is `int(Variant Inventory Qty) > 0`.
   - Note: `Variant Inventory Tracker` is blank on 65 of 66 variant rows (only `biodegradable-cardboard-pots` sets `"shopify"`), while `Variant Inventory Qty` uses `0` on out-of-stock sample rows (`pink-armchair`, `wooden-outdoor-slats`, and the second variants of `chain-bracelet`, `leather-anchor`, and `gemstone`); using `Variant Inventory Qty > 0` preserves those official sold-out sample states.

## Resulting Baseline Coverage Summary

Across the **60** converted `Fixture` objects (`66` variants):
- **On-sale (`compare_at_price > price`)**: `30` products
- **Completely sold-out (all variants `available == false`)**: `2` products (`pink-armchair`, `wooden-outdoor-slats`)
- **Partially sold-out multi-variant**: `3` products (`chain-bracelet`, `leather-anchor`, `gemstone`)
- **Multi-variant (`variants.length >= 2`)**: `5` products (`classic-varsity-top` [3], `clay-plant-pot` [2], `chain-bracelet` [2], `leather-anchor` [2], `gemstone` [2])
- **Varying base prices (`price_varies == true`)**: `2` products (`clay-plant-pot`, `leather-anchor`)
- **Varying non-null compare-at prices (`compare_at_price_varies == true`)**: `0` products

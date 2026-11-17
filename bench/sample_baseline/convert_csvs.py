#!/usr/bin/env python3
"""Deterministic converter from pinned Shopify Partners product CSVs to schema-valid Fixture JSON."""

from __future__ import annotations

import csv
import hashlib
import json
from collections import defaultdict
from decimal import Decimal
from pathlib import Path
from typing import Any

SOURCE_REPOSITORY = "https://github.com/shopifypartners/product-csvs"
PINNED_COMMIT_SHA = "045fb432d85dc59d558717208399176d62bf106d"
CSV_FILENAMES: tuple[str, ...] = ("apparel.csv", "home-and-garden.csv", "jewelery.csv")
MAX_VARIANTS = 8
MAX_PRICE_CENTS = 10_000_000


def parse_cents(raw_value: str) -> int:
    text = raw_value.strip()
    cents = int((Decimal(text) * 100).to_integral_value())
    if cents < 0 or cents > MAX_PRICE_CENTS:
        raise ValueError(f"Price cents {cents} out of range 0..{MAX_PRICE_CENTS} (raw={raw_value!r})")
    return cents


def derive_available(product_published: bool, product_status: str, row: dict[str, str]) -> bool:
    if not product_published:
        return False
    if product_status and product_status.lower() != "active":
        return False
    policy = (row.get("Variant Inventory Policy") or "deny").strip().lower()
    if policy == "continue":
        return True
    raw_qty = (row.get("Variant Inventory Qty") or "0").strip()
    qty = int(raw_qty) if raw_qty else 0
    return qty > 0


def convert_raw_csvs(sample_dir: Path | None = None) -> dict[str, Any]:
    base_dir = sample_dir or Path(__file__).resolve().parent
    raw_dir = base_dir / "raw"

    csv_metadata: list[dict[str, Any]] = []
    products: list[dict[str, Any]] = []
    truncated_handles: list[str] = []

    for filename in CSV_FILENAMES:
        csv_path = raw_dir / filename
        raw_bytes = csv_path.read_bytes()
        csv_sha256 = hashlib.sha256(raw_bytes).hexdigest()

        with csv_path.open("r", encoding="utf-8", newline="") as fh:
            reader = csv.DictReader(fh)
            grouped: dict[str, list[dict[str, str]]] = defaultdict(list)
            handle_order: list[str] = []
            total_rows = 0
            for row in reader:
                total_rows += 1
                handle = (row.get("Handle") or "").strip()
                if not handle:
                    raise ValueError(f"Missing Handle in {filename} row {total_rows}")
                if handle not in grouped:
                    handle_order.append(handle)
                grouped[handle].append(row)

        file_products = 0
        for handle in handle_order:
            hrows = grouped[handle]
            first_row = hrows[0]
            title = (first_row.get("Title") or handle).strip() or handle

            pub_raw = (first_row.get("Published") or "").strip().lower()
            product_published = pub_raw != "false"
            product_status = (first_row.get("Status") or "").strip()

            # Shopify CSVs repeat a Handle for secondary gallery images with blank Variant Price.
            variant_rows = [r for r in hrows if (r.get("Variant Price") or "").strip() != ""]
            if not variant_rows:
                raise ValueError(f"Product handle {handle!r} in {filename} has no variant rows with Variant Price")

            if len(variant_rows) > MAX_VARIANTS:
                truncated_handles.append(f"{filename}:{handle}")
                variant_rows = variant_rows[:MAX_VARIANTS]

            variants: list[dict[str, Any]] = []
            for idx, vrow in enumerate(variant_rows, start=1):
                price_cents = parse_cents(vrow["Variant Price"])
                raw_cap = (vrow.get("Variant Compare At Price") or "").strip()
                cap_cents = parse_cents(raw_cap) if raw_cap else None
                available = derive_available(product_published, product_status, vrow)
                variants.append(
                    {
                        "id": f"v{idx}",
                        "price": price_cents,
                        "compare_at_price": cap_cents,
                        "available": available,
                    }
                )

            products.append(
                {
                    "id": f"{Path(filename).stem}/{handle}",
                    "source_csv": filename,
                    "handle": handle,
                    "title": title,
                    "fixture": {
                        "schema_version": 1,
                        "currency": "USD",
                        "variants": variants,
                    },
                }
            )
            file_products += 1

        csv_metadata.append(
            {
                "filename": filename,
                "sha256": csv_sha256,
                "csv_rows": total_rows,
                "product_count": file_products,
            }
        )

    return {
        "schema_version": 1,
        "source_repository": SOURCE_REPOSITORY,
        "pinned_commit_sha": PINNED_COMMIT_SHA,
        "csv_files": csv_metadata,
        "product_count": len(products),
        "variant_count": sum(len(p["fixture"]["variants"]) for p in products),
        "truncated_handles": truncated_handles,
        "products": products,
    }


def main() -> int:
    base_dir = Path(__file__).resolve().parent
    payload = convert_raw_csvs(base_dir)
    out_path = base_dir / "sample_products.json"
    out_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(
        f"Wrote {out_path} (products={payload['product_count']}, "
        f"variants={payload['variant_count']}, truncated={len(payload['truncated_handles'])})"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

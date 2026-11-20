"""Deterministic candidate product fixture generator for counterexample search."""

from __future__ import annotations

import itertools
import json
import random
from typing import Any, Callable, Iterator, Sequence

GENERATOR_VERSION = "1.0.0"
MAX_DUPLICATE_ATTEMPTS = 10_000
MAX_PRICE_CENTS = 10_000_000
MAX_VARIANTS = 8

COMPARE_AT_CATEGORIES: tuple[str, ...] = ("missing", "zero", "below", "equal", "above")
BOUNDARY_PRICES: tuple[int, ...] = (0, 100, 1000, 2000, 2500)
PHASE2_PRICE_PALETTE: tuple[int, ...] = (
    0,
    1,
    50,
    99,
    100,
    199,
    500,
    999,
    1000,
    1500,
    1999,
    2000,
    2499,
    2500,
    5000,
    10_000,
)


def canonical_json(obj: Any) -> str:
    """Serialize obj as canonical sorted-key compact UTF-8 JSON without NaN."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def compare_at_for_category(price: int, category: str) -> int | None:
    """Map a relative compare-at category to a concrete integer cent value or None."""
    if category == "missing":
        return None
    if category == "zero":
        return 0
    if category == "below":
        if price <= 0:
            return 0
        if price <= 100:
            return price // 2
        return price - 100
    if category == "equal":
        return price
    if category == "above":
        if price <= 0:
            return 100
        return min(MAX_PRICE_CENTS, price + 500)
    raise ValueError(f"Unknown compare-at category: {category!r}")


def build_fixture(specs: Sequence[tuple[int, int | None, bool]]) -> dict[str, Any]:
    """Build a schema-valid Fixture from (price, compare_at_price, available) tuples."""
    if not (1 <= len(specs) <= MAX_VARIANTS):
        raise ValueError(f"Fixture must contain 1..{MAX_VARIANTS} variants, got {len(specs)}")

    variants = []
    for idx, (price, compare_at, available) in enumerate(specs, start=1):
        variants.append(
            {
                "id": f"v{idx}",
                "price": int(price),
                "compare_at_price": None if compare_at is None else int(compare_at),
                "available": bool(available),
            }
        )

    return {
        "schema_version": 1,
        "currency": "USD",
        "variants": variants,
    }


def build_phase1_boundary_fixtures() -> list[dict[str, Any]]:
    """Generate ordered, deduplicated 1-, 2-, and 3-variant boundary coverage fixtures."""
    fixtures: list[dict[str, Any]] = []
    seen: set[str] = set()

    def add_specs(specs: Sequence[tuple[int, int | None, bool]]) -> None:
        fixture = build_fixture(specs)
        key = canonical_json(fixture)
        if key not in seen:
            seen.add(key)
            fixtures.append(fixture)

    # 0. Stratified fast-watch prefix (25 core 1-, 2-, and 3-variant boundaries from
    # sections 1-3 below so default 32-pair watch mode covers multi-variant and
    # availability regressions immediately without changing the Phase 1 fixture set).
    fast_prefix: list[Sequence[tuple[int, int | None, bool]]] = [
        # 1-variant core categories & availability (zero-price first to match BOUNDARY_PRICES)
        [(0, compare_at_for_category(0, "zero"), True)],
        [(0, compare_at_for_category(0, "above"), True)],
        [(1000, compare_at_for_category(1000, "missing"), True)],
        [(1000, compare_at_for_category(1000, "zero"), True)],
        [(1000, compare_at_for_category(1000, "below"), True)],
        [(1000, compare_at_for_category(1000, "equal"), True)],
        [(1000, compare_at_for_category(1000, "above"), True)],
        [(1000, compare_at_for_category(1000, "above"), False)],
        # 2-variant position, zero-vs-sale, varied price, and availability boundaries
        [(0, compare_at_for_category(0, "zero"), True), (0, compare_at_for_category(0, "above"), True)],
        [(0, compare_at_for_category(0, "above"), True), (0, compare_at_for_category(0, "zero"), True)],
        [(0, compare_at_for_category(0, "missing"), True), (0, compare_at_for_category(0, "above"), True)],
        [(0, compare_at_for_category(0, "above"), True), (0, compare_at_for_category(0, "missing"), True)],
        [(1000, compare_at_for_category(1000, "missing"), True), (1000, compare_at_for_category(1000, "above"), True)],
        [(1000, compare_at_for_category(1000, "above"), True), (1000, compare_at_for_category(1000, "missing"), True)],
        [(1000, compare_at_for_category(1000, "zero"), True), (1000, compare_at_for_category(1000, "above"), True)],
        [(1000, compare_at_for_category(1000, "above"), True), (1000, compare_at_for_category(1000, "zero"), True)],
        [(1000, compare_at_for_category(1000, "below"), True), (1000, compare_at_for_category(1000, "above"), True)],
        [(1000, compare_at_for_category(1000, "above"), True), (1000, compare_at_for_category(1000, "missing"), False)],
        [(1000, compare_at_for_category(1000, "above"), False), (1000, compare_at_for_category(1000, "missing"), True)],
        [(1000, compare_at_for_category(1000, "missing"), True), (2000, compare_at_for_category(2000, "above"), True)],
        [(2000, compare_at_for_category(2000, "above"), True), (1000, compare_at_for_category(1000, "missing"), True)],
        # 3-variant position shift & availability mask
        [
            (1000, compare_at_for_category(1000, "above"), True),
            (1000, compare_at_for_category(1000, "missing"), True),
            (1000, compare_at_for_category(1000, "missing"), True),
        ],
        [
            (1000, compare_at_for_category(1000, "missing"), True),
            (1000, compare_at_for_category(1000, "above"), True),
            (1000, compare_at_for_category(1000, "missing"), True),
        ],
        [
            (1000, compare_at_for_category(1000, "missing"), True),
            (1000, compare_at_for_category(1000, "missing"), True),
            (1000, compare_at_for_category(1000, "above"), True),
        ],
        [
            (100, compare_at_for_category(100, "missing"), False),
            (1000, compare_at_for_category(1000, "zero"), True),
            (2500, compare_at_for_category(2500, "above"), False),
        ],
    ]
    for specs in fast_prefix:
        add_specs(specs)

    # 1. Single-variant boundary coverage: prices around zero & simple monetary amounts,
    # all relative compare-at categories, and both availability values.
    for price in BOUNDARY_PRICES:
        for avail in (True, False):
            for cat in COMPARE_AT_CATEGORIES:
                add_specs([(price, compare_at_for_category(price, cat), avail)])

    # 2. Two-variant boundary coverage:
    # 2a. Equal base price (1000) across all 5x5 ordered category pairs (captures position flips).
    for cat1, cat2 in itertools.product(COMPARE_AT_CATEGORIES, repeat=2):
        add_specs(
            [
                (1000, compare_at_for_category(1000, cat1), True),
                (1000, compare_at_for_category(1000, cat2), True),
            ]
        )

    # 2b. Equal zero prices across key compare-at categories.
    for cat1, cat2 in itertools.product(("missing", "zero", "above"), repeat=2):
        add_specs(
            [
                (0, compare_at_for_category(0, cat1), True),
                (0, compare_at_for_category(0, cat2), True),
            ]
        )

    # 2c. Varied prices ascending (1000, 2000) across all 5x5 ordered category pairs.
    for cat1, cat2 in itertools.product(COMPARE_AT_CATEGORIES, repeat=2):
        add_specs(
            [
                (1000, compare_at_for_category(1000, cat1), True),
                (2000, compare_at_for_category(2000, cat2), True),
            ]
        )

    # 2d. Varied prices descending (2000, 1000) across all 5x5 ordered category pairs.
    for cat1, cat2 in itertools.product(COMPARE_AT_CATEGORIES, repeat=2):
        add_specs(
            [
                (2000, compare_at_for_category(2000, cat1), True),
                (1000, compare_at_for_category(1000, cat2), True),
            ]
        )

    # 2e. Zero-and-positive price pairs in both orders.
    zero_pos_patterns = [
        ("missing", "above"),
        ("above", "missing"),
        ("zero", "above"),
        ("above", "zero"),
        ("missing", "equal"),
        ("equal", "missing"),
    ]
    for cat1, cat2 in zero_pos_patterns:
        add_specs(
            [
                (0, compare_at_for_category(0, cat1), True),
                (1000, compare_at_for_category(1000, cat2), True),
            ]
        )
        add_specs(
            [
                (1000, compare_at_for_category(1000, cat1), True),
                (0, compare_at_for_category(0, cat2), True),
            ]
        )

    # 2f. Availability masks on representative 2-variant patterns.
    avail_patterns: list[tuple[tuple[int, str], tuple[int, str]]] = [
        ((1000, "above"), (1000, "missing")),
        ((1000, "missing"), (1000, "above")),
        ((1000, "below"), (1000, "above")),
        ((1000, "equal"), (1000, "equal")),
        ((1000, "missing"), (2000, "equal")),
        ((1000, "zero"), (2000, "above")),
    ]
    for (p1, c1), (p2, c2) in avail_patterns:
        for av1, av2 in ((True, False), (False, True), (False, False)):
            add_specs(
                [
                    (p1, compare_at_for_category(p1, c1), av1),
                    (p2, compare_at_for_category(p2, c2), av2),
                ]
            )

    # 3. Three-variant ordered boundary combinations:
    # 3a. Permutations of mixed categories at equal price (1000).
    for perm in itertools.permutations(("missing", "zero", "above")):
        add_specs([(1000, compare_at_for_category(1000, c), True) for c in perm])
    for perm in itertools.permutations(("missing", "below", "above")):
        add_specs([(1000, compare_at_for_category(1000, c), True) for c in perm])

    # 3b. Position shifts with 1 sale variant vs 2 non-sale variants.
    three_equal_patterns = [
        ("above", "missing", "missing"),
        ("missing", "above", "missing"),
        ("missing", "missing", "above"),
        ("equal", "equal", "above"),
        ("above", "equal", "equal"),
        ("zero", "zero", "above"),
    ]
    for c1, c2, c3 in three_equal_patterns:
        add_specs(
            [
                (1000, compare_at_for_category(1000, c1), True),
                (1000, compare_at_for_category(1000, c2), True),
                (1000, compare_at_for_category(1000, c3), True),
            ]
        )

    # 3c. Varied prices (ascending & descending) and availability masks in 3 variants.
    varied_triples = [
        ((100, "missing"), (1000, "zero"), (2500, "above")),
        ((100, "missing"), (1000, "equal"), (2500, "above")),
        ((100, "below"), (1000, "equal"), (2500, "missing")),
        ((100, "missing"), (1000, "below"), (2500, "zero")),
        ((2500, "above"), (1000, "zero"), (100, "missing")),
        ((2500, "equal"), (1000, "missing"), (100, "missing")),
        ((100, "above"), (1000, "above"), (2500, "above")),
        ((100, "missing"), (1000, "missing"), (2500, "missing")),
    ]
    for (p1, c1), (p2, c2), (p3, c3) in varied_triples:
        add_specs(
            [
                (p1, compare_at_for_category(p1, c1), True),
                (p2, compare_at_for_category(p2, c2), True),
                (p3, compare_at_for_category(p3, c3), True),
            ]
        )

    for av_mask in ((True, False, True), (False, True, False), (False, False, False)):
        add_specs(
            [
                (100, compare_at_for_category(100, "missing"), av_mask[0]),
                (1000, compare_at_for_category(1000, "zero"), av_mask[1]),
                (2500, compare_at_for_category(2500, "above"), av_mask[2]),
            ]
        )

    return fixtures


def sample_phase2_fixture(rng: random.Random) -> dict[str, Any]:
    """Sample a random 1..8 variant fixture biased toward shared prices and mixed sale states."""
    n_variants = rng.randint(1, MAX_VARIANTS)

    price_mode = rng.random()
    if price_mode < 0.45:
        shared = _pick_price(rng)
        prices = [shared for _ in range(n_variants)]
    elif price_mode < 0.70:
        p1 = _pick_price(rng)
        p2 = _pick_price(rng)
        prices = [rng.choice((p1, p2)) for _ in range(n_variants)]
    else:
        prices = [_pick_price(rng) for _ in range(n_variants)]

    profile = rng.random()
    if profile < 0.70:
        cat_pool = COMPARE_AT_CATEGORIES
    elif profile < 0.85:
        cat_pool = ("missing", "zero", "below", "equal")
    else:
        cat_pool = ("above", "equal", "missing", "zero")

    avail_mode = rng.random()
    specs: list[tuple[int, int | None, bool]] = []
    for price in prices:
        cat = rng.choice(cat_pool)
        compare_at = _sample_compare_at(rng, price, cat)
        if avail_mode < 0.15:
            available = False
        elif avail_mode < 0.35:
            available = True
        else:
            available = rng.random() < 0.70
        specs.append((price, compare_at, available))

    return build_fixture(specs)


def _pick_price(rng: random.Random) -> int:
    if rng.random() < 0.65:
        return rng.choice(PHASE2_PRICE_PALETTE)
    if rng.random() < 0.85:
        return rng.randint(0, 10_000)
    return rng.randint(0, MAX_PRICE_CENTS)


def _sample_compare_at(rng: random.Random, price: int, category: str) -> int | None:
    if category == "missing":
        return None
    if category == "zero":
        return 0
    if category == "equal":
        return price
    if category == "below":
        if price <= 0:
            return 0
        if price == 1:
            return 0
        return rng.choice(
            [
                0,
                max(0, price - 1),
                price // 2,
                max(0, price - 100),
                rng.randint(0, price - 1),
            ]
        )
    if category == "above":
        if price >= MAX_PRICE_CENTS:
            return MAX_PRICE_CENTS
        delta = rng.choice([1, 50, 100, 500, 1000, 2500, rng.randint(1, 5000)])
        return min(MAX_PRICE_CENTS, price + delta)
    raise ValueError(f"Unknown compare-at category: {category!r}")


class CandidateGenerator:
    """Stateful deterministic Phase 1 + Phase 2 candidate fixture iterator."""

    def __init__(
        self,
        *,
        seed: int,
        max_pairs: int,
        max_duplicate_attempts: int = MAX_DUPLICATE_ATTEMPTS,
        phase1_fixtures: Sequence[dict[str, Any]] | None = None,
        phase2_sampler: Callable[[random.Random], dict[str, Any]] | None = None,
    ) -> None:
        if max_pairs < 1:
            raise ValueError("max_pairs must be >= 1")
        if max_duplicate_attempts < 1:
            raise ValueError("max_duplicate_attempts must be >= 1")

        self.seed = int(seed)
        self.max_pairs = int(max_pairs)
        self.max_duplicate_attempts = int(max_duplicate_attempts)
        self._phase1_fixtures = (
            list(phase1_fixtures) if phase1_fixtures is not None else build_phase1_boundary_fixtures()
        )
        self._phase2_sampler = phase2_sampler if phase2_sampler is not None else sample_phase2_fixture
        self.yielded_count = 0
        self.duplicate_skips = 0
        self.exhausted_space = False

    def __iter__(self) -> Iterator[dict[str, Any]]:
        seen: set[str] = set()
        self.yielded_count = 0
        self.duplicate_skips = 0
        self.exhausted_space = False

        for fixture in self._phase1_fixtures:
            key = canonical_json(fixture)
            if key in seen:
                continue
            seen.add(key)
            self.yielded_count += 1
            yield fixture
            if self.yielded_count >= self.max_pairs:
                return

        rng = random.Random(self.seed)
        consecutive_duplicates = 0
        while self.yielded_count < self.max_pairs:
            candidate = self._phase2_sampler(rng)
            key = canonical_json(candidate)
            if key in seen:
                self.duplicate_skips += 1
                consecutive_duplicates += 1
                if consecutive_duplicates >= self.max_duplicate_attempts:
                    self.exhausted_space = True
                    return
                continue

            seen.add(key)
            consecutive_duplicates = 0
            self.yielded_count += 1
            yield candidate


def generate_candidates(
    seed: int,
    max_pairs: int,
    *,
    max_duplicate_attempts: int = MAX_DUPLICATE_ATTEMPTS,
) -> list[dict[str, Any]]:
    """Return up to `max_pairs` canonical unique candidate fixtures for `seed`."""
    return list(
        CandidateGenerator(
            seed=seed,
            max_pairs=max_pairs,
            max_duplicate_attempts=max_duplicate_attempts,
        )
    )

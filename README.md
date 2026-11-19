# Shopify Liquid Regression Finder

`liquid-regression-finder` is a local npm CLI (and optional web demo) that checks Shopify Liquid product-card snippets on save or in CI against a Git baseline, deterministically searches for a product fixture where sale-badge presence (`[data-regression-badge="sale"]`) diverges, verifies both outputs against the official `liquid` Ruby gem (`5.14.0`), minimizes the counterexample, and saves a deterministic replay bundle.

---

## Quickstart: npm CLI Developer Workflow

### 1. Prerequisites

`liquid-regression-finder` runs locally in your Shopify theme repository without Rails or React. System prerequisites (see [`docs/setup-guide.md`](docs/setup-guide.md) for OS package commands):

- **Git** (`git` on `PATH`)
- **Node.js** `>= 18.0.0` (verified with `v24.15.0` / `npm 11.12.1`)
- **Python** `>= 3.10` (`python3.11` recommended; macOS `/usr/bin/python3` `3.9` is rejected)
- **Ruby** `>= 3.1` (`ruby@3.3` recommended; macOS `/usr/bin/ruby` `2.6.10` is rejected) and matching **Bundler** (`>= 2.0.0`)

### 2. Install & Initialize Engine Cache

Install from a packed tarball (or by package name once published to npm):

```sh
npm install -D /path/to/liquid-regression-finder.tgz
# Or once published to npm:
# npm install -D liquid-regression-finder
```

Verify prerequisites, install locked Ruby engine gems (`engine/Gemfile.lock`) into a versioned user cache (`~/.cache/liquid-regression-finder/...` or `$LRF_CACHE_DIR`) without modifying `node_modules/`, and run the built-in smoke check:

```sh
npx liquid-regression-finder setup
```

### 3. Configure Your Theme Repo

Create `liquid-regression.json` at your Git repository root (copyable from [`liquid-regression.example.json`](liquid-regression.example.json)):

```json
{
  "snippet_path": "snippets/card-product.liquid",
  "observer": "sale_badge",
  "seed": 0,
  "budget": {
    "search_pairs": 256,
    "shrink_pairs": 128
  },
  "watch_budget": {
    "search_pairs": 32,
    "shrink_pairs": 16
  }
}
```

Ignore generated replay artifacts in `.gitignore`:

```gitignore
.liquid-regression/
```

Add `liquid:watch` alongside your existing dev scripts in `package.json`:

```json
{
  "scripts": {
    "dev": "shopify theme dev",
    "liquid:watch": "liquid-regression-finder watch",
    "liquid:check": "liquid-regression-finder check --base-ref HEAD"
  }
}
```

### 4. Daily Commands

- **Watch on save** (resolves `--base-ref` once at startup, defaults to `HEAD` and `watch_budget` `32`/`16`, debounces `250 ms`, stays quiet on negative checks, writes `.liquid-regression/result.json` on findings, and stops cleanly on `Ctrl-C`):

  ```sh
  npx liquid-regression-finder watch
  ```

  > **Tip:** Override budgets per run when needed (for example, `--search-pairs 64 --shrink-pairs 32` to catch multi-variant regressions beyond the first 32 boundary candidates while watching).

- **One-off check** (working tree vs `HEAD` with `budget` `256`/`128`, or two explicit Git commits for CI):

  ```sh
  npx liquid-regression-finder check --base-ref HEAD
  npx liquid-regression-finder check --base-ref <base_sha> --head-ref <head_sha> --search-pairs 256 --shrink-pairs 128 --replay-out .liquid-regression/result.json
  ```

- **Deterministic replay** (verifies saved `.liquid-regression/result.json` in a fresh process against official `liquid 5.14.0` without searching):

  ```sh
  npx liquid-regression-finder replay .liquid-regression/result.json
  ```

- **Machine-readable JSON output**: pass `--json` to `setup`, `check`, or `replay`.

### CLI Exit Codes

| Exit Code | `check` | `watch` | `replay` | `setup` |
| --- | --- | --- | --- | --- |
| `0` | `no_difference_found` | Clean `SIGINT`/`SIGTERM` shutdown | `replayed` (parity & hashes verified) | Prerequisites, cache, and smoke check passed |
| `1` | `difference_found` (official `liquid 5.14.0` confirmed) | — | — | — |
| `2` | Setup, config, missing Git ref/blob, syntax, or engine error | Startup prerequisite, config, or Git baseline error | Tampered bundle, hash/version mismatch, or execution error | Missing/incompatible tool, Bundler error, or smoke check failure |

---

## Two-Version Sale-Badge Demo

The repository includes a concrete two-version demonstration comparing variant-level sale detection in [`snippets/card-product.liquid`](snippets/card-product.liquid) against a product-level refactor in [`fixtures/demo/after.liquid`](fixtures/demo/after.liquid).

**Before (`snippets/card-product.liquid`, variant-level loop):**

```liquid
{%- assign on_sale = false -%}
{%- for variant in product.variants -%}
  {%- if variant.compare_at_price != nil and variant.compare_at_price > variant.price -%}
    {%- assign on_sale = true -%}
  {%- endif -%}
{%- endfor -%}
<div class="card-product" data-available="{{ product.available }}">
  {%- if on_sale -%}
  <span class="badge" data-regression-badge="sale">Sale</span>
  {%- endif -%}
  <span class="price">{{ product.price }}</span>
</div>
```

**After (product-level broken edit, matching [`fixtures/demo/after.liquid`](fixtures/demo/after.liquid)):**

```liquid
{%- if product.compare_at_price != nil and product.compare_at_price > product.price -%}
<span class="badge" data-regression-badge="sale">Sale</span>
{%- endif -%}
```

When `v1` has `price: 0, compare_at_price: 0` and `v2` has `price: 0, compare_at_price: 1` (discovered at candidate index `55` in `56` search pairs and shrunk in `28` shrink pairs), `product.compare_at_price` aggregates to `0` while `v2` is on sale (`1c > 0c`). Running `check --base-ref HEAD` (or `watch --search-pairs 64 --shrink-pairs 32`) outputs:

```text
snippets/card-product.liquid:1 Sale badge disappeared
Before: v2 compared 1c > 0c, true. Badge shown.
After:  product compared 0c > 0c, false. Badge absent.
Official Liquid confirmed. Replay in .liquid-regression/result.json.
```

Replaying the saved bundle reproduces the exact same witness and official Liquid confirmation:

```sh
npx liquid-regression-finder replay .liquid-regression/result.json
```

---

## Platform & Tool Versions Tested

| Environment | OS / Platform | Verified Toolchain Versions | Notes |
| --- | --- | --- | --- |
| **Local Development & Verification** | macOS `26.3` (`Build 25D125`, `arm64`) | Node.js `v24.15.0`, npm `11.12.1`, Ruby `3.3.13` (`arm64-darwin25`), Bundler `4.0.23`, Python `3.11.18`, Git `2.50.1 (Apple Git-155)`, `liquid 5.14.0` (`nokogiri 1.19.7`, `json_schemer 2.5.0`, `regexp_parser 2.12.0` in [`engine/Gemfile.lock`](engine/Gemfile.lock)) | All CLI, engine, clean-checkout, and tarball acceptance gates exercised locally. |
| **GitHub Actions CI Target** | `ubuntu-latest` ([`.github/workflows/liquid-regression.yml`](.github/workflows/liquid-regression.yml)) | Ruby `3.3` (`.ruby-version` `3.3.13`), Python `3.11` (`.python-version` `3.11.18`), Node `24` (`.node-version` `24.15.0`) | Workflow YAML validated locally; live GitHub Actions execution has not been triggered. |

---

## Architecture & Verified Engine Metrics

### CLI Execution Flow

```text
liquid-regression-finder (cli/, Node >= 18 stdlib-only)
  ├── git cat-file / working tree raw UTF-8 bytes
  ├── search/ (Python 3.11 stdlib-only: generator 1.0.0, shrinker, trace alignment, replay)
  └── reference/bin/worker (Ruby 3.3 JSONL IPC)
        ├── LiquidInterpreter (0.1.0) — AST evaluation + trace side-channel
        └── Official liquid (5.14.0) + Nokogiri HTML5 observer ([data-regression-badge="sale"])
```

- **HTML Observer Contract**: [`observer.rb`](reference/lib/liquid_reference/observer.rb) parses fragments with `Nokogiri::HTML5.fragment` and matches `[data-regression-badge="sale"]`. Plain text, HTML comments, escaped HTML, `<script>`/`<style>`/`<textarea>` raw text, and `sold_out` badges do not match. Snippets must be valid UTF-8 and `<= 16 KiB` (`16,384` bytes), evaluated under `depth <= 32`, `steps <= 50,000`, `output <= 128 KiB`, and `trace_events <= 10,000`.
- **Conformance Coverage (`liquid-spec`)**: Against pinned `liquid-spec` (`84bf25e0edbca5f7e530574788b0f875ab331f50`) and `liquid 5.14.0` ([`artifacts/stage-7/conformance-report.txt`](artifacts/stage-7/conformance-report.txt)):
  - Selected & passing: **`399 / 399` (`100.00%`**, `fail=0`, `error=0`; `basics` `155 / 955`, `liquid_ruby` `244 / 2106`)
  - Inventoried (`basics + liquid_ruby`, `3,061`): **`13.03%`**; All 8 `liquid-spec` suites (`7,395`): **`5.40%`**
- **Dawn Benchmark Summary**: Across **15 verified `Shopify/dawn` cases** (`10` supported, `5` unsupported; `seeds 0..4`, `search_pairs=256`, `shrink_pairs=128`) vs `shopifypartners/product-csvs` sample baseline (`60` products / `66` variants at `045fb432d85dc59d558717208399176d62bf106d`; [`bench/reports/benchmark.md`](bench/reports/benchmark.md)):
  - Supported 10 cases detected: **`10 / 10` (`100.0%`, `50 / 50` runs)** vs **`9 / 10` (`90.0%`)** sample baseline
  - All 15 cases detected: **`10 / 15` (`66.7%`, `50 / 75` runs, `0` error)** vs **`9 / 15` (`60.0%`, `1` `budget_exhausted`, `0` error)**
  - Median pairs (detected): **`3.5` search / `1` shrink** vs **`22` search / `2` shrink** (sub-second `first_difference_ms` and `shrink_ms` recorded per run in [`bench/reports/benchmark.md`](bench/reports/benchmark.md))
  - Instrumented JSONL IPC overhead (`256` pairs on `dawn_pr_794_price_badge_sale_aria_hidden`): sub-tenth-millisecond per-pair serialization overhead (`< 0.1 ms/pair`; exact `custom` and `reference` measurements recorded in [`bench/reports/benchmark.md`](bench/reports/benchmark.md))

---

## Pull-Request CI Workflow

[`.github/workflows/liquid-regression.yml`](.github/workflows/liquid-regression.yml) defines two jobs on `ubuntu-latest` (`Ruby 3.3`, `Python 3.11`, `Node 24`):

1. **`verify`**: Runs `./bin/setup && ./bin/check all` on `push` and `pull_request`, exercising both the engine/API/web stage gates (`stage-1`..`stage-10`) and the npm CLI gates (`cli-stage-1`..`cli-stage-4`).
2. **`pr-snippet-check`**: On same-repository `pull_request` events (`fetch-depth: 0`), packs and installs the npm CLI locally, runs `npx --no-install liquid-regression-finder setup`, and runs the same CLI check command against the PR base and head SHAs:

   ```sh
   npx --no-install liquid-regression-finder check \
     --base-ref "${{ github.event.pull_request.base.sha }}" \
     --head-ref "${{ github.event.pull_request.head.sha }}" \
     --search-pairs 256 \
     --shrink-pairs 128 \
     --replay-out .liquid-regression/result.json
   ```

   Exit codes `0`, `1`, and `2` are preserved explicitly, a Markdown summary is written to `$GITHUB_STEP_SUMMARY`, and `.liquid-regression/result.json` + `.liquid-regression/summary.txt` are uploaded via `actions/upload-artifact@v4` whenever a finding (`1`) or error (`2`) occurs.

*(The legacy Rails-backed [`bin/pr-check`](bin/pr-check) and [`bin/pr_dry_run`](bin/pr_dry_run) scripts remain intact for the optional Rails API workflow.)*

---

## Optional Rails + React Web App Demo

The repository also includes a full-stack web companion (`api/` Rails `8.1.4.1` + SQLite + Solid Queue, `web/` React `19.3.1` + TypeScript `5.9.3` + Vite `7.3.8`, plus Node serverless companion handlers in `web/api/`).

- **Live Vercel Demo**: https://liquid-regression-finder.vercel.app (`web/` + `web/api/` Node serverless companion)
- **Local Full-Stack Launch**:

  1. Install all Ruby (`Gemfile.lock`, `engine/Gemfile.lock`, `api/Gemfile.lock`) and npm (`web/package-lock.json`) dependencies and prepare SQLite databases:

     ```sh
     ./bin/setup
     ```

  2. Start the Solid Queue worker and Rails API server (`api/`):

     ```sh
     cd api
     bundle exec bin/jobs
     ```

     ```sh
     cd api
     bundle exec bin/rails server -b 127.0.0.1 -p 3000
     ```

  3. Start the React + Vite frontend (`web/`, proxying `/api` to `http://127.0.0.1:3000`):

     ```sh
     cd web
     npm run dev
     ```

- **Full Verification & Clean-Checkout Check**:

  ```sh
  ./bin/check cli-stage-4        # Migration Stages 1–4 CLI gates + acceptance walkthrough
  ./bin/check all                # All original (1–10) + CLI migration (1–4) stage gates
  ./bin/verify_clean_checkout    # Clean source export -> ./bin/setup -> ./bin/check all -> standalone checks
  ```

---

## Repository Layout, Scope & Verification Status

| Path | Purpose |
| --- | --- |
| [`cli/`](cli/) | Node.js `>= 18` stdlib-only CLI (`setup`, `check`, `watch`, `replay`), config loader, Git reader, 4-line formatter, and Stage 1–4 tests |
| [`engine/`](engine/) | Minimal 4-gem runtime bundle (`engine/Gemfile`, `engine/Gemfile.lock`) for the packaged CLI |
| [`interpreter/`](interpreter/) | Custom UTF-8 Liquid lexer, parser, AST, evaluator, tracer, resource limits, and `liquid-spec` adapter |
| [`reference/`](reference/) | Official `liquid 5.14.0` renderer, `PROJECTION_VERSION = "1.0.0"`, Nokogiri HTML5 observer, and JSONL worker |
| [`search/`](search/) | Python 3.11 stdlib-only deterministic generator (`1.0.0`), search engine, lexicographic shrinker, trace explainer, and replay |
| [`contracts/`](contracts/) | Draft 2020-12 JSON Schemas, schema tests, and frozen `liquid-spec` conformance manifest |
| [`bench/`](bench/) | Verified 15-case `Shopify/dawn` corpus, `shopifypartners/product-csvs` baseline, benchmark runner, and generated reports |
| [`fixtures/`](fixtures/) & [`snippets/`](snippets/) | Demo snippets, ordinary controls, Dawn witnesses, and watched [`snippets/card-product.liquid`](snippets/card-product.liquid) |
| [`api/`](api/) & [`web/`](web/) | Optional Rails `8.1.4.1` + Solid Queue API and React `19.3.1` + TypeScript `5.9.3` UI |
| [`bin/`](bin/) | [`bin/setup`](bin/setup), [`bin/check`](bin/check), [`bin/verify_clean_checkout`](bin/verify_clean_checkout), [`bin/pr-check`](bin/pr-check), [`bin/pr_dry_run`](bin/pr_dry_run) |

### Scope & External-Host Status

- **Release Scope**: One configured standalone snippet (`<= 16 KiB`), one `sale_badge` observer (`[data-regression-badge="sale"]`), integer USD cents fixtures (`1..8` variants), and daily commands `watch`, `check`, and `replay` (`setup` for engine cache initialization). Whole-theme dependency tracking, external CSS visibility evaluation, and Shopify object Drops beyond `product` / `product.variants` are out of scope.
- **Storefront Probe**: `storefront_unverified` — probe template ([`product-projection-probe.liquid`](reference/probe/product-projection-probe.liquid)) and 6-case matrix ([`fixtures/storefront_probe_matrix.json`](fixtures/storefront_probe_matrix.json)) ship with the repo, scoped to local projection model `1.0.0`.
- **GitHub Actions PR Run**: [`.github/workflows/liquid-regression.yml`](.github/workflows/liquid-regression.yml) is validated syntactically with Ruby `YAML.safe_load_file`; its `check` command (`--base-ref` / `--head-ref` / `--search-pairs 256` / `--shrink-pairs 128` / `--replay-out`) is verified locally in [`cli/tests/test_stage4_acceptance_walkthrough.mjs`](cli/tests/test_stage4_acceptance_walkthrough.mjs), not triggered on a live GitHub pull request event.
- **Hosted Vercel Web Demo**: Exercised and verified (`web/` + `web/api/`) at `https://liquid-regression-finder.vercel.app`.

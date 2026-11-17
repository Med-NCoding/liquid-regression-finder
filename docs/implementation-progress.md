# Implementation Progress — Shopify Liquid Regression Finder

- **Current Stage**: Stage 8 (`passed`)
- **Last Completed Stage**: Stage 8 — Rails API and asynchronous persistence
- **Repository**: https://github.com/Med-NCoding/liquid-regression-finder

## Stage Tracker

| Stage | Title | Status | Gate Command | Last Exit Status | Evidence Paths |
|---|---|---|---|---|---|
| 1 | Bootstrap and conformance adapter | passed | `bin/check stage-1` | 0 | `artifacts/stage-1/liquid-spec-pilot.txt`, `contracts/conformance-manifest.json`, `docs/toolchain-versions.md` |
| 2 | Liquid engine | passed | `bin/check stage-2` | 0 | `artifacts/stage-2/conformance-report.txt`, `artifacts/stage-2/nested-loop-trace.json`, `interpreter/test/` |
| 3 | Shopify projection and reference | passed | `bin/check stage-3` | 0 | `artifacts/stage-3/ordinary-parity.json`, `fixtures/storefront_probe_matrix.json`, `docs/storefront-probe.md`, `reference/test/` |
| 4 | Counterexample search | passed | `bin/check stage-4` | 0 | `artifacts/stage-4/demo-compare.json`, `artifacts/stage-4/demo-replay.json`, `artifacts/stage-4/identical-compare.json`, `search/tests/` |
| 5 | Shrink, explanation and replay | passed | `bin/check stage-5` | 0 | `artifacts/stage-5/demo-compare.json`, `artifacts/stage-5/demo-replay.json`, `artifacts/stage-5/demo-replay-result.json`, `artifacts/stage-5/identical-compare.json`, `search/tests/` |
| 6 | Dawn corpus | passed | `bin/check stage-6` | 0 | `bench/corpus/manifest.json`, `fixtures/witnesses/`, `artifacts/stage-6/corpus-verification.json`, `artifacts/stage-6/corpus-summary.md`, `bench/tests/test_dawn_corpus.rb` |
| 7 | Benchmark and engine extensions | passed | `bin/check stage-7` | 0 | `bench/reports/benchmark.md`, `bench/reports/benchmark.csv`, `bench/reports/benchmark_details.json`, `bench/sample_baseline/PROVENANCE.md`, `artifacts/stage-7/conformance-report.txt` |
| 8 | Rails API and jobs | passed | `bin/check stage-8` | 0 | `api/`, `api/bin/e2e_smoke_check`, `artifacts/stage-8/e2e-smoke-report.json`, `api/test/` |
| 9 | React results UI | pending | `bin/check stage-9` | — | — |
| 10 | PR workflow and release | pending | `bin/check all` | — | — |

## Stage Details & Checkpoint Log

### Stage 0 — Repository Initialization
- **Status**: `passed`
- **Completed Tasks**:
  - Created repository structure at `/Users/medhanshnegi/.gemini/antigravity/scratch/liquid-regression-finder`
  - Saved `Shopify-Liquid-Regression-Finder-Implementation-Plan.md`
  - Added `.gitignore` and `docs/implementation-progress.md`
- **Next Command**: Start Stage 1 worker (`bin/check stage-1`)

### Stage 1 — Bootstrap and Conformance Adapter
- **Status**: `passed`
- **Pinned Toolchain & Lockfiles**:
  - `.ruby-version` (`3.3.13`), `.python-version` (`3.11.18`), `.node-version` (`24.15.0`)
  - `Gemfile` and `Gemfile.lock` locked with `liquid 5.14.0`, `nokogiri 1.19.7`, `minitest 5.27.0`, `json_schemer 2.5.0` (with `regexp_parser 2.12.0` pinned `< 2.13` to avoid `EcmaRegexp::Syntax` incompatibility with `2.13.x`), and `liquid-spec 2.0.0` at SHA `84bf25e0edbca5f7e530574788b0f875ab331f50` (Bundler `4.0.23`, local `vendor/bundle`).
  - Full version table documented in `docs/toolchain-versions.md`.
- **Completed Tasks**:
  - **JSON Schemas & Contract Examples (`contracts/`)**: Implemented all 10 Draft 2020-12 schemas (`fixture`, `trace_event`, `render_result`, `compare_request`, `replay_bundle`, `projection`, `finding`, `comparison_job`, `jsonl_request`, `jsonl_response`) with `additionalProperties: false` and Section 4 bounds/invariants, valid/invalid examples under `contracts/examples/`, and `contracts/test_contracts.rb` (6 runs, 196 assertions, 0 failures).
  - **Minimal Custom Interpreter (`interpreter/`)**: Implemented `LiquidInterpreter` (`version.rb`, `span.rb`, `diagnostic.rb`, `ast.rb`, `lexer.rb`, `parser.rb`, `evaluator.rb`, `template.rb`, `conformance.rb`), parsing plain text into `AST::Text` nodes and evaluating via per-render `Evaluator` state while rejecting `{{` / `{%` in Stage 1 with line/Unicode-column `Span` diagnostics. Verified in `interpreter/test/test_stage1_bootstrap.rb` (7 runs, 9590 assertions, 0 failures).
  - **Liquid-Spec Adapter & Frozen Manifest**: Implemented `interpreter/liquid_spec_adapter.rb` (`LiquidSpec.setup`, `configure`, `compile`, `render`), `interpreter/bin/generate_manifest`, and `interpreter/bin/conformance_report`. Froze `contracts/conformance-manifest.json` from static pre-execution feature scope across all 8 suites (`7395` total; `3061` inventoried across `basics` `955` and `liquid_ruby` `2106`; `359` selected = `141` `basics` + `218` `liquid_ruby`, including `14` `plain_text` pilot cases = `8` `basics` + `6` `liquid_ruby`).
  - **Root Gate Dispatcher**: Implemented `bin/setup` and `bin/check` (`stage-1`, stub errors for `stage-2`..`stage-10` and `all`).
- **Exact `liquid-spec` Runner Invocations & Pilot Summary**:
  - `bundle exec liquid-spec run interpreter/liquid_spec_adapter.rb -s basics -n "/^(empty_template|literal_passthrough|whitespace_preserved|newlines_preserved|raw_text_)/" -v --list-passed` -> exit `0` (`Basics`: `8/8 passed`)
  - `bundle exec liquid-spec run interpreter/liquid_spec_adapter.rb -s liquid_ruby -n "StandardTagTest#test_no_transform" -v --list-passed` -> exit `0` (`Liquid Ruby`: `6/6 passed`)
  - `bundle exec ruby interpreter/bin/conformance_report --require-plain-text` -> exit `0`:
    - `plain_text_pilot`: `14/14` (`100.00%`)
    - `pass/selected`: `14/359` (`3.90%`, `fail=0`, `error=345` awaiting Stage 2 tags/expressions)
    - `pass/inventoried`: `14/3061` (`0.46%` across `basics` + `liquid_ruby`)
    - `pass/all_suites`: `14/7395` (`0.19%` across all 8 suites)
  - Full output with all 345 failure IDs saved to `artifacts/stage-1/liquid-spec-pilot.txt`.
- **Gate Command & Exit Status**: `./bin/check stage-1` -> exit `0`.
- **Stage 2 Note on Stage 1 Regression Test**: In Stage 2, `interpreter/test/test_stage1_bootstrap.rb` (`test_lexer_rejects_liquid_syntax_with_unicode_span`) was updated from testing `{{ name }}` / `{% if true %}` (now enabled in Stage 2) to `{% bogus %}` / `{% comment %}` so the test continues verifying `UnsupportedFeatureError` (`< SyntaxError`) with line and Unicode code-point column `Span`s.
- **Remaining Tasks**: Stage 3 through Stage 10.
- **Next Command**: Start Stage 3 worker (`bin/check stage-3`).

### Stage 2 — Liquid Engine
- **Status**: `passed`
- **Completed Tasks**:
  - **SpanMapper & Limits (`span.rb`, `diagnostic.rb`)**: Added `SpanMapper` for O(log L) UTF-8 byte-offset and Unicode code-point column mapping across multiline snippets, and `LimitError < Error` for resource limit diagnostics.
  - **Lexer & Whitespace Trimming (`lexer.rb`)**: Implemented full `:text`, `:output` (`{{ ... }}` / `{{- ... -}}`), and `:tag` (`{% ... %}` / `{%- ... -%}`) lexing, preserving raw UTF-8 spans without normalizing non-Liquid markup or non-ASCII whitespace (e.g., `\u00a0`), enforcing `MAX_SNIPPET_BYTES = 16_384`, and applying Liquid boundary trim markers (`{{-`, `-}}`, `{%-`, `-%}`).
  - **AST & Parser (`ast.rb`, `parser.rb`)**: Implemented `Document`, `Text`, `Output`, `Assign`, `Conditional` (`if`/`elsif`/`else`/`unless` with `ConditionalArm`), `For` (with optional `else`), and expressions (`Literal`, `Path`, `Compare`, right-grouped `Logical`), deterministic AST-path `node_id`s, `blank?` block whitespace removal matching `liquid 5.14.0`, `MAX_DEPTH = 32`, and structured `SyntaxError`/`UnsupportedFeatureError` diagnostics with source spans.
  - **Evaluator & Scopes (`evaluator.rb`)**: Implemented per-render deep-copied JSON assigns, `root_scope` + `loop_scopes` stack (`assign` persistence across loops, `for` binder shadowing/restoration), permissive missing-vs-null lookups, `liquid 5.14.0` truthiness, right-grouped `and`/`or` short-circuiting, strict comparison error/false parity, and array/hash/string output rendering.
  - **Tracer & Resource Limits (`tracer.rb`, `template.rb`, `interpreter/bin/nested_loop_demo`)**: Implemented trace side-channel emitting schema-valid `Lookup`, `Comparison`, `Branch`, `Assignment`, and `Emit` events (`seq`, AST `node_id`, nested loop `Frame`s with `variant_id`, value snapshots, `active_branch_seqs`), `Template.render_result` returning contract `RenderResult`, and runtime enforcement of `MAX_DEPTH = 32`, `MAX_STEPS = 50_000`, `MAX_OUTPUT_BYTES = 131_072`, and `MAX_TRACE_EVENTS = 10_000`.
  - **Unit, Oracle, Tracer & Limit Suites (`interpreter/test/`)**:
    - `contracts/test_contracts.rb`: `6 runs, 196 assertions, 0 failures, 0 errors, 0 skips`
    - `interpreter/test/test_stage1_bootstrap.rb`: `7 runs, 9591 assertions, 0 failures, 0 errors, 0 skips`
    - `interpreter/test/test_lexer_and_parser.rb`: `7 runs, 232 assertions, 0 failures, 0 errors, 0 skips`
    - `interpreter/test/test_evaluator_and_oracle.rb`: `7 runs, 710 assertions, 0 failures, 0 errors, 0 skips`
    - `interpreter/test/test_tracer_and_limits.rb`: `8 runs, 30978 assertions, 0 failures, 0 errors, 0 skips`
- **Conformance & `liquid-spec` Verification**:
  - `bundle exec ruby interpreter/bin/conformance_report --require-all-selected` -> exit `0` (saved to `artifacts/stage-2/conformance-report.txt`; manifest unchanged):
    - `basics`: `141/141` (`fail=0, error=0, skip=814`)
    - `liquid_ruby`: `218/218` (`fail=0, error=0, skip=1888`)
    - `plain_text_pilot`: `14/14` (`100.00%`)
    - `pass/selected`: `359/359` (`100.00%`)
    - `pass/inventoried`: `359/3061` (`11.73%` across `basics` + `liquid_ruby`)
    - `pass/all_suites`: `359/7395` (`4.85%` across all 8 suites)
  - Full suite `liquid-spec` runs (out-of-scope features like filters/floats/ranges/empty account for remaining suite failures):
    - `bundle exec liquid-spec run interpreter/liquid_spec_adapter.rb -s basics` -> `143 passes, 700 failures, 112 skipped`
    - `bundle exec liquid-spec run interpreter/liquid_spec_adapter.rb -s liquid_ruby` -> `235 passes, 1318 failures, 553 skipped`
  - Selected-subset `liquid-spec` CLI checks in `bin/check stage-2` (`-s basics` `34/34` passes, `-s liquid_ruby` `68/68` passes) -> exit `0`.
  - Nested-loop trace demo (`interpreter/bin/nested_loop_demo --out artifacts/stage-2/nested-loop-trace.json`) -> exit `0` (`status=ok`, `html_bytes=142`, `observed=true`, `events=38`, validated against `render_result.schema.json` and `trace_event.schema.json`).
- **Gate Command & Exit Status**: `./bin/check stage-2` -> exit `0` (`./bin/check stage-1` -> exit `0`).
- **Stage 7 Note on Stage 2 Regression Test & Manifest**: In Stage 7, `interpreter/test/test_lexer_and_parser.rb` (`test_rejects_unsupported_features_with_line_column_diagnostics`) was updated on one entry from `{% liquid ... %}` (now implemented in Stage 7) to `{% capture x %}hi{% endcapture %}`, and `contracts/conformance-manifest.json` was regenerated to widen from `359/359` to `399/399` (`+40` cases across `default` filter, `.size` property, and `liquid` tag).
- **Remaining Tasks**: Stage 3 through Stage 10.
- **Next Command**: Start Stage 3 worker (`bin/check stage-3`).

### Stage 3 — Shopify Projection and Reference
- **Status**: `passed`
- **Completed Tasks**:
  - **Fixture Validation & Product Projection (`reference/lib/liquid_reference/fixture_validator.rb`, `projection.rb`, `version.rb`)**: Implemented strict `Fixture` validation against `contracts/schemas/fixture.schema.json` plus semantic invariants (unique variant IDs `1..32` chars, integer USD cents `0..10_000_000`, `compare_at_price` `nil` or integer, strict booleans, no extra/symbol keys). Implemented `LiquidReference::Projection` (`PROJECTION_VERSION = "1.0.0"`) computing `price`/`price_min`/`price_max`/`price_varies`, `available`, and numeric `compare_at_price*` aggregates retaining explicit `0` while excluding `nil`, returning `Projection.project_for_render` validated against `projection.schema.json` with independent `deep_copy` assigns per engine render.
  - **HTML Observer (`reference/lib/liquid_reference/observer.rb`)**: Implemented `LiquidReference::Observer.observe("sale_badge", html)` using `Nokogiri::HTML5.fragment(html)` (with graceful `HTML4.fragment` fallback) querying `[data-regression-badge="sale"]`, rejecting decoy plain text, HTML comments, escaped HTML, `<script>`/`<textarea>`/`<style>` raw text, `sold_out` badges, and unsupported observer names.
  - **Official Reference & Custom Wrapper (`reference/lib/liquid_reference/renderer.rb`)**: Configured a restricted `Liquid::Environment` (`liquid 5.14.0`, `error_mode: :strict2`, `DisabledFileSystem` blocking `include`/`render`, standard tags/filters only, `strict_variables: false`), enforcing `MAX_SNIPPET_BYTES = 16_384`, `MAX_DEPTH = 32`, `MAX_STEPS = 50_000` (`Liquid::ResourceLimits` + `Timeout` backstop), and `MAX_OUTPUT_BYTES = 131_072` (`render_length_limit` + post-render byte check), returning contract `RenderResult`s (`events: []` for `reference`, traced `events` for `custom`).
  - **Persistent JSONL Worker (`reference/lib/liquid_reference/worker.rb`, `reference/bin/worker`)**: Implemented UTF-8 JSONL protocol handling `compile`, `render_pair`, and `quit` over `STDIN`/`STDOUT` (with `STDERR` reserved for unexpected diagnostics and `16 MiB` response frame limit), returning schema-valid `compile_result`, `render_pair_result`, `quit_result`, or `Diagnostic` `error_response` on invalid JSON/protocol/fixture/compile errors without crashing the loop.
  - **Ordinary Controls & Storefront Probe Deliverables**: Added ordinary control fixtures and snippets (`fixtures/ordinary/sale_product.json`, `regular_product.json`, `variant_sale_card.liquid`, `aggregate_sale_card.liquid`), draft probe template (`reference/probe/product-projection-probe.liquid`), instructions (`docs/storefront-probe.md`), and 6-case matrix (`fixtures/storefront_probe_matrix.json`) explicitly marked `status: "storefront_unverified"` and scoped to `PROJECTION_VERSION = "1.0.0"`.
  - **Stage 3 Unit & Protocol Suites (`reference/test/`)**:
    - `reference/test/test_projection.rb`: `5 runs, 126 assertions, 0 failures, 0 errors, 0 skips`
    - `reference/test/test_observer_and_reference.rb`: `4 runs, 131 assertions, 0 failures, 0 errors, 0 skips`
    - `reference/test/test_jsonl_worker.rb`: `3 runs, 149 assertions, 0 failures, 0 errors, 0 skips`
  - **Ordinary Parity Verification (`reference/bin/ordinary_parity_check`)**: Verified via real `reference/bin/worker` subprocess pipes over `sale_product.json` (`observed=true` across both engines) and `regular_product.json` (`observed=false` across both engines), saved to `artifacts/stage-3/ordinary-parity.json`.
- **Gate Command & Exit Status**: `./bin/check stage-3` -> exit `0` (includes `./bin/check stage-1` -> exit `0` and `./bin/check stage-2` -> exit `0`).
- **Remaining Tasks**: Stage 4 through Stage 10 (plus optional live Shopify storefront probe recorded as `storefront_unverified`).
- **Next Command**: Start Stage 4 worker (`bin/check stage-4`).

### Stage 4 — Counterexample Search
- **Status**: `passed`
- **Completed Tasks**:
  - **JSONL Worker Client (`search/worker_client.py`)**: Implemented Python 3.11 stdlib-only persistent subprocess client (`bundle exec ruby reference/bin/worker`, resolving `bundle` from PATH or `/opt/homebrew/opt/ruby@3.3/bin/bundle` with `cwd` at repo root and `start_new_session=True`), non-blocking `selectors` I/O, `5.0s` per-request timeout, `16 MiB` max stdout frame enforcement, `90.0s` hard job deadline watchdog, process-group reaping (`os.killpg`) on timeout/protocol errors/oversized frames/`quit` hangs, response schema validation, and structured exceptions (`WorkerProtocolError`, `WorkerTimeoutError`, `JobDeadlineError`, `WorkerCompileError`).
  - **Deterministic Candidate Generator (`search/generator.py`)**: Implemented `GENERATOR_VERSION = "1.0.0"`, `canonical_json` (`sort_keys=True`, compact separators, `allow_nan=False`), Phase 1 ordered 1-, 2-, and 3-variant boundary coverage (`189` unique fixtures across `missing`/`zero`/`below`/`equal`/`above`, zero and monetary prices, availability masks, equal vs varied prices, and position reversals), and Phase 2 `random.Random(seed)` sampling of `1..8` variants biased toward shared prices and mixed sale states, with cross-phase canonical deduplication and `MAX_DUPLICATE_ATTEMPTS = 10000`.
  - **Counterexample Search Engine (`search/engine.py`)**: Implemented `CompareRequest` validation, one-time worker `compile` with SHA-256 verification, budgeted search loop over `custom` (`trace=False`), reference parity verification (`reference`, `trace=False`) with `parity_rejections` tracking (`reference_mismatch` if exhausted with rejections and no confirmed finding), `trace=True` re-render verification, repo version resolution (`LiquidInterpreter::VERSION = "0.1.0"`, `liquid = "5.14.0"`, `PROJECTION_VERSION = "1.0.0"`), and Stage 4 `Finding`/`ReplayBundle`/`Stats` construction (`explanation.kind = "undetermined"` pending Stage 5).
  - **Demo Fixtures & CLI (`fixtures/demo/before.liquid`, `fixtures/demo/after.liquid`, `search/__init__.py`, `search/cli.py`, `search/__main__.py`)**: Added standalone `before.liquid` (variant-loop `on_sale` flag) and `after.liquid` (product-aggregate check) with NO failing fixture file in `fixtures/demo/`, and implemented `python -m search compare` (JSON on stdout only, diagnostics on stderr only, compact sorted-key UTF-8 `--replay-out`, exit codes `0` no difference, `1` confirmed difference, `2` failed/usage).
  - **Tests & Schema Verification (`search/tests/`)**:
    - `test_generator.py` (`7` tests), `test_engine_fake_worker.py` (`11` tests), `test_cli_and_real_worker.py` (`5` tests) — `23` tests total passing in `python3.11 -m unittest discover -s search/tests -v` (including stdlib-only AST import audit, real subprocess reaping/timeout/watchdog/16 MiB checks, fake-worker error/mismatch paths, real worker across seeds `0`, `1`, `2`, `42`, Phase 2 4-variant discovery, and identical-template negative).
    - Validated generated `artifacts/stage-4/demo-compare.json` (`status="difference_found"`, `candidate_index=55`, `search_pairs=56`, `direction="before_only"`, `reference_status="confirmed"`, CLI exit `1`), `artifacts/stage-4/demo-replay.json` (canonical compact UTF-8 `ReplayBundle`), and `artifacts/stage-4/identical-compare.json` (`status="no_difference_found"`, `search_pairs=16`, `exhausted_by="pair_limit"`, CLI exit `0`) against `contracts/schemas/` via `search/tests/validate_stage4_schemas.rb`.
- **Gate Command & Exit Status**: `./bin/check stage-4` -> exit `0` (includes Stage 1–3 regression checks).
- **Stage 5 Note on Stage 4 CLI Test**: In Stage 5, `search/tests/test_cli_and_real_worker.py` (`test_demo_compare_succeeds_across_pinned_seeds_and_validates_schemas`) was updated from Stage 4's placeholder assertions (`stats.shrink_pairs == 0` and `explanation.kind == "undetermined"` with `"Trace explanation pending Stage 5 shrink/alignment."`) to verify real Stage 5 shrink execution (`0 < stats.shrink_pairs <= 128`) and structural explanation (`explanation.kind == "structural_change"`, `before.line == 3`, `after.line == 1`, `"Structural change:"` summary).
- **Remaining Tasks**: Stage 5 through Stage 10.
- **Next Command**: Start Stage 5 worker (`bin/check stage-5`).

### Stage 5 — Shrink, Explanation and Replay
- **Status**: `passed`
- **Completed Tasks**:
  - **Ordered Shrinker (`search/shrinker.py`)**: Implemented strict descending lexicographic measure `fixture_measure = (len(variants), non_null_compare_at_count, total_cents, true_availability_count, canonical_utf8_bytes)`, preserving original variant `id` strings, deduplicating canonical fixtures across initial confirmation and shrink proposals, enforcing `budget.shrink_pairs` (including `0`-budget bypass with 0 worker evaluations) and `deadline_check`/`deadline_monotonic`, and checking in order: (1) chunk & single-variant deletions, (2) single-field simplifications (`compare_at_price`, `price`, `available`), and (3) paired `(price, compare_at_price)` per-variant and all-variant scaling/shifting, restarting after each accepted strict decrease and reporting `local_fixed_point: True` only on full neighborhood exhaustion.
  - **Trace Attribution & Explanation (`search/explain.py`)**: Implemented UTF-8 byte-offset HTML opening-tag walker (`find_sale_badge_opening_tags`) ignoring HTML comments, `<script>`/`<style>`/`<textarea>`/`<title>` raw text, escaped HTML, and quoted attribute decoys while matching HTML5 case-insensitive tag/attribute names and first-wins duplicate attributes; joined overlapping `emit` events via longest common `active_branch_seqs` chain (falling back to `undetermined` for 0/`>=2` badge tags, zero emits, or disjoint chains); resolved assigned flag variables (`on_sale`) backwards to the last relevant `Assignment` and enclosing loop `Branch` retaining `variant_id` and operand values; and aligned cross-version branches into `aligned_change` (with symmetric source-context disambiguation), `structural_change`, or `undetermined` (`build_explanation`).
  - **Fresh-Process Replay & CLI Integration (`search/replay.py`, `search/cli.py`, `search/engine.py`, `search/__init__.py`)**: Integrated shrinking, final traced re-render, independent reference parity verification, `"minimized fixture"` messaging, and `build_explanation` into `SearchEngine.compare` (keeping `stats` strictly compliant with `comparison_job.schema.json#/$defs/stats`); added `python -m search replay --bundle <path>` (`ReplayRunner`) validating bundle fields, SHA-256 digests, and runtime versions (`0.1.0`, `5.14.0`, `1.0.0`), bypassing search/shrink, reproducing `custom` (`trace=True`) + `reference` (`trace=False`) renders and explanation, emitting deterministic timestamp-free JSON with `timings` separate, and exiting `0` on verified replay or `2` on tampering/mismatch/errors.
  - **Stage 5 Tests & Contract Validation (`search/tests/`)**:
    - Added `test_shrinker.py` (`9` tests), `test_explain.py` (`7` tests), `test_replay_and_acceptance.py` (`3` tests) alongside Stage 4 suites (`42` Python tests total passing in `python3.11 -m unittest discover -s search/tests -v`, stdlib-only verified).
    - Added `search/tests/validate_stage5_schemas.rb` validating `compare_report`, `replay_bundle`, and `replay_result` against Draft 2020-12 schemas via Ruby `JSONSchemer`.
    - Generated Stage 5 evidence artifacts under `artifacts/stage-5/`: `demo-compare.json` (`search_pairs=56`, `shrink_pairs=28`, `pre_shrink_measure=[2, 2, 3500, 2, 179]` -> `post_shrink_measure=[2, 2, 1, 0, 172]`, `local_fixed_point=true`, `explanation.kind="structural_change"`, `before.line=3`, `after.line=1`), `demo-replay.json`, `demo-replay-result.json` (verified identical across independent fresh-process runs), and `identical-compare.json` (`status="no_difference_found"`, `search_pairs=16`, `shrink_pairs=0`).
- **Gate Command & Exit Status**: `./bin/check stage-5` -> exit `0` (includes Stage 1–4 regression checks).
- **Remaining Tasks**: Stage 6 through Stage 10.
- **Next Command**: Start Stage 6 worker (`bin/check stage-6`).

### Stage 6 — Dawn Corpus
- **Status**: `passed`
- **Completed Tasks**:
  - **Real `Shopify/dawn` History Mining & Provenance (`bench/corpus/manifest.json`, `bench/corpus/LICENSE-DAWN-MIT.txt`, `bench/corpus/cases/<case_id>/`)**: Collected **15 verified real cases** with distinct `(before_sha, after_sha, upstream_paths)` tuples and full 40-char commit SHAs across all 3 observables (`4 sale_badge`, `5 sold_out_badge`, `6 price_range`; `12 bug_fixed`, `3 bug_introduced`), spanning `snippets/product-card.liquid`, `snippets/card-product.liquid`, `snippets/price.liquid`, `snippets/buy-buttons.liquid`, and CSS-coupled stylesheet interactions (`assets/component-card.css`, `assets/component-price.css`). Categorized into `3` cases runnable natively in Stage 2 `LiquidInterpreter`, `7` additional benchmark-supported cases targeting Stage 7 extensions (`| t`, `| money`, `| default`, `.size`, `unless`, `liquid` tag), and `5` verified explicitly-unsupported cases (CSS visibility coupling in `.card--horizontal` and `.price--on-sale`, `shop.b2b_customers_enabled`, variant `inventory_management`/`quantity_rule`, and nil `selected_or_first_available_variant`).
  - **Unverified Leads Separation (`bench/corpus/unverified_candidates.json`)**: Investigated and documented **7** unverified/non-merged or duplicate leads separately from the verified corpus, including Section 6 leads `Shopify/dawn#3581` (`closed_not_planned`, no upstream fix), `#871` / `#3231` (`closed_not_planned`, intentional behavior traced back to PR `#662`), `#3924` / unmerged `#3925` (`cla-needed`, fork commit absent from Dawn), `#3616`, and duplicate release-branch twin PR `#3573`.
  - **Pinned Witness Fixtures (`fixtures/witnesses/<case_id>.json`)**: Authored **15** schema-valid witness fixtures isolated under `fixtures/witnesses/` (separate from `fixtures/demo/` and `fixtures/ordinary/`), each validated with `LiquidReference::FixtureValidator` and `LiquidReference::Projection`.
  - **Benchmark Observer Support (`reference/lib/liquid_reference/observer.rb`, `reference/test/test_observer_and_reference.rb`)**: Added `BENCHMARK_OBSERVERS` (`sale_badge`, `sold_out_badge`, `price_range`) and `Observer.observe_benchmark(observer_name, html, selector: nil)` while keeping public `Observer.observe("sale_badge", html)` strictly scoped to `sale_badge` (`test_observer_and_reference.rb` extended to `5 runs, 146 assertions, 0 failures`).
  - **Isolated Benchmark Verifier & Stage 6 Tests (`bench/lib/dawn_corpus_verifier.rb`, `bench/verify_corpus.rb`, `bench/tests/test_dawn_corpus.rb`)**: Built isolated `Liquid 5.14.0` `BENCHMARK_ENVIRONMENT` with `DawnBenchmarkFilters v1.0.0` (`money`, `money_with_currency`, `t`, without modifying `LiquidReference::Renderer::REFERENCE_ENVIRONMENT`), verifying all 15 `before.liquid`/`after.liquid` pairs against their witness fixtures (`expected_before_observed != expected_after_observed`) and Stage 2 HTML parity on all `supported_in_stage2: true` cases; added `bench/tests/test_dawn_corpus.rb` (`5 runs, 97 assertions, 0 failures, 0 errors, 0 skips`) and saved reports to `artifacts/stage-6/corpus-verification.json` and `artifacts/stage-6/corpus-summary.md`.
  - **Stage 6 Gate (`bin/check`)**: Added `run_stage_6` and `stage-6` target running Stage 1–5 regression checks plus `bench/verify_corpus.rb` and `bench/tests/test_dawn_corpus.rb`.
- **Gate Command & Exit Status**: `./bin/check stage-6` -> exit `0` (includes Stage 1–5 regression checks).
- **Remaining Tasks**: Stage 7 through Stage 10.
- **Next Command**: Start Stage 7 worker (`bin/check stage-7`).

### Stage 7 — Benchmark and Engine Extensions
- **Status**: `passed`
- **Completed Tasks**:
  - **Coherent Liquid Engine Extensions (`interpreter/lib/liquid_interpreter/{ast,parser,evaluator,template,conformance}.rb`)**:
    - Added `.size` virtual property on `Array`, `String` (codepoint count), and `Hash` (with explicit Hash `"size"` key taking precedence over `Hash#size`), plus `Hash == Hash` / `Array == Array` value equality verified against `liquid 5.14.0`.
    - Added `{% liquid ... %}` multiline tag parsing (`assign`, `if`, `elsif`, `else`, `unless`, `for`, `endif`, `endunless`, `endfor`, nested `liquid`, `#` inline comment lines, blank lines) into the exact same AST nodes (`Assign`, `Conditional`, `For`) with `SpanMapper` UTF-8 line/column spans preserved.
    - Added standard Liquid filter pipeline parsing (`AST::FilterPipeline`, `AST::FilterStage`) in `Output` and `Assign` tags and implemented the standard `default` filter (with optional `allow_false` keyword option matching `liquid 5.14.0`), plus an opt-in `filters:` option on `Template.compile`/`Evaluator` isolated to benchmark mode (`LiquidReference::BenchmarkFilters` providing `money`, `money_with_currency`, `t`, disabled in default `LiquidInterpreter` and `liquid_spec_adapter.rb`).
    - Added `interpreter/test/test_stage7_extensions.rb` (`6 runs, 1628 assertions, 0 failures, 0 errors, 0 skips`) probing every extension and trace invariance against `liquid 5.14.0`.
  - **Conformance Coverage Expansion (`contracts/conformance-manifest.json`, `artifacts/stage-7/conformance-report.txt`)**:
    - Regenerated `contracts/conformance-manifest.json` via `interpreter/bin/generate_manifest` (`stage_scope: "stage-7"`) and verified `100.00%` pass in `interpreter/bin/conformance_report --require-all-selected`:
      - Before Stage 7 (`stage-2`): **`359/359`** (`100.00%`; `basics=141`, `liquid_ruby=218`; `11.73%` inventoried; `4.85%` all suites).
      - After Stage 7 (`stage-7`): **`399/399`** (`100.00%`; `basics=155` [`+14`], `liquid_ruby=244` [`+26`]; `13.03%` inventoried; `5.40%` all suites; `fail=0`, `error=0`).
  - **Benchmark-Only Worker & Search Support (`reference/`, `search/`)**:
    - Extracted `LiquidReference::BenchmarkFilters` (`reference/lib/liquid_reference/benchmark_filters.rb`, shared with `DawnCorpus::DawnBenchmarkFilters`), extended `Renderer` (`BENCHMARK_ENVIRONMENT`, `benchmark:`, `selector:`, `fixed_context:`), `Worker` (`benchmark_mode:`), and `reference/bin/worker --benchmark`, while keeping default worker mode strictly enforcing `jsonl_request.schema.json` and `sale_badge` only (`reference/test/test_jsonl_worker.rb`: `4 runs, 203 assertions, 0 failures`).
    - Updated `search/worker_client.py` (`benchmark=True`), `search/explain.py` (added `sold_out_badge`, `price_range`, leaf selector support, and `{% liquid %}` tag-line indexing), and `search/engine.py` (`benchmark=True`, `selector`, `fixed_context`, `candidate_fixtures`, and `shrink_ms` tracking while keeping public `validate_compare_request` and `contracts/schemas/compare_request.schema.json` strictly scoped to `sale_badge`).
  - **Official Shopify Sample Baseline (`bench/sample_baseline/`)**:
    - Downloaded pinned CSVs (`apparel.csv`, `home-and-garden.csv`, `jewelery.csv`, `readme.md`) from `https://github.com/shopifypartners/product-csvs` at commit SHA `045fb432d85dc59d558717208399176d62bf106d` under `bench/sample_baseline/raw/`.
    - Converted deterministically via `bench/sample_baseline/convert_csvs.py` into `60` schema-valid `Fixture` objects (`66` variants, `0` truncated) in `bench/sample_baseline/sample_products.json` and documented full mapping rules in `bench/sample_baseline/PROVENANCE.md`.
  - **Benchmark Runner, Subprocess IPC Overhead & Reports (`bench/run.py`, `bench/measure_ipc_overhead.rb`, `bench/reports/`)**:
    - Executed frozen experiment across all **15** verified Dawn cases (`10` supported, `5` unsupported), seeds `[0, 1, 2, 3, 4]`, `search_pairs=256`, `shrink_pairs=128`, vs `sample_baseline` (`60` products evaluated once per case, `shrink_pairs=128`):
      - **All 15 verified cases**: `generated_search` detected **`10/15` (`66.7%`)** [`50/75` runs: `50` detected, `0` budget_exhausted, `25` unsupported, `0` error] vs `sample_baseline` **`9/15` (`60.0%`)** [`9/15` runs: `9` detected, `1` budget_exhausted (`dawn_pr_662_compare_at_price_varies`), `5` unsupported, `0` error].
      - **Supported-only (10 cases)**: `generated_search` **`10/10` (`100.0%`, `50/50` runs)** in median **`3.5` pairs** (`first_difference_ms=262 ms`, `shrink_ms=0 ms`, `parity_rejections=0`) vs `sample_baseline` **`9/10` (`90.0%`)** in median **`22` pairs** (`first_difference_ms=264 ms`, `shrink_ms=1 ms`, `parity_rejections=0`).
      - **Instrumented JSONL IPC overhead (`256` `render_pair` calls on `dawn_pr_794`)**: `custom` in-process Ruby `59.196 ms` (`0.2312 ms/pair`) vs JSONL IPC `68.133 ms` (`0.2661 ms/pair`, startup+compile `260.713 ms`) -> `+0.0349 ms/pair` (`13.1%`, `1.15x`); `reference` in-process `66.456 ms` (`0.2596 ms/pair`) vs JSONL IPC `75.073 ms` (`0.2933 ms/pair`) -> `+0.0337 ms/pair` (`11.5%`, `1.13x`).
    - Generated `bench/reports/benchmark.csv`, `bench/reports/benchmark_details.json`, and `bench/reports/benchmark.md`.
  - **Stage 7 Tests & Gate (`bench/tests/test_benchmark.py`, `bin/check stage-7`)**:
    - Added `bench/tests/test_benchmark.py` (`5` tests passing, Python 3.11 stdlib-only verified, validating all 60 sample fixtures against `fixture.schema.json`, 10-case worker parity, 15-case accounting, and deterministic reproducibility across repeated runs).
    - Extended `bin/check` with `run_stage_7` / `stage-7`.
- **Gate Command & Exit Status**: `./bin/check stage-7` -> exit `0` (includes Stage 1–6 regression checks).
- **Remaining Tasks**: Stage 8 through Stage 10.
- **Next Command**: Start Stage 8 worker (`bin/check stage-8`).

### Stage 8 — Rails API and Asynchronous Persistence
- **Status**: `passed`
- **Completed Tasks**:
  - **Rails 8 API Application & Lockfiles (`api/`)**: Created Rails `8.1.4.1` API-mode application (`--api --database=sqlite3`) using `sqlite3 2.10.2`, `solid_queue 1.7.2`, `puma 8.1.2`, `minitest 5.27.0`, `json_schemer 2.5.0`, and `regexp_parser 2.12.0` (`api/Gemfile` + `api/Gemfile.lock`, locally bundled in `api/vendor/bundle`); updated root `bin/setup`, `.gitignore`, and `docs/toolchain-versions.md` so clean checkouts install both root and `api/` bundles from lockfiles and prepare SQLite databases cleanly.
  - **SQLite, Solid Queue & Log Redaction (`api/config/`, `api/db/migrate/`)**: Configured single-worker database-backed Solid Queue (`processes: 1`, `threads: 1`) with Solid Queue tables and `comparisons` schema in `api/db/migrate/` so `db:migrate` and `db:prepare` work cleanly across `test`, `development`, and `production` environments without manual intervention; configured `config.filter_parameters`, `Comparison.filter_attributes`, `ComparisonRunJob.log_arguments = false`, and SQL/parse-error redaction filters so snippet `source`, `before`, `after`, `fixture`, and `html` never appear in Rails server or SQL logs.
  - **Comparison Model & Contracts (`api/app/models/comparison.rb`, `api/app/services/contract_schemas.rb`)**: Implemented UUID primary key (`SecureRandom.uuid`), whitespace-sensitive SHA-256 `request_digest` over canonical UTF-8 JSON, partial unique `idempotency_key` index (`WHERE idempotency_key IS NOT NULL`), atomic claim (`claim_queued!`), guarded transactional completion/retry release (`complete_with_token!`, `release_for_retry_with_token!`), and `as_comparison_job` conforming to `contracts/schemas/comparison_job.schema.json`.
  - **API Endpoints & Request Validation (`api/app/controllers/api/v1/`, `api/app/services/compare_request_validator.rb`, `api/config/routes.rb`)**: Implemented `POST /api/v1/comparisons`, `GET /api/v1/comparisons/:id`, and `GET /api/v1/health` with strict raw-body JSON validation (rejecting malformed JSON, non-UTF-8, extra keys, filesystem path keys, >16 KiB snippets, non-`sale_badge` observers, and out-of-range `seed`/`budget`), `Idempotency-Key` reuse (`202`/`200`) and whitespace-sensitive `409 Conflict` (`idempotency_conflict`), `RecordNotUnique` race recovery, SQLite row persistence before `ComparisonRunJob.perform_later`, and optional scoped `Authorization: Bearer` auth via `ENV["LIQUID_REGRESSION_API_TOKEN"]`.
  - **Worker Job, Reconciliation & Safe Subprocess Runner (`api/app/jobs/comparison_run_job.rb`, `api/app/services/comparison_reconciler.rb`, `api/app/services/comparison_runner.rb`, `api/lib/tasks/comparisons.rake`)**: Implemented atomic `WHERE status = 'queued'` claim with `110s` lease, isolated `Dir.mktmpdir` argv `Process.spawn(..., unsetenv_others: true, pgroup: true)` with `90s` hard watchdog (`TERM` -> `KILL` + `waitpid2`) and strict `JSONSchemer` validation of `search` output, immediate terminal `failed` on engine/syntax/validation/`reference_mismatch` vs single-retry bound (`attempts < 2`) on infrastructure failures, and `ComparisonReconciler.reconcile!` (plus `bin/rails runner ComparisonReconciler.reconcile!` and `rake comparisons:reconcile`) recovering missed `queued` rows and expired `running` claims.
  - **Tests, Real Server/Worker E2E Smoke Check & Gate (`api/test/`, `api/bin/e2e_smoke_check`, `bin/check stage-8`)**:
    - `api/test/` Minitest suite: `28 runs, 319 assertions, 0 failures, 0 errors, 0 skips` covering request validation, idempotency & whitespace conflict, `RecordNotUnique` race recovery, scoped bearer auth, duplicate delivery, stale `attempt_token` write rejection, lease expiry recovery (`attempts == 1` vs `2`), missed-enqueue reconciliation, SQLite reload persistence, terminal vs infrastructure retry bounds, real `ComparisonRunner` subprocess execution + watchdog reaping, log redaction, and `SolidQueue::Job` SQLite persistence.
    - `api/bin/e2e_smoke_check` (`artifacts/stage-8/e2e-smoke-report.json`): boots real Puma `rails server` + single `bin/jobs` Solid Queue worker on an isolated SQLite DB, runs `fixtures/demo/` end-to-end (`status="difference_found"`, `search_pairs=56`, `shrink_pairs=28`), validates responses with `JSONSchemer`, verifies idempotency replay (`200`) and whitespace conflict (`409`), restarts Puma against the same SQLite DB and confirms identical persisted `ComparisonJob`, and verifies clean redacted logs.
- **Gate Command & Exit Status**: `./bin/check stage-8` -> exit `0` (includes Stage 1–7 regression checks).
- **Remaining Tasks**: Stage 9 through Stage 10.
- **Next Command**: Start Stage 9 worker (`bin/check stage-9`).

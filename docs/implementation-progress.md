# Implementation Progress — Shopify Liquid Regression Finder

- **Current Stage**: Stage 4 (`passed`)
- **Last Completed Stage**: Stage 4 — Counterexample search
- **Repository**: https://github.com/Med-NCoding/liquid-regression-finder

## Stage Tracker

| Stage | Title | Status | Gate Command | Last Exit Status | Evidence Paths |
|---|---|---|---|---|---|
| 1 | Bootstrap and conformance adapter | passed | `bin/check stage-1` | 0 | `artifacts/stage-1/liquid-spec-pilot.txt`, `contracts/conformance-manifest.json`, `docs/toolchain-versions.md` |
| 2 | Liquid engine | passed | `bin/check stage-2` | 0 | `artifacts/stage-2/conformance-report.txt`, `artifacts/stage-2/nested-loop-trace.json`, `interpreter/test/` |
| 3 | Shopify projection and reference | passed | `bin/check stage-3` | 0 | `artifacts/stage-3/ordinary-parity.json`, `fixtures/storefront_probe_matrix.json`, `docs/storefront-probe.md`, `reference/test/` |
| 4 | Counterexample search | passed | `bin/check stage-4` | 0 | `artifacts/stage-4/demo-compare.json`, `artifacts/stage-4/demo-replay.json`, `artifacts/stage-4/identical-compare.json`, `search/tests/` |
| 5 | Shrink, explanation and replay | pending | `bin/check stage-5` | — | — |
| 6 | Dawn corpus | pending | `bin/check stage-6` | — | — |
| 7 | Benchmark and engine extensions | pending | `bin/check stage-7` | — | — |
| 8 | Rails API and jobs | pending | `bin/check stage-8` | — | — |
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
- **Remaining Tasks**: Stage 5 through Stage 10.
- **Next Command**: Start Stage 5 worker (`bin/check stage-5`).

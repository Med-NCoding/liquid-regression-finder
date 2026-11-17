# frozen_string_literal: true

require "digest"
require "json"
require "json_schemer"
require "minitest/autorun"
require "open3"
require "stringio"

$LOAD_PATH.unshift(File.expand_path("../lib", __dir__))
require "liquid_reference"

class JsonlWorkerTest < Minitest::Test
  REPO_ROOT = File.expand_path("../..", __dir__)
  SCHEMAS_DIR = File.join(REPO_ROOT, "contracts/schemas")
  WORKER_BIN = File.join(REPO_ROOT, "reference/bin/worker")

  def setup
    @ref_resolver = lambda do |uri|
      JSON.parse(File.read(File.join(SCHEMAS_DIR, File.basename(uri.path)), encoding: Encoding::UTF_8))
    end
    @req_schema = JSONSchemer.schema(
      JSON.parse(File.read(File.join(SCHEMAS_DIR, "jsonl_request.schema.json"), encoding: Encoding::UTF_8)),
      ref_resolver: @ref_resolver,
    )
    @resp_schema = JSONSchemer.schema(
      JSON.parse(File.read(File.join(SCHEMAS_DIR, "jsonl_response.schema.json"), encoding: Encoding::UTF_8)),
      ref_resolver: @ref_resolver,
    )
  end

  def with_worker
    Open3.popen3(RbConfig.ruby, WORKER_BIN, chdir: REPO_ROOT) do |stdin, stdout, stderr, wait_thr|
      stdin.set_encoding(Encoding::UTF_8)
      stdout.set_encoding(Encoding::UTF_8)
      stderr.set_encoding(Encoding::UTF_8)
      yield stdin, stdout, stderr, wait_thr
    end
  end

  def rpc(stdin, stdout, payload, validate_request: true)
    if validate_request
      req_errors = @req_schema.validate(payload).to_a
      assert_empty req_errors, "Outgoing request failed schema: #{req_errors.map { |e| e['error'] }}"
    end

    stdin.write(JSON.generate(payload) + "\n")
    stdin.flush
    raw = stdout.gets
    refute_nil raw, "Worker closed stdout unexpectedly"

    resp = JSON.parse(raw)
    resp_errors = @resp_schema.validate(resp).to_a
    assert_empty resp_errors, "Worker response failed schema: #{resp_errors.map { |e| e['error'] }}"
    resp
  end

  def test_compile_render_pair_trace_parity_and_clean_quit
    before_src = "{% assign on_sale = false %}{% for v in product.variants %}{% if v.compare_at_price != nil and v.compare_at_price > v.price %}{% assign on_sale = true %}{% endif %}{% endfor %}{% if on_sale %}<span data-regression-badge=\"sale\">Sale äöü</span>{% endif %}"
    after_src = "{% if product.compare_at_price != nil and product.compare_at_price > product.price %}<span data-regression-badge=\"sale\">Sale äöü</span>{% endif %}"

    fixture = {
      "schema_version" => 1,
      "currency" => "USD",
      "variants" => [
        { "id" => "v1", "price" => 1000, "compare_at_price" => 900, "available" => true },
        { "id" => "v2", "price" => 1500, "compare_at_price" => 2000, "available" => true },
      ],
    }

    with_worker do |stdin, stdout, stderr, wait_thr|
      compile_resp = rpc(stdin, stdout, {
        "id" => "req-1",
        "op" => "compile",
        "before" => before_src,
        "after" => after_src,
        "observer" => "sale_badge",
      })
      assert_equal "req-1", compile_resp["id"]
      assert_equal Digest::SHA256.hexdigest(before_src), compile_resp["result"]["before_sha256"]
      assert_equal Digest::SHA256.hexdigest(after_src), compile_resp["result"]["after_sha256"]

      # Custom without trace
      r_custom_no_trace = rpc(stdin, stdout, {
        "id" => "req-2",
        "op" => "render_pair",
        "fixture" => fixture,
        "engine" => "custom",
        "trace" => false,
      })["result"]
      assert_equal true, r_custom_no_trace["before"]["observed"]
      assert_equal false, r_custom_no_trace["after"]["observed"]
      assert_empty r_custom_no_trace["before"]["events"]
      assert_empty r_custom_no_trace["after"]["events"]

      # Custom with trace
      r_custom_trace = rpc(stdin, stdout, {
        "id" => "req-3",
        "op" => "render_pair",
        "fixture" => fixture,
        "engine" => "custom",
        "trace" => true,
      })["result"]
      assert_equal r_custom_no_trace["before"]["html"], r_custom_trace["before"]["html"]
      assert_equal r_custom_no_trace["after"]["html"], r_custom_trace["after"]["html"]
      refute_empty r_custom_trace["before"]["events"]
      refute_empty r_custom_trace["after"]["events"]

      # Reference (trace flag true still emits empty events)
      r_ref = rpc(stdin, stdout, {
        "id" => "req-4",
        "op" => "render_pair",
        "fixture" => fixture,
        "engine" => "reference",
        "trace" => true,
      })["result"]
      assert_equal r_custom_trace["before"]["html"], r_ref["before"]["html"]
      assert_equal r_custom_trace["after"]["html"], r_ref["after"]["html"]
      assert_equal true, r_ref["before"]["observed"]
      assert_equal false, r_ref["after"]["observed"]
      assert_empty r_ref["before"]["events"]
      assert_empty r_ref["after"]["events"]
      assert_equal r_custom_trace["product"], r_ref["product"]
      assert_equal 900, r_ref["product"]["compare_at_price"]

      quit_resp = rpc(stdin, stdout, { "id" => "req-5", "op" => "quit" })
      assert_equal({ "id" => "req-5", "result" => { "ok" => true } }, quit_resp)

      stdin.close
      assert_equal "", stderr.read
      assert wait_thr.value.success?
    end
  end

  def test_worker_error_responses_keep_loop_alive_and_conform_to_schema
    valid_fixture = {
      "schema_version" => 1,
      "currency" => "USD",
      "variants" => [{ "id" => "v1", "price" => 1000, "compare_at_price" => 1500, "available" => true }],
    }

    with_worker do |stdin, stdout, stderr, wait_thr|
      # 1. render_pair before compile
      not_compiled = rpc(stdin, stdout, {
        "id" => "err-1",
        "op" => "render_pair",
        "fixture" => valid_fixture,
        "engine" => "custom",
        "trace" => false,
      })
      assert_equal "not_compiled", not_compiled["error"]["code"]

      # 2. Malformed JSON line
      stdin.write("{not valid json\n")
      stdin.flush
      bad_json_resp = JSON.parse(stdout.gets)
      assert_empty @resp_schema.validate(bad_json_resp).to_a
      assert_equal "unknown", bad_json_resp["id"]
      assert_equal "protocol_error", bad_json_resp["error"]["code"]

      # 3. Invalid quit with extra arguments does not exit
      bad_quit = rpc(stdin, stdout, { "id" => "err-quit", "op" => "quit", "extra" => 1 }, validate_request: false)
      assert_equal "protocol_error", bad_quit["error"]["code"]

      # 4. Compile syntax/unsupported error returns structured Diagnostic with span
      bad_compile = rpc(stdin, stdout, {
        "id" => "err-compile",
        "op" => "compile",
        "before" => "{% bogus %}",
        "after" => "ok",
        "observer" => "sale_badge",
      })
      assert_equal "unsupported_tag", bad_compile["error"]["code"]
      assert_equal 1, bad_compile["error"]["span"]["line"]

      # 5. Compile oversize snippet
      too_big = rpc(stdin, stdout, {
        "id" => "err-big",
        "op" => "compile",
        "before" => "x" * 16_385,
        "after" => "ok",
        "observer" => "sale_badge",
      })
      assert_equal "snippet_too_large", too_big["error"]["code"]

      # 6. Valid compile followed by invalid fixtures (duplicate variant id, float price)
      ok_compile = rpc(stdin, stdout, {
        "id" => "ok-compile",
        "op" => "compile",
        "before" => "{% if product.price < '10' %}bad{% endif %}",
        "after" => "<span>{{ product.price }}</span>",
        "observer" => "sale_badge",
      })
      assert ok_compile.key?("result")

      dup_resp = rpc(stdin, stdout, {
        "id" => "err-dup",
        "op" => "render_pair",
        "fixture" => {
          "schema_version" => 1,
          "currency" => "USD",
          "variants" => [
            { "id" => "same", "price" => 100, "compare_at_price" => nil, "available" => true },
            { "id" => "same", "price" => 200, "compare_at_price" => nil, "available" => true },
          ],
        },
        "engine" => "custom",
        "trace" => false,
      }, validate_request: false)
      assert_equal "duplicate_variant_id", dup_resp["error"]["code"]

      float_resp = rpc(stdin, stdout, {
        "id" => "err-float",
        "op" => "render_pair",
        "fixture" => {
          "schema_version" => 1,
          "currency" => "USD",
          "variants" => [
            { "id" => "v1", "price" => 10.5, "compare_at_price" => nil, "available" => true },
          ],
        },
        "engine" => "custom",
        "trace" => false,
      }, validate_request: false)
      assert_equal "invalid_fixture", float_resp["error"]["code"]

      # 7. Failed re-compile clears previous compiled pair so stale pair is not rendered
      failed_re_compile = rpc(stdin, stdout, {
        "id" => "err-recompile",
        "op" => "compile",
        "before" => "ok",
        "after" => "{% if true %}",
        "observer" => "sale_badge",
      })
      assert_equal "unclosed_tag", failed_re_compile["error"]["code"]

      stale_check = rpc(stdin, stdout, {
        "id" => "err-stale-render",
        "op" => "render_pair",
        "fixture" => valid_fixture,
        "engine" => "custom",
        "trace" => false,
      })
      assert_equal "not_compiled", stale_check["error"]["code"]

      # 8. Invalid UTF-8 bytes on JSONL stdin return protocol_error and keep worker alive
      stdin.set_encoding(Encoding::BINARY)
      stdin.write("{\"id\":\"bad-utf8\",\"op\":\"quit\"}\xFF\n".b)
      stdin.flush
      stdin.set_encoding(Encoding::UTF_8)
      bad_utf8_resp = JSON.parse(stdout.gets)
      assert_empty @resp_schema.validate(bad_utf8_resp).to_a
      assert_equal "unknown", bad_utf8_resp["id"]
      assert_equal "protocol_error", bad_utf8_resp["error"]["code"]

      # 9. Runtime comparison error after clean recompile returns RenderResult status=error inside render_pair_result
      ok_compile2 = rpc(stdin, stdout, {
        "id" => "ok-compile-2",
        "op" => "compile",
        "before" => "{% if product.price < '10' %}bad{% endif %}",
        "after" => "<span>{{ product.price }}</span>",
        "observer" => "sale_badge",
      })
      assert ok_compile2.key?("result")

      runtime_custom = rpc(stdin, stdout, {
        "id" => "err-runtime-custom",
        "op" => "render_pair",
        "fixture" => valid_fixture,
        "engine" => "custom",
        "trace" => true,
      })["result"]
      assert_equal "error", runtime_custom["before"]["status"]
      assert_equal "comparison_error", runtime_custom["before"]["error"]["code"]
      assert_equal "ok", runtime_custom["after"]["status"]

      runtime_ref = rpc(stdin, stdout, {
        "id" => "err-runtime-ref",
        "op" => "render_pair",
        "fixture" => valid_fixture,
        "engine" => "reference",
        "trace" => false,
      })["result"]
      assert_equal "error", runtime_ref["before"]["status"]
      assert_equal "reference_render_error", runtime_ref["before"]["error"]["code"]
      assert_equal "ok", runtime_ref["after"]["status"]

      quit_resp = rpc(stdin, stdout, { "id" => "quit-final", "op" => "quit" })
      assert_equal true, quit_resp["result"]["ok"]

      stdin.close
      assert_equal "", stderr.read
      assert wait_thr.value.success?
    end
  end

  def test_worker_enforces_response_frame_byte_limit
    input = StringIO.new(
      [
        JSON.generate("id" => "c1", "op" => "compile", "before" => "ok", "after" => "ok", "observer" => "sale_badge"),
        JSON.generate("id" => "q1", "op" => "quit"),
      ].join("\n") + "\n",
    )
    output = StringIO.new
    err = StringIO.new

    worker = LiquidReference::Worker.new(input: input, output: output, error_output: err, max_response_bytes: 120)
    assert_equal 0, worker.run

    lines = output.string.lines
    assert_equal 2, lines.size
    resp1 = JSON.parse(lines[0])
    resp2 = JSON.parse(lines[1])
    assert_empty @resp_schema.validate(resp1).to_a
    assert_empty @resp_schema.validate(resp2).to_a
    assert_equal "response_too_large", resp1["error"]["code"]
    assert_equal({ "id" => "q1", "result" => { "ok" => true } }, resp2)
    assert_equal "", err.string
  end

  def test_default_worker_rejects_benchmark_fields_and_benchmark_worker_enables_dawn_parity
    # Default worker strictly enforces jsonl_request.schema.json (sale_badge only, no benchmark fields)
    with_worker do |stdin, stdout, stderr, wait_thr|
      bad_obs = rpc(stdin, stdout, {
        "id" => "pub-1",
        "op" => "compile",
        "before" => "a",
        "after" => "b",
        "observer" => "sold_out_badge",
      }, validate_request: false)
      assert_equal "unsupported_observer", bad_obs["error"]["code"]

      bad_extra = rpc(stdin, stdout, {
        "id" => "pub-2",
        "op" => "compile",
        "before" => "a",
        "after" => "b",
        "observer" => "sale_badge",
        "benchmark" => true,
      }, validate_request: false)
      assert_equal "protocol_error", bad_extra["error"]["code"]

      quit_resp = rpc(stdin, stdout, { "id" => "pub-q", "op" => "quit" })
      assert_equal true, quit_resp["result"]["ok"]
      stdin.close
      assert_equal "", stderr.read
      assert wait_thr.value.success?
    end

    # Benchmark worker (--benchmark) supports sold_out_badge, price_range, selector, fixed_context, and DawnBenchmarkFilters
    Open3.popen3(RbConfig.ruby, WORKER_BIN, "--benchmark", chdir: REPO_ROOT) do |stdin, stdout, stderr, wait_thr|
      stdin.set_encoding(Encoding::UTF_8)
      stdout.set_encoding(Encoding::UTF_8)
      stderr.set_encoding(Encoding::UTF_8)

      manifest = JSON.parse(File.read(File.join(REPO_ROOT, "bench/corpus/manifest.json"), encoding: Encoding::UTF_8))
      dawn_case = manifest.fetch("cases").find { |c| c["id"] == "dawn_pr_794_price_badge_sale_aria_hidden" }
      before_src = File.read(File.join(REPO_ROOT, dawn_case["before_path"]), encoding: Encoding::UTF_8)
      after_src = File.read(File.join(REPO_ROOT, dawn_case["after_path"]), encoding: Encoding::UTF_8)
      witness = JSON.parse(File.read(File.join(REPO_ROOT, dawn_case["witness_fixture_path"]), encoding: Encoding::UTF_8))

      comp = rpc(stdin, stdout, {
        "id" => "b-1",
        "op" => "compile",
        "before" => before_src,
        "after" => after_src,
        "observer" => dawn_case["observable"],
        "benchmark" => true,
        "selector" => dawn_case["observer_selector"],
        "fixed_context" => dawn_case["fixed_context"],
      }, validate_request: false)
      assert comp.key?("result"), "Expected compile success in benchmark mode, got #{comp.inspect}"

      cust = rpc(stdin, stdout, {
        "id" => "b-2",
        "op" => "render_pair",
        "fixture" => witness,
        "engine" => "custom",
        "trace" => true,
      })["result"]
      ref = rpc(stdin, stdout, {
        "id" => "b-3",
        "op" => "render_pair",
        "fixture" => witness,
        "engine" => "reference",
        "trace" => false,
      })["result"]

      assert_equal "ok", cust["before"]["status"]
      assert_equal "ok", cust["after"]["status"]
      assert_equal ref["before"]["html"], cust["before"]["html"]
      assert_equal ref["after"]["html"], cust["after"]["html"]
      assert_equal false, cust["before"]["observed"]
      assert_equal true, cust["after"]["observed"]
      assert_equal false, ref["before"]["observed"]
      assert_equal true, ref["after"]["observed"]
      refute_empty cust["before"]["events"]
      assert_empty ref["before"]["events"]

      # Rejects fixed_context containing 'product'
      bad_ctx = rpc(stdin, stdout, {
        "id" => "b-4",
        "op" => "compile",
        "before" => "a",
        "after" => "b",
        "observer" => "price_range",
        "benchmark" => true,
        "fixed_context" => { "product" => {} },
      }, validate_request: false)
      assert_equal "protocol_error", bad_ctx["error"]["code"]

      quit_resp = rpc(stdin, stdout, { "id" => "b-q", "op" => "quit" })
      assert_equal true, quit_resp["result"]["ok"]
      stdin.close
      assert_equal "", stderr.read
      assert wait_thr.value.success?
    end
  end
end

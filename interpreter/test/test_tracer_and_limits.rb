# frozen_string_literal: true

require "json"
require "json_schemer"
require "minitest/autorun"

$LOAD_PATH.unshift(File.expand_path("../lib", __dir__))
require "liquid_interpreter"

class TracerAndLimitsTest < Minitest::Test
  SCHEMAS_DIR = File.expand_path("../../contracts/schemas", __dir__)

  def setup
    @ref_resolver = lambda do |uri|
      JSON.parse(File.read(File.join(SCHEMAS_DIR, File.basename(uri.path)), encoding: Encoding::UTF_8))
    end
    @trace_event_schema = JSONSchemer.schema(
      JSON.parse(File.read(File.join(SCHEMAS_DIR, "trace_event.schema.json"), encoding: Encoding::UTF_8)),
      ref_resolver: @ref_resolver,
    )
    @render_result_schema = JSONSchemer.schema(
      JSON.parse(File.read(File.join(SCHEMAS_DIR, "render_result.schema.json"), encoding: Encoding::UTF_8)),
      ref_resolver: @ref_resolver,
    )
  end

  def validate_render_result!(payload)
    errors = @render_result_schema.validate(payload).to_a
    assert_empty errors, "RenderResult schema validation failed: #{errors.map { |e| e["error"] }}"
    payload.fetch("events").each_with_index do |ev, idx|
      assert_equal idx, ev["seq"], "Expected monotonic seq #{idx}"
      ev_errors = @trace_event_schema.validate(ev).to_a
      assert_empty ev_errors, "TraceEvent #{idx} failed validation: #{ev_errors.map { |e| e["error"] }}"
    end
  end

  def test_trace_and_no_trace_produce_byte_identical_html_and_valid_schema
    src = <<~LIQUID
      {% assign on_sale = false -%}
      {%- for v in product.variants -%}
        {%- if v.compare_at_price != nil and v.compare_at_price > v.price -%}
          {%- assign on_sale = true -%}
        {%- endif -%}
      {%- endfor -%}
      {%- if on_sale -%}<span data-regression-badge="sale">Sale: {{ product.title }}</span>{%- else -%}<span>Regular</span>{%- endif -%}
    LIQUID

    assigns = {
      "product" => {
        "title" => "Äöü Jacket",
        "variants" => [
          { "id" => "var_1", "price" => 2500, "compare_at_price" => nil, "available" => true },
          { "id" => "var_2", "price" => 1999, "compare_at_price" => 2999, "available" => true },
        ],
      },
    }

    tpl = LiquidInterpreter::Template.compile(src)
    plain_html = tpl.render(assigns)
    traced = tpl.render_with_trace(assigns)

    assert_equal plain_html, traced["html"]
    assert_equal Encoding::UTF_8, plain_html.encoding
    assert_equal Encoding::UTF_8, traced["html"].encoding

    render_result = LiquidInterpreter::Template.render_result(src, assigns, trace: true, observed: true)
    assert_equal plain_html, render_result["html"]
    assert_equal traced["events"], render_result["events"]
    validate_render_result!(render_result)

    # Verify variant_id frames on loop events
    var1_events = render_result["events"].select { |e| e["scope"].any? { |f| f["variant_id"] == "var_1" } }
    var2_events = render_result["events"].select { |e| e["scope"].any? { |f| f["variant_id"] == "var_2" } }
    refute_empty var1_events
    refute_empty var2_events
    assert_equal 0, var1_events.first["scope"].first["iteration"]
    assert_equal 1, var2_events.first["scope"].first["iteration"]

    # Verify Emit byte ranges match actual UTF-8 byte slices and carry active_branch_seqs
    emits = render_result["events"].select { |e| e["data"]["kind"] == "emit" }
    assert_equal 3, emits.size
    reconstructed = emits.map do |e|
      d = e["data"]
      render_result["html"].byteslice(d["output_start_byte"]...d["output_end_byte"])
    end.join
    assert_equal render_result["html"], reconstructed

    # All 3 emits sit inside the taken `{%- if on_sale -%}` branch
    last_branch = render_result["events"].reverse.find { |e| e["data"]["kind"] == "branch" && e["data"]["taken"] }
    refute_nil last_branch
    emits.each do |e|
      assert_equal [last_branch["seq"]], e["data"]["active_branch_seqs"]
    end
  end

  def test_nested_loops_and_snapshot_isolation_and_active_branch_nesting
    src = "{% for c in collections %}{% for v in c.variants %}{% if v.price < 100 %}{% unless v.sold_out %}[{{ v.id }}]{% endunless %}{% endif %}{% endfor %}{% endfor %}"
    assigns = {
      "collections" => [
        {
          "id" => "col_a",
          "variants" => [
            { "id" => "v_1", "price" => 50, "sold_out" => false },
            { "id" => "v_2", "price" => 200, "sold_out" => false },
          ],
        },
        {
          "id" => "col_b",
          "variants" => [
            { "id" => "v_3", "price" => 80, "sold_out" => true },
          ],
        },
      ],
    }

    res = LiquidInterpreter::Template.render_result(src, assigns, trace: true, observed: false)
    assert_equal "[v_1]", res["html"]
    validate_render_result!(res)

    # Mutate original assigns after render; trace events must remain unaffected snapshots
    assigns["collections"][0]["variants"][0]["price"] = 999_999
    assigns["collections"].clear

    v1_cmp = res["events"].find { |e| e["data"]["kind"] == "comparison" && e["scope"].last&.dig("variant_id") == "v_1" }
    refute_nil v1_cmp
    assert_equal 50, v1_cmp["data"]["left"]
    assert_equal 2, v1_cmp["scope"].size
    assert_equal "col_a", v1_cmp["scope"][0]["variant_id"]
    assert_equal 0, v1_cmp["scope"][0]["iteration"]
    assert_equal "v_1", v1_cmp["scope"][1]["variant_id"]
    assert_equal 0, v1_cmp["scope"][1]["iteration"]

    # Check active_branch_seqs on the `v.id` Emit has BOTH enclosing taken Branch seqs (if and unless)
    emit_v1 = res["events"].find { |e| e["data"]["kind"] == "emit" && e["data"]["output_end_byte"] - e["data"]["output_start_byte"] == 3 }
    refute_nil emit_v1
    assert_equal 2, emit_v1["data"]["active_branch_seqs"].size
    branch_seqs = emit_v1["data"]["active_branch_seqs"]
    assert_equal ["v.price < 100", "v.sold_out"], branch_seqs.map { |s| res["events"][s]["data"]["expression"] }
  end

  def test_for_else_branch_recorded_in_active_branch_seqs
    src = "{% for v in items %}x{% else %}NONE{% endfor %}"
    res = LiquidInterpreter::Template.render_result(src, { "items" => [] }, trace: true, observed: false)
    assert_equal "NONE", res["html"]
    validate_render_result!(res)

    branch = res["events"].find { |e| e["data"]["kind"] == "branch" }
    emit = res["events"].find { |e| e["data"]["kind"] == "emit" }
    refute_nil branch
    refute_nil emit
    assert_equal "else", branch["data"]["expression"]
    assert_equal [branch["seq"]], emit["data"]["active_branch_seqs"]
  end

  def test_resource_limit_snippet_size
    over = "x" * 16_385
    res = LiquidInterpreter::Template.render_result(over, {}, trace: true)
    assert_equal "error", res["status"]
    assert_nil res["html"]
    assert_nil res["observed"]
    assert_empty res["events"]
    assert_equal "snippet_too_large", res["error"]["code"]
    validate_render_result!(res)
  end

  def test_resource_limit_depth_compile_and_eval
    deep_33 = ("{% if true %}" * 33) + "hi" + ("{% endif %}" * 33)
    res = LiquidInterpreter::Template.render_result(deep_33, {}, trace: true)
    assert_equal "error", res["status"]
    assert_equal "depth_limit_exceeded", res["error"]["code"]
    validate_render_result!(res)

    # Runtime evaluator depth check (even if AST compiled with relaxed max_depth)
    tpl = LiquidInterpreter::Template.compile("{% if true %}{% if true %}hi{% endif %}{% endif %}")
    err = assert_raises(LiquidInterpreter::LimitError) do
      tpl.render({}, max_depth: 1)
    end
    assert_equal "depth_limit_exceeded", err.code
  end

  def test_resource_limit_max_steps_50000
    # 250 * 250 = 62,500 iterations hits 50,000 steps easily in a tiny template
    src = "{% for a in xs %}{% for b in xs %}{% endfor %}{% endfor %}"
    assigns = { "xs" => Array.new(250, 1) }

    err = assert_raises(LiquidInterpreter::LimitError) do
      LiquidInterpreter::Template.compile(src).render(assigns)
    end
    assert_equal "step_limit_exceeded", err.code

    res = LiquidInterpreter::Template.render_result(src, assigns, trace: true)
    assert_equal "error", res["status"]
    assert_equal "step_limit_exceeded", res["error"]["code"]
    assert_empty res["events"]
    validate_render_result!(res)
  end

  def test_resource_limit_max_output_bytes_128_kib
    # 128 KiB = 131,072 bytes exact boundary passes; 131,073 fails
    chunk_1024 = "a" * 1024
    src = "{% for x in xs %}{{ chunk }}{% endfor %}"

    ok_assigns = { "xs" => Array.new(128, 1), "chunk" => chunk_1024 }
    ok_res = LiquidInterpreter::Template.render_result(src, ok_assigns, trace: true)
    assert_equal "ok", ok_res["status"]
    assert_equal 131_072, ok_res["html"].bytesize
    validate_render_result!(ok_res)

    over_assigns = { "xs" => Array.new(128, 1), "chunk" => chunk_1024 }
    over_src = "{% for x in xs %}{{ chunk }}{% endfor %}!"
    err_res = LiquidInterpreter::Template.render_result(over_src, over_assigns, trace: true)
    assert_equal "error", err_res["status"]
    assert_equal "output_limit_exceeded", err_res["error"]["code"]
    assert_empty err_res["events"]
    validate_render_result!(err_res)
  end

  def test_resource_limit_max_trace_events_10000
    # 1 lookup for `xs` + 4,999 * (Lookup + Emit) + 1 trailing Emit = 10,000 events exact boundary
    ok_src = "{% for x in xs %}{{ x }}{% endfor %}!"
    ok_res = LiquidInterpreter::Template.render_result(ok_src, { "xs" => Array.new(4_999, "a") }, trace: true)
    assert_equal "ok", ok_res["status"]
    assert_equal 10_000, ok_res["events"].size
    validate_render_result!(ok_res)

    over_src = "{% for x in xs %}{{ x }}{% endfor %}"
    over_assigns = { "xs" => Array.new(5_000, "a") } # 1 + 5,000 * 2 = 10,001 events
    # Without tracing, renders cleanly within step & output limits
    no_trace_html = LiquidInterpreter::Template.compile(over_src).render(over_assigns)
    assert_equal 5_000, no_trace_html.bytesize

    # With tracing, triggers trace_event_limit_exceeded and returns clean error RenderResult
    err_res = LiquidInterpreter::Template.render_result(over_src, over_assigns, trace: true)
    assert_equal "error", err_res["status"]
    assert_nil err_res["html"]
    assert_nil err_res["observed"]
    assert_empty err_res["events"]
    assert_equal "trace_event_limit_exceeded", err_res["error"]["code"]
    validate_render_result!(err_res)
  end
end

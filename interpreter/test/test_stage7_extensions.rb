# frozen_string_literal: true

require "json"
require "json_schemer"
require "minitest/autorun"

$LOAD_PATH.unshift(File.expand_path("../lib", __dir__))
$LOAD_PATH.unshift(File.expand_path("../../reference/lib", __dir__))
require "liquid"
require "liquid_interpreter"

class Stage7ExtensionsTest < Minitest::Test
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

  def render_oracle(source, assigns = {})
    Liquid::Template.parse(source, error_mode: :strict2, line_numbers: true).render!(assigns)
  end

  def assert_oracle_parity(source, assigns = {}, filters: nil)
    expected = render_oracle(source, assigns)
    tpl = LiquidInterpreter::Template.compile(source, filters: filters)
    actual_plain = tpl.render(assigns)
    traced = tpl.render_with_trace(assigns)

    assert_equal expected, actual_plain, "Plain render mismatch vs liquid #{Liquid::VERSION} for #{source.inspect}"
    assert_equal actual_plain, traced["html"], "Trace altered rendered HTML for #{source.inspect}"
    assert_equal Encoding::UTF_8, traced["html"].encoding

    payload = {
      "status" => "ok",
      "html" => traced["html"],
      "observed" => false,
      "events" => traced["events"],
      "error" => nil,
    }
    errors = @render_result_schema.validate(payload).to_a
    assert_empty errors, "RenderResult failed schema validation: #{errors.map { |e| e['error'] }}"
    traced["events"].each_with_index do |ev, idx|
      assert_equal idx, ev["seq"]
      ev_errors = @trace_event_schema.validate(ev).to_a
      assert_empty ev_errors, "TraceEvent #{idx} failed schema validation: #{ev_errors.map { |e| e['error'] }}"
    end

    traced
  end

  def test_size_property_on_array_string_hash_and_key_precedence_matches_oracle
    assigns = {
      "arr" => [10, 20, 30],
      "empty_arr" => [],
      "str" => "äöü€",
      "empty_str" => "",
      "h" => { "a" => 1, "b" => 2 },
      "empty_h" => {},
      "h_with_size" => { "size" => 99, "a" => 1 },
      "h_with_nil_size" => { "size" => nil, "a" => 1 },
      "n" => nil,
      "b" => true,
      "num" => 42,
    }

    tpl = <<~LIQUID
      arr={{ arr.size }}|empty_arr={{ empty_arr.size }}|str={{ str.size }}|empty_str={{ empty_str.size }}|h={{ h.size }}|empty_h={{ empty_h.size }}|hs={{ h_with_size.size }}|hn={{ h_with_nil_size.size }}|n={{ n.size }}|b={{ b.size }}|chained={{ arr.size.missing }}
      {%- if arr.size == 3 and h.size > 1 and h_with_size.size == 99 and h_with_nil_size.size == nil -%}OK{%- endif -%}
    LIQUID
    traced = assert_oracle_parity(tpl, assigns)

    lookups = traced["events"].select { |e| e["data"]["kind"] == "lookup" }.map { |e| [e["data"]["path"], e["data"]["found"], e["data"]["value"]] }
    assert_includes lookups, ["arr.size", true, 3]
    assert_includes lookups, ["str.size", true, 4]
    assert_includes lookups, ["h.size", true, 2]
    assert_includes lookups, ["h_with_size.size", true, 99]
    assert_includes lookups, ["h_with_nil_size.size", true, nil]
    assert_includes lookups, ["n.size", false, nil]
    assert_includes lookups, ["b.size", false, nil]
    assert_includes lookups, ["arr.size.missing", false, nil]

    # Root variable named `size` resolves from scope, not as property
    assert_oracle_parity("{{ size }}-{{ h.size }}", { "size" => "L", "h" => { "a" => 1 } })
  end

  def test_hash_and_array_value_equality_matches_oracle
    assigns = {
      "product" => {
        "price" => 1000,
        "price_varies" => true,
        "variants" => [
          { "id" => "v1", "price" => 1000, "available" => true },
          { "id" => "v2", "price" => 2000, "available" => false },
        ],
      },
      "reordered_product" => {
        "variants" => [
          { "available" => true, "price" => 1000, "id" => "v1" },
          { "available" => false, "price" => 2000, "id" => "v2" },
        ],
        "price_varies" => true,
        "price" => 1000,
      },
      "different_order_array" => [2, 1],
      "same_array" => [1, 2],
      "same_array_2" => [1, 2],
      "empty_h" => {},
      "empty_a" => [],
    }

    tpl = <<~LIQUID
      {%- assign target = product -%}
      {%- assign variant = product.variants -%}
      {%- if target == product -%}P1{%- endif -%}
      {%- if product == reordered_product -%}P2{%- endif -%}
      {%- if target != variant -%}P3{%- endif -%}
      {%- if same_array == same_array_2 -%}A1{%- endif -%}
      {%- if same_array != different_order_array -%}A2{%- endif -%}
      {%- if empty_h == empty_a -%}NO{%- else -%}DIFF{%- endif -%}
      {%- if empty_h == nil -%}NIL{%- else -%}NOTNIL{%- endif -%}
    LIQUID
    assert_oracle_parity(tpl, assigns)
  end

  def test_liquid_multiline_tag_statements_comments_spans_and_blank_stripping
    src = <<~LIQUID
      start:ä
      {%- liquid
        # full-line comment
        ### banner comment

        assign flag = false
        for v in product.variants
          if v.compare_at_price != nil and v.compare_at_price > v.price
            assign flag = true
          elsif v.price == 0
            assign zero_seen = true
          else
            assign other = true
          endif
        endfor
        unless flag
          assign label = 'regular'
        else
          assign label = 'sale'
        endunless
      -%}
      result={{ label }}|zero={{ zero_seen }}|other={{ other }}
    LIQUID

    assigns = {
      "product" => {
        "variants" => [
          { "id" => "v1", "price" => 0, "compare_at_price" => nil, "available" => true },
          { "id" => "v2", "price" => 1000, "compare_at_price" => 1500, "available" => true },
        ],
      },
    }

    traced = assert_oracle_parity(src, assigns)
    tpl = LiquidInterpreter::Template.compile(src)

    # Verify AST children come from standard AST classes with exact source spans!
    # children[0] is Text ("start:ä" trimmed by {%-), children[1..] are Assign/For/Conditional from {% liquid %}
    for_node = tpl.ast.children.find { |n| n.is_a?(LiquidInterpreter::AST::For) }
    refute_nil for_node
    assert_equal 7, for_node.span.line
    assert_equal 3, for_node.span.column
    assert_equal "for v in product.variants", src.byteslice(for_node.span.start_byte...for_node.span.end_byte)

    if_node = for_node.body.first
    assert_instance_of LiquidInterpreter::AST::Conditional, if_node
    assert_equal 8, if_node.span.line
    assert_equal 5, if_node.span.column
    assert_equal "if v.compare_at_price != nil and v.compare_at_price > v.price", src.byteslice(if_node.span.start_byte...if_node.span.end_byte)

    # Trace events inside {% liquid %} record loop variant_id frames & exact line numbers
    branch_events = traced["events"].select { |e| e["data"]["kind"] == "branch" }
    v2_if = branch_events.find { |e| e["span"]["line"] == 8 && e["scope"].any? { |f| f["variant_id"] == "v2" } }
    refute_nil v2_if
    assert_equal true, v2_if["data"]["taken"]

    # Blank? whitespace stripping when {% liquid %} is sole content inside {% if %}
    assert_oracle_parity("{% if true %}\n  {% liquid\n    # comment only\n    assign x = 1\n  %}\n{% endif %}{{ x }}")
    # Top-level whitespace preservation around {% liquid %}
    assert_oracle_parity("  {% liquid\n  assign x = 1\n%}  \nhello")
    # CRLF and nested liquid lines
    assert_oracle_parity("{%- liquid\r\n  liquid\r\n    assign a = 1\r\n  liquid assign b = 2\r\n-%}{{ a }}{{ b }}")
    # Empty liquid tag
    assert_oracle_parity("a{% liquid %}b")
  end

  def test_liquid_tag_syntax_and_unsupported_errors_preserve_exact_spans
    # Unclosed `if` inside {% liquid %}
    unclosed_src = "x\n{% liquid\n  if true\n    assign a = 1\n%}"
    err_unclosed = assert_raises(LiquidInterpreter::SyntaxError) do
      LiquidInterpreter::Template.compile(unclosed_src)
    end
    assert_equal "unclosed_tag", err_unclosed.code
    assert_equal 3, err_unclosed.line
    assert_equal 3, err_unclosed.column

    # Unexpected `else` at top-level of {% liquid %} inside outer {% if %}
    bad_else_src = "{% if true %}\n{% liquid\n  else\n%}\n{% endif %}"
    err_else = assert_raises(LiquidInterpreter::SyntaxError) do
      LiquidInterpreter::Template.compile(bad_else_src)
    end
    assert_equal "unexpected_tag", err_else.code
    assert_equal 3, err_else.line
    assert_equal 3, err_else.column

    # Inline `#` after statement rejected (matches liquid 5.14.0)
    inline_hash_src = "{% liquid\n  assign x = 1 # bad\n%}"
    assert_raises(Liquid::SyntaxError) { render_oracle(inline_hash_src) }
    err_hash = assert_raises(LiquidInterpreter::SyntaxError) do
      LiquidInterpreter::Template.compile(inline_hash_src)
    end
    assert_equal 2, err_hash.line

    # Unsupported tag inside {% liquid %}
    unsupported_src = "{% liquid\n  echo 'hi'\n%}"
    err_unsup = assert_raises(LiquidInterpreter::UnsupportedFeatureError) do
      LiquidInterpreter::Template.compile(unsupported_src)
    end
    assert_equal "unsupported_tag", err_unsup.code
    assert_equal 2, err_unsup.line
    assert_equal 3, err_unsup.column
  end

  def test_default_filter_and_pipelines_match_oracle
    values = [nil, false, true, "", " ", "0", 0, [], {}, [1], { "a" => 1 }]
    values.each do |val|
      env = { "x" => val, "fb" => "FALLBACK" }
      assert_oracle_parity("{{ x | default }}", env)
      assert_oracle_parity("{{ x | default: 'FB' }}", env)
      assert_oracle_parity("{{ x | default: fb }}", env)
      assert_oracle_parity("{{ x | default: 'FB', allow_false: true }}", env)
      assert_oracle_parity("{{ x | default: 'FB', allow_false: false }}", env)
      assert_oracle_parity("{{ x | default: 'FB', allow_false: 'yes' }}", env)
      assert_oracle_parity("{{ x | default: 'FB', allow_false: nil }}", env)
      assert_oracle_parity("{% assign y = x | default: 'FB', allow_false: true %}{{ y }}", env)
    end

    # Chained default filters and trailing commas and empty colon
    assert_oracle_parity("{{ a | default: b | default: 'C' }}", { "a" => nil, "b" => "" })
    assert_oracle_parity("{{ nil | default: 'bar', }}")
    assert_oracle_parity("{{ nil | default: }}")
    assert_oracle_parity("{{ x | default: allow_false: true }}", { "x" => false })
    assert_oracle_parity("{{ x | default: 'a', allow_false: true, allow_false: false }}", { "x" => false })
    assert_oracle_parity("{% liquid\n  assign price = target.price | default: 1999\n  assign avail = target.available | default: false\n%}{{ price }}|{{ avail }}", { "target" => {} })

    # Excess positional arguments raise RenderError (matching Liquid::ArgumentError)
    assert_raises(Liquid::ArgumentError) { render_oracle("{{ nil | default: 'a', 'b', 'c' }}") }
    err_arity = assert_raises(LiquidInterpreter::RenderError) do
      LiquidInterpreter::Template.compile("{{ nil | default: 'a', 'b', 'c' }}").render
    end
    assert_equal "filter_error", err_arity.code

    # Filters disallowed in `if` and `for` conditions
    assert_raises(Liquid::SyntaxError) { render_oracle("{% if x | default: true %}Y{% endif %}") }
    assert_raises(LiquidInterpreter::SyntaxError) do
      LiquidInterpreter::Template.compile("{% if x | default: true %}Y{% endif %}")
    end
    assert_raises(Liquid::SyntaxError) { render_oracle("{% for i in x | default: y %}{% endfor %}") }
    assert_raises(LiquidInterpreter::SyntaxError) do
      LiquidInterpreter::Template.compile("{% for i in x | default: y %}{% endfor %}")
    end
  end

  def test_benchmark_only_filters_stay_disabled_by_default
    %w[money money_with_currency t upcase].each do |fname|
      err = assert_raises(LiquidInterpreter::UnsupportedFeatureError) do
        LiquidInterpreter::Template.compile("{{ x | #{fname} }}")
      end
      assert_equal "unsupported_filter", err.code

      err_assign = assert_raises(LiquidInterpreter::UnsupportedFeatureError) do
        LiquidInterpreter::Template.compile("{% assign y = x | #{fname} %}")
      end
      assert_equal "unsupported_filter", err_assign.code
    end

    # When explicit benchmark filter registry is passed, money / money_with_currency / t execute and trace cleanly
    bench_filters = {
      "money" => ->(cents) { cents.nil? ? "" : format("$%d.%02d", cents / 100, cents % 100) },
      "t" => ->(key, params = nil) { "#{key}:#{params&.fetch('price', '')}" },
    }
    tpl = LiquidInterpreter::Template.compile(
      "{% assign p = target.price | default: 1999 %}{% assign m = p | money %}{{ 'price.from' | t: price: m }}",
      filters: bench_filters,
    )
    plain = tpl.render({ "target" => {} })
    traced = tpl.render_with_trace({ "target" => {} })
    assert_equal "price.from:$19.99", plain
    assert_equal plain, traced["html"]
    refute_empty traced["events"]
  end
end

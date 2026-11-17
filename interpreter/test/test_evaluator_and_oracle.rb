# frozen_string_literal: true

require "minitest/autorun"

$LOAD_PATH.unshift(File.expand_path("../lib", __dir__))
require "liquid"
require "liquid_interpreter"

class EvaluatorAndOracleTest < Minitest::Test
  def render_oracle(source, assigns = {})
    Liquid::Template.parse(source, error_mode: :strict2).render!(assigns)
  end

  def render_custom(source, assigns = {})
    LiquidInterpreter::Template.compile(source).render(assigns)
  end

  def assert_oracle_parity(source, assigns = {})
    expected = render_oracle(source, assigns)
    actual = render_custom(source, assigns)
    assert_equal expected, actual, "Mismatch vs liquid #{Liquid::VERSION} for #{source.inspect} with #{assigns.inspect}"
  end

  def test_nil_comparisons_both_orders_match_oracle
    assigns = { "missing_present_nil" => nil, "zero" => 0, "empty_s" => "", "f" => false }
    ops = %w[== != < <= > >=]
    lefts = ["nil", "null", "missing", "missing_present_nil", "zero", "5", "empty_s", "'a'", "f", "true"]
    rights = ["nil", "null", "missing", "missing_present_nil", "zero", "5", "empty_s", "'a'", "f", "true"]

    ops.each do |op|
      lefts.each do |lhs|
        rights.each do |rhs|
          tpl = "{% if #{lhs} #{op} #{rhs} %}T{% else %}F{% endif %}"
          oracle_raised = false
          oracle_out = nil
          begin
            oracle_out = render_oracle(tpl, assigns)
          rescue Liquid::ArgumentError
            oracle_raised = true
          end

          if oracle_raised
            assert_raises(LiquidInterpreter::RenderError, "Expected RenderError for #{tpl}") do
              render_custom(tpl, assigns)
            end
          else
            assert_equal oracle_out, render_custom(tpl, assigns), "Mismatch for #{tpl}"
          end
        end
      end
    end
  end

  def test_mixed_numeric_and_string_and_collection_comparisons_match_oracle
    env = {
      "n_zero" => 0,
      "n_pos" => 5,
      "n_neg" => -2,
      "s_zero" => "0",
      "s_five" => "5",
      "s_money" => "$5.00",
      "s_alpha" => "apple",
      "s_beta" => "banana",
      "arr_a" => [1, 2],
      "arr_b" => [1, 2],
      "arr_c" => [1, 3],
      "hash_a" => { "k" => 1 },
      "hash_b" => { "k" => 1 },
      "hash_c" => { "k" => 2 },
    }

    # Never coerce money strings, zero, or nil into each other
    [
      "{% if n_zero == nil %}T{% else %}F{% endif %}",
      "{% if n_zero == s_zero %}T{% else %}F{% endif %}",
      "{% if s_money == n_pos %}T{% else %}F{% endif %}",
      "{% if s_money == 0 %}T{% else %}F{% endif %}",
      "{% if s_money == nil %}T{% else %}F{% endif %}",
      "{% if n_pos == s_five %}T{% else %}F{% endif %}",
      "{% if n_pos != s_five %}T{% else %}F{% endif %}",
      "{% if n_neg < n_zero %}T{% else %}F{% endif %}",
      "{% if s_alpha < s_beta %}T{% else %}F{% endif %}",
      "{% if s_beta <= s_alpha %}T{% else %}F{% endif %}",
      "{% if arr_a == arr_b %}T{% else %}F{% endif %}",
      "{% if arr_a == arr_c %}T{% else %}F{% endif %}",
      "{% if arr_a < arr_c %}T{% else %}F{% endif %}",
      "{% if hash_a == hash_b %}T{% else %}F{% endif %}",
      "{% if hash_a == hash_c %}T{% else %}F{% endif %}",
      "{% if hash_a < hash_c %}T{% else %}F{% endif %}",
    ].each do |tpl|
      assert_oracle_parity(tpl, env)
    end

    # Ordered comparison between Integer and String raises in both engines
    [
      "{% if n_pos < s_five %}T{% else %}F{% endif %}",
      "{% if s_five > n_pos %}T{% else %}F{% endif %}",
      "{% if 5 <= '6' %}T{% else %}F{% endif %}",
      "{% if '6' >= 5 %}T{% else %}F{% endif %}",
    ].each do |tpl|
      assert_raises(Liquid::ArgumentError) { render_oracle(tpl, env) }
      err = assert_raises(LiquidInterpreter::RenderError) { render_custom(tpl, env) }
      assert_equal "comparison_error", err.code
    end
  end

  def test_truthiness_and_condition_inversion_and_branch_fallthrough
    env = {
      "v_nil" => nil,
      "v_false" => false,
      "v_true" => true,
      "v_zero" => 0,
      "v_empty" => "",
      "v_str0" => "0",
      "v_strfalse" => "false",
      "v_arr" => [],
      "v_hash" => {},
    }

    env.each_key do |k|
      assert_oracle_parity("{% if #{k} %}T{% else %}F{% endif %}", env)
      assert_oracle_parity("{% unless #{k} %}T{% else %}F{% endunless %}", env)
    end

    # Condition inversion with elsif + else on unless
    [true, false].each do |a|
      [true, false].each do |b|
        tpl = "{% unless a %}U{% elsif b %}E{% else %}L{% endunless %}"
        assert_oracle_parity(tpl, { "a" => a, "b" => b })
      end
    end

    # Branch fallthrough: first matching arm wins and later arms are not evaluated
    fallthrough_tpl = "{% if a %}A{% elsif b %}B{% elsif c %}C{% else %}D{% endif %}"
    [
      { "a" => true, "b" => true, "c" => true },
      { "a" => false, "b" => true, "c" => true },
      { "a" => false, "b" => false, "c" => true },
      { "a" => false, "b" => false, "c" => false },
    ].each do |e|
      assert_oracle_parity(fallthrough_tpl, e)
    end
  end

  def test_right_grouped_logical_chains_and_short_circuit_lookup_ordering
    # All 3-variable truth table combinations for and/or chains
    [true, false].product([true, false], [true, false]).each do |a, b, c|
      env = { "a" => a, "b" => b, "c" => c }
      assert_oracle_parity("{% if a and b or c %}T{% else %}F{% endif %}", env)
      assert_oracle_parity("{% if a or b and c %}T{% else %}F{% endif %}", env)
      assert_oracle_parity("{% unless a and b or c %}T{% else %}F{% endunless %}", env)
      assert_oracle_parity("{% unless a or b and c %}T{% else %}F{% endunless %}", env)
    end

    # Prove right-associative short-circuiting via lookup order in trace!
    # `false and (true or true)` must ONLY look up `a`, never `b` or `c`.
    tpl1 = LiquidInterpreter::Template.compile("{% if a and b or c %}T{% else %}F{% endif %}")
    tr1 = tpl1.render_with_trace({ "a" => false, "b" => true, "c" => true })
    assert_equal "F", tr1["html"]
    lookups1 = tr1["events"].select { |e| e["data"]["kind"] == "lookup" }.map { |e| e["data"]["path"] }
    assert_equal ["a"], lookups1

    # `true and (false or true)` evaluates a, b, c in order
    tr2 = tpl1.render_with_trace({ "a" => true, "b" => false, "c" => true })
    assert_equal "T", tr2["html"]
    lookups2 = tr2["events"].select { |e| e["data"]["kind"] == "lookup" }.map { |e| e["data"]["path"] }
    assert_equal %w[a b c], lookups2

    # `true and (true or false)` evaluates a, b and short-circuits c!
    tr3 = tpl1.render_with_trace({ "a" => true, "b" => true, "c" => false })
    assert_equal "T", tr3["html"]
    lookups3 = tr3["events"].select { |e| e["data"]["kind"] == "lookup" }.map { |e| e["data"]["path"] }
    assert_equal %w[a b], lookups3

    # `true or (false and false)` evaluates ONLY `a`!
    tpl2 = LiquidInterpreter::Template.compile("{% if a or b and c %}T{% else %}F{% endif %}")
    tr4 = tpl2.render_with_trace({ "a" => true, "b" => false, "c" => false })
    assert_equal "T", tr4["html"]
    lookups4 = tr4["events"].select { |e| e["data"]["kind"] == "lookup" }.map { |e| e["data"]["path"] }
    assert_equal ["a"], lookups4

    # `false or (false and true)` evaluates `a` and `b`, short-circuits `c`!
    tr5 = tpl2.render_with_trace({ "a" => false, "b" => false, "c" => true })
    assert_equal "F", tr5["html"]
    lookups5 = tr5["events"].select { |e| e["data"]["kind"] == "lookup" }.map { |e| e["data"]["path"] }
    assert_equal %w[a b], lookups5
  end

  def test_assign_persistence_and_for_loop_shadowing_and_restoration_match_oracle
    # Demo-style sale flag set inside loop persists after loop
    demo_tpl = <<~LIQUID
      {% assign on_sale = false %}
      {% for v in product.variants %}
        {% if v.compare_at_price != nil and v.compare_at_price > v.price %}
          {% assign on_sale = true %}
        {% endif %}
      {% endfor %}
      {% if on_sale %}<span data-regression-badge="sale">Sale</span>{% endif %}
    LIQUID
    demo_env = {
      "product" => {
        "variants" => [
          { "id" => "v1", "price" => 1000, "compare_at_price" => nil },
          { "id" => "v2", "price" => 1000, "compare_at_price" => 1500 },
        ],
      },
    }
    assert_oracle_parity(demo_tpl, demo_env)

    # Nested loop + outer variable shadowing & restoration + assign inside loop to binder name
    shadow_tpl = "{% assign x = 'outer' %}{% for x in outer %}[{% for x in inner %}{{ x }}{% endfor %}:{{ x }}{% assign x = 'inner_assign' %}->{{ x }}]{% endfor %}|{{ x }}"
    shadow_env = { "outer" => %w[A B], "inner" => [1, 2], "x" => "from_env" }
    assert_oracle_parity(shadow_tpl, shadow_env)

    # Empty loop else branch does not bind loop variable
    else_tpl = "{% for x in items %}{{ x }}{% else %}[{{ x }}]{% endfor %}"
    assert_oracle_parity(else_tpl, { "items" => [], "x" => "outer_env" })

    # For over string, empty string, hash, nil, integer
    ["abc", "", { "a" => 1, "b" => 2 }, nil, 42].each do |val|
      assert_oracle_parity("{% for item in v %}[{{ item }}]{% else %}EMPTY{% endfor %}", { "v" => val })
    end
  end

  def test_output_rendering_of_primitives_arrays_and_hashes_matches_oracle
    env = {
      "n" => nil,
      "b_t" => true,
      "b_f" => false,
      "i" => -42,
      "s" => "hello äöü",
      "arr" => [1, nil, [true, "x"], { "k" => [2, nil] }],
      "h" => { "a" => 1, "b" => "two", "c" => nil },
      "empty_h" => {},
    }

    assert_oracle_parity("{{ n }}|{{ b_t }}|{{ b_f }}|{{ i }}|{{ s }}|{{ arr }}|{{ h }}|{{ empty_h }}", env)
  end

  def test_permissive_lookup_distinguishes_missing_key_from_present_null
    tpl = LiquidInterpreter::Template.compile("{{ present_null }}{{ v.compare_at_price }}{{ v.missing }}{{ absent }}")
    env = {
      "present_null" => nil,
      "v" => { "id" => "v1", "compare_at_price" => nil },
    }

    traced = tpl.render_with_trace(env)
    assert_equal "", traced["html"]

    lookups = traced["events"].select { |e| e["data"]["kind"] == "lookup" }.map { |e| [e["data"]["path"], e["data"]["found"], e["data"]["value"]] }
    assert_equal [
      ["present_null", true, nil],
      ["v.compare_at_price", true, nil],
      ["v.missing", false, nil],
      ["absent", false, nil],
    ], lookups

    # Re-rendering does not leak assigns from prior render or mutate caller assigns
    assign_tpl = LiquidInterpreter::Template.compile("{% assign leaked = 'yes' %}{{ leaked }}-{{ v.id }}")
    first_env = { "v" => { "id" => "v1" } }
    assert_equal "yes-v1", assign_tpl.render(first_env)
    assert_equal({ "v" => { "id" => "v1" } }, first_env)
    assert_equal "yes-", assign_tpl.render({})
  end
end

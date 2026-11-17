# frozen_string_literal: true

require "minitest/autorun"

$LOAD_PATH.unshift(File.expand_path("../lib", __dir__))
require "liquid_interpreter"

class LexerAndParserTest < Minitest::Test
  def test_lexes_mixed_html_utf8_and_multiline_tags_with_exact_spans
    src = "<div>äöü\n  {{- product.title -}}\n  {% if\n    v.price > 100\n  %}<span>Sale</span>{% endif %}</div>"
    tokens = LiquidInterpreter::Lexer.tokenize(src)

    assert_equal %i[text output text tag text tag text], tokens.map(&:type)

    # First text token: raw preserved, trimmed value removes trailing "\n  " due to {{-
    t0 = tokens[0]
    assert_equal "<div>äöü\n  ", t0.raw
    assert_equal "<div>äöü", t0.value
    assert_equal 0, t0.span.start_byte
    assert_equal t0.raw.bytesize, t0.span.end_byte
    assert_equal 1, t0.span.line
    assert_equal 1, t0.span.column

    # Output token: line 2, code-point column 3
    t1 = tokens[1]
    assert_equal "{{- product.title -}}", t1.raw
    assert_equal " product.title ", t1.value
    assert t1.trim_left
    assert t1.trim_right
    assert_equal 2, t1.span.line
    assert_equal 3, t1.span.column
    assert_equal t1.raw, src.byteslice(t1.span.start_byte...t1.span.end_byte)

    # Text token between -}} and {% if: leading "\n  " trimmed to ""
    t2 = tokens[2]
    assert_equal "\n  ", t2.raw
    assert_equal "", t2.value

    # Multiline tag token: line 3, col 3
    t3 = tokens[3]
    assert_equal "{% if\n    v.price > 100\n  %}", t3.raw
    assert_equal 3, t3.span.line
    assert_equal 3, t3.span.column

    # Verify AST expression spans inside multiline tag
    tpl = LiquidInterpreter::Template.compile(src)
    cond_node = tpl.ast.children[2]
    assert_instance_of LiquidInterpreter::AST::Conditional, cond_node
    cmp = cond_node.arms.first.condition
    assert_instance_of LiquidInterpreter::AST::Compare, cmp
    assert_equal 4, cmp.span.line
    assert_equal 5, cmp.span.column
    assert_equal "v.price > 100", src.byteslice(cmp.span.start_byte...cmp.span.end_byte)
    assert_equal "v.price", src.byteslice(cmp.left.span.start_byte...cmp.left.span.end_byte)
  end

  def test_whitespace_trimming_preserves_nbsp_and_handles_trim_blank
    src = "a\u00a0 {{-}} \n\t{%- if true -%} yes {%- endif -%}\t\n\u00a0b"
    tpl = LiquidInterpreter::Template.compile(src)
    assert_equal "a\u00a0yes\u00a0b", tpl.render

    # Consecutive trim markers without text between them
    src2 = "x {% if true -%}{%- assign y = 'Z' %} {{ y }}{% endif %}"
    assert_equal "x  Z", LiquidInterpreter::Template.compile(src2).render
  end

  def test_deterministic_node_ids_and_ast_structure
    src = "{% assign flag = false %}{% for v in product.variants %}{% if v.compare_at_price > v.price %}{% assign flag = true %}{% endif %}{% endfor %}{% if flag %}<span>{{ product.title }}</span>{% endif %}"
    t1 = LiquidInterpreter::Template.compile(src)
    t2 = LiquidInterpreter::Template.compile(src)

    assert_equal t1.source_sha256, t2.source_sha256
    assert_equal "doc", t1.ast.node_id

    assign_node, for_node, if_node = t1.ast.children
    assert_equal "n0:assign", assign_node.node_id
    assert_equal "n1:for", for_node.node_id
    assert_equal "n2:conditional", if_node.node_id

    assert_equal "n1:for.coll:lookup", for_node.collection_expr.node_id
    inner_if = for_node.body.first
    assert_equal "n1:for.b0:conditional", inner_if.node_id
    assert_equal "n1:for.b0:conditional.a0:branch", inner_if.arms.first.node_id
    assert_equal "n1:for.b0:conditional.a0.cond:comparison", inner_if.arms.first.condition.node_id
    assert_equal "n1:for.b0:conditional.a0.cond.l:lookup", inner_if.arms.first.condition.left.node_id
    assert_equal "n1:for.b0:conditional.a0.b0:assign", inner_if.arms.first.body.first.node_id
    assert_equal "n2:conditional.a0.b1:output", if_node.arms.first.body[1].node_id
  end

  def test_logical_right_associative_grouping
    src = "{% if a and b or c and d %}ok{% endif %}"
    tpl = LiquidInterpreter::Template.compile(src)
    cond = tpl.ast.children.first.arms.first.condition

    # Expect: a and (b or (c and d))
    assert_instance_of LiquidInterpreter::AST::Logical, cond
    assert_equal "and", cond.op
    assert_equal "a", cond.left.path_string

    rhs1 = cond.right
    assert_instance_of LiquidInterpreter::AST::Logical, rhs1
    assert_equal "or", rhs1.op
    assert_equal "b", rhs1.left.path_string

    rhs2 = rhs1.right
    assert_instance_of LiquidInterpreter::AST::Logical, rhs2
    assert_equal "and", rhs2.op
    assert_equal "c", rhs2.left.path_string
    assert_equal "d", rhs2.right.path_string
  end

  def test_rejects_malformed_syntax_with_line_column_diagnostics
    cases = [
      ["{{ unclosed", LiquidInterpreter::SyntaxError, "unterminated_output", 1, 1],
      ["a\n  {% unclosed", LiquidInterpreter::SyntaxError, "unterminated_tag", 2, 3],
      ["{{ 'abc' } }}", LiquidInterpreter::SyntaxError, "unterminated_output", 1, 1],
      ["{{ 'unterminated }}", LiquidInterpreter::SyntaxError, "unterminated_string", 1, 4],
      ["{% if true %}x", LiquidInterpreter::SyntaxError, "unclosed_tag", 1, 1],
      ["{% endif %}", LiquidInterpreter::SyntaxError, "unmatched_end_tag", 1, 1],
      ["{% endunless %}", LiquidInterpreter::SyntaxError, "unmatched_end_tag", 1, 1],
      ["{% endfor %}", LiquidInterpreter::SyntaxError, "unmatched_end_tag", 1, 1],
      ["{% else %}", LiquidInterpreter::SyntaxError, "unexpected_tag", 1, 1],
      ["{% if true %}a{% endunless %}", LiquidInterpreter::SyntaxError, "mismatched_end_tag", 1, 15],
      ["{% for x in items %}a{% endif %}", LiquidInterpreter::SyntaxError, "mismatched_end_tag", 1, 22],
      ["{% if true %}a{% else %}b{% elsif false %}c{% endif %}", LiquidInterpreter::SyntaxError, "unexpected_tag", 1, 26],
      ["{% if true %}a{% else %}b{% else %}c{% endif %}", LiquidInterpreter::SyntaxError, "unexpected_tag", 1, 26],
      ["{% for x in items %}{% elsif a %}{% endfor %}", LiquidInterpreter::SyntaxError, "unexpected_tag", 1, 21],
      ["{% assign = 1 %}", LiquidInterpreter::SyntaxError, "syntax_error", 1, 11],
      ["{% assign x = %}", LiquidInterpreter::SyntaxError, "syntax_error", 1, 1],
      ["{% if %}{% endif %}", LiquidInterpreter::SyntaxError, "syntax_error", 1, 1],
      ["{% if a == %}{% endif %}", LiquidInterpreter::SyntaxError, "syntax_error", 1, 9],
      ["{% for x items %}{% endfor %}", LiquidInterpreter::SyntaxError, "syntax_error", 1, 10],
      ["{{ a. }}", LiquidInterpreter::SyntaxError, "syntax_error", 1, 5],
      ["{{ .a }}", LiquidInterpreter::SyntaxError, "syntax_error", 1, 4],
      ["{{ a == b }}", LiquidInterpreter::SyntaxError, "syntax_error", 1, 6],
    ]

    cases.each do |src, err_class, code, line, col|
      err = assert_raises(err_class, "Expected #{err_class} for #{src.inspect}") do
        LiquidInterpreter::Template.compile(src)
      end
      assert_equal code, err.code, "Wrong code for #{src.inspect}"
      refute_nil err.span, "Expected span for #{src.inspect}"
      assert_equal line, err.line, "Wrong line for #{src.inspect}"
      assert_equal col, err.column, "Wrong column for #{src.inspect}"
    end
  end

  def test_rejects_unsupported_features_with_line_column_diagnostics
    cases = [
      ["{{ x | upcase }}", "unsupported_filter", 1, 6],
      ["{{ items[0] }}", "unsupported_bracket_access", 1, 9],
      ["{% for i in (1..5) %}{% endfor %}", "unsupported_syntax", 1, 13],
      ["{% if a contains 'x' %}{% endif %}", "unsupported_operator", 1, 9],
      ["{% if a <> b %}{% endif %}", "unsupported_operator", 1, 9],
      ["{% if a == empty %}{% endif %}", "unsupported_keyword", 1, 12],
      ["{% if a == blank %}{% endif %}", "unsupported_keyword", 1, 12],
      ["{{ 12.34 }}", "unsupported_float", 1, 4],
      ["{% for i in items %}{{ forloop.index }}{% endfor %}", "unsupported_forloop", 1, 24],
      ["{% for i in items limit: 2 %}{% endfor %}", "unsupported_for_modifier", 1, 19],
      ["{% comment %}hi{% endcomment %}", "unsupported_tag", 1, 1],
      ["{% raw %}{{ x }}{% endraw %}", "unsupported_tag", 1, 1],
      ["{% liquid\n  assign x = 1\n%}", "unsupported_tag", 1, 1],
    ]

    cases.each do |src, code, line, col|
      err = assert_raises(LiquidInterpreter::UnsupportedFeatureError, "Expected UnsupportedFeatureError for #{src.inspect}") do
        LiquidInterpreter::Template.compile(src)
      end
      assert_equal code, err.code, "Wrong code for #{src.inspect}"
      refute_nil err.span, "Expected span for #{src.inspect}"
      assert_equal line, err.line, "Wrong line for #{src.inspect}"
      assert_equal col, err.column, "Wrong column for #{src.inspect}"
    end
  end

  def test_enforces_compile_time_size_and_depth_limits
    ok_src = "a" * 16_384
    assert_equal ok_src, LiquidInterpreter::Template.compile(ok_src).render

    too_big = "a" * 16_385
    size_err = assert_raises(LiquidInterpreter::LimitError) do
      LiquidInterpreter::Template.compile(too_big)
    end
    assert_equal "snippet_too_large", size_err.code

    depth_32 = ("{% if true %}" * 32) + "ok" + ("{% endif %}" * 32)
    assert_equal "ok", LiquidInterpreter::Template.compile(depth_32).render

    depth_33 = ("{% if true %}" * 33) + "ok" + ("{% endif %}" * 33)
    depth_err = assert_raises(LiquidInterpreter::LimitError) do
      LiquidInterpreter::Template.compile(depth_33)
    end
    assert_equal "depth_limit_exceeded", depth_err.code
    refute_nil depth_err.span
    assert_equal 1, depth_err.line
  end
end

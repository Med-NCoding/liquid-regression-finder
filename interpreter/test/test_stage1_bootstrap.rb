# frozen_string_literal: true

require "json"
require "json_schemer"
require "minitest/autorun"

$LOAD_PATH.unshift(File.expand_path("../lib", __dir__))
require "liquid"
require "liquid/spec"
require "liquid_interpreter"
require "liquid_interpreter/conformance"

class Stage1BootstrapTest < Minitest::Test
  REPO_ROOT = File.expand_path("../..", __dir__)
  ADAPTER_PATH = File.join(REPO_ROOT, "interpreter/liquid_spec_adapter.rb")
  MANIFEST_PATH = File.join(REPO_ROOT, "contracts/conformance-manifest.json")
  SCHEMAS_DIR = File.join(REPO_ROOT, "contracts/schemas")

  def test_plain_text_compiles_to_ast_text_and_renders_via_evaluator
    src = "Hello, äöü 中文!"
    template = LiquidInterpreter::Template.compile(src)

    assert_instance_of LiquidInterpreter::AST::Document, template.ast
    assert_equal 1, template.ast.children.size
    node = template.ast.children.first
    assert_instance_of LiquidInterpreter::AST::Text, node
    assert_equal src, node.value
    assert_equal "n0:text", node.node_id
    assert_equal 0, node.span.start_byte
    assert_equal src.bytesize, node.span.end_byte
    assert_equal 1, node.span.line
    assert_equal 1, node.span.column

    assigns = { "ignored" => "value" }
    rendered = template.render(assigns)
    assert_equal src, rendered
    assert_equal Encoding::UTF_8, rendered.encoding
    assert_equal({ "ignored" => "value" }, assigns)
  end

  def test_empty_template_compiles_to_empty_document
    template = LiquidInterpreter::Template.compile("")
    assert_instance_of LiquidInterpreter::AST::Document, template.ast
    assert_empty template.ast.children
    assert_equal "", template.render
  end

  def test_render_with_trace_matches_render_and_validates_contract
    src = "Line 1\nLine 2: äöü"
    template = LiquidInterpreter::Template.compile(src)
    plain = template.render
    traced = template.render_with_trace

    assert_equal plain, traced["html"]
    assert_equal 1, traced["events"].size

    render_result_payload = {
      "status" => "ok",
      "html" => traced["html"],
      "observed" => false,
      "events" => traced["events"],
      "error" => nil,
    }
    resolver = ->(uri) { JSON.parse(File.read(File.join(SCHEMAS_DIR, File.basename(uri.path)))) }
    schemer = JSONSchemer.schema(
      JSON.parse(File.read(File.join(SCHEMAS_DIR, "render_result.schema.json"))),
      ref_resolver: resolver,
    )
    errors = schemer.validate(render_result_payload).to_a
    assert_empty errors, "Trace RenderResult failed schema validation: #{errors.inspect}"
  end

  def test_lexer_rejects_liquid_syntax_with_unicode_span
    src = "hi äö\n  ä{{ name }}"
    err = assert_raises(LiquidInterpreter::UnsupportedFeatureError) do
      LiquidInterpreter::Template.compile(src)
    end
    assert_kind_of LiquidInterpreter::SyntaxError, err
    assert_equal "unsupported_syntax", err.code
    assert_equal 2, err.line
    assert_equal 4, err.column
    refute_nil err.span
    assert_equal "{{", src.byteslice(err.span.start_byte...err.span.end_byte)

    tag_err = assert_raises(LiquidInterpreter::UnsupportedFeatureError) do
      LiquidInterpreter::Template.compile("ok {% if true %}yes{% endif %}")
    end
    assert_equal 1, tag_err.line
    assert_equal 4, tag_err.column
  end

  def test_lexer_rejects_invalid_utf8
    bad_utf8 = (+"\xFF\xFE").force_encoding(Encoding::UTF_8)
    err = assert_raises(LiquidInterpreter::SyntaxError) do
      LiquidInterpreter::Template.compile(bad_utf8)
    end
    assert_equal "invalid_utf8", err.code
  end

  def test_liquid_spec_adapter_executes_liquid_interpreter_and_ast_text
    adapter = Liquid::Spec.load_adapter(ADAPTER_PATH)
    specs = Liquid::Spec.load_specs(suite: :basics, filter: /\A(empty_template|literal_passthrough|raw_text_special_characters)\z/)
    assert_equal 3, specs.size

    compile_calls = []
    evaluate_nodes = []

    orig_compile = LiquidInterpreter::Template.method(:compile)
    orig_evaluate = LiquidInterpreter::Evaluator.instance_method(:evaluate)

    LiquidInterpreter::Template.define_singleton_method(:compile) do |source, **opts|
      compile_calls << source
      orig_compile.call(source, **opts)
    end

    LiquidInterpreter::Evaluator.define_method(:evaluate) do |document, **opts|
      document.children.each { |child| evaluate_nodes << child.class }
      orig_evaluate.bind_call(self, document, **opts)
    end

    begin
      run_result = adapter.run(specs)
      assert run_result.success?, "Expected plain-text specs to pass, got: #{run_result.summary}"
      assert_equal 3, run_result.pass_count
      assert_equal 3, compile_calls.size
      assert_includes evaluate_nodes, LiquidInterpreter::AST::Text
      assert_instance_of LiquidInterpreter::Template, adapter.ctx[:template]
      assert_instance_of LiquidInterpreter::AST::Document, adapter.ctx[:ast]
      assert_instance_of LiquidInterpreter::AST::Text, adapter.ctx[:ast].children.first
    ensure
      LiquidInterpreter::Template.define_singleton_method(:compile, orig_compile)
      LiquidInterpreter::Evaluator.define_method(:evaluate, orig_evaluate)
    end
  end

  def test_frozen_conformance_manifest_matches_pinned_corpus
    assert File.exist?(MANIFEST_PATH), "Missing conformance manifest at #{MANIFEST_PATH}"
    manifest = JSON.parse(File.read(MANIFEST_PATH, encoding: Encoding::UTF_8))

    assert_equal LiquidInterpreter::Conformance::PINNED_LIQUID_SPEC_SHA, manifest["liquid_spec_sha"]
    assert_equal Liquid::VERSION, manifest["liquid_gem_version"]

    totals = manifest.fetch("totals")
    assert_equal totals["inventoried"], totals["selected"] + totals["skipped_in_inventoried"]
    assert_equal totals["all_suites"], totals["inventoried"] + totals["skipped_other_suites"]
    assert_operator totals["plain_text_selected"], :>=, 14

    manifest.fetch("cases").each do |c|
      assert_includes %w[selected skipped], c["status"]
      if c["status"] == "skipped"
        refute_nil c["skip_reason"], "Skipped case #{c["id"]} missing skip_reason"
      else
        assert_includes %w[plain_text stage2_liquid], c["category"]
      end
    end

    regenerated = LiquidInterpreter::Conformance.build_manifest
    assert_equal regenerated, manifest, "Frozen conformance manifest drifted from deterministic classifier"
  end
end

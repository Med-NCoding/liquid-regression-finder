# frozen_string_literal: true

require "json"
require "json_schemer"
require "minitest/autorun"

$LOAD_PATH.unshift(File.expand_path("../lib", __dir__))
require "liquid_reference"

class ObserverAndReferenceTest < Minitest::Test
  REPO_ROOT = File.expand_path("../..", __dir__)
  SCHEMAS_DIR = File.join(REPO_ROOT, "contracts/schemas")

  def setup
    @ref_resolver = lambda do |uri|
      JSON.parse(File.read(File.join(SCHEMAS_DIR, File.basename(uri.path)), encoding: Encoding::UTF_8))
    end
    @render_result_schema = JSONSchemer.schema(
      JSON.parse(File.read(File.join(SCHEMAS_DIR, "render_result.schema.json"), encoding: Encoding::UTF_8)),
      ref_resolver: @ref_resolver,
    )
  end

  def assert_valid_render_result!(res)
    errors = @render_result_schema.validate(res).to_a
    assert_empty errors, "Invalid RenderResult: #{errors.map { |e| e['error'] }}"
  end

  def test_sale_badge_observer_matches_markup_and_rejects_decoys
    assert LiquidReference::Observer.observe("sale_badge", '<span data-regression-badge="sale">Sale</span>')
    assert LiquidReference::Observer.observe("sale_badge", "<div>\n  <span class=\"pill\" data-regression-badge = 'sale' >Äöü Sale</span>\n</div>")
    assert LiquidReference::Observer.observe("sale_badge", '<span data-regression-badge="sale">Unclosed')

    decoys = [
      "",
      'data-regression-badge="sale"',
      '<p>data-regression-badge="sale"</p>',
      '<!-- <span data-regression-badge="sale">Sale</span> -->',
      '&lt;span data-regression-badge="sale"&gt;Sale&lt;/span&gt;',
      '<script>const badge = "<span data-regression-badge=\\"sale\\">Sale</span>";</script>',
      '<textarea><span data-regression-badge="sale">Sale</span></textarea>',
      '<style>/* <span data-regression-badge="sale"> */</style>',
      '<span data-regression-badge="sold_out">Sold Out</span>',
      '<span data-regression-badge="SALE">Sale</span>',
      '<span data-regression-badge="sale-alt">Sale</span>',
      '<span data-badge="sale">Sale</span>',
      '<span title=\'data-regression-badge="sale"\'>Regular</span>',
    ]

    decoys.each do |html|
      refute LiquidReference::Observer.observe("sale_badge", html), "Decoy matched unexpectedly: #{html.inspect}"
    end

    ["sold_out_badge", "", nil, :sale_badge].each do |bad_observer|
      assert_raises(LiquidReference::Observer::UnsupportedObserverError) do
        LiquidReference::Observer.observe(bad_observer, "<span>ok</span>")
      end
    end
  end

  def test_restricted_environment_blocks_includes_and_strict2_and_permissive_variables
    include_res = LiquidReference::Renderer.render_reference('{% include "secret" %}', {}, observer: "sale_badge")
    assert_equal "error", include_res["status"]
    assert_equal "filesystem_disabled", include_res["error"]["code"]
    assert_empty include_res["events"]
    assert_valid_render_result!(include_res)

    render_res = LiquidReference::Renderer.render_reference('{% render "partial" %}', {}, observer: "sale_badge")
    assert_equal "error", render_res["status"]
    assert_equal "filesystem_disabled", render_res["error"]["code"]
    assert_valid_render_result!(render_res)

    syntax_res = LiquidReference::Renderer.render_reference("line1\n{% bogus %}", {}, observer: "sale_badge")
    assert_equal "error", syntax_res["status"]
    assert_equal "syntax_error", syntax_res["error"]["code"]
    assert_equal 2, syntax_res["error"]["span"]["line"]
    assert_valid_render_result!(syntax_res)

    runtime_res = LiquidReference::Renderer.render_reference("line1\n{% if 5 < '6' %}T{% endif %}", {}, observer: "sale_badge")
    assert_equal "error", runtime_res["status"]
    assert_equal "reference_render_error", runtime_res["error"]["code"]
    assert_equal 2, runtime_res["error"]["span"]["line"]
    assert_valid_render_result!(runtime_res)

    # Permissive missing variables render empty string without failing
    missing_res = LiquidReference::Renderer.render_reference("A{{ product.missing }}B", { "product" => {} }, observer: "sale_badge")
    assert_equal "ok", missing_res["status"]
    assert_equal "AB", missing_res["html"]
    assert_equal false, missing_res["observed"]
    assert_empty missing_res["events"]
    assert_valid_render_result!(missing_res)
  end

  def test_reference_engine_resource_limits
    # 1. Snippet size limit (16,384 allowed, 16,385 rejected)
    ok_snippet = "a" * 16_384
    ok_size_res = LiquidReference::Renderer.render_reference(ok_snippet, {}, observer: "sale_badge")
    assert_equal "ok", ok_size_res["status"]

    over_snippet = "a" * 16_385
    over_size_res = LiquidReference::Renderer.render_reference(over_snippet, {}, observer: "sale_badge")
    assert_equal "error", over_size_res["status"]
    assert_equal "snippet_too_large", over_size_res["error"]["code"]
    assert_valid_render_result!(over_size_res)

    # 2. Depth limit (32 allowed, 33 rejected)
    ok_deep = ("{% if true %}" * 32) + "ok" + ("{% endif %}" * 32)
    assert_equal "ok", LiquidReference::Renderer.render_reference(ok_deep, {}, observer: "sale_badge")["status"]

    over_deep = ("{% if true %}" * 33) + "no" + ("{% endif %}" * 33)
    over_deep_res = LiquidReference::Renderer.render_reference(over_deep, {}, observer: "sale_badge")
    assert_equal "error", over_deep_res["status"]
    assert_equal "depth_limit_exceeded", over_deep_res["error"]["code"]
    assert_valid_render_result!(over_deep_res)

    # Invalid UTF-8 rejected cleanly in reference renderer
    utf8_res = LiquidReference::Renderer.render_reference("hi\xFF".b, {}, observer: "sale_badge")
    assert_equal "error", utf8_res["status"]
    assert_equal "invalid_utf8", utf8_res["error"]["code"]
    assert_valid_render_result!(utf8_res)

    # Precompiled reference runtime max_depth enforcement
    compiled_two = LiquidReference::Renderer.compile_reference("{% if true %}{% if true %}hi{% endif %}{% endif %}")
    rt_depth_res = LiquidReference::Renderer.render_reference(compiled_two, {}, observer: "sale_badge", max_depth: 1)
    assert_equal "error", rt_depth_res["status"]
    assert_equal "depth_limit_exceeded", rt_depth_res["error"]["code"]
    assert_valid_render_result!(rt_depth_res)

    # 3. Output bytes limit (131,072 allowed, 131,073 rejected)
    chunk = "a" * 1024
    ok_out_res = LiquidReference::Renderer.render_reference(
      "{% for x in xs %}{{ chunk }}{% endfor %}",
      { "xs" => Array.new(128, 1), "chunk" => chunk },
      observer: "sale_badge",
    )
    assert_equal "ok", ok_out_res["status"]
    assert_equal 131_072, ok_out_res["html"].bytesize

    over_out_res = LiquidReference::Renderer.render_reference(
      "{% for x in xs %}{{ chunk }}{% endfor %}!",
      { "xs" => Array.new(128, 1), "chunk" => chunk },
      observer: "sale_badge",
    )
    assert_equal "error", over_out_res["status"]
    assert_equal "output_limit_exceeded", over_out_res["error"]["code"]
    assert_valid_render_result!(over_out_res)

    # 4. Step / render_score limit (<= 50,000)
    step_res = LiquidReference::Renderer.render_reference(
      "{% for a in xs %}{% for b in xs %}{% assign z = 1 %}{% endfor %}{% endfor %}",
      { "xs" => Array.new(250, 1) },
      observer: "sale_badge",
    )
    assert_equal "error", step_res["status"]
    assert_equal "step_limit_exceeded", step_res["error"]["code"]
    assert_valid_render_result!(step_res)

    # 5. Timeout backstop on huge empty loop
    timeout_res = LiquidReference::Renderer.render_reference(
      "{% for a in xs %}{% for b in xs %}{% endfor %}{% endfor %}",
      { "xs" => Array.new(5000, 1) },
      observer: "sale_badge",
      timeout_seconds: 0.05,
    )
    assert_equal "error", timeout_res["status"]
    assert_equal "render_timeout", timeout_res["error"]["code"]
    assert_valid_render_result!(timeout_res)
  end

  def test_ordinary_sale_and_non_sale_parity_across_engines
    ordinary_dir = File.join(REPO_ROOT, "fixtures/ordinary")
    before_src = File.read(File.join(ordinary_dir, "variant_sale_card.liquid"), encoding: Encoding::UTF_8)
    after_src = File.read(File.join(ordinary_dir, "aggregate_sale_card.liquid"), encoding: Encoding::UTF_8)
    sale_fixture = JSON.parse(File.read(File.join(ordinary_dir, "sale_product.json"), encoding: Encoding::UTF_8))
    regular_fixture = JSON.parse(File.read(File.join(ordinary_dir, "regular_product.json"), encoding: Encoding::UTF_8))

    pair = LiquidReference::Renderer.compile_pair(before: before_src, after: after_src, observer: "sale_badge")

    [
      [sale_fixture, true],
      [regular_fixture, false],
    ].each do |fixture, expected_observed|
      projected = LiquidReference::Projection.project_for_render(fixture)

      custom_before = LiquidReference::Renderer.render_custom(pair.custom_before, projected.fresh_assigns, observer: "sale_badge", trace: true)
      custom_after = LiquidReference::Renderer.render_custom(pair.custom_after, projected.fresh_assigns, observer: "sale_badge", trace: true)
      ref_before = LiquidReference::Renderer.render_reference(pair.reference_before, projected.fresh_assigns, observer: "sale_badge", trace: true)
      ref_after = LiquidReference::Renderer.render_reference(pair.reference_after, projected.fresh_assigns, observer: "sale_badge", trace: true)

      [custom_before, custom_after, ref_before, ref_after].each do |res|
        assert_equal "ok", res["status"]
        assert_equal expected_observed, res["observed"]
        assert_valid_render_result!(res)
      end

      assert_equal ref_before["html"], custom_before["html"]
      assert_equal ref_after["html"], custom_after["html"]
      refute_empty custom_before["events"]
      refute_empty custom_after["events"]
      assert_empty ref_before["events"]
      assert_empty ref_after["events"]
    end
  end

  def test_benchmark_observers_without_relaxing_public_observe
    assert LiquidReference::Observer.observe_benchmark("sale_badge", '<span data-regression-badge="sale">Sale</span>')
    assert LiquidReference::Observer.observe_benchmark("sold_out_badge", '<button data-regression-badge="sold_out" disabled>Sold out</button>')
    refute LiquidReference::Observer.observe_benchmark("sold_out_badge", '<span data-regression-badge="sale">Sale</span>')
    assert LiquidReference::Observer.observe_benchmark("price_range", '<span data-regression-price-range>$10 - $20</span>')
    refute LiquidReference::Observer.observe_benchmark("price_range", '<span>$10</span>')

    # Case-specific CSS visibility / accessibility predicate selector support
    assert LiquidReference::Observer.observe_benchmark(
      "sale_badge",
      '<span data-regression-badge="sale">Sale</span>',
      selector: '[data-regression-badge="sale"]:not([aria-hidden="true"])',
    )
    refute LiquidReference::Observer.observe_benchmark(
      "sale_badge",
      '<span data-regression-badge="sale" aria-hidden="true">Sale</span>',
      selector: '[data-regression-badge="sale"]:not([aria-hidden="true"])',
    )

    ["sold_out_badge", "price_range", "unknown", nil].each do |non_public|
      assert_raises(LiquidReference::Observer::UnsupportedObserverError) do
        LiquidReference::Observer.observe(non_public, '<span data-regression-badge="sold_out">Sold out</span>')
      end
    end

    ["unknown", "", nil, :sold_out_badge].each do |bad_bench|
      assert_raises(LiquidReference::Observer::UnsupportedObserverError) do
        LiquidReference::Observer.observe_benchmark(bad_bench, "<span>ok</span>")
      end
    end
  end
end

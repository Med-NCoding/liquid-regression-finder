# frozen_string_literal: true

require "json"
require "json_schemer"
require "minitest/autorun"

$LOAD_PATH.unshift(File.expand_path("../lib", __dir__))
require "liquid_reference"

class ProjectionAndValidatorTest < Minitest::Test
  REPO_ROOT = File.expand_path("../..", __dir__)
  SCHEMAS_DIR = File.join(REPO_ROOT, "contracts/schemas")

  def setup
    @ref_resolver = lambda do |uri|
      JSON.parse(File.read(File.join(SCHEMAS_DIR, File.basename(uri.path)), encoding: Encoding::UTF_8))
    end
    @fixture_schema = JSONSchemer.schema(
      JSON.parse(File.read(File.join(SCHEMAS_DIR, "fixture.schema.json"), encoding: Encoding::UTF_8)),
      ref_resolver: @ref_resolver,
    )
    @projection_schema = JSONSchemer.schema(
      JSON.parse(File.read(File.join(SCHEMAS_DIR, "projection.schema.json"), encoding: Encoding::UTF_8)),
      ref_resolver: @ref_resolver,
    )
  end

  def make_fixture(variants)
    {
      "schema_version" => 1,
      "currency" => "USD",
      "variants" => variants,
    }
  end

  def test_projection_version_and_contract_alignment
    assert_equal "1.0.0", LiquidReference::PROJECTION_VERSION

    fixture = make_fixture([
      { "id" => "v1", "price" => 1999, "compare_at_price" => nil, "available" => true },
      { "id" => "v2", "price" => 2499, "compare_at_price" => 2999, "available" => true },
    ])
    expected = JSON.parse(
      File.read(File.join(REPO_ROOT, "contracts/examples/valid/projection/mixed_compare_at.json"), encoding: Encoding::UTF_8),
    )

    result = LiquidReference::Projection.project_for_render(fixture)
    assert_equal expected, result.projection
    assert_empty @projection_schema.validate(result.projection).to_a
    refute result.projection.key?("variants")

    product = result.product_assign.fetch("product")
    assert_equal fixture["variants"], product["variants"]
    expected.each do |k, v|
      if v.nil?
        assert_nil product[k]
      else
        assert_equal v, product[k]
      end
    end
  end

  def test_projection_all_null_mixed_nil_zero_equal_varied_and_availability
    # All nil compare_at_price
    all_null = make_fixture([
      { "id" => "a", "price" => 500, "compare_at_price" => nil, "available" => false },
      { "id" => "b", "price" => 900, "compare_at_price" => nil, "available" => false },
    ])
    p_all_null = LiquidReference::Projection.project(all_null)
    assert_equal(
      {
        "price" => 500,
        "price_min" => 500,
        "price_max" => 900,
        "price_varies" => true,
        "compare_at_price" => nil,
        "compare_at_price_min" => nil,
        "compare_at_price_max" => nil,
        "compare_at_price_varies" => false,
        "available" => false,
      },
      p_all_null,
    )

    # Explicit zero + positive retains 0 as min/compare_at_price and marks varies=true
    zero_plus_pos = make_fixture([
      { "id" => "z1", "price" => 1000, "compare_at_price" => 0, "available" => false },
      { "id" => "z2", "price" => 1000, "compare_at_price" => 2500, "available" => true },
    ])
    p_zero_pos = LiquidReference::Projection.project(zero_plus_pos)
    assert_equal 0, p_zero_pos["compare_at_price"]
    assert_equal 0, p_zero_pos["compare_at_price_min"]
    assert_equal 2500, p_zero_pos["compare_at_price_max"]
    assert_equal true, p_zero_pos["compare_at_price_varies"]
    assert_equal false, p_zero_pos["price_varies"]
    assert_equal true, p_zero_pos["available"]

    # Mixed nil + explicit zero retains 0 and varies=false
    nil_plus_zero = make_fixture([
      { "id" => "nz1", "price" => 0, "compare_at_price" => nil, "available" => true },
      { "id" => "nz2", "price" => 10_000_000, "compare_at_price" => 0, "available" => false },
    ])
    p_nil_zero = LiquidReference::Projection.project(nil_plus_zero)
    assert_equal 0, p_nil_zero["price"]
    assert_equal 0, p_nil_zero["price_min"]
    assert_equal 10_000_000, p_nil_zero["price_max"]
    assert_equal true, p_nil_zero["price_varies"]
    assert_equal 0, p_nil_zero["compare_at_price"]
    assert_equal 0, p_nil_zero["compare_at_price_min"]
    assert_equal 0, p_nil_zero["compare_at_price_max"]
    assert_equal false, p_nil_zero["compare_at_price_varies"]
    assert_equal true, p_nil_zero["available"]

    # Equal numeric compare_at_price with varied prices
    equal_cmp = make_fixture([
      { "id" => "e1", "price" => 1200, "compare_at_price" => 2000, "available" => true },
      { "id" => "e2", "price" => 1500, "compare_at_price" => 2000, "available" => true },
    ])
    p_equal = LiquidReference::Projection.project(equal_cmp)
    assert_equal true, p_equal["price_varies"]
    assert_equal 2000, p_equal["compare_at_price"]
    assert_equal false, p_equal["compare_at_price_varies"]

    # Mixed nil, explicit 0, and positive compare_at_price retains 0 and varies=true
    mixed_all = make_fixture([
      { "id" => "m1", "price" => 1000, "compare_at_price" => nil, "available" => false },
      { "id" => "m2", "price" => 1000, "compare_at_price" => 0, "available" => false },
      { "id" => "m3", "price" => 1000, "compare_at_price" => 1500, "available" => true },
    ])
    p_mixed = LiquidReference::Projection.project(mixed_all)
    assert_equal 0, p_mixed["compare_at_price"]
    assert_equal 0, p_mixed["compare_at_price_min"]
    assert_equal 1500, p_mixed["compare_at_price_max"]
    assert_equal true, p_mixed["compare_at_price_varies"]
    assert_equal true, p_mixed["available"]

    # Single variant never varies
    single = make_fixture([{ "id" => "only", "price" => 500, "compare_at_price" => 0, "available" => false }])
    p_single = LiquidReference::Projection.project(single)
    assert_equal false, p_single["price_varies"]
    assert_equal false, p_single["compare_at_price_varies"]
    assert_equal 0, p_single["compare_at_price"]
    assert_equal false, p_single["available"]
  end

  def test_variant_order_explicit_nils_and_deep_copy_isolation
    fixture = make_fixture([
      { "id" => +"first", "price" => 3000, "compare_at_price" => nil, "available" => false },
      { "id" => +"second", "price" => 1500, "compare_at_price" => 2000, "available" => true },
    ])

    projected = LiquidReference::Projection.project_for_render(fixture)
    copy_a = projected.fresh_assigns
    copy_b = projected.fresh_assigns

    assert_equal %w[first second], copy_a["product"]["variants"].map { |v| v["id"] }
    assert copy_a["product"]["variants"][0].key?("compare_at_price")
    assert_nil copy_a["product"]["variants"][0]["compare_at_price"]

    # Mutate input fixture and copy_a aggressively; copy_b and projection must be unaffected
    fixture["variants"][0]["price"] = 999
    fixture["variants"][0]["id"] << "_mutated"
    copy_a["product"]["price"] = 1
    copy_a["product"]["variants"][0]["id"] << "_hacked"
    copy_a["product"]["variants"].clear

    assert_equal 1500, projected.projection["price"]
    assert_equal 1500, copy_b["product"]["price"]
    assert_equal 2, copy_b["product"]["variants"].size
    assert_equal "first", copy_b["product"]["variants"][0]["id"]
    assert_equal 3000, copy_b["product"]["variants"][0]["price"]
  end

  def test_fixture_validator_rejects_duplicate_ids_floats_extra_keys_and_bounds
    dup_ids = make_fixture([
      { "id" => "dup", "price" => 100, "compare_at_price" => nil, "available" => true },
      { "id" => "dup", "price" => 200, "compare_at_price" => 300, "available" => false },
    ])
    err = assert_raises(LiquidReference::FixtureValidator::ValidationError) do
      LiquidReference::FixtureValidator.validate!(dup_ids)
    end
    assert_equal "duplicate_variant_id", err.code

    invalid_cases = [
      "not a hash",
      make_fixture([{ "id" => "v1", "price" => 19.99, "compare_at_price" => nil, "available" => true }]),
      make_fixture([{ "id" => "v1", "price" => "1999", "compare_at_price" => nil, "available" => true }]),
      make_fixture([{ "id" => "v1", "price" => true, "compare_at_price" => nil, "available" => true }]),
      make_fixture([{ "id" => "v1", "price" => 100, "compare_at_price" => 15.5, "available" => true }]),
      make_fixture([{ "id" => "v1", "price" => -1, "compare_at_price" => nil, "available" => true }]),
      make_fixture([{ "id" => "v1", "price" => 10_000_001, "compare_at_price" => nil, "available" => true }]),
      make_fixture([{ "id" => "v1", "price" => 100, "compare_at_price" => -1, "available" => true }]),
      make_fixture([{ "id" => "v1", "price" => 100, "compare_at_price" => 10_000_001, "available" => true }]),
      make_fixture([{ "id" => "v1", "price" => 100, "compare_at_price" => nil, "available" => "true" }]),
      make_fixture([{ "id" => "", "price" => 100, "compare_at_price" => nil, "available" => true }]),
      make_fixture([{ "id" => "x" * 33, "price" => 100, "compare_at_price" => nil, "available" => true }]),
      make_fixture([{ "id" => "v1", "price" => 100, "compare_at_price" => nil, "available" => true, "title" => "extra" }]),
      make_fixture([]),
      make_fixture((1..9).map { |i| { "id" => "v#{i}", "price" => 100, "compare_at_price" => nil, "available" => true } }),
      make_fixture([{ "id" => "v1", "price" => 100, "compare_at_price" => nil, "available" => true }]).merge("extra" => 1),
      make_fixture([{ "id" => "v1", "price" => 100, "compare_at_price" => nil, "available" => true }]).merge(symbol_key: 1),
      make_fixture([{ "id" => "v1", "price" => 100, "compare_at_price" => nil }]),
      make_fixture([{ "id" => "bad\xFF".b, "price" => 100, "compare_at_price" => nil, "available" => true }]),
      { "schema_version" => 2, "currency" => "USD", "variants" => [{ "id" => "v1", "price" => 100, "compare_at_price" => nil, "available" => true }] },
      { "schema_version" => 1, "currency" => "CAD", "variants" => [{ "id" => "v1", "price" => 100, "compare_at_price" => nil, "available" => true }] },
    ]

    invalid_cases.each do |bad|
      assert_raises(LiquidReference::FixtureValidator::ValidationError, "Expected rejection for #{bad.inspect}") do
        LiquidReference::FixtureValidator.validate!(bad)
      end
    end

    # Boundary valid cases: 1 variant with 1-char id, 8 variants with 32-char ids
    min_valid = make_fixture([{ "id" => "a", "price" => 0, "compare_at_price" => 0, "available" => false }])
    assert_empty @fixture_schema.validate(min_valid).to_a
    assert LiquidReference::Projection.project_for_render(min_valid)

    max_valid = make_fixture((1..8).map do |i|
      { "id" => format("v%031d", i), "price" => 10_000_000, "compare_at_price" => 10_000_000, "available" => true }
    end)
    assert_empty @fixture_schema.validate(max_valid).to_a
    assert LiquidReference::Projection.project_for_render(max_valid)
  end

  def test_storefront_probe_matrix_and_ordinary_fixtures_are_valid
    matrix_path = File.join(REPO_ROOT, "fixtures/storefront_probe_matrix.json")
    matrix = JSON.parse(File.read(matrix_path, encoding: Encoding::UTF_8))

    assert_equal "1.0.0", matrix["projection_version"]
    assert_equal "storefront_unverified", matrix["status"]
    assert_nil matrix["storefront_date"]
    assert_nil matrix["currency_market"]
    assert_nil matrix["explicit_zero_retained"]

    expected_ids = %w[
      all_null
      null_plus_positive
      explicit_zero_plus_positive
      equal_numeric
      varied_numeric
      mixed_availability
    ]
    assert_equal expected_ids, matrix["cases"].map { |c| c["case_id"] }

    matrix["cases"].each do |entry|
      assert_nil entry["observed_storefront"], "Expected storefront_unverified placeholder nil for #{entry['case_id']}"
      assert_empty @fixture_schema.validate(entry["fixture"]).to_a
      assert_empty @projection_schema.validate(entry["local_projection"]).to_a
      projected = LiquidReference::Projection.project(entry["fixture"])
      assert_equal projected, entry["local_projection"], "Mismatch in probe matrix for #{entry['case_id']}"
    end

    %w[sale_product.json regular_product.json].each do |fname|
      fpath = File.join(REPO_ROOT, "fixtures/ordinary", fname)
      fixture = JSON.parse(File.read(fpath, encoding: Encoding::UTF_8))
      assert_empty @fixture_schema.validate(fixture).to_a
      LiquidReference::FixtureValidator.validate!(fixture)
    end
  end
end

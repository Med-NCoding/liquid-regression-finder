# frozen_string_literal: true

require "json"
require "json_schemer"
require "minitest/autorun"

class ContractSchemaTest < Minitest::Test
  SCHEMAS_DIR = File.expand_path("schemas", __dir__)
  EXAMPLES_DIR = File.expand_path("examples", __dir__)

  REQUIRED_SCHEMAS = %w[
    fixture
    trace_event
    render_result
    compare_request
    replay_bundle
    projection
    finding
    comparison_job
    jsonl_request
    jsonl_response
  ].freeze

  def setup
    @ref_resolver = lambda do |uri|
      path = File.join(SCHEMAS_DIR, File.basename(uri.path))
      JSON.parse(File.read(path, encoding: Encoding::UTF_8))
    end
  end

  def load_raw_schema(name)
    path = File.join(SCHEMAS_DIR, "#{name}.schema.json")
    assert File.exist?(path), "Missing schema file: #{path}"
    JSON.parse(File.read(path, encoding: Encoding::UTF_8))
  end

  def load_schemer(name)
    JSONSchemer.schema(load_raw_schema(name), ref_resolver: @ref_resolver)
  end

  def deep_dup(obj)
    JSON.parse(JSON.generate(obj))
  end

  def test_all_required_schemas_exist_and_are_valid_draft_2020_12
    meta = JSONSchemer.draft202012
    REQUIRED_SCHEMAS.each do |name|
      raw = load_raw_schema(name)
      assert_equal "https://json-schema.org/draft/2020-12/schema", raw["$schema"], "#{name} must declare Draft 2020-12"
      errors = meta.validate(raw).to_a
      assert_empty errors, "#{name}.schema.json failed meta-schema validation: #{errors.map { |e| e["error"] }}"
    end
  end

  def test_valid_examples_pass_and_reject_extra_top_level_keys
    REQUIRED_SCHEMAS.each do |name|
      schemer = load_schemer(name)
      valid_files = Dir[File.join(EXAMPLES_DIR, "valid", name, "*.json")].sort
      refute_empty valid_files, "Expected at least one valid example for #{name}"

      valid_files.each do |file|
        payload = JSON.parse(File.read(file, encoding: Encoding::UTF_8))
        errors = schemer.validate(payload).to_a
        assert_empty errors, "Valid example #{file} failed #{name}: #{errors.map { |e| e["error"] }}"

        mutated = deep_dup(payload)
        mutated["_unexpected_extra_key"] = true
        refute schemer.valid?(mutated), "Schema #{name} failed to reject extra key on #{File.basename(file)}"
      end
    end
  end

  def test_invalid_examples_fail
    REQUIRED_SCHEMAS.each do |name|
      schemer = load_schemer(name)
      invalid_files = Dir[File.join(EXAMPLES_DIR, "invalid", name, "*.json")].sort
      refute_empty invalid_files, "Expected at least one invalid example for #{name}"

      invalid_files.each do |file|
        payload = JSON.parse(File.read(file, encoding: Encoding::UTF_8))
        refute schemer.valid?(payload), "Invalid example #{file} unexpectedly passed #{name}"
      end
    end
  end

  def test_fixture_boundaries_and_nested_extra_keys
    schemer = load_schemer("fixture")
    base = JSON.parse(File.read(File.join(EXAMPLES_DIR, "valid/fixture/two_variants.json"), encoding: Encoding::UTF_8))

    # Minimum and maximum boundary values
    boundary = deep_dup(base)
    boundary["variants"] = (1..8).map do |idx|
      {
        "id" => idx == 1 ? "a" : ("v" + ("x" * 31)),
        "price" => idx == 1 ? 0 : 10_000_000,
        "compare_at_price" => idx == 1 ? 0 : 10_000_000,
        "available" => idx.even?
      }
    end
    # Ensure distinct IDs across 8 variants
    boundary["variants"].each_with_index { |v, i| v["id"] = i == 0 ? "a" : format("v%031d", i) }
    assert schemer.valid?(boundary), "Expected 8-variant boundary fixture to pass"

    # 9 variants rejected
    too_many = deep_dup(boundary)
    too_many["variants"] << { "id" => "v9", "price" => 100, "compare_at_price" => nil, "available" => true }
    refute schemer.valid?(too_many)

    # Price out of bounds
    over_price = deep_dup(base)
    over_price["variants"][0]["price"] = 10_000_001
    refute schemer.valid?(over_price)

    # Empty or >32 char ID rejected
    bad_id = deep_dup(base)
    bad_id["variants"][0]["id"] = ""
    refute schemer.valid?(bad_id)
    bad_id["variants"][0]["id"] = "x" * 33
    refute schemer.valid?(bad_id)

    # Extra key on nested variant rejected
    extra_nested = deep_dup(base)
    extra_nested["variants"][0]["title"] = "Default"
    refute schemer.valid?(extra_nested)
  end

  def test_compare_request_boundaries
    schemer = load_schemer("compare_request")
    base = JSON.parse(File.read(File.join(EXAMPLES_DIR, "valid/compare_request/basic.json"), encoding: Encoding::UTF_8))

    min_valid = deep_dup(base)
    min_valid["seed"] = 0
    min_valid["budget"] = { "search_pairs" => 1, "shrink_pairs" => 0 }
    assert schemer.valid?(min_valid)

    max_valid = deep_dup(base)
    max_valid["seed"] = 4_294_967_295
    max_valid["budget"] = { "search_pairs" => 5000, "shrink_pairs" => 1000 }
    assert schemer.valid?(max_valid)

    bad_seed = deep_dup(base)
    bad_seed["seed"] = 4_294_967_296
    refute schemer.valid?(bad_seed)

    bad_shrink = deep_dup(base)
    bad_shrink["budget"]["shrink_pairs"] = 1001
    refute schemer.valid?(bad_shrink)

    extra_snippet_key = deep_dup(base)
    extra_snippet_key["before"]["path"] = "card.liquid"
    refute schemer.valid?(extra_snippet_key)
  end

  def test_comparison_job_state_invariants
    schemer = load_schemer("comparison_job")
    queued = JSON.parse(File.read(File.join(EXAMPLES_DIR, "valid/comparison_job/queued.json"), encoding: Encoding::UTF_8))

    running = deep_dup(queued)
    running["status"] = "running"
    assert schemer.valid?(running)

    no_diff = deep_dup(queued)
    no_diff["status"] = "no_difference_found"
    no_diff["stats"] = {
      "search_pairs" => 256,
      "shrink_pairs" => 0,
      "parity_rejections" => 0,
      "exhausted_by" => "pair_limit",
      "first_difference_ms" => nil,
      "elapsed_ms" => 140
    }
    no_diff["completed_at"] = "2026-11-17T03:00:02Z"
    assert schemer.valid?(no_diff)

    # no_difference_found must have non-null stats and completed_at
    bad_no_diff = deep_dup(no_diff)
    bad_no_diff["stats"] = nil
    refute schemer.valid?(bad_no_diff)

    # failed job allows null stats (partial or absent)
    failed = JSON.parse(File.read(File.join(EXAMPLES_DIR, "valid/comparison_job/failed.json"), encoding: Encoding::UTF_8))
    failed["stats"] = nil
    assert schemer.valid?(failed)
  end
end

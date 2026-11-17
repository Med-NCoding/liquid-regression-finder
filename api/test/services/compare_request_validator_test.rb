# frozen_string_literal: true

require "test_helper"

class CompareRequestValidatorTest < ActiveSupport::TestCase
  test "accepts valid request including exact 16 KiB boundary and preserves whitespace" do
    exact_16k = "a" * 16_384
    raw = JSON.generate(valid_compare_request(
      before_source: exact_16k,
      after_source: "  line1\r\nline2\u00a0 ",
      seed: 4_294_967_295,
      search_pairs: 5_000,
      shrink_pairs: 1_000
    ))

    parsed = CompareRequestValidator.parse_and_validate!(raw)
    assert_equal exact_16k, parsed.dig("before", "source")
    assert_equal "  line1\r\nline2\u00a0 ", parsed.dig("after", "source")
  end

  test "rejects malformed json, non-utf8, and non-object roots" do
    err = assert_raises(CompareRequestValidator::ValidationError) do
      CompareRequestValidator.parse_and_validate!("{bad json")
    end
    assert_equal "invalid_json", err.code

    err_empty = assert_raises(CompareRequestValidator::ValidationError) do
      CompareRequestValidator.parse_and_validate!("   ")
    end
    assert_equal "invalid_json", err_empty.code

    err_utf8 = assert_raises(CompareRequestValidator::ValidationError) do
      CompareRequestValidator.parse_and_validate!("\xff\xfe".dup.force_encoding(Encoding::BINARY))
    end
    assert_equal "invalid_utf8", err_utf8.code

    err_arr = assert_raises(CompareRequestValidator::ValidationError) do
      CompareRequestValidator.parse_and_validate!("[1, 2, 3]")
    end
    assert_equal "invalid_request", err_arr.code
  end

  test "rejects arbitrary filesystem path keys and extra keys" do
    %w[path file before_path after_path].each do |key|
      top = valid_compare_request.merge(key => "/etc/passwd")
      err = assert_raises(CompareRequestValidator::ValidationError) do
        CompareRequestValidator.parse_and_validate!(JSON.generate(top))
      end
      assert_equal "invalid_request", err.code

      nested = valid_compare_request
      nested["before"][key] = "fixtures/demo/before.liquid"
      err_nested = assert_raises(CompareRequestValidator::ValidationError) do
        CompareRequestValidator.parse_and_validate!(JSON.generate(nested))
      end
      assert_equal "invalid_request", err_nested.code
    end

    extra = valid_compare_request.merge("extra" => true)
    assert_raises(CompareRequestValidator::ValidationError) do
      CompareRequestValidator.parse_and_validate!(JSON.generate(extra))
    end
  end

  test "rejects oversized snippet, unsupported observer, bad types, and out-of-range bounds" do
    oversized = valid_compare_request(before_source: "x" * 16_385)
    err_size = assert_raises(CompareRequestValidator::ValidationError) do
      CompareRequestValidator.parse_and_validate!(JSON.generate(oversized))
    end
    assert_equal "snippet_too_large", err_size.code

    bad_obs = valid_compare_request(observer: "sold_out_badge")
    err_obs = assert_raises(CompareRequestValidator::ValidationError) do
      CompareRequestValidator.parse_and_validate!(JSON.generate(bad_obs))
    end
    assert_equal "unsupported_observer", err_obs.code

    [
      valid_compare_request.merge("schema_version" => 2),
      valid_compare_request.merge("schema_version" => "1"),
      valid_compare_request(seed: -1),
      valid_compare_request(seed: 4_294_967_296),
      valid_compare_request(seed: 1.5),
      valid_compare_request(search_pairs: 0),
      valid_compare_request(search_pairs: 5_001),
      valid_compare_request(shrink_pairs: -1),
      valid_compare_request(shrink_pairs: 1_001),
      valid_compare_request.tap { |r| r["budget"]["extra"] = 1 }
    ].each do |invalid_req|
      err = assert_raises(CompareRequestValidator::ValidationError) do
        CompareRequestValidator.parse_and_validate!(JSON.generate(invalid_req))
      end
      assert_equal "invalid_request", err.code
    end
  end
end

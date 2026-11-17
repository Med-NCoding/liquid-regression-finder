# frozen_string_literal: true

require "stringio"
require "test_helper"

class Api::V1::ComparisonsControllerTest < ActionDispatch::IntegrationTest
  include ActiveJob::TestHelper

  def post_raw(body, headers: {})
    post api_v1_comparisons_path,
         params: body,
         headers: { "CONTENT_TYPE" => "application/json" }.merge(headers)
  end

  def with_api_token(token)
    old = ENV["LIQUID_REGRESSION_API_TOKEN"]
    if token.nil?
      ENV.delete("LIQUID_REGRESSION_API_TOKEN")
    else
      ENV["LIQUID_REGRESSION_API_TOKEN"] = token
    end
    yield
  ensure
    if old.nil?
      ENV.delete("LIQUID_REGRESSION_API_TOKEN")
    else
      ENV["LIQUID_REGRESSION_API_TOKEN"] = old
    end
  end

  test "health endpoint returns 200 ok" do
    get api_v1_health_path
    assert_response :ok
    assert_equal({ "status" => "ok" }, JSON.parse(response.body))
  end

  test "POST creates queued comparison and GET returns schema-valid ComparisonJob or 404" do
    payload = valid_compare_request
    assert_enqueued_with(job: ComparisonRunJob) do
      post_raw(JSON.generate(payload))
    end

    assert_response :accepted
    body = JSON.parse(response.body)
    assert_valid_schema("comparison_job", body)
    assert_equal "queued", body["status"]
    assert_equal "/comparisons/#{body['id']}", body["result_url"]
    assert_equal "/api/v1/comparisons/#{body['id']}", response.headers["Location"]
    assert_nil body["finding"]
    assert_nil body["stats"]
    assert_nil body["error"]
    assert_nil body["completed_at"]

    get api_v1_comparison_path(body["id"])
    assert_response :ok
    fetched = JSON.parse(response.body)
    assert_equal body, fetched

    get api_v1_comparison_path("00000000-0000-0000-0000-000000000000")
    assert_response :not_found
    err = JSON.parse(response.body)
    assert_equal "not_found", err.dig("error", "code")
    assert_valid_diagnostic(err["error"])
  end

  test "POST validates strict JSON, filesystem path rejection, size, observer, seed, and budget" do
    post_raw("{malformed json")
    assert_response 422
    err = JSON.parse(response.body)
    assert_equal "invalid_json", err.dig("error", "code")
    assert_valid_diagnostic(err["error"])

    invalid_payloads = [
      [ valid_compare_request.merge("extra" => 1), "invalid_request" ],
      [ valid_compare_request.merge("before_path" => "fixtures/demo/before.liquid"), "invalid_request" ],
      [ valid_compare_request.tap { |r| r["before"]["path"] = "fixtures/demo/before.liquid" }, "invalid_request" ],
      [ valid_compare_request.tap { |r| r["after"]["file"] = "fixtures/demo/after.liquid" }, "invalid_request" ],
      [ valid_compare_request(before_source: "a" * 16_385), "snippet_too_large" ],
      [ valid_compare_request(observer: "price_range"), "unsupported_observer" ],
      [ valid_compare_request(seed: 4_294_967_296), "invalid_request" ],
      [ valid_compare_request(search_pairs: 0), "invalid_request" ],
      [ valid_compare_request(search_pairs: 5_001), "invalid_request" ],
      [ valid_compare_request(shrink_pairs: -1), "invalid_request" ],
      [ valid_compare_request(shrink_pairs: 1_001), "invalid_request" ]
    ]

    invalid_payloads.each do |req, expected_code|
      post_raw(JSON.generate(req))
      assert_response 422, "Expected 422 for #{expected_code}"
      parsed = JSON.parse(response.body)
      assert_equal expected_code, parsed.dig("error", "code")
      assert_valid_diagnostic(parsed["error"])
    end
  end

  test "Idempotency-Key rejects empty header, reuses same digest across 202/200, and returns 409 on whitespace diff" do
    post_raw(JSON.generate(valid_compare_request), headers: { "Idempotency-Key" => "" })
    assert_response 422
    assert_equal "invalid_idempotency_key", JSON.parse(response.body).dig("error", "code")

    post_raw(JSON.generate(valid_compare_request), headers: { "Idempotency-Key" => "   " })
    assert_response 422
    assert_equal "invalid_idempotency_key", JSON.parse(response.body).dig("error", "code")

    req1 = valid_compare_request(before_source: "{{ product.price }}", after_source: "ok")
    post_raw(JSON.generate(req1), headers: { "Idempotency-Key" => "pr-123-sha" })
    assert_response :accepted
    first = JSON.parse(response.body)
    assert_equal 1, enqueued_jobs.size

    # Same key + same digest while active -> 202 with same UUID, no duplicate enqueue
    post_raw(JSON.generate(req1), headers: { "Idempotency-Key" => "pr-123-sha" })
    assert_response :accepted
    second = JSON.parse(response.body)
    assert_equal first["id"], second["id"]
    assert_equal first["result_url"], second["result_url"]
    assert_equal 1, enqueued_jobs.size

    # Same key + whitespace-only difference in Liquid -> 409 Conflict
    req_ws = valid_compare_request(before_source: "{{  product.price }}", after_source: "ok")
    post_raw(JSON.generate(req_ws), headers: { "Idempotency-Key" => "pr-123-sha" })
    assert_response :conflict
    conflict = JSON.parse(response.body)
    assert_equal "idempotency_conflict", conflict.dig("error", "code")
    assert_valid_diagnostic(conflict["error"])

    # Transition to terminal -> same key + same digest returns 200 OK with terminal payload
    token = Comparison.claim_queued!(first["id"])
    Comparison.complete_with_token!(
      id: first["id"],
      attempt_token: token,
      status: "no_difference_found",
      stats: {
        "search_pairs" => 8,
        "shrink_pairs" => 0,
        "parity_rejections" => 0,
        "exhausted_by" => "pair_limit",
        "first_difference_ms" => nil,
        "elapsed_ms" => 11
      }
    )

    post_raw(JSON.generate(req1), headers: { "Idempotency-Key" => "pr-123-sha" })
    assert_response :ok
    third = JSON.parse(response.body)
    assert_equal first["id"], third["id"]
    assert_equal "no_difference_found", third["status"]
    assert_valid_schema("comparison_job", third)
  end

  test "recovers cleanly from SQLite RecordNotUnique race on concurrent idempotent submission" do
    req = valid_compare_request(before_source: "a", after_source: "b")
    existing = Comparison.create_queued!(validated_request: req, idempotency_key: "race-key")

    original_create = Comparison.method(:create_queued!)
    Comparison.define_singleton_method(:create_queued!) do |**kwargs|
      raise ActiveRecord::RecordNotUnique, "UNIQUE constraint failed: comparisons.idempotency_key"
    end

    begin
      # Simulate race where find_by missed before insert: stub find_by to return nil once, then real
      calls = 0
      original_find_by = Comparison.method(:find_by)
      Comparison.define_singleton_method(:find_by) do |*args, **kwargs|
        calls += 1
        return nil if calls == 1 && kwargs[:idempotency_key] == "race-key"

        original_find_by.call(*args, **kwargs)
      end

      post_raw(JSON.generate(req), headers: { "Idempotency-Key" => "race-key" })
      assert_response :accepted
      assert_equal existing.id, JSON.parse(response.body)["id"]
    ensure
      Comparison.define_singleton_method(:find_by, original_find_by) if original_find_by
      Comparison.define_singleton_method(:create_queued!, original_create)
    end
  end

  test "scoped bearer token protects POST comparisons when LIQUID_REGRESSION_API_TOKEN is set" do
    req_json = JSON.generate(valid_compare_request)

    with_api_token("scoped-secret-token") do
      post_raw(req_json)
      assert_response :unauthorized
      unauth = JSON.parse(response.body)
      assert_equal "unauthorized", unauth.dig("error", "code")
      assert_valid_diagnostic(unauth["error"])

      post_raw(req_json, headers: { "Authorization" => "Bearer wrong-token" })
      assert_response :unauthorized

      post_raw(req_json, headers: { "Authorization" => "Bearer scoped-secret-token" })
      assert_response :accepted
      created_id = JSON.parse(response.body)["id"]

      # GET endpoints remain readable for UI result links without the CI token
      get api_v1_comparison_path(created_id)
      assert_response :ok
      get api_v1_health_path
      assert_response :ok
    end
  end

  test "redacts snippet source, fixture, and html from Rails server and SQL logs" do
    secret_before = "SECRET_BEFORE_SOURCE_XYZ"
    secret_after = "SECRET_AFTER_SOURCE_XYZ"
    secret_variant = "SECRET_FIXTURE_VARIANT_XYZ"
    secret_html = "<span>SECRET_RENDERED_HTML_XYZ</span>"

    io = StringIO.new
    captured_logger = ActiveSupport::Logger.new(io)
    captured_logger.level = Logger::DEBUG

    old_rails_logger = Rails.logger
    old_ar_logger = ActiveRecord::Base.logger
    old_ac_logger = ActionController::Base.logger
    old_aj_logger = ActiveJob::Base.logger

    begin
      Rails.logger = captured_logger
      ActiveRecord::Base.logger = captured_logger
      ActionController::Base.logger = captured_logger
      ActiveJob::Base.logger = captured_logger

      req = valid_compare_request(before_source: secret_before, after_source: secret_after)
      post_raw(JSON.generate(req))
      assert_response :accepted
      comp_id = JSON.parse(response.body)["id"]

      # Also test malformed JSON log redaction
      post_raw("{\"before\":{\"source\":\"SECRET_MALFORMED_XYZ\"")
      assert_response 422

      # Simulate terminal write containing fixture and html
      token = Comparison.claim_queued!(comp_id)
      Comparison.complete_with_token!(
        id: comp_id,
        attempt_token: token,
        status: "difference_found",
        finding: {
          "product" => {
            "price" => 100, "price_min" => 100, "price_max" => 100, "price_varies" => false,
            "compare_at_price" => 200, "compare_at_price_min" => 200, "compare_at_price_max" => 200,
            "compare_at_price_varies" => false, "available" => true
          },
          "replay" => {
            "request" => req,
            "fixture" => {
              "schema_version" => 1,
              "currency" => "USD",
              "variants" => [ { "id" => secret_variant, "price" => 100, "compare_at_price" => 200, "available" => true } ]
            },
            "before_sha256" => "0" * 64,
            "after_sha256" => "1" * 64,
            "interpreter_version" => "0.1.0",
            "liquid_version" => "5.14.0",
            "projection_version" => "1.0.0"
          },
          "before" => { "status" => "ok", "html" => secret_html, "observed" => true, "events" => [], "error" => nil },
          "after" => { "status" => "ok", "html" => "", "observed" => false, "events" => [], "error" => nil },
          "reference" => {
            "before" => { "status" => "ok", "html" => secret_html, "observed" => true, "events" => [], "error" => nil },
            "after" => { "status" => "ok", "html" => "", "observed" => false, "events" => [], "error" => nil }
          },
          "explanation" => { "kind" => "undetermined", "before" => nil, "after" => nil, "summary" => "summary" }
        },
        stats: {
          "search_pairs" => 1, "shrink_pairs" => 0, "parity_rejections" => 0,
          "exhausted_by" => nil, "first_difference_ms" => 1, "elapsed_ms" => 2
        }
      )

      inspected = Comparison.find(comp_id).inspect
      log_text = io.string

      [ secret_before, secret_after, secret_variant, secret_html, "SECRET_MALFORMED_XYZ" ].each do |secret|
        refute_includes log_text, secret, "Rails log output leaked sensitive value #{secret}"
        refute_includes inspected, secret, "Comparison#inspect leaked sensitive value #{secret}"
      end
      assert_includes log_text, "[FILTERED]"
    ensure
      Rails.logger = old_rails_logger
      ActiveRecord::Base.logger = old_ar_logger
      ActionController::Base.logger = old_ac_logger
      ActiveJob::Base.logger = old_aj_logger
    end
  end
end

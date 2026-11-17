# frozen_string_literal: true

require "test_helper"

class ComparisonTest < ActiveSupport::TestCase
  test "create_queued persists UUID, schema_version, and whitespace-sensitive SHA-256 digest" do
    req1 = valid_compare_request(before_source: "{{ product.price }}", after_source: "<span>Sale</span>")
    req2 = valid_compare_request(before_source: "{{  product.price }}", after_source: "<span>Sale</span>")
    req3 = valid_compare_request(before_source: "{{ product.price }}\n", after_source: "<span>Sale</span>")

    d1 = Comparison.compute_request_digest(req1)
    d2 = Comparison.compute_request_digest(req2)
    d3 = Comparison.compute_request_digest(req3)

    assert_equal 64, d1.length
    assert_match(/\A[0-9a-f]{64}\z/, d1)
    refute_equal d1, d2, "Digest must NOT normalize internal spaces in source"
    refute_equal d1, d3, "Digest must NOT strip trailing newlines in source"

    comp = Comparison.create_queued!(validated_request: req1, idempotency_key: "key-1")
    assert_match(/\A[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\z/i, comp.id)
    assert_equal 1, comp.schema_version
    assert_equal "queued", comp.status
    assert_equal d1, comp.request_digest
    assert_equal 0, comp.attempts
    assert_nil comp.completed_at

    job_payload = comp.as_comparison_job
    assert_valid_schema("comparison_job", job_payload)
    assert_equal "/comparisons/#{comp.id}", job_payload["result_url"]
    assert_nil job_payload["finding"]
    assert_nil job_payload["stats"]
    assert_nil job_payload["error"]
    assert_nil job_payload["completed_at"]
  end

  test "partial unique index allows multiple NULL idempotency keys but rejects duplicate non-NULL keys" do
    req = valid_compare_request(before_source: "a", after_source: "b")
    c1 = Comparison.create_queued!(validated_request: req, idempotency_key: nil)
    c2 = Comparison.create_queued!(validated_request: req, idempotency_key: nil)
    refute_equal c1.id, c2.id

    Comparison.create_queued!(validated_request: req, idempotency_key: "unique-key")
    assert_raises(ActiveRecord::RecordNotUnique) do
      Comparison.create_queued!(validated_request: req, idempotency_key: "unique-key")
    end
  end

  test "claim_queued and guarded complete_with_token reject stale attempt tokens" do
    comp = Comparison.create_queued!(validated_request: valid_compare_request)

    token_1 = Comparison.claim_queued!(comp.id, lease_duration: 110.seconds)
    assert_not_nil token_1
    assert_nil Comparison.claim_queued!(comp.id), "Duplicate claim while running must return nil"

    comp.reload
    assert_equal "running", comp.status
    assert_equal 1, comp.attempts
    assert_equal token_1, comp.attempt_token
    assert_operator comp.lease_expires_at, :>, 100.seconds.from_now

    # Simulate lease expiration recovery + second worker claiming with token_2
    assert Comparison.release_for_retry_with_token!(id: comp.id, attempt_token: token_1)
    token_2 = Comparison.claim_queued!(comp.id, lease_duration: 110.seconds)
    refute_equal token_1, token_2

    # Stale worker 1 attempts write with token_1 -> MUST BE REJECTED
    stale_ok = Comparison.complete_with_token!(
      id: comp.id,
      attempt_token: token_1,
      status: "no_difference_found",
      stats: {
        "search_pairs" => 1,
        "shrink_pairs" => 0,
        "parity_rejections" => 0,
        "exhausted_by" => "pair_limit",
        "first_difference_ms" => nil,
        "elapsed_ms" => 10
      }
    )
    assert_equal false, stale_ok
    refute Comparison.release_for_retry_with_token!(id: comp.id, attempt_token: token_1)

    comp.reload
    assert_equal "running", comp.status
    assert_equal 2, comp.attempts
    assert_equal token_2, comp.attempt_token

    # Active worker 2 completes cleanly with token_2
    stats = {
      "search_pairs" => 16,
      "shrink_pairs" => 0,
      "parity_rejections" => 0,
      "exhausted_by" => "pair_limit",
      "first_difference_ms" => nil,
      "elapsed_ms" => 42
    }
    assert Comparison.complete_with_token!(
      id: comp.id,
      attempt_token: token_2,
      status: "no_difference_found",
      stats: stats
    )

    # Even token_2 cannot overwrite once terminal
    refute Comparison.complete_with_token!(
      id: comp.id,
      attempt_token: token_2,
      status: "failed",
      error: { "code" => "late", "message" => "late write", "span" => nil }
    )

    comp.reload
    assert_equal "no_difference_found", comp.status
    assert_nil comp.attempt_token
    assert_nil comp.lease_expires_at
    assert_not_nil comp.completed_at
    assert_valid_schema("comparison_job", comp.as_comparison_job)
  end

  test "persistence survives connection pool reset and reload" do
    req = valid_compare_request(before_source: "a", after_source: "a")
    comp = Comparison.create_queued!(validated_request: req, idempotency_key: "persist-1")
    token = Comparison.claim_queued!(comp.id)
    Comparison.complete_with_token!(
      id: comp.id,
      attempt_token: token,
      status: "no_difference_found",
      stats: {
        "search_pairs" => 10,
        "shrink_pairs" => 0,
        "parity_rejections" => 0,
        "exhausted_by" => "pair_limit",
        "first_difference_ms" => nil,
        "elapsed_ms" => 15
      }
    )

    expected_job = comp.reload.as_comparison_job
    ActiveRecord::Base.connection_handler.clear_all_connections!

    reloaded = Comparison.find(comp.id)
    assert_equal expected_job, reloaded.as_comparison_job
    assert_valid_schema("comparison_job", reloaded.as_comparison_job)
  end
end

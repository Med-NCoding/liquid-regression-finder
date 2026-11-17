# frozen_string_literal: true

require "test_helper"

class ComparisonReconcilerTest < ActiveSupport::TestCase
  include ActiveJob::TestHelper

  test "re-enqueues missed stale queued rows while leaving fresh queued rows alone" do
    stale = Comparison.create_queued!(validated_request: valid_compare_request)
    stale.update_columns(created_at: 10.seconds.ago)

    fresh = Comparison.create_queued!(validated_request: valid_compare_request)
    fresh.update_columns(created_at: 1.second.ago)

    summary = ComparisonReconciler.reconcile!(queued_grace_period: 5.seconds)
    assert_equal 1, summary[:requeued_queued]
    assert_equal 0, summary[:requeued_expired]
    assert_equal 0, summary[:failed_expired]

    assert_equal 1, enqueued_jobs.size
    assert_equal [ stale.id ], enqueued_jobs.first[:args]
  end

  test "recovers expired running claim once when attempts < 2" do
    comp = Comparison.create_queued!(validated_request: valid_compare_request)
    token = Comparison.claim_queued!(comp.id)
    comp.update_columns(lease_expires_at: 1.second.ago)

    summary = ComparisonReconciler.reconcile!
    assert_equal 1, summary[:requeued_expired]
    assert_equal 0, summary[:failed_expired]

    comp.reload
    assert_equal "queued", comp.status
    assert_equal 1, comp.attempts
    assert_nil comp.attempt_token
    assert_nil comp.lease_expires_at
    assert_equal 1, enqueued_jobs.size
    assert_equal [ comp.id ], enqueued_jobs.first[:args]
    refute_equal token, comp.attempt_token
  end

  test "marks expired running claim terminal failed with lease_expired when attempts >= 2" do
    comp = Comparison.create_queued!(validated_request: valid_compare_request)
    t1 = Comparison.claim_queued!(comp.id)
    assert Comparison.release_for_retry_with_token!(id: comp.id, attempt_token: t1)
    t2 = Comparison.claim_queued!(comp.id)
    assert_not_nil t2
    comp.update_columns(lease_expires_at: 1.second.ago)

    summary = ComparisonReconciler.reconcile!
    assert_equal 0, summary[:requeued_expired]
    assert_equal 1, summary[:failed_expired]
    assert_equal 0, enqueued_jobs.size

    comp.reload
    assert_equal "failed", comp.status
    assert_equal 2, comp.attempts
    assert_nil comp.attempt_token
    assert_nil comp.lease_expires_at
    assert_not_nil comp.completed_at
    assert_equal "lease_expired", comp.parsed_error["code"]
    assert_valid_schema("comparison_job", comp.as_comparison_job)
  end

  test "leaves non-expired running leases untouched" do
    comp = Comparison.create_queued!(validated_request: valid_compare_request)
    token = Comparison.claim_queued!(comp.id, lease_duration: 110.seconds)

    summary = ComparisonReconciler.reconcile!
    assert_equal({ requeued_queued: 0, requeued_expired: 0, failed_expired: 0 }, summary)
    assert_equal 0, enqueued_jobs.size

    comp.reload
    assert_equal "running", comp.status
    assert_equal token, comp.attempt_token
  end
end

# frozen_string_literal: true

require "test_helper"

class ComparisonRunJobTest < ActiveSupport::TestCase
  include ActiveJob::TestHelper

  class FakeRunner
    def initialize(outcomes)
      @outcomes = outcomes.dup
      @calls = 0
    end

    attr_reader :calls

    def run(_request)
      @calls += 1
      entry = @outcomes.shift || raise("Unexpected extra FakeRunner call ##{@calls}")
      entry.is_a?(Proc) ? entry.call : entry
    end
  end

  def sample_stats(search_pairs: 8, elapsed_ms: 12)
    {
      "search_pairs" => search_pairs,
      "shrink_pairs" => 0,
      "parity_rejections" => 0,
      "exhausted_by" => "pair_limit",
      "first_difference_ms" => nil,
      "elapsed_ms" => elapsed_ms
    }
  end

  test "duplicate job delivery skips cleanly without executing runner twice" do
    comp = Comparison.create_queued!(validated_request: valid_compare_request(before_source: "a", after_source: "a"))
    runner = FakeRunner.new([
      ComparisonRunner::Result.new(outcome: :no_difference_found, stats: sample_stats)
    ])

    ComparisonRunJob.perform_now(comp.id, runner: runner)
    ComparisonRunJob.perform_now(comp.id, runner: runner)

    assert_equal 1, runner.calls
    comp.reload
    assert_equal "no_difference_found", comp.status
    assert_equal 1, comp.attempts
    assert_valid_schema("comparison_job", comp.as_comparison_job)
  end

  test "terminal engine, compile, and reference_mismatch errors fail immediately without retry" do
    [
      { "code" => "syntax_error", "message" => "Unknown tag 'bogus'", "span" => { "start_byte" => 0, "end_byte" => 11, "line" => 1, "column" => 1 } },
      { "code" => "reference_mismatch", "message" => "Reference disagreed", "span" => nil }
    ].each do |diag|
      comp = Comparison.create_queued!(validated_request: valid_compare_request)
      runner = FakeRunner.new([
        ComparisonRunner::Result.new(
          outcome: :terminal_failed,
          stats: sample_stats(search_pairs: 1, elapsed_ms: 5),
          error: diag
        )
      ])

      ComparisonRunJob.perform_now(comp.id, runner: runner)

      assert_equal 0, enqueued_jobs.size, "Terminal failure #{diag['code']} must not enqueue retry"
      comp.reload
      assert_equal "failed", comp.status
      assert_equal 1, comp.attempts
      assert_equal diag, comp.parsed_error
      assert_not_nil comp.completed_at
      assert_valid_schema("comparison_job", comp.as_comparison_job)
    end
  end

  test "infrastructure failure retries once then fails terminally on second failure" do
    comp = Comparison.create_queued!(validated_request: valid_compare_request)
    infra_error = { "code" => "runner_timeout", "message" => "Watchdog killed worker", "span" => nil }
    runner = FakeRunner.new([
      ComparisonRunner::Result.new(outcome: :infrastructure_failed, stats: nil, error: infra_error),
      ComparisonRunner::Result.new(outcome: :infrastructure_failed, stats: nil, error: infra_error)
    ])

    # Attempt 1: releases back to queued and enqueues retry once
    ComparisonRunJob.perform_now(comp.id, runner: runner)
    comp.reload
    assert_equal "queued", comp.status
    assert_equal 1, comp.attempts
    assert_nil comp.attempt_token
    assert_nil comp.lease_expires_at
    assert_nil comp.completed_at
    assert_equal 1, enqueued_jobs.size
    assert_equal [ comp.id ], enqueued_jobs.first[:args]

    # Attempt 2: second infrastructure failure transitions to terminal failed with no 3rd retry
    enqueued_jobs.clear
    ComparisonRunJob.perform_now(comp.id, runner: runner)
    comp.reload
    assert_equal 2, runner.calls
    assert_equal "failed", comp.status
    assert_equal 2, comp.attempts
    assert_equal infra_error, comp.parsed_error
    assert_not_nil comp.completed_at
    assert_equal 0, enqueued_jobs.size
    assert_valid_schema("comparison_job", comp.as_comparison_job)
  end

  test "infrastructure failure recovers when retry attempt succeeds" do
    comp = Comparison.create_queued!(validated_request: valid_compare_request)
    runner = FakeRunner.new([
      -> { raise IOError, "broken pipe" },
      ComparisonRunner::Result.new(outcome: :no_difference_found, stats: sample_stats)
    ])

    ComparisonRunJob.perform_now(comp.id, runner: runner)
    comp.reload
    assert_equal "queued", comp.status
    assert_equal 1, comp.attempts
    assert_equal 1, enqueued_jobs.size

    enqueued_jobs.clear
    ComparisonRunJob.perform_now(comp.id, runner: runner)
    comp.reload
    assert_equal "no_difference_found", comp.status
    assert_equal 2, comp.attempts
    assert_equal 0, enqueued_jobs.size
    assert_valid_schema("comparison_job", comp.as_comparison_job)
  end
end

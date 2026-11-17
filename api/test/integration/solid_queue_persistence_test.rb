# frozen_string_literal: true

require "test_helper"

class SolidQueuePersistenceTest < ActiveSupport::TestCase
  def with_solid_queue_adapter
    old_adapter = ComparisonRunJob.queue_adapter
    ComparisonRunJob.queue_adapter = :solid_queue
    yield
  ensure
    ComparisonRunJob.queue_adapter = old_adapter
  end

  test "enqueues ComparisonRunJob into SQLite Solid Queue tables and avoids duplicating pending jobs during reconciliation" do
    with_solid_queue_adapter do
      req = valid_compare_request(before_source: "SECRET_SQ_SOURCE", after_source: "ok")
      enqueued_comp = Comparison.create_queued!(validated_request: req)
      enqueued_comp.update_columns(created_at: 10.seconds.ago)

      ComparisonRunJob.perform_later(enqueued_comp.id)
      assert_equal 1, SolidQueue::Job.where(class_name: "ComparisonRunJob").count
      assert_equal 1, SolidQueue::ReadyExecution.count

      sq_job = SolidQueue::Job.where(class_name: "ComparisonRunJob").first
      assert_equal [ enqueued_comp.id ], sq_job.arguments["arguments"]
      refute_includes sq_job.arguments.to_json, "SECRET_SQ_SOURCE"

      # Also create a missed-enqueue stale queued row
      missed_comp = Comparison.create_queued!(validated_request: req)
      missed_comp.update_columns(created_at: 10.seconds.ago)

      summary = ComparisonReconciler.reconcile!(queued_grace_period: 5.seconds)
      assert_equal 1, summary[:requeued_queued], "Expected only missed_comp to be enqueued, not enqueued_comp"
      assert_equal 2, SolidQueue::Job.where(class_name: "ComparisonRunJob").count
      assert_equal 2, SolidQueue::ReadyExecution.count
    end
  end
end

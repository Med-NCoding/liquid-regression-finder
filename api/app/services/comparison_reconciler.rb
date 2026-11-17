# frozen_string_literal: true

require "json"
require "set"

class ComparisonReconciler
  DEFAULT_QUEUED_GRACE_PERIOD = 5.seconds

  def self.reconcile!(queued_grace_period: DEFAULT_QUEUED_GRACE_PERIOD, now: Time.current)
    new(queued_grace_period: queued_grace_period, now: now).reconcile!
  end

  def initialize(queued_grace_period: DEFAULT_QUEUED_GRACE_PERIOD, now: Time.current)
    @queued_grace_period = queued_grace_period
    @now = now
  end

  def reconcile!
    summary = {
      requeued_queued: 0,
      requeued_expired: 0,
      failed_expired: 0
    }

    reconcile_expired_running!(summary)
    reconcile_stale_queued!(summary)
    summary
  end

  private

  def reconcile_expired_running!(summary)
    Comparison.expired_running(@now).find_each do |comparison|
      token = comparison.attempt_token
      if comparison.attempts < 2
        requeued = Comparison.where(
          id: comparison.id,
          status: "running",
          attempt_token: token
        ).update_all(
          status: "queued",
          attempt_token: nil,
          lease_expires_at: nil
        )
        if requeued == 1
          ComparisonRunJob.perform_later(comparison.id)
          summary[:requeued_expired] += 1
        end
      else
        diag = {
          "code" => "lease_expired",
          "message" => "Comparison worker lease expired after #{comparison.attempts} attempts.",
          "span" => nil
        }
        failed = Comparison.where(
          id: comparison.id,
          status: "running",
          attempt_token: token
        ).update_all(
          status: "failed",
          error_json: JSON.generate(diag),
          attempt_token: nil,
          lease_expires_at: nil,
          completed_at: @now.utc
        )
        summary[:failed_expired] += 1 if failed == 1
      end
    end
  end

  def reconcile_stale_queued!(summary)
    cutoff = @now - @queued_grace_period
    pending_ids = active_solid_queue_comparison_ids

    Comparison.queued_before(cutoff).find_each do |comparison|
      next if pending_ids&.include?(comparison.id)

      ComparisonRunJob.perform_later(comparison.id)
      summary[:requeued_queued] += 1
    end
  end

  def active_solid_queue_comparison_ids
    return nil unless ComparisonRunJob.queue_adapter.is_a?(ActiveJob::QueueAdapters::SolidQueueAdapter)
    return nil unless defined?(SolidQueue::Job) && SolidQueue::Job.table_exists?

    failed_job_ids = SolidQueue::FailedExecution.select(:job_id)
    ids = Set.new
    SolidQueue::Job
      .where(class_name: "ComparisonRunJob", finished_at: nil)
      .where.not(id: failed_job_ids)
      .find_each do |job|
        args = job.arguments.is_a?(Hash) ? job.arguments : JSON.parse(job.arguments.to_s)
        arg_id = Array(args["arguments"]).first
        ids << arg_id if arg_id.is_a?(String)
      rescue JSON::ParserError
        next
      end
    ids
  end
end

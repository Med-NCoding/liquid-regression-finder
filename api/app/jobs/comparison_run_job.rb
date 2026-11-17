# frozen_string_literal: true

class ComparisonRunJob < ApplicationJob
  queue_as :default

  self.log_arguments = false

  LEASE_DURATION = 110.seconds

  def perform(comparison_id, runner: nil)
    attempt_token = Comparison.claim_queued!(comparison_id, lease_duration: LEASE_DURATION)
    return if attempt_token.nil?

    comparison = Comparison.find_by(id: comparison_id)
    return if comparison.nil?

    active_runner = runner || ComparisonRunner.new
    result = active_runner.run(comparison.parsed_request)

    case result.outcome
    when :difference_found
      Comparison.complete_with_token!(
        id: comparison.id,
        attempt_token: attempt_token,
        status: "difference_found",
        finding: result.finding,
        stats: result.stats
      )
    when :no_difference_found
      Comparison.complete_with_token!(
        id: comparison.id,
        attempt_token: attempt_token,
        status: "no_difference_found",
        stats: result.stats
      )
    when :terminal_failed
      Comparison.complete_with_token!(
        id: comparison.id,
        attempt_token: attempt_token,
        status: "failed",
        stats: result.stats,
        error: result.error
      )
    when :infrastructure_failed
      handle_infrastructure_failure(
        comparison: comparison,
        attempt_token: attempt_token,
        stats: result.stats,
        error: result.error
      )
    else
      handle_infrastructure_failure(
        comparison: comparison,
        attempt_token: attempt_token,
        stats: nil,
        error: {
          "code" => "internal_error",
          "message" => "Unexpected runner outcome #{result.outcome.inspect}",
          "span" => nil
        }
      )
    end
  rescue StandardError => e
    if comparison && attempt_token
      Rails.logger.error("[ComparisonRunJob] comparison=#{comparison_id} failed with #{e.class}")
      handle_infrastructure_failure(
        comparison: comparison,
        attempt_token: attempt_token,
        stats: nil,
        error: {
          "code" => "internal_error",
          "message" => "Comparison worker exception (#{e.class}): #{e.message}",
          "span" => nil
        }
      )
    else
      raise
    end
  end

  private

  def handle_infrastructure_failure(comparison:, attempt_token:, stats:, error:)
    if comparison.attempts < 2
      if Comparison.release_for_retry_with_token!(id: comparison.id, attempt_token: attempt_token)
        self.class.perform_later(comparison.id)
      end
    else
      Comparison.complete_with_token!(
        id: comparison.id,
        attempt_token: attempt_token,
        status: "failed",
        stats: stats,
        error: error
      )
    end
  end
end

# frozen_string_literal: true

require "digest"
require "json"
require "securerandom"

class Comparison < ApplicationRecord
  STATUSES = %w[queued running difference_found no_difference_found failed].freeze
  ACTIVE_STATUSES = %w[queued running].freeze
  TERMINAL_STATUSES = %w[difference_found no_difference_found failed].freeze
  SCHEMA_VERSION = 1

  self.primary_key = "id"
  self.filter_attributes += %i[request_json finding_json stats_json error_json]

  before_validation :assign_defaults, on: :create

  validates :id, presence: true, format: {
    with: /\A[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\z/
  }
  validates :schema_version, numericality: { only_integer: true, equal_to: SCHEMA_VERSION }
  validates :status, inclusion: { in: STATUSES }
  validates :request_json, presence: true
  validates :request_digest, presence: true, format: { with: /\A[0-9a-f]{64}\z/ }
  validates :attempts, numericality: { only_integer: true, greater_than_or_equal_to: 0 }

  scope :queued_before, ->(cutoff) { where(status: "queued").where("created_at <= ?", cutoff) }
  scope :expired_running, ->(now = Time.current) { where(status: "running").where("lease_expires_at IS NULL OR lease_expires_at <= ?", now) }

  def self.canonical_sort(obj)
    case obj
    when Hash
      obj.keys.map(&:to_s).sort.each_with_object({}) do |key, out|
        val = obj.key?(key) ? obj[key] : obj[key.to_sym]
        out[key] = canonical_sort(val)
      end
    when Array
      obj.map { |item| canonical_sort(item) }
    else
      obj
    end
  end

  def self.canonical_json(obj)
    JSON.generate(canonical_sort(obj))
  end

  # SHA-256 over canonical JSON without normalizing whitespace in before.source or after.source.
  def self.compute_request_digest(validated_request)
    Digest::SHA256.hexdigest(canonical_json(validated_request).encode(Encoding::UTF_8))
  end

  def self.create_queued!(validated_request:, idempotency_key: nil)
    canonical_request = canonical_sort(validated_request)
    request_json = JSON.generate(canonical_request)
    request_digest = Digest::SHA256.hexdigest(request_json.encode(Encoding::UTF_8))

    create!(
      id: SecureRandom.uuid,
      schema_version: SCHEMA_VERSION,
      status: "queued",
      request_json: request_json,
      request_digest: request_digest,
      idempotency_key: idempotency_key,
      attempts: 0
    )
  end

  # Atomically claim a queued comparison for execution. Returns attempt_token or nil.
  def self.claim_queued!(id, lease_duration: 110.seconds, now: Time.current)
    token = SecureRandom.uuid
    updated = where(id: id, status: "queued").update_all(
      status: "running",
      attempt_token: token,
      attempts: Arel.sql("attempts + 1"),
      lease_expires_at: (now + lease_duration).utc
    )
    updated == 1 ? token : nil
  end

  # Guarded transactional terminal write; stale attempt_token writes are rejected.
  def self.complete_with_token!(id:, attempt_token:, status:, finding: nil, stats: nil, error: nil, completed_at: Time.current)
    raise ArgumentError, "Invalid terminal status: #{status}" unless TERMINAL_STATUSES.include?(status)

    transaction do
      updated = where(
        id: id,
        status: "running",
        attempt_token: attempt_token
      ).update_all(
        status: status,
        finding_json: finding ? JSON.generate(finding) : nil,
        stats_json: stats ? JSON.generate(stats) : nil,
        error_json: error ? JSON.generate(error) : nil,
        attempt_token: nil,
        lease_expires_at: nil,
        completed_at: completed_at.utc
      )
      updated == 1
    end
  end

  # Guarded release back to queued when an infrastructure failure occurs under the retry bound.
  def self.release_for_retry_with_token!(id:, attempt_token:)
    transaction do
      updated = where(
        id: id,
        status: "running",
        attempt_token: attempt_token
      ).update_all(
        status: "queued",
        attempt_token: nil,
        lease_expires_at: nil
      )
      updated == 1
    end
  end

  def active?
    ACTIVE_STATUSES.include?(status)
  end

  def terminal?
    TERMINAL_STATUSES.include?(status)
  end

  def result_url
    "/comparisons/#{id}"
  end

  def parsed_request
    JSON.parse(request_json)
  end

  def parsed_finding
    return nil unless status == "difference_found" && finding_json.present?

    JSON.parse(finding_json)
  end

  def parsed_stats
    return nil if active? || stats_json.blank?

    JSON.parse(stats_json)
  end

  def parsed_error
    return nil unless status == "failed" && error_json.present?

    JSON.parse(error_json)
  end

  def as_comparison_job
    {
      "schema_version" => schema_version,
      "id" => id,
      "status" => status,
      "request" => parsed_request,
      "finding" => parsed_finding,
      "stats" => parsed_stats,
      "error" => parsed_error,
      "result_url" => result_url,
      "created_at" => created_at&.utc&.iso8601(3),
      "completed_at" => active? ? nil : completed_at&.utc&.iso8601(3)
    }
  end

  private

  def assign_defaults
    self.id ||= SecureRandom.uuid
    self.schema_version ||= SCHEMA_VERSION
    self.status ||= "queued"
    self.attempts ||= 0
  end
end

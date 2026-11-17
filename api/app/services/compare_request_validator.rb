# frozen_string_literal: true

require "json"

class CompareRequestValidator
  MAX_SNIPPET_BYTES = 16_384
  MAX_BODY_BYTES = 1_048_576
  MAX_SEED = 4_294_967_295
  MIN_SEARCH_PAIRS = 1
  MAX_SEARCH_PAIRS = 5_000
  MIN_SHRINK_PAIRS = 0
  MAX_SHRINK_PAIRS = 1_000
  SUPPORTED_OBSERVER = "sale_badge"

  TOP_LEVEL_KEYS = %w[after before budget observer schema_version seed].freeze
  SNIPPET_KEYS = %w[source].freeze
  BUDGET_KEYS = %w[search_pairs shrink_pairs].freeze
  FORBIDDEN_PATH_KEYS = %w[path file before_path after_path].freeze

  class ValidationError < StandardError
    attr_reader :code, :span

    def initialize(code:, message:, span: nil)
      @code = code
      @span = span
      super(message)
    end
  end

  def self.parse_and_validate!(raw_body)
    new.parse_and_validate!(raw_body)
  end

  def parse_and_validate!(raw_body)
    raise ValidationError.new(code: "invalid_request", message: "Request body must be a JSON object") unless raw_body.is_a?(String)

    utf8_body = raw_body.dup.force_encoding(Encoding::UTF_8)
    unless utf8_body.valid_encoding?
      raise ValidationError.new(code: "invalid_utf8", message: "Request body is not valid UTF-8")
    end

    if utf8_body.bytesize > MAX_BODY_BYTES
      raise ValidationError.new(
        code: "snippet_too_large",
        message: "Request body (#{utf8_body.bytesize} bytes) exceeds maximum payload limit (#{MAX_BODY_BYTES} bytes)"
      )
    end

    if utf8_body.strip.empty?
      raise ValidationError.new(code: "invalid_json", message: "Request body must not be empty")
    end

    payload = begin
      JSON.parse(utf8_body)
    rescue JSON::ParserError, EncodingError => e
      raise ValidationError.new(code: "invalid_json", message: "Malformed JSON request body: #{e.message}")
    end

    validate_hash!(payload)
  end

  def validate_hash!(payload)
    unless payload.is_a?(Hash)
      raise ValidationError.new(code: "invalid_request", message: "CompareRequest must be a JSON object")
    end

    reject_forbidden_path_keys!(payload, "CompareRequest")

    unless payload.keys.sort == TOP_LEVEL_KEYS
      raise ValidationError.new(
        code: "invalid_request",
        message: "CompareRequest must contain exact keys: schema_version, before, after, observer, seed, budget"
      )
    end

    schema_version = payload["schema_version"]
    unless schema_version.is_a?(Integer) && schema_version == 1
      raise ValidationError.new(code: "invalid_request", message: "CompareRequest.schema_version must be integer 1")
    end

    validate_snippet!(payload["before"], "before")
    validate_snippet!(payload["after"], "after")

    observer = payload["observer"]
    unless observer.is_a?(String) && observer == SUPPORTED_OBSERVER
      raise ValidationError.new(
        code: "unsupported_observer",
        message: "Unsupported observer #{observer.inspect}; only '#{SUPPORTED_OBSERVER}' is supported"
      )
    end

    seed = payload["seed"]
    unless seed.is_a?(Integer) && seed >= 0 && seed <= MAX_SEED
      raise ValidationError.new(
        code: "invalid_request",
        message: "CompareRequest.seed must be an integer in 0..#{MAX_SEED}"
      )
    end

    validate_budget!(payload["budget"])

    payload
  end

  private

  def reject_forbidden_path_keys!(hash, context)
    forbidden = hash.keys & FORBIDDEN_PATH_KEYS
    return if forbidden.empty?

    raise ValidationError.new(
      code: "invalid_request",
      message: "Arbitrary filesystem source keys (#{forbidden.join(', ')}) are not permitted on #{context}"
    )
  end

  def validate_snippet!(snippet, side)
    unless snippet.is_a?(Hash)
      raise ValidationError.new(code: "invalid_request", message: "CompareRequest.#{side} must be a JSON object")
    end

    reject_forbidden_path_keys!(snippet, "CompareRequest.#{side}")

    unless snippet.keys == SNIPPET_KEYS
      raise ValidationError.new(
        code: "invalid_request",
        message: "CompareRequest.#{side} must have exact key 'source'"
      )
    end

    source = snippet["source"]
    unless source.is_a?(String)
      raise ValidationError.new(code: "invalid_request", message: "CompareRequest.#{side}.source must be a string")
    end

    unless source.valid_encoding?
      raise ValidationError.new(code: "invalid_utf8", message: "CompareRequest.#{side}.source is not valid UTF-8")
    end

    utf8_source = source.encode(Encoding::UTF_8)
    if utf8_source.bytesize > MAX_SNIPPET_BYTES
      raise ValidationError.new(
        code: "snippet_too_large",
        message: "CompareRequest.#{side}.source (#{utf8_source.bytesize} bytes) exceeds #{MAX_SNIPPET_BYTES} byte limit"
      )
    end
  rescue EncodingError => e
    raise ValidationError.new(code: "invalid_utf8", message: "CompareRequest.#{side}.source is not valid UTF-8: #{e.message}")
  end

  def validate_budget!(budget)
    unless budget.is_a?(Hash) && budget.keys.sort == BUDGET_KEYS
      raise ValidationError.new(
        code: "invalid_request",
        message: "CompareRequest.budget must have exact keys search_pairs and shrink_pairs"
      )
    end

    search_pairs = budget["search_pairs"]
    unless search_pairs.is_a?(Integer) && search_pairs >= MIN_SEARCH_PAIRS && search_pairs <= MAX_SEARCH_PAIRS
      raise ValidationError.new(
        code: "invalid_request",
        message: "CompareRequest.budget.search_pairs must be an integer in #{MIN_SEARCH_PAIRS}..#{MAX_SEARCH_PAIRS}"
      )
    end

    shrink_pairs = budget["shrink_pairs"]
    unless shrink_pairs.is_a?(Integer) && shrink_pairs >= MIN_SHRINK_PAIRS && shrink_pairs <= MAX_SHRINK_PAIRS
      raise ValidationError.new(
        code: "invalid_request",
        message: "CompareRequest.budget.shrink_pairs must be an integer in #{MIN_SHRINK_PAIRS}..#{MAX_SHRINK_PAIRS}"
      )
    end
  end
end

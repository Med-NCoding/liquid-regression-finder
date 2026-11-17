# frozen_string_literal: true

module LiquidReference
  # Validates synthetic product fixtures against contracts/schemas/fixture.schema.json
  # plus semantic invariants (such as unique variant IDs).
  module FixtureValidator
    class ValidationError < StandardError
      attr_reader :code

      def initialize(message, code: "invalid_fixture")
        @code = String(code)
        super(message)
      end

      def to_diagnostic
        {
          "code" => @code,
          "message" => message,
          "span" => nil,
        }
      end
    end

    REQUIRED_TOP_KEYS = %w[schema_version currency variants].freeze
    REQUIRED_VARIANT_KEYS = %w[id price compare_at_price available].freeze
    MAX_VARIANTS = 8
    MAX_ID_LENGTH = 32
    MAX_PRICE_CENTS = 10_000_000

    module_function

    def validate!(fixture)
      unless fixture.is_a?(Hash)
        raise ValidationError.new("Fixture must be a JSON object", code: "invalid_fixture")
      end

      check_exact_keys!(fixture, REQUIRED_TOP_KEYS, context: "fixture")

      schema_version = fixture["schema_version"]
      unless schema_version.is_a?(Integer) && schema_version == 1
        raise ValidationError.new("fixture.schema_version must be integer 1", code: "invalid_fixture")
      end

      currency = fixture["currency"]
      unless currency.is_a?(String) && currency == "USD"
        raise ValidationError.new("fixture.currency must be string 'USD'", code: "invalid_fixture")
      end

      variants = fixture["variants"]
      unless variants.is_a?(Array) && !variants.empty? && variants.length <= MAX_VARIANTS
        raise ValidationError.new(
          "fixture.variants must be an array of 1 to #{MAX_VARIANTS} variants",
          code: "invalid_fixture",
        )
      end

      seen_ids = {}
      normalized_variants = variants.each_with_index.map do |variant, idx|
        norm = validate_variant!(variant, idx)
        vid = norm["id"]
        if seen_ids.key?(vid)
          raise ValidationError.new(
            "Duplicate variant id '#{vid}' at index #{idx}",
            code: "duplicate_variant_id",
          )
        end
        seen_ids[vid] = true
        norm
      end

      {
        "schema_version" => 1,
        "currency" => "USD",
        "variants" => normalized_variants,
      }
    end

    def validate_variant!(variant, idx)
      unless variant.is_a?(Hash)
        raise ValidationError.new("fixture.variants[#{idx}] must be an object", code: "invalid_fixture")
      end

      check_exact_keys!(variant, REQUIRED_VARIANT_KEYS, context: "fixture.variants[#{idx}]")

      id = variant["id"]
      unless id.is_a?(String)
        raise ValidationError.new("fixture.variants[#{idx}].id must be a string", code: "invalid_fixture")
      end

      id_utf8 = normalize_utf8_string!(id, "fixture.variants[#{idx}].id")
      if id_utf8.empty? || id_utf8.length > MAX_ID_LENGTH
        raise ValidationError.new(
          "fixture.variants[#{idx}].id length must be between 1 and #{MAX_ID_LENGTH} characters",
          code: "invalid_fixture",
        )
      end

      price = validate_cents!(variant["price"], "fixture.variants[#{idx}].price", allow_nil: false)
      compare_at_price = validate_cents!(
        variant["compare_at_price"],
        "fixture.variants[#{idx}].compare_at_price",
        allow_nil: true,
      )

      available = variant["available"]
      unless available == true || available == false
        raise ValidationError.new("fixture.variants[#{idx}].available must be a boolean", code: "invalid_fixture")
      end

      {
        "id" => id_utf8,
        "price" => price,
        "compare_at_price" => compare_at_price,
        "available" => available,
      }
    end

    def validate_cents!(value, field_name, allow_nil:)
      return nil if allow_nil && value.nil?

      unless value.is_a?(Integer)
        raise ValidationError.new("#{field_name} must be an integer", code: "invalid_fixture")
      end

      if value.negative? || value > MAX_PRICE_CENTS
        raise ValidationError.new(
          "#{field_name} must be between 0 and #{MAX_PRICE_CENTS}",
          code: "invalid_fixture",
        )
      end

      value
    end

    def check_exact_keys!(hash, expected_keys, context:)
      non_string = hash.keys.reject { |k| k.is_a?(String) }
      unless non_string.empty?
        raise ValidationError.new(
          "#{context} contains non-string key(s): #{non_string.inspect}",
          code: "invalid_fixture",
        )
      end

      missing = expected_keys - hash.keys
      unless missing.empty?
        raise ValidationError.new(
          "#{context} missing required key(s): #{missing.join(', ')}",
          code: "invalid_fixture",
        )
      end

      extra = hash.keys - expected_keys
      return if extra.empty?

      raise ValidationError.new(
        "#{context} contains unexpected key(s): #{extra.join(', ')}",
        code: "invalid_fixture",
      )
    end

    def normalize_utf8_string!(str, field_name)
      if str.encoding == Encoding::UTF_8
        raise ValidationError.new("#{field_name} has invalid UTF-8 encoding", code: "invalid_fixture") unless str.valid_encoding?

        str.dup
      elsif str.encoding == Encoding::BINARY
        utf8 = str.dup.force_encoding(Encoding::UTF_8)
        raise ValidationError.new("#{field_name} has invalid UTF-8 encoding", code: "invalid_fixture") unless utf8.valid_encoding?

        utf8
      else
        str.encode(Encoding::UTF_8)
      end
    rescue EncodingError => e
      raise ValidationError.new("#{field_name} encoding error: #{e.message}", code: "invalid_fixture")
    end
  end
end

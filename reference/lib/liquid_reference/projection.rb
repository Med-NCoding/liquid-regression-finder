# frozen_string_literal: true

require "json"
require "json_schemer"

module LiquidReference
  # Computes Shopify-compatible product aggregates and Liquid render assigns
  # from a validated Fixture under PROJECTION_VERSION = "1.0.0".
  module Projection
    PROJECTION_SCHEMA_PATH = File.expand_path("../../../contracts/schemas/projection.schema.json", __dir__)

    Result = Struct.new(:projection, :product_assign, keyword_init: true) do
      def [](key)
        case key.to_s
        when "projection"
          projection
        when "product_assign"
          product_assign
        else
          raise KeyError, "Unknown Projection::Result key: #{key.inspect}"
        end
      end

      def fresh_assigns
        Projection.deep_copy(product_assign)
      end

      def to_h
        {
          "projection" => Projection.deep_copy(projection),
          "product_assign" => Projection.deep_copy(product_assign),
        }
      end
    end

    module_function

    def projection_schema
      @projection_schema ||= JSONSchemer.schema(
        JSON.parse(File.read(PROJECTION_SCHEMA_PATH, encoding: Encoding::UTF_8)),
      )
    end

    # Computes the Projection contract object (without variants) from a Fixture.
    def project(fixture)
      validated = FixtureValidator.validate!(fixture)
      compute_projection(validated["variants"])
    end

    # Validates the fixture, validates the computed Projection against projection.schema.json,
    # and returns both `projection` and `product_assign` (`{"product" => ...}`).
    def project_for_render(fixture)
      validated = FixtureValidator.validate!(fixture)
      variants = validated["variants"].map do |v|
        {
          "id" => v["id"].dup,
          "price" => v["price"],
          "compare_at_price" => v["compare_at_price"],
          "available" => v["available"],
        }
      end

      projection = compute_projection(variants)
      schema_errors = projection_schema.validate(projection).to_a
      unless schema_errors.empty?
        raise FixtureValidator::ValidationError.new(
          "Projected product failed schema validation: #{schema_errors.map { |e| e['error'] }.join('; ')}",
          code: "invalid_projection",
        )
      end

      product_assign = {
        "product" => projection.merge("variants" => deep_copy(variants)),
      }

      Result.new(projection: projection, product_assign: product_assign)
    end

    def deep_copy(value)
      case value
      when Hash
        value.each_with_object({}) { |(k, v), copy| copy[k.is_a?(String) ? k.dup : k] = deep_copy(v) }
      when Array
        value.map { |item| deep_copy(item) }
      when String
        value.dup
      else
        value
      end
    end

    def compute_projection(variants)
      prices = variants.map { |v| v["price"] }
      price_min = prices.min
      price_max = prices.max
      price_varies = price_min != price_max
      available = variants.any? { |v| v["available"] == true }

      # Retain explicit 0 values while excluding nil.
      non_nil_compare_ats = variants.filter_map { |v| v["compare_at_price"] }
      if non_nil_compare_ats.empty?
        compare_at_price = nil
        compare_at_price_min = nil
        compare_at_price_max = nil
        compare_at_price_varies = false
      else
        compare_at_price_min = non_nil_compare_ats.min
        compare_at_price_max = non_nil_compare_ats.max
        compare_at_price = compare_at_price_min
        compare_at_price_varies = non_nil_compare_ats.uniq.size >= 2
      end

      {
        "price" => price_min,
        "price_min" => price_min,
        "price_max" => price_max,
        "price_varies" => price_varies,
        "compare_at_price" => compare_at_price,
        "compare_at_price_min" => compare_at_price_min,
        "compare_at_price_max" => compare_at_price_max,
        "compare_at_price_varies" => compare_at_price_varies,
        "available" => available,
      }
    end
  end
end

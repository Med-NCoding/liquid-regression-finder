# frozen_string_literal: true

require "liquid"

module LiquidReference
  # Minimal Shopify-compatible filter stubs isolated exclusively to Stage 6-7
  # benchmark runs. Never registered on Renderer::REFERENCE_ENVIRONMENT or default
  # LiquidInterpreter.
  module BenchmarkFilters
    include Liquid::StandardFilters

    BENCHMARK_STUBS_VERSION = "1.0.0"

    TRANSLATIONS = {
      "products.product.on_sale" => "Sale",
      "products.product.sold_out" => "Sold out",
      "products.product.add_to_cart" => "Add to cart",
      "products.product.choose_options" => "Choose options",
      "products.product.unavailable" => "Unavailable",
      "products.product.price.regular_price" => "Regular price",
      "products.product.price.sale_price" => "Sale price",
      "products.product.price.from_price_html" => "From {{ price }}",
      "products.product.volume_pricing.price_range" => "{{ minimum }} - {{ maximum }}",
    }.freeze

    def money(cents)
      return "" if cents.nil?

      amount = Integer(cents)
      sign = amount.negative? ? "-" : ""
      abs = amount.abs
      format("%s$%d.%02d", sign, abs / 100, abs % 100)
    rescue ArgumentError, TypeError
      cents.to_s
    end

    def money_with_currency(cents)
      formatted = money(cents)
      formatted.empty? ? "" : "#{formatted} USD"
    end

    def t(key, params = nil)
      template = TRANSLATIONS[key.to_s] || key.to_s
      return template unless params.is_a?(Hash)

      params.each_with_object(template.dup) do |(param_key, param_val), rendered|
        rendered.gsub!(/\{\{\s*#{Regexp.escape(param_key.to_s)}\s*\}\}/, param_val.to_s)
      end
    end

    def self.custom_registry
      @custom_registry ||= begin
        host = Object.new.extend(self)
        {
          "money" => host.method(:money),
          "money_with_currency" => host.method(:money_with_currency),
          "t" => host.method(:t),
        }.freeze
      end
    end
  end
end

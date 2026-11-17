# frozen_string_literal: true

require "nokogiri"

module LiquidReference
  # Parses rendered HTML fragments and evaluates supported DOM observers.
  module Observer
    class UnsupportedObserverError < StandardError
      attr_reader :code

      def initialize(message, code: "unsupported_observer")
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

    SUPPORTED_OBSERVERS = ["sale_badge"].freeze
    SALE_BADGE_SELECTOR = '[data-regression-badge="sale"]'
    SOLD_OUT_BADGE_SELECTOR = '[data-regression-badge="sold_out"]'
    PRICE_RANGE_SELECTOR = '[data-regression-price-range]'
    BENCHMARK_OBSERVERS = {
      "sale_badge" => SALE_BADGE_SELECTOR,
      "sold_out_badge" => SOLD_OUT_BADGE_SELECTOR,
      "price_range" => PRICE_RANGE_SELECTOR,
    }.freeze

    module_function

    def supported?(observer_name)
      observer_name.is_a?(String) && SUPPORTED_OBSERVERS.include?(observer_name)
    end

    def benchmark_supported?(observer_name)
      observer_name.is_a?(String) && BENCHMARK_OBSERVERS.key?(observer_name)
    end

    def validate_name!(observer_name)
      return observer_name if supported?(observer_name)

      raise UnsupportedObserverError.new(
        "Unsupported observer #{observer_name.inspect}; supported observers: #{SUPPORTED_OBSERVERS.join(', ')}",
        code: "unsupported_observer",
      )
    end

    def validate_benchmark_name!(observer_name)
      return observer_name if benchmark_supported?(observer_name)

      raise UnsupportedObserverError.new(
        "Unsupported benchmark observer #{observer_name.inspect}; supported benchmark observers: #{BENCHMARK_OBSERVERS.keys.join(', ')}",
        code: "unsupported_observer",
      )
    end

    def observe(observer_name, html)
      validate_name!(observer_name)
      raise ArgumentError, "Rendered HTML must be a String" unless html.is_a?(String)

      evaluate_selector(html, SALE_BADGE_SELECTOR)
    end

    # Benchmark-only observer supporting Stage 6-7 Dawn corpus observables
    # without relaxing Stage 3-5 public API validation in Observer.observe.
    def observe_benchmark(observer_name, html, selector: nil)
      validate_benchmark_name!(observer_name)
      raise ArgumentError, "Rendered HTML must be a String" unless html.is_a?(String)
      unless selector.nil? || (selector.is_a?(String) && !selector.strip.empty?)
        raise ArgumentError, "Custom benchmark selector must be a non-empty String or nil"
      end

      css_selector = selector || BENCHMARK_OBSERVERS.fetch(observer_name)
      evaluate_selector(html, css_selector)
    end

    def evaluate_selector(html, css_selector)
      utf8_html = ensure_utf8(html)
      fragment = parse_fragment(utf8_html)
      !fragment.css(css_selector).empty?
    end

    def parse_fragment(html)
      if defined?(Nokogiri::HTML5) && Nokogiri::HTML5.respond_to?(:fragment)
        Nokogiri::HTML5.fragment(html)
      else
        Nokogiri::HTML4.fragment(html)
      end
    rescue EncodingError, ArgumentError
      Nokogiri::HTML4.fragment(html)
    end

    def ensure_utf8(html)
      if html.encoding == Encoding::UTF_8
        html.valid_encoding? ? html : html.encode(Encoding::UTF_8, invalid: :replace, undef: :replace)
      elsif html.encoding == Encoding::BINARY
        dup = html.dup.force_encoding(Encoding::UTF_8)
        dup.valid_encoding? ? dup : dup.encode(Encoding::UTF_8, invalid: :replace, undef: :replace)
      else
        html.encode(Encoding::UTF_8)
      end
    end
  end
end

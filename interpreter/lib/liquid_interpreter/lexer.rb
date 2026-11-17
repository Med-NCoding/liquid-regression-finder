# frozen_string_literal: true

module LiquidInterpreter
  class Token
    attr_reader :type, :raw, :value, :span

    def initialize(type:, raw:, value:, span:)
      @type = type
      @raw = raw.freeze
      @value = value.freeze
      @span = span
      freeze
    end
  end

  class Lexer
    LIQUID_DELIMITER_PATTERN = /\{\{|\{%/.freeze

    def self.normalize_utf8(str)
      unless str.is_a?(String)
        raise SyntaxError.new("Template source must be a String", code: "invalid_source")
      end

      if str.encoding == Encoding::UTF_8
        unless str.valid_encoding?
          raise SyntaxError.new("Template source contains invalid UTF-8 bytes", code: "invalid_utf8")
        end
        str.dup
      elsif str.encoding == Encoding::BINARY
        utf8 = str.dup.force_encoding(Encoding::UTF_8)
        unless utf8.valid_encoding?
          raise SyntaxError.new("Template source contains invalid UTF-8 bytes", code: "invalid_utf8")
        end
        utf8
      else
        str.encode(Encoding::UTF_8)
      end
    rescue EncodingError => e
      raise SyntaxError.new("Template source encoding error: #{e.message}", code: "invalid_utf8")
    end

    def self.tokenize(source)
      new(source).tokenize
    end

    def initialize(source)
      @source = self.class.normalize_utf8(source)
    end

    def tokenize
      if (match = @source.match(LIQUID_DELIMITER_PATTERN))
        start_byte, end_byte = match.byteoffset(0)
        span = Span.at_byte_offset(@source, start_byte, end_byte)
        raise UnsupportedFeatureError.new(
          "Liquid syntax delimiter '#{match[0]}' is not enabled in Stage 1 bootstrap (line #{span.line}, column #{span.column})",
          code: "unsupported_syntax",
          span: span,
        )
      end

      return [] if @source.empty?

      span = Span.new(start_byte: 0, end_byte: @source.bytesize, line: 1, column: 1)
      [Token.new(type: :text, raw: @source, value: @source, span: span)]
    end
  end
end

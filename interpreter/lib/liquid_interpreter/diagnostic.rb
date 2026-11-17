# frozen_string_literal: true

module LiquidInterpreter
  # Structured diagnostic aligned with the Diagnostic contract schema.
  class Diagnostic
    attr_reader :code, :message, :span

    def initialize(code:, message:, span: nil)
      @code = String(code)
      @message = String(message)
      @span = span
      freeze
    end

    def to_h
      {
        "code" => @code,
        "message" => @message,
        "span" => @span&.to_h,
      }
    end

    def ==(other)
      other.is_a?(Diagnostic) &&
        @code == other.code &&
        @message == other.message &&
        @span == other.span
    end
  end

  class Error < ::StandardError
    attr_reader :diagnostic, :code, :span

    def initialize(message, code: "interpreter_error", span: nil)
      @code = String(code)
      @span = span
      @diagnostic = Diagnostic.new(code: @code, message: message, span: span)
      super(message)
    end

    def line
      @span&.line
    end

    def column
      @span&.column
    end
  end

  class SyntaxError < Error
    def initialize(message, code: "syntax_error", span: nil)
      super(message, code: code, span: span)
    end
  end

  class UnsupportedFeatureError < SyntaxError
    def initialize(message, code: "unsupported_feature", span: nil)
      super(message, code: code, span: span)
    end
  end

  class RenderError < Error
    def initialize(message, code: "render_error", span: nil)
      super(message, code: code, span: span)
    end
  end

  class LimitError < Error
    def initialize(message, code: "resource_limit_exceeded", span: nil)
      super(message, code: code, span: span)
    end
  end
end

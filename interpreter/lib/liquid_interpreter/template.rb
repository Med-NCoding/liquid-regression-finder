# frozen_string_literal: true

require "digest"

module LiquidInterpreter
  class Template
    attr_reader :source, :source_sha256, :ast, :compile_options

    def self.compile(source, **options)
      normalized = Lexer.normalize_utf8(source)
      tokens = Lexer.tokenize(normalized)
      ast = Parser.parse(tokens, source: normalized)
      new(source: normalized, ast: ast, compile_options: options)
    end

    def initialize(source:, ast:, compile_options: {})
      @source = source.freeze
      @source_sha256 = Digest::SHA256.hexdigest(@source).freeze
      @ast = ast
      @compile_options = compile_options.dup.freeze
      freeze
    end

    # Creates a fresh Evaluator and render state per invocation.
    def render(assigns = {}, **options)
      Evaluator.new(trace: false).evaluate(@ast, assigns: assigns, **options).html
    end

    def render_with_trace(assigns = {}, **options)
      result = Evaluator.new(trace: true).evaluate(@ast, assigns: assigns, **options)
      {
        "status" => "ok",
        "html" => result.html,
        "events" => result.events,
        "error" => nil,
      }
    end
  end
end

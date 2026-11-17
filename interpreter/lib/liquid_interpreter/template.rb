# frozen_string_literal: true

require "digest"

module LiquidInterpreter
  class Template
    attr_reader :source, :source_sha256, :ast, :compile_options

    def self.compile(source, **options)
      normalized = Lexer.normalize_utf8(source)
      max_snippet_bytes = options.fetch(:max_snippet_bytes, Lexer::MAX_SNIPPET_BYTES)
      max_depth = options.fetch(:max_depth, Parser::MAX_DEPTH)
      filters = options[:filters]
      tokens = Lexer.tokenize(normalized, max_snippet_bytes: max_snippet_bytes)
      ast = Parser.parse(tokens, source: normalized, max_depth: max_depth, filters: filters)
      new(source: normalized, ast: ast, compile_options: options)
    end

    # Compiles and renders a source snippet into a full RenderResult-shaped Hash.
    def self.render_result(source, assigns = {}, trace: true, observed: false, **options)
      template = compile(source, **options)
      result = Evaluator.new(
        trace: trace,
        max_depth: options.fetch(:max_depth, Evaluator::MAX_DEPTH),
        max_steps: options.fetch(:max_steps, Evaluator::MAX_STEPS),
        max_output_bytes: options.fetch(:max_output_bytes, Evaluator::MAX_OUTPUT_BYTES),
        max_trace_events: options.fetch(:max_trace_events, Evaluator::MAX_TRACE_EVENTS),
        filters: options[:filters],
      ).evaluate(template.ast, assigns: assigns, **options)

      {
        "status" => "ok",
        "html" => result.html,
        "observed" => !!observed,
        "events" => result.events,
        "error" => nil,
      }
    rescue Error => e
      {
        "status" => "error",
        "html" => nil,
        "observed" => nil,
        "events" => [],
        "error" => e.diagnostic.to_h,
      }
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
      build_evaluator(trace: false, options: options).evaluate(@ast, assigns: assigns, **options).html
    end

    def render_with_trace(assigns = {}, **options)
      result = build_evaluator(trace: true, options: options).evaluate(@ast, assigns: assigns, **options)
      {
        "status" => "ok",
        "html" => result.html,
        "events" => result.events,
        "error" => nil,
      }
    rescue Error => e
      {
        "status" => "error",
        "html" => nil,
        "events" => [],
        "error" => e.diagnostic.to_h,
      }
    end

    private

    def build_evaluator(trace:, options:)
      Evaluator.new(
        trace: trace,
        max_depth: options.fetch(:max_depth, Evaluator::MAX_DEPTH),
        max_steps: options.fetch(:max_steps, Evaluator::MAX_STEPS),
        max_output_bytes: options.fetch(:max_output_bytes, Evaluator::MAX_OUTPUT_BYTES),
        max_trace_events: options.fetch(:max_trace_events, Evaluator::MAX_TRACE_EVENTS),
        filters: options.fetch(:filters, @compile_options[:filters]),
      )
    end
  end
end

# frozen_string_literal: true

require "digest"
require "timeout"

module LiquidReference
  # Renders compiled templates in either the custom LiquidInterpreter engine
  # or the restricted official Liquid 5.14.0 reference engine.
  module Renderer
    MAX_SNIPPET_BYTES = LiquidInterpreter::Lexer::MAX_SNIPPET_BYTES
    MAX_DEPTH = LiquidInterpreter::Parser::MAX_DEPTH
    MAX_STEPS = LiquidInterpreter::Evaluator::MAX_STEPS
    MAX_OUTPUT_BYTES = LiquidInterpreter::Evaluator::MAX_OUTPUT_BYTES
    MAX_TRACE_EVENTS = LiquidInterpreter::Evaluator::MAX_TRACE_EVENTS
    DEFAULT_TIMEOUT_SECONDS = 3.0

    # File system that strictly forbids any partial/include/render filesystem access.
    class DisabledFileSystem
      def read_template_file(_template_path)
        raise Liquid::FileSystemError, "Filesystem access and includes are disabled in reference renderer."
      end
    end

    REFERENCE_ENVIRONMENT = Liquid::Environment.build(
      tags: Liquid::Tags::STANDARD_TAGS.dup,
      error_mode: :strict2,
      file_system: DisabledFileSystem.new,
    ) do |env|
      env.default_resource_limits = {
        render_length_limit: MAX_OUTPUT_BYTES,
        render_score_limit: MAX_STEPS,
      }.freeze
    end

    BENCHMARK_ENVIRONMENT = Liquid::Environment.build(
      tags: Liquid::Tags::STANDARD_TAGS.dup,
      error_mode: :strict2,
      file_system: DisabledFileSystem.new,
    ) do |env|
      env.register_filter(Liquid::StandardFilters)
      env.register_filter(BenchmarkFilters)
      env.default_resource_limits = {
        render_length_limit: MAX_OUTPUT_BYTES,
        render_score_limit: MAX_STEPS,
      }.freeze
    end

    CompiledReference = Struct.new(:source, :source_sha256, :template, :environment, keyword_init: true)
    CompiledPair = Struct.new(
      :custom_before,
      :custom_after,
      :reference_before,
      :reference_after,
      :before_sha256,
      :after_sha256,
      :observer,
      :benchmark,
      :selector,
      :fixed_context,
      keyword_init: true,
    )

    module_function

    def compile_custom(source, max_snippet_bytes: MAX_SNIPPET_BYTES, max_depth: MAX_DEPTH, filters: nil)
      LiquidInterpreter::Template.compile(
        source,
        max_snippet_bytes: max_snippet_bytes,
        max_depth: max_depth,
        filters: filters,
      )
    end

    def compile_reference(
      source,
      max_snippet_bytes: MAX_SNIPPET_BYTES,
      max_depth: MAX_DEPTH,
      environment: REFERENCE_ENVIRONMENT
    )
      normalized = LiquidInterpreter::Lexer.normalize_utf8(source)
      if normalized.bytesize > max_snippet_bytes
        raise LiquidInterpreter::LimitError.new(
          "Template snippet size #{normalized.bytesize} bytes exceeds maximum #{max_snippet_bytes} bytes",
          code: "snippet_too_large",
          span: nil,
        )
      end

      template = Liquid::Template.parse(
        normalized,
        environment: environment,
        line_numbers: true,
      )

      depth = ast_block_depth(template.root)
      if depth > max_depth
        raise LiquidInterpreter::LimitError.new(
          "Template nesting depth #{depth} exceeds maximum #{max_depth}",
          code: "depth_limit_exceeded",
          span: nil,
        )
      end

      CompiledReference.new(
        source: normalized.freeze,
        source_sha256: Digest::SHA256.hexdigest(normalized).freeze,
        template: template,
        environment: environment,
      )
    rescue Liquid::StackLevelError => e
      raise LiquidInterpreter::LimitError.new(
        e.message,
        code: "depth_limit_exceeded",
        span: line_span(normalized, e.line_number),
      )
    rescue Liquid::SyntaxError, Liquid::Error => e
      raise LiquidInterpreter::SyntaxError.new(
        e.message,
        code: "syntax_error",
        span: line_span(normalized, e.line_number),
      )
    end

    def compile_pair(
      before:,
      after:,
      observer:,
      max_snippet_bytes: MAX_SNIPPET_BYTES,
      max_depth: MAX_DEPTH,
      benchmark: false,
      selector: nil,
      fixed_context: nil
    )
      if benchmark
        Observer.validate_benchmark_name!(observer)
        unless selector.nil? || (selector.is_a?(String) && !selector.strip.empty?)
          raise ArgumentError, "Benchmark selector must be nil or a non-empty String"
        end
        unless fixed_context.nil? || (fixed_context.is_a?(Hash) && !fixed_context.key?("product"))
          raise ArgumentError, "Benchmark fixed_context must be nil or a Hash without 'product'"
        end
        custom_filters = BenchmarkFilters.custom_registry
        ref_env = BENCHMARK_ENVIRONMENT
      else
        Observer.validate_name!(observer)
        raise ArgumentError, "selector is only supported in benchmark mode" unless selector.nil?
        raise ArgumentError, "fixed_context is only supported in benchmark mode" unless fixed_context.nil?

        custom_filters = nil
        ref_env = REFERENCE_ENVIRONMENT
      end

      custom_before = compile_custom(before, max_snippet_bytes: max_snippet_bytes, max_depth: max_depth, filters: custom_filters)
      ref_before = compile_reference(before, max_snippet_bytes: max_snippet_bytes, max_depth: max_depth, environment: ref_env)
      custom_after = compile_custom(after, max_snippet_bytes: max_snippet_bytes, max_depth: max_depth, filters: custom_filters)
      ref_after = compile_reference(after, max_snippet_bytes: max_snippet_bytes, max_depth: max_depth, environment: ref_env)

      CompiledPair.new(
        custom_before: custom_before,
        custom_after: custom_after,
        reference_before: ref_before,
        reference_after: ref_after,
        before_sha256: custom_before.source_sha256,
        after_sha256: custom_after.source_sha256,
        observer: observer,
        benchmark: !!benchmark,
        selector: selector,
        fixed_context: fixed_context ? Projection.deep_copy(fixed_context) : nil,
      )
    end

    def render(engine:, template:, assigns:, observer:, trace: false, benchmark: false, selector: nil, **limits)
      case engine
      when "custom"
        render_custom(template, assigns, observer: observer, trace: trace, benchmark: benchmark, selector: selector, **limits)
      when "reference"
        render_reference(template, assigns, observer: observer, trace: trace, benchmark: benchmark, selector: selector, **limits)
      else
        raise ArgumentError, "Unknown engine #{engine.inspect}; expected 'custom' or 'reference'"
      end
    end

    def render_custom(template_or_source, assigns = {}, observer: "sale_badge", trace: true, benchmark: false, selector: nil, **limits)
      if benchmark
        Observer.validate_benchmark_name!(observer)
      else
        Observer.validate_name!(observer)
        raise ArgumentError, "selector is only supported in benchmark mode" unless selector.nil?
      end
      max_snippet_bytes = limits.fetch(:max_snippet_bytes, MAX_SNIPPET_BYTES)
      max_depth = limits.fetch(:max_depth, MAX_DEPTH)
      max_steps = limits.fetch(:max_steps, MAX_STEPS)
      max_output_bytes = limits.fetch(:max_output_bytes, MAX_OUTPUT_BYTES)
      max_trace_events = limits.fetch(:max_trace_events, MAX_TRACE_EVENTS)
      timeout_seconds = limits.fetch(:timeout_seconds, DEFAULT_TIMEOUT_SECONDS)

      compiled = if template_or_source.is_a?(LiquidInterpreter::Template)
        template_or_source
      else
        compile_custom(
          template_or_source,
          max_snippet_bytes: max_snippet_bytes,
          max_depth: max_depth,
          filters: benchmark ? BenchmarkFilters.custom_registry : nil,
        )
      end

      fresh_assigns = Projection.deep_copy(assigns || {})
      evaluator = LiquidInterpreter::Evaluator.new(
        trace: !!trace,
        max_depth: max_depth,
        max_steps: max_steps,
        max_output_bytes: max_output_bytes,
        max_trace_events: max_trace_events,
        filters: compiled.compile_options[:filters],
      )

      eval_result = Timeout.timeout(timeout_seconds) do
        evaluator.evaluate(compiled.ast, assigns: fresh_assigns)
      end

      html = ensure_utf8_output(eval_result.html)
      if html.bytesize > max_output_bytes
        return error_result(
          code: "output_limit_exceeded",
          message: "Rendered output size #{html.bytesize} bytes exceeds maximum #{max_output_bytes} bytes",
          span: nil,
        )
      end

      observed = benchmark ? Observer.observe_benchmark(observer, html, selector: selector) : Observer.observe(observer, html)
      {
        "status" => "ok",
        "html" => html,
        "observed" => observed,
        "events" => trace ? eval_result.events : [],
        "error" => nil,
      }
    rescue LiquidInterpreter::Error => e
      error_result_from_diagnostic(e.diagnostic.to_h)
    rescue Timeout::Error
      error_result(
        code: "render_timeout",
        message: "Custom engine render exceeded #{timeout_seconds}s timeout",
        span: nil,
      )
    end

    def render_reference(template_or_source, assigns = {}, observer: "sale_badge", trace: false, benchmark: false, selector: nil, **limits)
      _ = trace # Reference engine never emits trace events.
      if benchmark
        Observer.validate_benchmark_name!(observer)
        active_env = BENCHMARK_ENVIRONMENT
      else
        Observer.validate_name!(observer)
        raise ArgumentError, "selector is only supported in benchmark mode" unless selector.nil?

        active_env = REFERENCE_ENVIRONMENT
      end
      max_snippet_bytes = limits.fetch(:max_snippet_bytes, MAX_SNIPPET_BYTES)
      max_depth = limits.fetch(:max_depth, MAX_DEPTH)
      max_steps = limits.fetch(:max_steps, MAX_STEPS)
      max_output_bytes = limits.fetch(:max_output_bytes, MAX_OUTPUT_BYTES)
      timeout_seconds = limits.fetch(:timeout_seconds, DEFAULT_TIMEOUT_SECONDS)

      compiled = if template_or_source.is_a?(CompiledReference)
        depth = ast_block_depth(template_or_source.template.root)
        if depth > max_depth
          return error_result(
            code: "depth_limit_exceeded",
            message: "Template nesting depth #{depth} exceeds maximum #{max_depth}",
            span: nil,
          )
        end
        template_or_source
      else
        compile_reference(template_or_source, max_snippet_bytes: max_snippet_bytes, max_depth: max_depth, environment: active_env)
      end

      render_env = compiled.environment || active_env
      fresh_assigns = Projection.deep_copy(assigns || {})
      resource_limits = Liquid::ResourceLimits.new(
        render_length_limit: max_output_bytes,
        render_score_limit: max_steps,
      )
      context = Liquid::Context.build(
        environment: render_env,
        environments: [fresh_assigns],
        registers: { file_system: render_env.file_system },
        rethrow_errors: true,
        resource_limits: resource_limits,
      )
      context.strict_variables = false

      raw_html = Timeout.timeout(timeout_seconds) do
        compiled.template.render!(context)
      end

      html = ensure_utf8_output(raw_html)
      if html.bytesize > max_output_bytes
        return error_result(
          code: "output_limit_exceeded",
          message: "Rendered output size #{html.bytesize} bytes exceeds maximum #{max_output_bytes} bytes",
          span: nil,
        )
      end

      observed = benchmark ? Observer.observe_benchmark(observer, html, selector: selector) : Observer.observe(observer, html)
      {
        "status" => "ok",
        "html" => html,
        "observed" => observed,
        "events" => [],
        "error" => nil,
      }
    rescue LiquidInterpreter::Error => e
      error_result_from_diagnostic(e.diagnostic.to_h)
    rescue Liquid::FileSystemError => e
      error_result(
        code: "filesystem_disabled",
        message: e.message,
        span: line_span(compiled&.source, e.line_number),
      )
    rescue Liquid::MemoryError => e
      code = resource_limits && resource_limits.render_score > max_steps ? "step_limit_exceeded" : "output_limit_exceeded"
      error_result(
        code: code,
        message: e.message,
        span: line_span(compiled&.source, e.line_number),
      )
    rescue Liquid::StackLevelError => e
      error_result(
        code: "depth_limit_exceeded",
        message: e.message,
        span: line_span(compiled&.source, e.line_number),
      )
    rescue Liquid::SyntaxError => e
      error_result(
        code: "syntax_error",
        message: e.message,
        span: line_span(compiled&.source, e.line_number),
      )
    rescue Liquid::Error => e
      error_result(
        code: "reference_render_error",
        message: e.message,
        span: line_span(compiled&.source, e.line_number),
      )
    rescue Timeout::Error
      error_result(
        code: "render_timeout",
        message: "Reference engine render exceeded #{timeout_seconds}s timeout",
        span: nil,
      )
    end

    def ast_block_depth(node)
      return 0 if node.is_a?(String)

      children = node.respond_to?(:nodelist) && node.nodelist ? node.nodelist : []
      max_child = 0
      children.each do |child|
        d = ast_block_depth(child)
        max_child = d if d > max_child
      end

      is_block = node.is_a?(Liquid::Block) && !node.is_a?(Liquid::Document)
      is_block ? 1 + max_child : max_child
    end

    def line_span(source, line_number)
      return nil unless source.is_a?(String) && line_number.is_a?(Integer) && line_number >= 1

      offset = 0
      current_line = 1
      while current_line < line_number
        nl = source.byteindex("\n", offset)
        return nil unless nl

        offset = nl + 1
        current_line += 1
      end

      next_nl = source.byteindex("\n", offset)
      end_byte = next_nl || source.bytesize
      LiquidInterpreter::Span.new(
        start_byte: offset,
        end_byte: end_byte,
        line: line_number,
        column: 1,
      )
    end

    def ensure_utf8_output(raw)
      str = raw.is_a?(String) ? raw : raw.to_s
      if str.encoding == Encoding::UTF_8 && str.valid_encoding?
        str
      elsif str.encoding == Encoding::BINARY
        dup = str.dup.force_encoding(Encoding::UTF_8)
        dup.valid_encoding? ? dup : dup.encode(Encoding::UTF_8, invalid: :replace, undef: :replace)
      else
        str.encode(Encoding::UTF_8)
      end
    end

    def error_result(code:, message:, span:)
      error_result_from_diagnostic(
        {
          "code" => String(code),
          "message" => String(message),
          "span" => span.nil? ? nil : (span.is_a?(Hash) ? span : span.to_h),
        },
      )
    end

    def error_result_from_diagnostic(diagnostic)
      {
        "status" => "error",
        "html" => nil,
        "observed" => nil,
        "events" => [],
        "error" => diagnostic,
      }
    end
  end
end

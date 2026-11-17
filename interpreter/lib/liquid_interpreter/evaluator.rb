# frozen_string_literal: true

module LiquidInterpreter
  class Evaluator
    MAX_DEPTH = Parser::MAX_DEPTH
    MAX_STEPS = 50_000
    MAX_OUTPUT_BYTES = 131_072
    MAX_TRACE_EVENTS = Tracer::MAX_TRACE_EVENTS

    Result = Struct.new(:html, :events, keyword_init: true)

    def initialize(
      trace: false,
      max_depth: MAX_DEPTH,
      max_steps: MAX_STEPS,
      max_output_bytes: MAX_OUTPUT_BYTES,
      max_trace_events: MAX_TRACE_EVENTS,
      filters: nil
    )
      @trace = !!trace
      @max_depth = Integer(max_depth)
      @max_steps = Integer(max_steps)
      @max_output_bytes = Integer(max_output_bytes)
      @max_trace_events = Integer(max_trace_events)
      @filters = normalize_filters(filters)
    end

    def evaluate(document, assigns: {}, **_options)
      unless document.is_a?(AST::Document)
        raise RenderError.new("Expected AST::Document, got #{document.class}", code: "invalid_ast")
      end

      @output = String.new(encoding: Encoding::UTF_8)
      @tracer = Tracer.new(enabled: @trace, max_events: @max_trace_events)
      @env = deep_copy_json(assigns || {})
      unless @env.is_a?(Hash)
        raise RenderError.new("Assigns must be a Hash", code: "invalid_assigns")
      end
      @root_scope = {}
      @loop_scopes = []
      @steps = 0

      eval_block(document.children, depth: 0)

      Result.new(html: @output.freeze, events: @tracer.events)
    end

    private

    def step!(span)
      @steps += 1
      return if @steps <= @max_steps

      raise LimitError.new(
        "Evaluation step limit (#{@max_steps}) exceeded",
        code: "step_limit_exceeded",
        span: span,
      )
    end

    def eval_block(nodes, depth:)
      nodes.each do |node|
        step!(node.span)

        case node
        when AST::Text
          append_output(node.value, node: node) unless node.value.empty?
        when AST::Output
          if node.expression
            val = eval_expr(node.expression)
            rendered = render_value(val)
            append_output(rendered, node: node) unless rendered.empty?
          end
        when AST::Assign
          val = eval_expr(node.value_expr)
          @root_scope[node.name] = val
          @tracer.record_assignment(
            node_id: node.node_id,
            span: node.span,
            name: node.name,
            value: val,
          )
        when AST::Conditional
          eval_conditional(node, depth: depth)
        when AST::For
          eval_for(node, depth: depth)
        else
          raise RenderError.new(
            "Unsupported AST node: #{node.class}",
            code: "unsupported_ast_node",
            span: node.span,
          )
        end
      end
    end

    def eval_conditional(node, depth:)
      next_depth = depth + 1
      if next_depth > @max_depth
        raise LimitError.new(
          "Evaluation nesting depth #{next_depth} exceeds maximum #{@max_depth}",
          code: "depth_limit_exceeded",
          span: node.span,
        )
      end

      matched = false
      node.arms.each do |arm|
        step!(arm.span)
        cond_val = eval_expr(arm.condition)
        cond_bool = truthy?(cond_val)
        taken = arm.negated ? !cond_bool : cond_bool

        branch_seq = @tracer.record_branch(
          node_id: arm.node_id,
          span: arm.span,
          expression: arm.raw_expression,
          condition: cond_bool,
          taken: taken,
        )

        next unless taken

        matched = true
        @tracer.with_active_branch(branch_seq) do
          eval_block(arm.body, depth: next_depth)
        end
        break
      end

      return if matched || node.else_arm.nil?

      else_arm = node.else_arm
      step!(else_arm.span)
      branch_seq = @tracer.record_branch(
        node_id: else_arm.node_id,
        span: else_arm.span,
        expression: else_arm.raw_expression,
        condition: true,
        taken: true,
      )
      @tracer.with_active_branch(branch_seq) do
        eval_block(else_arm.body, depth: next_depth)
      end
    end

    def eval_for(node, depth:)
      next_depth = depth + 1
      if next_depth > @max_depth
        raise LimitError.new(
          "Evaluation nesting depth #{next_depth} exceeds maximum #{@max_depth}",
          code: "depth_limit_exceeded",
          span: node.span,
        )
      end

      collection = eval_expr(node.collection_expr)
      items = iterable_items(collection)

      if items.empty?
        return unless node.else_body

        step!(node.else_span)
        branch_seq = @tracer.record_branch(
          node_id: node.else_node_id,
          span: node.else_span,
          expression: "else",
          condition: true,
          taken: true,
        )
        @tracer.with_active_branch(branch_seq) do
          eval_block(node.else_body, depth: next_depth)
        end
        return
      end

      loop_scope = {}
      @loop_scopes.push(loop_scope)
      begin
        items.each_with_index do |item, iter_idx|
          step!(node.span)
          loop_scope[node.variable_name] = item
          variant_id = extract_variant_id(item)

          @tracer.with_loop_frame(
            loop_id: node.node_id,
            iteration: iter_idx,
            variant_id: variant_id,
          ) do
            eval_block(node.body, depth: next_depth)
          end
        end
      ensure
        @loop_scopes.pop
      end
    end

    def eval_expr(expr)
      step!(expr.span)

      case expr
      when AST::Literal
        expr.value
      when AST::Path
        found, value = resolve_path(expr.segments)
        @tracer.record_lookup(
          node_id: expr.node_id,
          span: expr.span,
          path: expr.path_string,
          found: found,
          value: value,
        )
        value
      when AST::Compare
        left = eval_expr(expr.left)
        right = eval_expr(expr.right)
        result = eval_comparison(expr.op, left, right, expr.span)
        @tracer.record_comparison(
          node_id: expr.node_id,
          span: expr.span,
          op: expr.op,
          left: left,
          right: right,
          result: result,
        )
        result
      when AST::Logical
        eval_logical(expr)
      when AST::FilterPipeline
        eval_filter_pipeline(expr)
      else
        raise RenderError.new(
          "Unsupported expression node: #{expr.class}",
          code: "unsupported_ast_node",
          span: expr.span,
        )
      end
    end

    def eval_logical(expr)
      cur = expr
      loop do
        left_val = eval_expr(cur.left)
        left_truthy = truthy?(left_val)

        if cur.op == "and"
          return left_val unless left_truthy
        else
          return left_val if left_truthy
        end

        if cur.right.is_a?(AST::Logical)
          step!(cur.right.span)
          cur = cur.right
        else
          return eval_expr(cur.right)
        end
      end
    end

    def eval_comparison(op, left, right, span)
      case op
      when "=="
        left == right
      when "!="
        left != right
      when "<", "<=", ">", ">="
        if (left.is_a?(Numeric) && right.is_a?(Numeric)) || (left.is_a?(String) && right.is_a?(String))
          !!left.public_send(op, right)
        elsif (left.is_a?(Numeric) && right.is_a?(String)) || (left.is_a?(String) && right.is_a?(Numeric))
          raise RenderError.new(
            "Comparison of #{left.class} with #{right.class} failed",
            code: "comparison_error",
            span: span,
          )
        else
          false
        end
      else
        raise RenderError.new("Unsupported comparison operator '#{op}'", code: "invalid_operator", span: span)
      end
    end

    def eval_filter_pipeline(expr)
      val = eval_expr(expr.input_expr)
      expr.stages.each do |stage|
        step!(stage.span)
        args = stage.pos_args.map { |arg_expr| eval_expr(arg_expr) }
        unless stage.kw_args.empty?
          kwargs = {}
          stage.kw_args.each { |k, v_expr| kwargs[k] = eval_expr(v_expr) }
          args << kwargs
        end
        val = invoke_filter(stage.name, val, args, stage.span)
      end
      val
    end

    def invoke_filter(name, input, args, span)
      if @filters.key?(name)
        begin
          return @filters[name].call(input, *args)
        rescue ArgumentError => e
          raise RenderError.new(e.message, code: "filter_error", span: span)
        end
      end

      return apply_default_filter(input, args, span) if name == "default"

      raise UnsupportedFeatureError.new(
        "Filter '#{name}' is not supported",
        code: "unsupported_filter",
        span: span,
      )
    end

    def apply_default_filter(input, args, span)
      if args.length > 2
        raise RenderError.new(
          "wrong number of arguments (given #{args.length + 1}, expected 1..3)",
          code: "filter_error",
          span: span,
        )
      end

      default_value = args.length >= 1 ? args[0] : ""
      options = args.length >= 2 && args[1].is_a?(Hash) ? args[1] : {}
      allow_false = truthy?(options["allow_false"])
      false_check = allow_false ? input.nil? : !truthy?(input)
      is_empty = input.respond_to?(:empty?) && input.empty?
      (false_check || is_empty) ? default_value : input
    end

    def normalize_filters(filters)
      return {}.freeze if filters.nil?

      if filters.is_a?(Hash)
        filters.each_with_object({}) do |(k, v), out|
          raise ArgumentError, "Filter '#{k}' must respond to #call" unless v.respond_to?(:call)

          out[k.to_s] = v
        end.freeze
      elsif filters.is_a?(Module)
        host = Object.new.extend(filters)
        filters.public_instance_methods(false).each_with_object({}) do |m, out|
          out[m.to_s] = host.method(m)
        end.freeze
      else
        raise ArgumentError, "Unsupported filters registry: #{filters.inspect}"
      end
    end

    def resolve_path(segments)
      root = segments[0]
      found, current = lookup_root(root)
      return [false, nil] unless found

      i = 1
      while i < segments.length
        seg = segments[i]
        if current.is_a?(Hash) && current.key?(seg)
          current = current[seg]
        elsif seg == "size" && (current.is_a?(Array) || current.is_a?(String) || current.is_a?(Hash))
          current = current.size
        else
          return [false, nil]
        end
        i += 1
      end

      [true, current]
    end

    def lookup_root(name)
      @loop_scopes.reverse_each do |scope|
        return [true, scope[name]] if scope.key?(name)
      end

      return [true, @root_scope[name]] if @root_scope.key?(name)
      return [true, @env[name]] if @env.key?(name)

      [false, nil]
    end

    def truthy?(val)
      !val.nil? && val != false
    end

    def iterable_items(collection)
      case collection
      when Array
        collection
      when String
        collection.empty? ? [] : [collection]
      when Hash
        collection.to_a
      else
        []
      end
    end

    def extract_variant_id(item)
      return nil unless item.is_a?(Hash)

      id = item["id"]
      id.is_a?(String) ? id : nil
    end

    def append_output(str, node:)
      start_byte = @output.bytesize
      new_size = start_byte + str.bytesize
      if new_size > @max_output_bytes
        raise LimitError.new(
          "Rendered output size #{new_size} bytes exceeds maximum #{@max_output_bytes} bytes",
          code: "output_limit_exceeded",
          span: node.span,
        )
      end

      @output << str
      end_byte = @output.bytesize
      @tracer.record_emit(
        node_id: node.node_id,
        span: node.span,
        output_start_byte: start_byte,
        output_end_byte: end_byte,
      )
    end

    def render_value(val)
      out = String.new(encoding: Encoding::UTF_8)
      append_rendered_value(val, out)
      out
    end

    def append_rendered_value(val, out)
      case val
      when NilClass
        # Nil renders as empty string
      when Array
        val.each { |item| append_rendered_value(item, out) }
      when Hash
        out << hash_inspect(val)
      else
        out << val.to_s
      end
    end

    def hash_inspect(hash)
      parts = hash.map { |k, v| "#{value_inspect(k)}=>#{value_inspect(v)}" }
      "{#{parts.join(", ")}}"
    end

    def value_inspect(val)
      case val
      when Hash
        hash_inspect(val)
      when Array
        "[#{val.map { |item| value_inspect(item) }.join(", ")}]"
      else
        val.inspect
      end
    end

    def deep_copy_json(value)
      Tracer.snapshot(value)
    end
  end
end

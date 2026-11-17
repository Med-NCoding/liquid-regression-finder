# frozen_string_literal: true

module LiquidInterpreter
  class Parser
    MAX_DEPTH = 32

    ASSIGN_VAR_PATTERN = /\A[a-zA-Z_][a-zA-Z0-9_-]*\z/.freeze
    IDENTIFIER_SCAN = /\A[a-zA-Z_][a-zA-Z0-9_-]*\??/.freeze
    FLOAT_SCAN = /\A-?\d+\.\d+/.freeze
    INT_SCAN = /\A-?\d+/.freeze
    TAG_SPLIT_PATTERN = /\A([ \t\r\n\f\v]*)([a-zA-Z_#][a-zA-Z0-9_-]*)([ \t\r\n\f\v]*)(.*)\z/m.freeze

    SUPPORTED_TAGS = %w[if elsif else endif unless endunless for endfor assign liquid].freeze
    STANDARD_FILTERS = %w[default].freeze
    ROOT_LITERALS = {
      "true" => true,
      "false" => false,
      "nil" => nil,
      "null" => nil,
    }.freeze
    UNSUPPORTED_KEYWORDS = %w[empty blank].freeze
    UNSUPPORTED_FOR_MODIFIERS = %w[limit offset reversed].freeze

    def self.parse(tokens, source:, max_depth: MAX_DEPTH, filters: nil)
      new(tokens, source: source, max_depth: max_depth, filters: filters).parse
    end

    def initialize(tokens, source:, max_depth: MAX_DEPTH, filters: nil)
      @tokens = tokens
      @source = source
      @max_depth = Integer(max_depth)
      @extra_filter_names = extract_filter_names(filters)
      @mapper = SpanMapper.new(@source)
      @cursor = 0
    end

    def parse
      raw_children, terminator = parse_body(stop_tags: [], depth: 0)
      if terminator
        raise SyntaxError.new(
          "Unexpected outer '#{terminator[:tag_name]}' tag",
          code: "unexpected_tag",
          span: terminator[:token].span,
        )
      end

      final_children = raw_children.each_with_index.map do |node, idx|
        finalize_stmt(node, idx, nil)
      end

      doc_span = Span.new(start_byte: 0, end_byte: @source.bytesize, line: 1, column: 1)
      AST::Document.new(children: final_children, span: doc_span)
    end

    private

    def parse_body(stop_tags:, depth:)
      nodes = []

      while @cursor < @tokens.length
        token = @tokens[@cursor]
        @cursor += 1

        case token.type
        when :text
          next if token.value.empty?

          nodes << { kind: :text, value: token.value, span: token.span }
        when :output
          nodes << parse_output_token(token)
        when :tag
          tag_name, markup, markup_base_byte = split_tag(token)
          if stop_tags.include?(tag_name)
            return [nodes, { tag_name: tag_name, markup: markup, markup_base_byte: markup_base_byte, token: token }]
          end

          case tag_name
          when "assign"
            nodes << parse_assign_tag(token, markup, markup_base_byte)
          when "liquid"
            nodes.concat(parse_liquid_tag(token, markup, markup_base_byte, depth))
          when "if"
            nodes << parse_conditional_tag(:if, "endif", token, markup, markup_base_byte, depth)
          when "unless"
            nodes << parse_conditional_tag(:unless, "endunless", token, markup, markup_base_byte, depth)
          when "for"
            nodes << parse_for_tag(token, markup, markup_base_byte, depth)
          when "elsif", "else"
            raise SyntaxError.new(
              "Unexpected '#{tag_name}' tag",
              code: "unexpected_tag",
              span: token.span,
            )
          when "endif", "endunless", "endfor"
            raise SyntaxError.new(
              "Unmatched '#{tag_name}' tag",
              code: "unmatched_end_tag",
              span: token.span,
            )
          else
            raise UnsupportedFeatureError.new(
              "Unsupported tag '#{tag_name}'",
              code: "unsupported_tag",
              span: token.span,
            )
          end
        else
          raise SyntaxError.new(
            "Unexpected token type '#{token.type}'",
            code: "unexpected_token",
            span: token.span,
          )
        end
      end

      [nodes, nil]
    end

    def split_tag(token)
      inner = token.value
      if inner.match?(/\A[ \t\r\n\f\v]*\z/)
        raise SyntaxError.new("Empty tag '{% %}' is invalid", code: "invalid_tag", span: token.span)
      end

      m = inner.match(TAG_SPLIT_PATTERN)
      unless m
        raise SyntaxError.new("Invalid tag syntax", code: "invalid_tag", span: token.span)
      end

      tag_name = m[2]
      unless SUPPORTED_TAGS.include?(tag_name)
        raise UnsupportedFeatureError.new(
          "Unsupported tag '#{tag_name}'",
          code: "unsupported_tag",
          span: token.span,
        )
      end

      markup = m[4]
      markup_base_byte = token.inner_span.start_byte + m.byteoffset(4)[0]
      [tag_name, markup, markup_base_byte]
    end

    def parse_output_token(token)
      expr_tokens = tokenize_expression(token.value, token.inner_span.start_byte)
      if expr_tokens.empty?
        return { kind: :output, expression: nil, span: token.span }
      end

      expr, idx = parse_filtered_expression(expr_tokens, 0)
      if idx < expr_tokens.length
        unexpected = expr_tokens[idx]
        raise SyntaxError.new(
          "Unexpected token '#{unexpected[1]}' in output expression",
          code: "syntax_error",
          span: unexpected[2],
        )
      end

      { kind: :output, expression: expr, span: token.span }
    end

    def parse_assign_tag(token, markup, base_byte)
      expr_tokens = tokenize_expression(markup, base_byte)
      if expr_tokens.empty?
        raise SyntaxError.new("Missing variable name in 'assign' tag", code: "syntax_error", span: token.span)
      end

      target_tok = expr_tokens[0]
      unless target_tok[0] == :id && target_tok[1].match?(ASSIGN_VAR_PATTERN)
        raise SyntaxError.new(
          "Invalid variable name '#{target_tok[1]}' in 'assign' tag",
          code: "syntax_error",
          span: target_tok[2],
        )
      end

      if target_tok[1] == "forloop"
        raise UnsupportedFeatureError.new(
          "'forloop' is not supported in Stage 2",
          code: "unsupported_forloop",
          span: target_tok[2],
        )
      end

      eq_tok = expr_tokens[1]
      unless eq_tok && eq_tok[0] == :assign_eq
        err_span = eq_tok ? eq_tok[2] : token.span
        raise SyntaxError.new("Expected '=' in 'assign' tag", code: "syntax_error", span: err_span)
      end

      if expr_tokens.length <= 2
        raise SyntaxError.new("Missing value expression in 'assign' tag", code: "syntax_error", span: token.span)
      end

      value_expr, idx = parse_filtered_expression(expr_tokens, 2)
      if idx < expr_tokens.length
        unexpected = expr_tokens[idx]
        raise SyntaxError.new(
          "Unexpected token '#{unexpected[1]}' in 'assign' tag",
          code: "syntax_error",
          span: unexpected[2],
        )
      end

      { kind: :assign, name: target_tok[1], value_expr: value_expr, span: token.span }
    end

    def parse_liquid_tag(_open_token, markup, base_byte, depth)
      liquid_tokens = tokenize_liquid_tag_lines(markup, base_byte)
      return [] if liquid_tokens.empty?

      prev_tokens = @tokens
      prev_cursor = @cursor
      @tokens = liquid_tokens
      @cursor = 0
      begin
        inner_nodes, terminator = parse_body(stop_tags: [], depth: depth)
        if terminator
          raise SyntaxError.new(
            "Unexpected '#{terminator[:tag_name]}' tag inside 'liquid' tag",
            code: "unexpected_tag",
            span: terminator[:token].span,
          )
        end
        inner_nodes
      ensure
        @tokens = prev_tokens
        @cursor = prev_cursor
      end
    end

    def tokenize_liquid_tag_lines(markup, base_byte)
      tokens = []
      pos = 0
      len = markup.bytesize

      while pos < len
        nl = markup.byteindex("\n", pos)
        line_end = nl || len
        line_raw = markup.byteslice(pos, line_end - pos)
        trimmed_right = line_raw.sub(/[ \t\v\f\r]+\z/, "")

        unless trimmed_right.empty?
          leading_ws = trimmed_right[/\A[ \t\v\f\r]*/]
          content = trimmed_right.byteslice(leading_ws.bytesize, trimmed_right.bytesize - leading_ws.bytesize)
          if content && !content.empty? && !content.start_with?("#")
            abs_start = base_byte + pos + leading_ws.bytesize
            abs_end = abs_start + content.bytesize
            span = @mapper.span_for(abs_start, abs_end)
            tokens << Token.new(
              type: :tag,
              raw: content,
              value: content,
              span: span,
              inner_span: span,
            )
          end
        end

        pos = nl ? nl + 1 : len
      end

      tokens
    end

    def parse_conditional_tag(kind, end_tag, open_token, markup, base_byte, depth)
      next_depth = depth + 1
      if next_depth > @max_depth
        raise LimitError.new(
          "Template nesting depth #{next_depth} exceeds maximum #{@max_depth}",
          code: "depth_limit_exceeded",
          span: open_token.span,
        )
      end

      arms = []
      first_cond = parse_condition_markup(markup, base_byte, open_token.span)
      stop_set = ["elsif", "else", end_tag, "endif", "endunless", "endfor"].uniq
      body, term = parse_body(stop_tags: stop_set, depth: next_depth)
      arms << {
        kind: kind,
        condition: first_cond,
        raw_expression: markup.strip,
        negated: kind == :unless,
        body: body,
        span: open_token.span,
      }

      else_arm = nil
      seen_else = false

      loop do
        unless term
          raise SyntaxError.new(
            "'#{kind}' tag was never closed (expected '#{end_tag}')",
            code: "unclosed_tag",
            span: open_token.span,
          )
        end

        term_name = term[:tag_name]
        term_token = term[:token]

        if term_name == end_tag
          break
        elsif term_name == "elsif"
          if seen_else
            raise SyntaxError.new(
              "Unexpected 'elsif' after 'else'",
              code: "unexpected_tag",
              span: term_token.span,
            )
          end

          elsif_raw = term[:markup].strip
          cond = parse_condition_markup(term[:markup], term[:markup_base_byte], term_token.span)
          arm_body, term = parse_body(stop_tags: stop_set, depth: next_depth)
          arms << {
            kind: :elsif,
            condition: cond,
            raw_expression: elsif_raw,
            negated: false,
            body: arm_body,
            span: term_token.span,
          }
        elsif term_name == "else"
          if seen_else
            raise SyntaxError.new(
              "Duplicate 'else' tag in '#{kind}' block",
              code: "unexpected_tag",
              span: term_token.span,
            )
          end

          ensure_empty_tag_markup!(term[:markup], term[:markup_base_byte], "else")
          seen_else = true
          else_stop = [end_tag, "elsif", "else", "endif", "endunless", "endfor"].uniq
          else_body, term = parse_body(stop_tags: else_stop, depth: next_depth)
          else_arm = {
            kind: :else,
            condition: nil,
            raw_expression: "else",
            negated: false,
            body: else_body,
            span: term_token.span,
          }
        else
          raise SyntaxError.new(
            "'#{term_name}' is not a valid delimiter for '#{kind}' tag (expected '#{end_tag}')",
            code: "mismatched_end_tag",
            span: term_token.span,
          )
        end
      end

      all_blank = arms.all? { |a| raw_body_blank?(a[:body]) } &&
        (else_arm.nil? || raw_body_blank?(else_arm[:body]))

      if all_blank
        arms.each { |a| a[:body].reject! { |n| n[:kind] == :text } }
        else_arm[:body].reject! { |n| n[:kind] == :text } if else_arm
      end

      {
        kind: :conditional,
        cond_kind: kind,
        arms: arms,
        else_arm: else_arm,
        span: open_token.span,
      }
    end

    def parse_for_tag(open_token, markup, base_byte, depth)
      next_depth = depth + 1
      if next_depth > @max_depth
        raise LimitError.new(
          "Template nesting depth #{next_depth} exceeds maximum #{@max_depth}",
          code: "depth_limit_exceeded",
          span: open_token.span,
        )
      end

      expr_tokens = tokenize_expression(markup, base_byte)
      if expr_tokens.empty?
        raise SyntaxError.new("Invalid 'for' tag syntax", code: "syntax_error", span: open_token.span)
      end

      var_tok = expr_tokens[0]
      unless var_tok[0] == :id && var_tok[1].match?(ASSIGN_VAR_PATTERN)
        raise SyntaxError.new(
          "Invalid loop variable '#{var_tok[1]}' in 'for' tag",
          code: "syntax_error",
          span: var_tok[2],
        )
      end

      if var_tok[1] == "forloop"
        raise UnsupportedFeatureError.new(
          "'forloop' is not supported in Stage 2",
          code: "unsupported_forloop",
          span: var_tok[2],
        )
      end

      in_tok = expr_tokens[1]
      unless in_tok && in_tok[0] == :id && in_tok[1] == "in"
        err_span = in_tok ? in_tok[2] : open_token.span
        raise SyntaxError.new("Expected 'in' in 'for' tag", code: "syntax_error", span: err_span)
      end

      if expr_tokens.length <= 2
        raise SyntaxError.new("Missing collection in 'for' tag", code: "syntax_error", span: open_token.span)
      end

      collection_expr, idx = parse_operand(expr_tokens, 2)
      if idx < expr_tokens.length
        extra = expr_tokens[idx]
        if (extra[0] == :id && UNSUPPORTED_FOR_MODIFIERS.include?(extra[1])) || extra[0] == :comma
          raise UnsupportedFeatureError.new(
            "For-loop modifier '#{extra[1]}' is not supported in Stage 2",
            code: "unsupported_for_modifier",
            span: extra[2],
          )
        end

        raise SyntaxError.new(
          "Unexpected token '#{extra[1]}' in 'for' tag",
          code: "syntax_error",
          span: extra[2],
        )
      end

      stop_set = %w[else endfor elsif endif endunless].freeze
      body, term = parse_body(stop_tags: stop_set, depth: next_depth)
      else_body = nil
      else_span = nil

      loop do
        unless term
          raise SyntaxError.new(
            "'for' tag was never closed (expected 'endfor')",
            code: "unclosed_tag",
            span: open_token.span,
          )
        end

        term_name = term[:tag_name]
        term_token = term[:token]

        if term_name == "endfor"
          break
        elsif term_name == "else"
          if else_body
            raise SyntaxError.new(
              "Duplicate 'else' tag in 'for' block",
              code: "unexpected_tag",
              span: term_token.span,
            )
          end

          ensure_empty_tag_markup!(term[:markup], term[:markup_base_byte], "else")
          else_span = term_token.span
          else_body, term = parse_body(stop_tags: stop_set, depth: next_depth)
        elsif term_name == "elsif"
          raise SyntaxError.new(
            "'elsif' is not valid inside a 'for' tag",
            code: "unexpected_tag",
            span: term_token.span,
          )
        else
          raise SyntaxError.new(
            "'#{term_name}' is not a valid delimiter for 'for' tag (expected 'endfor')",
            code: "mismatched_end_tag",
            span: term_token.span,
          )
        end
      end

      all_blank = raw_body_blank?(body) && (else_body.nil? || raw_body_blank?(else_body))
      if all_blank
        body.reject! { |n| n[:kind] == :text }
        else_body&.reject! { |n| n[:kind] == :text }
      end

      {
        kind: :for,
        variable_name: var_tok[1],
        collection_expr: collection_expr,
        body: body,
        else_body: else_body,
        else_span: else_span,
        span: open_token.span,
      }
    end

    def ensure_empty_tag_markup!(markup, base_byte, tag_name)
      toks = tokenize_expression(markup, base_byte)
      return if toks.empty?

      raise SyntaxError.new(
        "Tag '#{tag_name}' does not accept arguments",
        code: "syntax_error",
        span: toks[0][2],
      )
    end

    def parse_condition_markup(markup, base_byte, tag_span)
      expr_tokens = tokenize_expression(markup, base_byte)
      if expr_tokens.empty?
        raise SyntaxError.new("Missing condition expression", code: "syntax_error", span: tag_span)
      end

      comparisons = []
      operators = []

      comp, idx = parse_comparison(expr_tokens, 0)
      comparisons << comp

      while idx < expr_tokens.length
        tok = expr_tokens[idx]
        if tok[0] == :id && (tok[1] == "and" || tok[1] == "or")
          operators << tok[1]
          idx += 1
          if idx >= expr_tokens.length
            raise SyntaxError.new(
              "Expected condition after '#{tok[1]}'",
              code: "syntax_error",
              span: tok[2],
            )
          end
          comp, idx = parse_comparison(expr_tokens, idx)
          comparisons << comp
        else
          raise SyntaxError.new(
            "Unexpected token '#{tok[1]}' in condition expression",
            code: "syntax_error",
            span: tok[2],
          )
        end
      end

      # Liquid groups chained `and` / `or` right-associatively.
      expr = comparisons.last
      (operators.length - 1).downto(0) do |i|
        left = comparisons[i]
        op = operators[i]
        span = @mapper.span_for(left[:span].start_byte, expr[:span].end_byte)
        expr = { kind: :logical, op: op, left: left, right: expr, span: span }
      end
      expr
    end

    def parse_comparison(expr_tokens, idx)
      left, idx = parse_operand(expr_tokens, idx)
      tok = expr_tokens[idx]
      if tok && tok[0] == :comparison
        op = tok[1]
        op_span = tok[2]
        idx += 1
        if idx >= expr_tokens.length
          raise SyntaxError.new(
            "Expected right operand after '#{op}'",
            code: "syntax_error",
            span: op_span,
          )
        end
        right, idx = parse_operand(expr_tokens, idx)
        span = @mapper.span_for(left[:span].start_byte, right[:span].end_byte)
        [{ kind: :compare, op: op, left: left, right: right, span: span }, idx]
      else
        [left, idx]
      end
    end

    def parse_filtered_expression(expr_tokens, idx)
      base_expr, idx = parse_operand(expr_tokens, idx)
      return [base_expr, idx] unless idx < expr_tokens.length && expr_tokens[idx][0] == :pipe

      stages = []
      last_span = base_expr[:span]

      while idx < expr_tokens.length && expr_tokens[idx][0] == :pipe
        pipe_tok = expr_tokens[idx]
        idx += 1

        name_tok = expr_tokens[idx]
        unless name_tok
          raise SyntaxError.new(
            "Expected filter name after '|'",
            code: "syntax_error",
            span: pipe_tok[2],
          )
        end
        unless name_tok[0] == :id
          raise SyntaxError.new(
            "Expected filter name, got '#{name_tok[1]}'",
            code: "syntax_error",
            span: name_tok[2],
          )
        end

        filter_name = name_tok[1]
        unless filter_supported?(filter_name)
          raise UnsupportedFeatureError.new(
            "Filter '#{filter_name}' is not supported",
            code: "unsupported_filter",
            span: pipe_tok[2],
          )
        end

        stage_end_span = name_tok[2]
        idx += 1
        pos_args = []
        kw_args = []

        if idx < expr_tokens.length && expr_tokens[idx][0] == :colon
          colon_tok = expr_tokens[idx]
          stage_end_span = colon_tok[2]
          idx += 1

          unless at_filter_arg_end?(expr_tokens, idx)
            arg_span, idx = parse_filter_argument(expr_tokens, idx, pos_args, kw_args)
            stage_end_span = arg_span

            while idx < expr_tokens.length && expr_tokens[idx][0] == :comma
              stage_end_span = expr_tokens[idx][2]
              idx += 1
              break if at_filter_arg_end?(expr_tokens, idx)

              arg_span, idx = parse_filter_argument(expr_tokens, idx, pos_args, kw_args)
              stage_end_span = arg_span
            end
          end
        end

        stage_span = @mapper.span_for(pipe_tok[2].start_byte, stage_end_span.end_byte)
        stages << {
          name: filter_name,
          pos_args: pos_args,
          kw_args: kw_args,
          span: stage_span,
        }
        last_span = stage_span
      end

      pipeline_span = @mapper.span_for(base_expr[:span].start_byte, last_span.end_byte)
      [
        {
          kind: :filter_pipeline,
          input_expr: base_expr,
          stages: stages,
          span: pipeline_span,
        },
        idx,
      ]
    end

    def parse_filter_argument(expr_tokens, idx, pos_args, kw_args)
      tok = expr_tokens[idx]
      next_tok = expr_tokens[idx + 1]
      if tok && tok[0] == :id && next_tok && next_tok[0] == :colon
        key = tok[1]
        colon_tok = next_tok
        idx += 2
        if idx >= expr_tokens.length
          raise SyntaxError.new(
            "Expected value expression after '#{key}:'",
            code: "syntax_error",
            span: colon_tok[2],
          )
        end
        val_expr, idx = parse_operand(expr_tokens, idx)
        kw_args << [key, val_expr]
        [val_expr[:span], idx]
      else
        val_expr, idx = parse_operand(expr_tokens, idx)
        pos_args << val_expr
        [val_expr[:span], idx]
      end
    end

    def at_filter_arg_end?(expr_tokens, idx)
      idx >= expr_tokens.length || expr_tokens[idx][0] == :pipe
    end

    def filter_supported?(name)
      STANDARD_FILTERS.include?(name) || @extra_filter_names.include?(name)
    end

    def extract_filter_names(filters)
      return [].freeze if filters.nil?

      if filters.is_a?(Hash)
        filters.keys.map(&:to_s).freeze
      elsif filters.is_a?(Module)
        filters.public_instance_methods(false).map(&:to_s).freeze
      elsif filters.respond_to?(:map)
        filters.map(&:to_s).freeze
      else
        raise ArgumentError, "Unsupported filters registry: #{filters.inspect}"
      end
    end

    def parse_operand(expr_tokens, idx)
      tok = expr_tokens[idx]
      unless tok
        raise SyntaxError.new("Expected operand", code: "syntax_error")
      end

      case tok[0]
      when :string, :number
        [{ kind: :literal, value: tok[1], span: tok[2] }, idx + 1]
      when :id
        root_name = tok[1]
        first_span = tok[2]
        next_tok = expr_tokens[idx + 1]

        if next_tok && next_tok[0] == :dot
          if root_name == "forloop"
            raise UnsupportedFeatureError.new(
              "'forloop' is not supported in Stage 2",
              code: "unsupported_forloop",
              span: first_span,
            )
          end

          segments = [root_name]
          last_span = first_span
          cur = idx + 1

          while expr_tokens[cur] && expr_tokens[cur][0] == :dot
            dot_span = expr_tokens[cur][2]
            cur += 1
            seg_tok = expr_tokens[cur]
            unless seg_tok && seg_tok[0] == :id
              err_span = seg_tok ? seg_tok[2] : dot_span
              raise SyntaxError.new(
                "Expected property identifier after '.'",
                code: "syntax_error",
                span: err_span,
              )
            end
            segments << seg_tok[1]
            last_span = seg_tok[2]
            cur += 1
          end

          span = @mapper.span_for(first_span.start_byte, last_span.end_byte)
          [{ kind: :path, segments: segments, span: span }, cur]
        else
          if UNSUPPORTED_KEYWORDS.include?(root_name)
            raise UnsupportedFeatureError.new(
              "Keyword '#{root_name}' is not supported in Stage 2",
              code: "unsupported_keyword",
              span: first_span,
            )
          end

          if root_name == "forloop"
            raise UnsupportedFeatureError.new(
              "'forloop' is not supported in Stage 2",
              code: "unsupported_forloop",
              span: first_span,
            )
          end

          if ROOT_LITERALS.key?(root_name)
            [{ kind: :literal, value: ROOT_LITERALS[root_name], span: first_span }, idx + 1]
          else
            [{ kind: :path, segments: [root_name], span: first_span }, idx + 1]
          end
        end
      else
        raise SyntaxError.new(
          "Expected literal or variable, got '#{tok[1]}'",
          code: "syntax_error",
          span: tok[2],
        )
      end
    end

    def tokenize_expression(text, base_byte)
      tokens = []
      pos = 0
      len = text.bytesize

      while pos < len
        byte = text.getbyte(pos)
        if byte == 32 || byte == 9 || byte == 10 || byte == 13 || byte == 12 || byte == 11
          pos += 1
          next
        end

        if byte == 39 || byte == 34 # '\'' or '"'
          quote_byte = byte
          close = text.byteindex(quote_byte.chr, pos + 1)
          if close.nil?
            raise SyntaxError.new(
              "Unterminated string literal",
              code: "unterminated_string",
              span: @mapper.span_for(base_byte + pos, base_byte + pos + 1),
            )
          end
          val = text.byteslice(pos + 1, close - pos - 1)
          span = @mapper.span_for(base_byte + pos, base_byte + close + 1)
          tokens << [:string, val, span]
          pos = close + 1
          next
        end

        if byte == 46 # '.'
          if pos + 1 < len && text.getbyte(pos + 1) == 46
            span = @mapper.span_for(base_byte + pos, base_byte + pos + 2)
            raise UnsupportedFeatureError.new(
              "Range operator '..' is not supported in Stage 2",
              code: "unsupported_range",
              span: span,
            )
          end
          tokens << [:dot, ".", @mapper.span_for(base_byte + pos, base_byte + pos + 1)]
          pos += 1
          next
        end

        if byte == 124 # '|'
          tokens << [:pipe, "|", @mapper.span_for(base_byte + pos, base_byte + pos + 1)]
          pos += 1
          next
        end

        if byte == 91 || byte == 93 # '[' or ']'
          raise UnsupportedFeatureError.new(
            "Bracket access is not supported in Stage 2",
            code: "unsupported_bracket_access",
            span: @mapper.span_for(base_byte + pos, base_byte + pos + 1),
          )
        end

        if byte == 40 || byte == 41 # '(' or ')'
          raise UnsupportedFeatureError.new(
            "Parentheses and ranges are not supported in Stage 2",
            code: "unsupported_syntax",
            span: @mapper.span_for(base_byte + pos, base_byte + pos + 1),
          )
        end

        if byte == 44 # ','
          tokens << [:comma, ",", @mapper.span_for(base_byte + pos, base_byte + pos + 1)]
          pos += 1
          next
        end

        if byte == 58 # ':'
          tokens << [:colon, ":", @mapper.span_for(base_byte + pos, base_byte + pos + 1)]
          pos += 1
          next
        end

        if byte == 61 # '='
          if pos + 1 < len && text.getbyte(pos + 1) == 61
            tokens << [:comparison, "==", @mapper.span_for(base_byte + pos, base_byte + pos + 2)]
            pos += 2
          else
            tokens << [:assign_eq, "=", @mapper.span_for(base_byte + pos, base_byte + pos + 1)]
            pos += 1
          end
          next
        end

        if byte == 33 # '!'
          if pos + 1 < len && text.getbyte(pos + 1) == 61
            tokens << [:comparison, "!=", @mapper.span_for(base_byte + pos, base_byte + pos + 2)]
            pos += 2
            next
          end
          raise SyntaxError.new(
            "Unexpected character '!'",
            code: "unexpected_character",
            span: @mapper.span_for(base_byte + pos, base_byte + pos + 1),
          )
        end

        if byte == 60 # '<'
          if pos + 1 < len && text.getbyte(pos + 1) == 61
            tokens << [:comparison, "<=", @mapper.span_for(base_byte + pos, base_byte + pos + 2)]
            pos += 2
          elsif pos + 1 < len && text.getbyte(pos + 1) == 62
            raise UnsupportedFeatureError.new(
              "Operator '<>' is not supported in Stage 2 (use '!=')",
              code: "unsupported_operator",
              span: @mapper.span_for(base_byte + pos, base_byte + pos + 2),
            )
          else
            tokens << [:comparison, "<", @mapper.span_for(base_byte + pos, base_byte + pos + 1)]
            pos += 1
          end
          next
        end

        if byte == 62 # '>'
          if pos + 1 < len && text.getbyte(pos + 1) == 61
            tokens << [:comparison, ">=", @mapper.span_for(base_byte + pos, base_byte + pos + 2)]
            pos += 2
          else
            tokens << [:comparison, ">", @mapper.span_for(base_byte + pos, base_byte + pos + 1)]
            pos += 1
          end
          next
        end

        rest = text.byteslice(pos, len - pos)

        if (byte >= 48 && byte <= 57) || (byte == 45 && pos + 1 < len && text.getbyte(pos + 1) >= 48 && text.getbyte(pos + 1) <= 57)
          if (fm = rest.match(FLOAT_SCAN))
            span = @mapper.span_for(base_byte + pos, base_byte + pos + fm[0].bytesize)
            raise UnsupportedFeatureError.new(
              "Float literals are not supported in Stage 2",
              code: "unsupported_float",
              span: span,
            )
          end

          im = rest.match(INT_SCAN)
          lexeme = im[0]
          span = @mapper.span_for(base_byte + pos, base_byte + pos + lexeme.bytesize)
          tokens << [:number, Integer(lexeme, 10), span]
          pos += lexeme.bytesize
          next
        end

        if (idm = rest.match(IDENTIFIER_SCAN))
          lexeme = idm[0]
          span = @mapper.span_for(base_byte + pos, base_byte + pos + lexeme.bytesize)
          if lexeme == "contains" && tokens.last&.first != :dot
            raise UnsupportedFeatureError.new(
              "Operator 'contains' is not supported in Stage 2",
              code: "unsupported_operator",
              span: span,
            )
          end
          tokens << [:id, lexeme, span]
          pos += lexeme.bytesize
          next
        end

        char = rest[0]
        char_len = char ? char.bytesize : 1
        raise SyntaxError.new(
          "Unexpected character '#{char}'",
          code: "unexpected_character",
          span: @mapper.span_for(base_byte + pos, base_byte + pos + char_len),
        )
      end

      tokens
    end

    def raw_body_blank?(raw_nodes)
      raw_nodes.all? do |n|
        case n[:kind]
        when :text
          n[:value].match?(/\A\s*\z/)
        when :assign
          true
        when :conditional
          n[:arms].all? { |a| raw_body_blank?(a[:body]) } &&
            (n[:else_arm].nil? || raw_body_blank?(n[:else_arm][:body]))
        when :for
          raw_body_blank?(n[:body]) && (n[:else_body].nil? || raw_body_blank?(n[:else_body]))
        else
          false
        end
      end
    end

    def finalize_stmt(raw, idx, prefix)
      kind_name = raw[:kind].to_s
      base_id = prefix ? "#{prefix}#{idx}" : "n#{idx}"
      node_id = "#{base_id}:#{kind_name}"

      case raw[:kind]
      when :text
        AST::Text.new(value: raw[:value], span: raw[:span], node_id: node_id)
      when :output
        expr = raw[:expression] ? finalize_expr(raw[:expression], "#{node_id}.expr") : nil
        AST::Output.new(expression: expr, span: raw[:span], node_id: node_id)
      when :assign
        val_expr = finalize_expr(raw[:value_expr], "#{node_id}.val")
        AST::Assign.new(name: raw[:name], value_expr: val_expr, span: raw[:span], node_id: node_id)
      when :conditional
        arms = raw[:arms].each_with_index.map do |arm, arm_idx|
          arm_prefix = "#{node_id}.a#{arm_idx}"
          cond = finalize_expr(arm[:condition], "#{arm_prefix}.cond")
          arm_body = arm[:body].each_with_index.map do |child, c_idx|
            finalize_stmt(child, c_idx, "#{arm_prefix}.b")
          end
          AST::ConditionalArm.new(
            kind: arm[:kind],
            condition: cond,
            raw_expression: arm[:raw_expression],
            negated: arm[:negated],
            body: arm_body,
            span: arm[:span],
            node_id: "#{arm_prefix}:branch",
          )
        end

        else_arm = if raw[:else_arm]
          else_prefix = "#{node_id}.else"
          else_body = raw[:else_arm][:body].each_with_index.map do |child, c_idx|
            finalize_stmt(child, c_idx, "#{else_prefix}.b")
          end
          AST::ConditionalArm.new(
            kind: :else,
            condition: nil,
            raw_expression: "else",
            negated: false,
            body: else_body,
            span: raw[:else_arm][:span],
            node_id: "#{else_prefix}:branch",
          )
        end

        AST::Conditional.new(
          kind: raw[:cond_kind],
          arms: arms,
          else_arm: else_arm,
          span: raw[:span],
          node_id: node_id,
        )
      when :for
        coll = finalize_expr(raw[:collection_expr], "#{node_id}.coll")
        for_body = raw[:body].each_with_index.map do |child, c_idx|
          finalize_stmt(child, c_idx, "#{node_id}.b")
        end
        else_body = if raw[:else_body]
          raw[:else_body].each_with_index.map do |child, c_idx|
            finalize_stmt(child, c_idx, "#{node_id}.e")
          end
        end
        else_node_id = else_body ? "#{node_id}.else:branch" : nil

        AST::For.new(
          variable_name: raw[:variable_name],
          collection_expr: coll,
          body: for_body,
          else_body: else_body,
          else_span: raw[:else_span],
          else_node_id: else_node_id,
          span: raw[:span],
          node_id: node_id,
        )
      else
        raise SyntaxError.new("Unknown AST node kind '#{raw[:kind]}'", code: "syntax_error", span: raw[:span])
      end
    end

    def finalize_expr(raw, path)
      case raw[:kind]
      when :literal
        AST::Literal.new(value: raw[:value], span: raw[:span], node_id: "#{path}:literal")
      when :path
        AST::Path.new(segments: raw[:segments], span: raw[:span], node_id: "#{path}:lookup")
      when :compare
        left = finalize_expr(raw[:left], "#{path}.l")
        right = finalize_expr(raw[:right], "#{path}.r")
        AST::Compare.new(op: raw[:op], left: left, right: right, span: raw[:span], node_id: "#{path}:comparison")
      when :logical
        left = finalize_expr(raw[:left], "#{path}.l")
        right = finalize_expr(raw[:right], "#{path}.r")
        AST::Logical.new(op: raw[:op], left: left, right: right, span: raw[:span], node_id: "#{path}:logical")
      when :filter_pipeline
        input_expr = finalize_expr(raw[:input_expr], "#{path}.in")
        stages = raw[:stages].each_with_index.map do |st, s_idx|
          stage_prefix = "#{path}.f#{s_idx}"
          pos_args = st[:pos_args].each_with_index.map do |arg, a_idx|
            finalize_expr(arg, "#{stage_prefix}.p#{a_idx}")
          end
          kw_args = st[:kw_args].each_with_index.map do |(k, v_expr), k_idx|
            [k, finalize_expr(v_expr, "#{stage_prefix}.k#{k_idx}")]
          end
          AST::FilterStage.new(
            name: st[:name],
            pos_args: pos_args,
            kw_args: kw_args,
            span: st[:span],
            node_id: "#{stage_prefix}:filter",
          )
        end
        AST::FilterPipeline.new(
          input_expr: input_expr,
          stages: stages,
          span: raw[:span],
          node_id: "#{path}:pipeline",
        )
      else
        raise SyntaxError.new("Unknown expression kind '#{raw[:kind]}'", code: "syntax_error", span: raw[:span])
      end
    end
  end
end

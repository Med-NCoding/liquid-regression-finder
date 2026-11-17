# frozen_string_literal: true

module LiquidInterpreter
  class Token
    attr_reader :type, :raw, :value, :span, :trim_left, :trim_right, :inner_span

    def initialize(type:, raw:, value:, span:, trim_left: false, trim_right: false, inner_span: nil)
      @type = type
      @raw = raw.dup.freeze
      @value = value.dup.freeze
      @span = span
      @trim_left = !!trim_left
      @trim_right = !!trim_right
      @inner_span = inner_span
      freeze
    end
  end

  class Lexer
    MAX_SNIPPET_BYTES = 16_384
    ASCII_LEADING_WS = /\A[ \t\r\n\f\v]+/.freeze
    ASCII_TRAILING_WS = /[ \t\r\n\f\v]+\z/.freeze

    OPEN_BRACE_BYTE = "{".getbyte(0)
    CLOSE_BRACE_BYTE = "}".getbyte(0)
    PERCENT_BYTE = "%".getbyte(0)
    DASH_BYTE = "-".getbyte(0)

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

    def self.tokenize(source, max_snippet_bytes: MAX_SNIPPET_BYTES)
      new(source, max_snippet_bytes: max_snippet_bytes).tokenize
    end

    def initialize(source, max_snippet_bytes: MAX_SNIPPET_BYTES)
      @source = self.class.normalize_utf8(source)
      @max_snippet_bytes = Integer(max_snippet_bytes)
    end

    def tokenize
      if @source.bytesize > @max_snippet_bytes
        raise LimitError.new(
          "Template snippet size #{@source.bytesize} bytes exceeds maximum #{@max_snippet_bytes} bytes",
          code: "snippet_too_large",
          span: nil,
        )
      end

      return [] if @source.empty?

      mapper = SpanMapper.new(@source)
      raw_tokens = []
      pos = 0
      len = @source.bytesize
      trim_next = false

      while pos < len
        byte_a = @source.getbyte(pos)
        byte_b = pos + 1 < len ? @source.getbyte(pos + 1) : nil

        if byte_a == OPEN_BRACE_BYTE && byte_b == OPEN_BRACE_BYTE
          end_byte = scan_output_end(pos, len, mapper)
          raw = @source.byteslice(pos, end_byte - pos)
          trim_left = raw.getbyte(2) == DASH_BYTE
          trim_right = raw.getbyte(raw.bytesize - 3) == DASH_BYTE
          trim_previous_text!(raw_tokens) if trim_left
          trim_next = trim_right

          inner_start_rel = trim_left ? 3 : 2
          inner_end_rel = (trim_right && raw.bytesize - inner_start_rel >= 3) ? raw.bytesize - 3 : raw.bytesize - 2
          inner = raw.byteslice(inner_start_rel, inner_end_rel - inner_start_rel)
          inner_span = mapper.span_for(pos + inner_start_rel, pos + inner_end_rel)

          raw_tokens << {
            type: :output,
            raw: raw,
            value: inner,
            span: mapper.span_for(pos, end_byte),
            trim_left: trim_left,
            trim_right: trim_right,
            inner_span: inner_span,
          }
          pos = end_byte
        elsif byte_a == OPEN_BRACE_BYTE && byte_b == PERCENT_BYTE
          end_byte = scan_tag_end(pos, len, mapper)
          raw = @source.byteslice(pos, end_byte - pos)
          trim_left = raw.getbyte(2) == DASH_BYTE
          trim_right = raw.getbyte(raw.bytesize - 3) == DASH_BYTE
          trim_previous_text!(raw_tokens) if trim_left
          trim_next = trim_right

          inner_start_rel = trim_left ? 3 : 2
          inner_end_rel = (trim_right && raw.bytesize - inner_start_rel >= 3) ? raw.bytesize - 3 : raw.bytesize - 2
          inner = raw.byteslice(inner_start_rel, inner_end_rel - inner_start_rel)
          inner_span = mapper.span_for(pos + inner_start_rel, pos + inner_end_rel)

          raw_tokens << {
            type: :tag,
            raw: raw,
            value: inner,
            span: mapper.span_for(pos, end_byte),
            trim_left: trim_left,
            trim_right: trim_right,
            inner_span: inner_span,
          }
          pos = end_byte
        else
          search_from = byte_a == OPEN_BRACE_BYTE ? pos + 1 : pos
          next_var = @source.byteindex("{{", search_from)
          next_tag = @source.byteindex("{%", search_from)
          end_byte = [next_var, next_tag].compact.min || len

          raw = @source.byteslice(pos, end_byte - pos)
          val = trim_next ? raw.sub(ASCII_LEADING_WS, "") : raw.dup
          trim_next = false

          raw_tokens << {
            type: :text,
            raw: raw,
            value: val,
            span: mapper.span_for(pos, end_byte),
            trim_left: false,
            trim_right: false,
            inner_span: nil,
          }
          pos = end_byte
        end
      end

      raw_tokens.map { |entry| Token.new(**entry) }.freeze
    end

    private

    def trim_previous_text!(raw_tokens)
      prev = raw_tokens.last
      return unless prev && prev[:type] == :text

      prev[:value] = prev[:value].sub(ASCII_TRAILING_WS, "")
    end

    def scan_output_end(start_pos, len, mapper)
      scan = start_pos + 2
      while scan < len
        b = @source.getbyte(scan)
        if b == CLOSE_BRACE_BYTE
          if scan + 1 < len && @source.getbyte(scan + 1) == CLOSE_BRACE_BYTE
            return scan + 2
          end

          raise SyntaxError.new(
            "Variable '{{' was not properly terminated with '}}'",
            code: "unterminated_output",
            span: mapper.span_for(start_pos, start_pos + 2),
          )
        elsif b == OPEN_BRACE_BYTE && scan + 1 < len && @source.getbyte(scan + 1) == PERCENT_BYTE
          raise SyntaxError.new(
            "Variable '{{' was not properly terminated before '{%'",
            code: "unterminated_output",
            span: mapper.span_for(start_pos, start_pos + 2),
          )
        end
        scan += 1
      end

      raise SyntaxError.new(
        "Variable '{{' was not properly terminated with '}}'",
        code: "unterminated_output",
        span: mapper.span_for(start_pos, start_pos + 2),
      )
    end

    def scan_tag_end(start_pos, _len, mapper)
      close = @source.byteindex("%}", start_pos + 2)
      if close.nil?
        raise SyntaxError.new(
          "Tag '{%' was not properly terminated with '%}'",
          code: "unterminated_tag",
          span: mapper.span_for(start_pos, start_pos + 2),
        )
      end

      close + 2
    end
  end
end

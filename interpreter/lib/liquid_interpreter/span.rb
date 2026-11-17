# frozen_string_literal: true

module LiquidInterpreter
  # Half-open UTF-8 byte offsets with 1-based line and Unicode code-point column.
  class Span
    attr_reader :start_byte, :end_byte, :line, :column

    def initialize(start_byte:, end_byte:, line:, column:)
      @start_byte = Integer(start_byte)
      @end_byte = Integer(end_byte)
      @line = Integer(line)
      @column = Integer(column)
      raise ArgumentError, "start_byte must be >= 0" if @start_byte.negative?
      raise ArgumentError, "end_byte must be >= start_byte" if @end_byte < @start_byte
      raise ArgumentError, "line must be >= 1" if @line < 1
      raise ArgumentError, "column must be >= 1" if @column < 1

      freeze
    end

    def self.at_byte_offset(source, start_byte, end_byte)
      prefix = source.byteslice(0, start_byte) || +""
      newline_count = prefix.count("\n")
      line = newline_count + 1
      last_nl_byte = prefix.byterindex("\n")
      line_prefix = last_nl_byte ? prefix.byteslice((last_nl_byte + 1)..) : prefix
      column = line_prefix.length + 1
      new(start_byte: start_byte, end_byte: end_byte, line: line, column: column)
    end

    def to_h
      {
        "start_byte" => @start_byte,
        "end_byte" => @end_byte,
        "line" => @line,
        "column" => @column,
      }
    end

    def ==(other)
      other.is_a?(Span) &&
        @start_byte == other.start_byte &&
        @end_byte == other.end_byte &&
        @line == other.line &&
        @column == other.column
    end
  end
end

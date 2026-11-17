# frozen_string_literal: true

module LiquidInterpreter
  class Parser
    def self.parse(tokens, source:)
      new(tokens, source: source).parse
    end

    def initialize(tokens, source:)
      @tokens = tokens
      @source = source
    end

    def parse
      children = @tokens.each_with_index.map do |token, idx|
        case token.type
        when :text
          AST::Text.new(value: token.value, span: token.span, node_id: "n#{idx}:text")
        else
          raise SyntaxError.new(
            "Unexpected token type '#{token.type}'",
            code: "unexpected_token",
            span: token.span,
          )
        end
      end

      doc_span = Span.new(start_byte: 0, end_byte: @source.bytesize, line: 1, column: 1)
      AST::Document.new(children: children, span: doc_span)
    end
  end
end

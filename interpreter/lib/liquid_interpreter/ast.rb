# frozen_string_literal: true

module LiquidInterpreter
  module AST
    class Node
      attr_reader :node_id, :span

      def initialize(node_id:, span:)
        @node_id = String(node_id)
        @span = span
      end
    end

    class Document < Node
      attr_reader :children

      def initialize(children:, span:, node_id: "doc")
        super(node_id: node_id, span: span)
        @children = children.freeze
        freeze
      end
    end

    class Text < Node
      attr_reader :value

      def initialize(value:, span:, node_id:)
        super(node_id: node_id, span: span)
        @value = String(value).freeze
        freeze
      end
    end
  end
end

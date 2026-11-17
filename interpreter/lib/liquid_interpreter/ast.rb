# frozen_string_literal: true

module LiquidInterpreter
  module AST
    class Node
      attr_reader :node_id, :span

      def initialize(node_id:, span:)
        @node_id = String(node_id).freeze
        @span = span
      end

      def blank?
        false
      end
    end

    class Document < Node
      attr_reader :children

      def initialize(children:, span:, node_id: "doc")
        super(node_id: node_id, span: span)
        @children = children.dup.freeze
        freeze
      end
    end

    class Text < Node
      attr_reader :value

      def initialize(value:, span:, node_id:)
        super(node_id: node_id, span: span)
        @value = String(value).dup.freeze
        freeze
      end

      def blank?
        @value.match?(/\A\s*\z/)
      end
    end

    class Output < Node
      attr_reader :expression

      def initialize(expression:, span:, node_id:)
        super(node_id: node_id, span: span)
        @expression = expression
        freeze
      end
    end

    class Assign < Node
      attr_reader :name, :value_expr

      def initialize(name:, value_expr:, span:, node_id:)
        super(node_id: node_id, span: span)
        @name = String(name).dup.freeze
        @value_expr = value_expr
        freeze
      end

      def blank?
        true
      end
    end

    class ConditionalArm < Node
      attr_reader :kind, :condition, :raw_expression, :negated, :body

      def initialize(kind:, condition:, raw_expression:, negated:, body:, span:, node_id:)
        super(node_id: node_id, span: span)
        @kind = kind
        @condition = condition
        @raw_expression = String(raw_expression).dup.freeze
        @negated = !!negated
        @body = body.dup.freeze
        freeze
      end

      def blank?
        @body.all?(&:blank?)
      end
    end

    class Conditional < Node
      attr_reader :kind, :arms, :else_arm

      def initialize(kind:, arms:, else_arm: nil, span:, node_id:)
        super(node_id: node_id, span: span)
        @kind = kind
        @arms = arms.dup.freeze
        @else_arm = else_arm
        freeze
      end

      def else_body
        @else_arm&.body
      end

      def blank?
        @arms.all?(&:blank?) && (@else_arm.nil? || @else_arm.blank?)
      end
    end

    class For < Node
      attr_reader :variable_name, :collection_expr, :body, :else_body, :else_span, :else_node_id

      def initialize(variable_name:, collection_expr:, body:, else_body: nil, else_span: nil, else_node_id: nil, span:, node_id:)
        super(node_id: node_id, span: span)
        @variable_name = String(variable_name).dup.freeze
        @collection_expr = collection_expr
        @body = body.dup.freeze
        @else_body = else_body&.dup&.freeze
        @else_span = else_span
        @else_node_id = else_node_id&.dup&.freeze
        freeze
      end

      def blank?
        @body.all?(&:blank?) && (@else_body.nil? || @else_body.all?(&:blank?))
      end
    end

    class Expr < Node
    end

    class Literal < Expr
      attr_reader :value

      def initialize(value:, span:, node_id:)
        super(node_id: node_id, span: span)
        @value = value.is_a?(String) ? value.dup.freeze : value
        freeze
      end
    end

    class Path < Expr
      attr_reader :segments, :path_string

      def initialize(segments:, span:, node_id:)
        super(node_id: node_id, span: span)
        @segments = segments.map { |s| String(s).dup.freeze }.freeze
        @path_string = @segments.join(".").freeze
        freeze
      end
    end

    class Compare < Expr
      attr_reader :op, :left, :right

      def initialize(op:, left:, right:, span:, node_id:)
        super(node_id: node_id, span: span)
        @op = String(op).dup.freeze
        @left = left
        @right = right
        freeze
      end
    end

    class Logical < Expr
      attr_reader :op, :left, :right

      def initialize(op:, left:, right:, span:, node_id:)
        super(node_id: node_id, span: span)
        @op = String(op).dup.freeze
        @left = left
        @right = right
        freeze
      end
    end

    class FilterStage < Node
      attr_reader :name, :pos_args, :kw_args

      def initialize(name:, pos_args:, kw_args:, span:, node_id:)
        super(node_id: node_id, span: span)
        @name = String(name).dup.freeze
        @pos_args = pos_args.dup.freeze
        @kw_args = kw_args.map { |k, v| [String(k).dup.freeze, v].freeze }.freeze
        freeze
      end
    end

    class FilterPipeline < Expr
      attr_reader :input_expr, :stages

      def initialize(input_expr:, stages:, span:, node_id:)
        super(node_id: node_id, span: span)
        @input_expr = input_expr
        @stages = stages.dup.freeze
        freeze
      end
    end
  end
end

# frozen_string_literal: true

module LiquidInterpreter
  class Evaluator
    Result = Struct.new(:html, :events, keyword_init: true)

    def initialize(trace: false)
      @trace = !!trace
    end

    def evaluate(document, assigns: {}, **_options)
      unless document.is_a?(AST::Document)
        raise RenderError.new("Expected AST::Document, got #{document.class}", code: "invalid_ast")
      end

      output = String.new(encoding: Encoding::UTF_8)
      events = []
      seq = 0
      # Isolate per-render state from caller's assigns hash.
      _local_assigns = deep_copy_json(assigns || {})

      document.children.each do |node|
        case node
        when AST::Text
          start_byte = output.bytesize
          output << node.value
          end_byte = output.bytesize
          if @trace
            events << {
              "seq" => seq,
              "node_id" => node.node_id,
              "scope" => [],
              "span" => node.span.to_h,
              "data" => {
                "kind" => "emit",
                "output_start_byte" => start_byte,
                "output_end_byte" => end_byte,
                "active_branch_seqs" => [],
              },
            }
            seq += 1
          end
        else
          raise RenderError.new("Unsupported AST node: #{node.class}", code: "unsupported_ast_node", span: node.span)
        end
      end

      Result.new(html: output.freeze, events: events.freeze)
    end

    private

    def deep_copy_json(value)
      case value
      when Hash
        value.each_with_object({}) { |(k, v), out| out[k.to_s] = deep_copy_json(v) }
      when Array
        value.map { |v| deep_copy_json(v) }
      else
        value
      end
    end
  end
end

# frozen_string_literal: true

module LiquidInterpreter
  class Tracer
    MAX_TRACE_EVENTS = 10_000

    attr_reader :max_events

    def self.snapshot(value)
      case value
      when Hash
        value.each_with_object({}) { |(k, v), out| out[k.to_s] = snapshot(v) }
      when Array
        value.map { |v| snapshot(v) }
      when String
        value.dup
      else
        value
      end
    end

    def initialize(enabled:, max_events: MAX_TRACE_EVENTS)
      @enabled = !!enabled
      @max_events = Integer(max_events)
      @events = []
      @seq = 0
      @scope_frames = []
      @active_branch_seqs = []
    end

    def enabled?
      @enabled
    end

    def events
      @events.dup.freeze
    end

    def with_loop_frame(loop_id:, iteration:, variant_id:)
      return yield unless @enabled

      @scope_frames.push(
        {
          "loop_id" => String(loop_id),
          "iteration" => Integer(iteration),
          "variant_id" => variant_id,
        }.freeze,
      )
      begin
        yield
      ensure
        @scope_frames.pop
      end
    end

    def with_active_branch(branch_seq)
      return yield unless @enabled && !branch_seq.nil?

      @active_branch_seqs.push(branch_seq)
      begin
        yield
      ensure
        @active_branch_seqs.pop
      end
    end

    def record_lookup(node_id:, span:, path:, found:, value:)
      return nil unless @enabled

      emit_event(
        node_id: node_id,
        span: span,
        data: {
          "kind" => "lookup",
          "path" => String(path),
          "found" => !!found,
          "value" => self.class.snapshot(value),
        },
      )
    end

    def record_comparison(node_id:, span:, op:, left:, right:, result:)
      return nil unless @enabled

      emit_event(
        node_id: node_id,
        span: span,
        data: {
          "kind" => "comparison",
          "op" => String(op),
          "left" => self.class.snapshot(left),
          "right" => self.class.snapshot(right),
          "result" => !!result,
        },
      )
    end

    def record_branch(node_id:, span:, expression:, condition:, taken:)
      return nil unless @enabled

      emit_event(
        node_id: node_id,
        span: span,
        data: {
          "kind" => "branch",
          "expression" => String(expression),
          "condition" => !!condition,
          "taken" => !!taken,
        },
      )
    end

    def record_assignment(node_id:, span:, name:, value:)
      return nil unless @enabled

      emit_event(
        node_id: node_id,
        span: span,
        data: {
          "kind" => "assignment",
          "name" => String(name),
          "value" => self.class.snapshot(value),
        },
      )
    end

    def record_emit(node_id:, span:, output_start_byte:, output_end_byte:)
      return nil unless @enabled

      emit_event(
        node_id: node_id,
        span: span,
        data: {
          "kind" => "emit",
          "output_start_byte" => Integer(output_start_byte),
          "output_end_byte" => Integer(output_end_byte),
          "active_branch_seqs" => @active_branch_seqs.dup,
        },
      )
    end

    private

    def emit_event(node_id:, span:, data:)
      if @events.length >= @max_events
        raise LimitError.new(
          "Trace event limit (#{@max_events}) exceeded",
          code: "trace_event_limit_exceeded",
          span: span,
        )
      end

      event_seq = @seq
      @seq += 1
      @events << {
        "seq" => event_seq,
        "node_id" => node_id,
        "scope" => @scope_frames.map(&:dup),
        "span" => span.to_h,
        "data" => data,
      }
      event_seq
    end
  end
end

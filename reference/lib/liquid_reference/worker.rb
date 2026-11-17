# frozen_string_literal: true

require "json"

module LiquidReference
  # Persistent UTF-8 JSON Lines worker processing compile, render_pair, and quit requests.
  class Worker
    MAX_RESPONSE_BYTES = 16 * 1024 * 1024

    COMPILE_KEYS = %w[id op before after observer].freeze
    RENDER_PAIR_KEYS = %w[id op fixture engine trace].freeze
    QUIT_KEYS = %w[id op].freeze
    VALID_ENGINES = %w[custom reference].freeze

    def initialize(input: $stdin, output: $stdout, error_output: $stderr, max_response_bytes: MAX_RESPONSE_BYTES, **render_limits)
      @input = input
      @output = output
      @error_output = error_output
      @max_response_bytes = Integer(max_response_bytes)
      @render_limits = render_limits
      @compiled = nil

      @input.set_encoding(Encoding::UTF_8) if @input.respond_to?(:set_encoding)
      @output.set_encoding(Encoding::UTF_8) if @output.respond_to?(:set_encoding)
      @output.sync = true if @output.respond_to?(:sync=)
    end

    def run
      @input.each_line do |raw_line|
        line = normalize_line(raw_line)
        should_quit, response = process_line(line)
        write_response(response)
        break if should_quit
      end
      0
    end

    def process_line(line)
      unless line.valid_encoding?
        return [false, error_response("unknown", code: "protocol_error", message: "Request line contains invalid UTF-8 bytes")]
      end

      payload = JSON.parse(line)
      handle_request(payload)
    rescue JSON::ParserError => e
      [false, error_response("unknown", code: "protocol_error", message: "Invalid JSON request: #{e.message}")]
    rescue StandardError => e
      @error_output.puts("[liquid_reference/worker] Unexpected error: #{e.class}: #{e.message}") if @error_output
      [false, error_response("unknown", code: "internal_error", message: "Worker internal error: #{e.message}")]
    end

    private

    def normalize_line(raw_line)
      line = raw_line.dup
      if line.encoding == Encoding::BINARY
        line.force_encoding(Encoding::UTF_8)
      elsif line.encoding != Encoding::UTF_8
        line = line.encode(Encoding::UTF_8)
      end
      line.chomp("\n").chomp("\r")
    rescue EncodingError
      raw_line
    end

    def handle_request(req)
      unless req.is_a?(Hash)
        return [false, error_response("unknown", code: "protocol_error", message: "JSONL request must be a JSON object")]
      end

      req_id = extract_request_id(req["id"])
      unless req_id
        return [false, error_response("unknown", code: "protocol_error", message: "Request 'id' must be a non-empty string")]
      end

      op = req["op"]
      unless op.is_a?(String)
        return [false, error_response(req_id, code: "protocol_error", message: "Request 'op' must be a string")]
      end

      case op
      when "compile"
        [false, handle_compile(req_id, req)]
      when "render_pair"
        [false, handle_render_pair(req_id, req)]
      when "quit"
        handle_quit(req_id, req)
      else
        [false, error_response(req_id, code: "protocol_error", message: "Unknown op '#{op}'")]
      end
    end

    def handle_compile(req_id, req)
      key_err = check_exact_keys(req, COMPILE_KEYS)
      return error_response(req_id, code: "protocol_error", message: key_err) if key_err

      before_src = req["before"]
      after_src = req["after"]
      observer = req["observer"]

      unless before_src.is_a?(String) && after_src.is_a?(String)
        return error_response(req_id, code: "protocol_error", message: "'before' and 'after' must be strings")
      end

      unless observer.is_a?(String)
        return error_response(req_id, code: "protocol_error", message: "'observer' must be a string")
      end

      @compiled = nil
      pair = Renderer.compile_pair(
        before: before_src,
        after: after_src,
        observer: observer,
        max_snippet_bytes: @render_limits.fetch(:max_snippet_bytes, Renderer::MAX_SNIPPET_BYTES),
        max_depth: @render_limits.fetch(:max_depth, Renderer::MAX_DEPTH),
      )
      @compiled = pair

      {
        "id" => req_id,
        "result" => {
          "before_sha256" => pair.before_sha256,
          "after_sha256" => pair.after_sha256,
        },
      }
    rescue Observer::UnsupportedObserverError => e
      error_response(req_id, code: e.code, message: e.message)
    rescue LiquidInterpreter::Error => e
      {
        "id" => req_id,
        "error" => e.diagnostic.to_h,
      }
    end

    def handle_render_pair(req_id, req)
      key_err = check_exact_keys(req, RENDER_PAIR_KEYS)
      return error_response(req_id, code: "protocol_error", message: key_err) if key_err

      engine = req["engine"]
      unless VALID_ENGINES.include?(engine)
        return error_response(req_id, code: "protocol_error", message: "'engine' must be 'custom' or 'reference'")
      end

      trace = req["trace"]
      unless trace == true || trace == false
        return error_response(req_id, code: "protocol_error", message: "'trace' must be a boolean")
      end

      if @compiled.nil?
        return error_response(req_id, code: "not_compiled", message: "Templates must be compiled before calling 'render_pair'")
      end

      projected = Projection.project_for_render(req["fixture"])

      before_tpl = engine == "custom" ? @compiled.custom_before : @compiled.reference_before
      after_tpl = engine == "custom" ? @compiled.custom_after : @compiled.reference_after

      before_result = Renderer.render(
        engine: engine,
        template: before_tpl,
        assigns: projected.fresh_assigns,
        observer: @compiled.observer,
        trace: trace,
        **@render_limits,
      )
      after_result = Renderer.render(
        engine: engine,
        template: after_tpl,
        assigns: projected.fresh_assigns,
        observer: @compiled.observer,
        trace: trace,
        **@render_limits,
      )

      {
        "id" => req_id,
        "result" => {
          "before" => before_result,
          "after" => after_result,
          "product" => projected.projection,
        },
      }
    rescue FixtureValidator::ValidationError => e
      error_response(req_id, code: e.code, message: e.message)
    end

    def handle_quit(req_id, req)
      key_err = check_exact_keys(req, QUIT_KEYS)
      return [false, error_response(req_id, code: "protocol_error", message: key_err)] if key_err

      [true, { "id" => req_id, "result" => { "ok" => true } }]
    end

    def extract_request_id(val)
      return nil unless val.is_a?(String) && !val.empty?

      val
    end

    def check_exact_keys(hash, expected_keys)
      missing = expected_keys - hash.keys
      return "Missing required key(s): #{missing.join(', ')}" unless missing.empty?

      extra = hash.keys - expected_keys
      return "Unexpected key(s): #{extra.join(', ')}" unless extra.empty?

      nil
    end

    def error_response(req_id, code:, message:, span: nil)
      {
        "id" => req_id,
        "error" => {
          "code" => String(code),
          "message" => String(message),
          "span" => span,
        },
      }
    end

    def write_response(response)
      frame = JSON.generate(response)
      if frame.bytesize > @max_response_bytes
        req_id = response.is_a?(Hash) && response["id"].is_a?(String) ? response["id"] : "unknown"
        frame = JSON.generate(
          error_response(
            req_id,
            code: "response_too_large",
            message: "JSONL response frame #{frame.bytesize} bytes exceeds #{@max_response_bytes} byte limit",
          ),
        )
      end

      @output.write(frame)
      @output.write("\n")
      @output.flush
    end
  end
end

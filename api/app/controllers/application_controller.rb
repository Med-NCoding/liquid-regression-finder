# frozen_string_literal: true

class ApplicationController < ActionController::API
  wrap_parameters format: []

  rescue_from ActionDispatch::Http::Parameters::ParseError do |exc|
    render_diagnostic(
      status: 422,
      code: "invalid_json",
      message: "Malformed JSON request body: #{exc.message}"
    )
  end

  private

  def render_diagnostic(status:, code:, message:, span: nil)
    render json: {
      error: {
        code: code,
        message: message,
        span: span
      }
    }, status: status
  end
end

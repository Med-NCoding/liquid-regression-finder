# frozen_string_literal: true

module Api
  module V1
    class ComparisonsController < ApplicationController
      before_action :authenticate_submission!, only: :create

      def create
        idempotency_key = extract_idempotency_key!
        return if performed?

        validated_request = CompareRequestValidator.parse_and_validate!(request.raw_post)
        request_digest = Comparison.compute_request_digest(validated_request)

        if idempotency_key
          existing = Comparison.find_by(idempotency_key: idempotency_key)
          if existing
            render_existing_idempotent(existing, request_digest)
            return
          end
        end

        comparison = Comparison.create_queued!(
          validated_request: validated_request,
          idempotency_key: idempotency_key
        )

        ComparisonRunJob.perform_later(comparison.id)

        response.set_header("Location", api_v1_comparison_path(comparison.id))
        render json: comparison.as_comparison_job, status: :accepted
      rescue CompareRequestValidator::ValidationError => e
        render_diagnostic(status: 422, code: e.code, message: e.message, span: e.span)
      rescue ActiveRecord::RecordNotUnique
        raise unless idempotency_key

        existing = Comparison.find_by!(idempotency_key: idempotency_key)
        render_existing_idempotent(existing, request_digest)
      end

      def show
        comparison = Comparison.find_by(id: params[:id])
        if comparison.nil?
          render_diagnostic(
            status: :not_found,
            code: "not_found",
            message: "Comparison '#{params[:id]}' was not found"
          )
          return
        end

        render json: comparison.as_comparison_job, status: :ok
      end

      private

      def authenticate_submission!
        expected = ENV["LIQUID_REGRESSION_API_TOKEN"]
        return if expected.nil? || expected.empty?

        auth_header = request.authorization.to_s
        match = auth_header.match(/\ABearer\s+(.+)\z/i)
        provided = match ? match[1] : ""

        if provided.empty? || !ActiveSupport::SecurityUtils.secure_compare(provided, expected)
          render_diagnostic(
            status: :unauthorized,
            code: "unauthorized",
            message: "Missing or invalid bearer token"
          )
        end
      end

      def extract_idempotency_key!
        return nil unless request.env.key?("HTTP_IDEMPOTENCY_KEY")

        raw_key = request.env["HTTP_IDEMPOTENCY_KEY"]
        if !raw_key.is_a?(String) || raw_key.strip.empty?
          render_diagnostic(
            status: 422,
            code: "invalid_idempotency_key",
            message: "Idempotency-Key header cannot be blank when provided"
          )
          return nil
        end

        if raw_key.bytesize > 255 || !raw_key.dup.force_encoding(Encoding::UTF_8).valid_encoding?
          render_diagnostic(
            status: 422,
            code: "invalid_idempotency_key",
            message: "Idempotency-Key header must be valid UTF-8 and at most 255 bytes"
          )
          return nil
        end

        raw_key
      end

      def render_existing_idempotent(existing, request_digest)
        if existing.request_digest != request_digest
          render_diagnostic(
            status: :conflict,
            code: "idempotency_conflict",
            message: "Idempotency-Key was already used with a different comparison request"
          )
          return
        end

        response.set_header("Location", api_v1_comparison_path(existing.id))
        http_status = existing.active? ? :accepted : :ok
        render json: existing.as_comparison_job, status: http_status
      end
    end
  end
end

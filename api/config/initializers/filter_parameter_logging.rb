# Be sure to restart your server when you modify this file.

# Configure parameters to be partially matched (e.g. passw matches password) and filtered from the log file.
# Redact Liquid snippet source, fixture, rendered HTML, and serialized comparison payloads from Rails logs.
Rails.application.config.filter_parameters += [
  :passw, :email, :secret, :token, :_key, :crypt, :salt, :certificate, :otp, :ssn, :cvv, :cvc,
  :source, :before, :after, :fixture, :html,
  :request_json, :finding_json, :stats_json, :error_json
]

module LiquidRegressionLogRedaction
  module ComparisonSqlFilter
    def sql(event)
      payload = event.payload
      raw_sql = payload[:sql]
      if raw_sql.is_a?(String) &&
         raw_sql.include?('"comparisons"') &&
         raw_sql.match?(/\A\s*(INSERT|UPDATE)\b/i)
        redacted_payload = payload.merge(sql: raw_sql.gsub(/'(?:[^']|'')*'/, "'[FILTERED]'"))
        redacted_event = ActiveSupport::Notifications::Event.new(
          event.name,
          event.time,
          event.end,
          event.transaction_id,
          redacted_payload
        )
        return super(redacted_event)
      end

      super
    end
  end

  module RequestParseErrorFilter
    private

    def log_parse_error_once
      @parse_error_logged ||= begin
        parse_logger = logger || ActiveSupport::Logger.new($stderr)
        parse_logger.debug("Error occurred while parsing request parameters (body redacted).")
      end
    end
  end
end

ActiveSupport.on_load(:active_record) do
  require "active_record/log_subscriber"

  unless ActiveRecord::LogSubscriber < LiquidRegressionLogRedaction::ComparisonSqlFilter
    ActiveRecord::LogSubscriber.prepend(LiquidRegressionLogRedaction::ComparisonSqlFilter)
  end
end

Rails.application.config.after_initialize do
  unless ActionDispatch::Http::Parameters < LiquidRegressionLogRedaction::RequestParseErrorFilter
    ActionDispatch::Http::Parameters.prepend(LiquidRegressionLogRedaction::RequestParseErrorFilter)
  end
end

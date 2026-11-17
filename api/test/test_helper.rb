# frozen_string_literal: true

ENV["RAILS_ENV"] ||= "test"
require_relative "../config/environment"
require "rails/test_help"

module ActiveSupport
  class TestCase
    # Run sequentially to keep SQLite and ENV assertions deterministic.
    parallelize(workers: 1)

    setup do
      Comparison.delete_all
      if defined?(SolidQueue::Job) && SolidQueue::Job.table_exists?
        SolidQueue::ReadyExecution.delete_all
        SolidQueue::ClaimedExecution.delete_all
        SolidQueue::ScheduledExecution.delete_all
        SolidQueue::FailedExecution.delete_all
        SolidQueue::BlockedExecution.delete_all
        SolidQueue::Job.delete_all
      end
    end

    def valid_compare_request(
      before_source: "{% assign on_sale = false %}{% for v in product.variants %}{% if v.compare_at_price != nil and v.compare_at_price > v.price %}{% assign on_sale = true %}{% endif %}{% endfor %}{% if on_sale %}<span data-regression-badge=\"sale\">Sale</span>{% endif %}",
      after_source: "{% if product.compare_at_price != nil and product.compare_at_price > product.price %}<span data-regression-badge=\"sale\">Sale</span>{% endif %}",
      observer: "sale_badge",
      seed: 0,
      search_pairs: 64,
      shrink_pairs: 32
    )
      {
        "schema_version" => 1,
        "before" => { "source" => before_source },
        "after" => { "source" => after_source },
        "observer" => observer,
        "seed" => seed,
        "budget" => {
          "search_pairs" => search_pairs,
          "shrink_pairs" => shrink_pairs
        }
      }
    end

    def assert_valid_schema(schema_name, payload)
      schemer = ContractSchemas.schema(schema_name)
      errors = schemer.validate(payload).to_a
      assert_empty errors, "Expected #{schema_name} schema validation to pass: #{errors.map { |e| "#{e['data_pointer']}: #{e['error']}" }.join('; ')}"
    end

    def assert_valid_diagnostic(payload)
      errors = ContractSchemas.diagnostic_schemer.validate(payload).to_a
      assert_empty errors, "Expected diagnostic schema validation to pass: #{errors.map { |e| "#{e['data_pointer']}: #{e['error']}" }.join('; ')}"
    end
  end
end

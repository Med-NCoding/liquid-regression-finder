# frozen_string_literal: true

require "date"
require "json"
require "pathname"
require "time"

module LiquidInterpreter
  # Deterministic feature-scope classifier and conformance manifest utilities
  # for pinning and reporting Shopify/liquid-spec coverage.
  module Conformance
    PINNED_LIQUID_SPEC_SHA = "84bf25e0edbca5f7e530574788b0f875ab331f50"
    INVENTORIED_SUITES = %i[basics liquid_ruby].freeze

    ALLOWED_STAGE2_TAGS = %w[if elsif else endif unless endunless for endfor assign].freeze

    SHOPIFY_FEATURES = %i[
      shopify_tags
      shopify_objects
      shopify_filters
      shopify_error_handling
      shopify_blank
      shopify_string_access
      shopify_error_format
      shopify_includes
    ].freeze

    DROP_FEATURES = %i[
      drops
      ruby_drops
      drop_class_output
      ruby_types
      self_environment_shadowing
      randomness
      binary_data
    ].freeze

    ERROR_FEATURES = %i[
      inline_errors
      lax_parsing
      strict2_blank_body_errors
    ].freeze

    LIMIT_FEATURES = %i[
      shopify_resource_limits
      range_resource_limits
    ].freeze

    SUITE_SKIP_REASONS = {
      benchmarks: "benchmark_suite_out_of_scope",
      liquid_ruby_lax: "lax_parsing_mode_out_of_scope",
      parser_errors: "error_wording_or_mutation_suite",
      partials: "partials_and_core_suite",
      shopify_production_recordings: "inline_error_mode_and_production_recordings",
      shopify_theme_dawn: "shopify_extensions_and_theme_sections",
    }.freeze

    module_function

    def spec_rel_path(spec)
      spec_dir = Pathname.new(File.realpath(Liquid::Spec::SPEC_DIR))
      src_path = Pathname.new(File.realpath(spec.source_file))
      src_path.relative_path_from(spec_dir).to_s
    end

    def case_id(_suite_id, spec)
      rel = spec_rel_path(spec)
      line = spec.line_number || 0
      "#{rel}:#{line}##{spec.name}"
    end

    def json_scalar_or_collection?(obj)
      case obj
      when NilClass, TrueClass, FalseClass, Integer, Float, String
        true
      when Array
        obj.all? { |item| json_scalar_or_collection?(item) }
      when Hash
        obj.all? { |k, v| k.is_a?(String) && json_scalar_or_collection?(v) }
      else
        false
      end
    end

    def contains_float?(obj)
      case obj
      when Float
        true
      when Array
        obj.any? { |item| contains_float?(item) }
      when Hash
        obj.values.any? { |v| contains_float?(v) }
      else
        false
      end
    end

    def strip_quoted_strings(expr)
      expr.gsub(/'[^']*'|"[^"]*"/, " STR ")
    end

    # Classifies a spec purely from static metadata and template syntax before execution.
    # Returns [status, category, skip_reason].
    def classify_spec(spec)
      feats = spec.features
      return ["skipped", nil, "shopify_extensions"] if (feats & SHOPIFY_FEATURES).any?
      if feats.include?(:template_factory) || (spec.raw_filesystem && !spec.raw_filesystem.empty?)
        return ["skipped", nil, "partials_and_filesystem"]
      end
      if (feats & DROP_FEATURES).any? || !json_scalar_or_collection?(spec.raw_environment)
        return ["skipped", nil, "drops_and_ruby_objects"]
      end
      return ["skipped", nil, "resource_limit_accounting_out_of_scope"] if (feats & LIMIT_FEATURES).any?
      if spec.render_errors || (feats & ERROR_FEATURES).any? || !spec.errors.empty? ||
          spec.expected_pattern || spec.expected.to_s.include?("Liquid")
        return ["skipped", nil, "error_wording_or_inline_error_mode"]
      end

      tpl = spec.template.to_s
      blocks = tpl.scan(/(\{\{-?.*?-?\}\}|\{%-?.*?-?%\})/m).flatten
      if blocks.empty?
        if tpl.match?(/\{\{|\{%/)
          return ["skipped", nil, "error_wording_or_inline_error_mode"]
        end
        return ["selected", "plain_text", nil]
      end

      blocks.each do |blk|
        is_tag = blk.start_with?("{%")
        inner = blk.sub(/\A\{[{%]-?/, "").sub(/-?[%}]\}\z/, "").strip
        code_no_strings = strip_quoted_strings(inner)

        if is_tag
          tag_name = inner.split(/\s+/, 2).first.to_s
          return ["skipped", nil, "partials_and_filesystem"] if tag_name == "include" || tag_name == "render"
          return ["skipped", nil, "unsupported_tags"] unless ALLOWED_STAGE2_TAGS.include?(tag_name)
          if tag_name == "for" && code_no_strings.match?(/\b(limit|offset|reversed)\b/)
            return ["skipped", nil, "for_loop_extensions_out_of_scope"]
          end
        end

        return ["skipped", nil, "unsupported_filters"] if code_no_strings.include?("|")
        return ["skipped", nil, "drops_and_ruby_objects"] if code_no_strings.match?(/\bself\b/)
        return ["skipped", nil, "for_loop_extensions_out_of_scope"] if code_no_strings.match?(/\bforloop\b/)
        if code_no_strings.include?("[") || code_no_strings.include?("]")
          return ["skipped", nil, "bracket_access_out_of_scope"]
        end
        return ["skipped", nil, "range_expressions_out_of_scope"] if code_no_strings.include?("..")
        if code_no_strings.match?(/\b(contains|empty|blank)\b/)
          return ["skipped", nil, "unsupported_operators_or_keywords"]
        end
        return ["skipped", nil, "floats_out_of_scope"] if code_no_strings.match?(/\b\d+\.\d+\b/)
        if code_no_strings.match?(/\.\s*(first|last|size)\b/)
          return ["skipped", nil, "virtual_collection_properties"]
        end
      end

      return ["skipped", nil, "floats_out_of_scope"] if contains_float?(spec.raw_environment)

      ["selected", "stage2_liquid", nil]
    end

    def build_manifest
      require "liquid"
      require "liquid/spec"

      suites_summary = {}
      cases = []
      skip_reason_counts = Hash.new(0)
      all_suites_total = 0

      Liquid::Spec::Suite.all.sort_by { |s| s.id.to_s }.each do |suite|
        specs = Liquid::Spec::SpecLoader.load_suite(suite)
        all_suites_total += specs.size

        if INVENTORIED_SUITES.include?(suite.id)
          suite_selected = 0
          suite_plain_text = 0
          suite_skipped = 0

          sorted_specs = specs.sort_by { |s| [spec_rel_path(s), s.line_number || 0, s.name.to_s] }
          sorted_specs.each do |spec|
            status, category, skip_reason = classify_spec(spec)
            if status == "selected"
              suite_selected += 1
              suite_plain_text += 1 if category == "plain_text"
            else
              suite_skipped += 1
              skip_reason_counts[skip_reason] += 1
            end

            cases << {
              "id" => case_id(suite.id, spec),
              "suite" => suite.id.to_s,
              "name" => spec.name.to_s,
              "source_file" => "specs/#{spec_rel_path(spec)}",
              "line_number" => spec.line_number,
              "complexity" => spec.complexity || 1000,
              "status" => status,
              "category" => category,
              "skip_reason" => skip_reason,
            }
          end

          suites_summary[suite.id.to_s] = {
            "default" => suite.default?,
            "features" => suite.features.map(&:to_s),
            "status" => "inventoried",
            "skip_reason" => nil,
            "total" => specs.size,
            "selected" => suite_selected,
            "plain_text_selected" => suite_plain_text,
            "skipped" => suite_skipped,
          }
        else
          skip_reason = SUITE_SKIP_REASONS.fetch(suite.id, "out_of_scope_suite")
          suites_summary[suite.id.to_s] = {
            "default" => suite.default?,
            "features" => suite.features.map(&:to_s),
            "status" => "skipped_suite",
            "skip_reason" => skip_reason,
            "total" => specs.size,
            "selected" => 0,
            "plain_text_selected" => 0,
            "skipped" => specs.size,
          }
        end
      end

      inventoried_total = INVENTORIED_SUITES.sum { |id| suites_summary.dig(id.to_s, "total") || 0 }
      selected_total = INVENTORIED_SUITES.sum { |id| suites_summary.dig(id.to_s, "selected") || 0 }
      plain_text_total = INVENTORIED_SUITES.sum { |id| suites_summary.dig(id.to_s, "plain_text_selected") || 0 }
      skipped_inventoried = inventoried_total - selected_total

      {
        "schema_version" => 1,
        "liquid_spec_sha" => PINNED_LIQUID_SPEC_SHA,
        "liquid_gem_version" => Liquid::VERSION,
        "stage_scope" => "stage-2",
        "selection_policy" => {
          "inventoried_suites" => INVENTORIED_SUITES.map(&:to_s),
          "included_constructs" => [
            "plain_text",
            "output_tags_without_filters",
            "whitespace_trimming",
            "literals_string_int_bool_nil",
            "identifiers_and_dot_property_access",
            "assign_tag_without_filters",
            "conditionals_if_elsif_else_unless",
            "comparison_and_logical_operators",
            "for_loops_without_ranges_modifiers_or_forloop",
          ],
          "excluded_constructs" => (
            skip_reason_counts.keys.sort + SUITE_SKIP_REASONS.values.uniq
          ).uniq.sort,
        },
        "totals" => {
          "all_suites" => all_suites_total,
          "inventoried" => inventoried_total,
          "selected" => selected_total,
          "plain_text_selected" => plain_text_total,
          "skipped_in_inventoried" => skipped_inventoried,
          "skipped_other_suites" => all_suites_total - inventoried_total,
        },
        "skip_reason_counts" => skip_reason_counts.sort_by { |k, _| k }.to_h,
        "suites" => suites_summary,
        "cases" => cases,
      }
    end
  end
end

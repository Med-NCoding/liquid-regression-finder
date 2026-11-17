# frozen_string_literal: true

require "digest"
require "json"
require "pathname"

$LOAD_PATH.unshift(File.expand_path("../../interpreter/lib", __dir__))
$LOAD_PATH.unshift(File.expand_path("../../reference/lib", __dir__))

require "liquid_interpreter"
require "liquid_reference"

module DawnCorpus
  # Minimal Shopify-compatible filter stubs isolated exclusively to Stage 6-7
  # benchmark corpus verification. Stage 3 LiquidReference::Renderer remains untouched.
  module DawnBenchmarkFilters
    include Liquid::StandardFilters

    TRANSLATIONS = {
      "products.product.on_sale" => "Sale",
      "products.product.sold_out" => "Sold out",
      "products.product.add_to_cart" => "Add to cart",
      "products.product.choose_options" => "Choose options",
      "products.product.unavailable" => "Unavailable",
      "products.product.price.regular_price" => "Regular price",
      "products.product.price.sale_price" => "Sale price",
      "products.product.price.from_price_html" => "From {{ price }}",
      "products.product.volume_pricing.price_range" => "{{ minimum }} - {{ maximum }}",
    }.freeze

    def money(cents)
      return "" if cents.nil?

      amount = Integer(cents)
      sign = amount.negative? ? "-" : ""
      abs = amount.abs
      format("%s$%d.%02d", sign, abs / 100, abs % 100)
    rescue ArgumentError, TypeError
      cents.to_s
    end

    def money_with_currency(cents)
      formatted = money(cents)
      formatted.empty? ? "" : "#{formatted} USD"
    end

    def t(key, params = nil)
      template = TRANSLATIONS[key.to_s] || key.to_s
      return template unless params.is_a?(Hash)

      params.each_with_object(template.dup) do |(param_key, param_val), rendered|
        rendered.gsub!(/\{\{\s*#{Regexp.escape(param_key.to_s)}\s*\}\}/, param_val.to_s)
      end
    end
  end

  module Verifier
    REQUIRED_CASE_KEYS = %w[
      id
      observable
      symptom
      issue_or_pr_url
      before_sha
      after_sha
      upstream_paths
      direction
      extraction_notes
      observer_selector
      fixed_context
      expected_before_observed
      expected_after_observed
      witness_fixture_path
      before_path
      after_path
      supported_in_stage2
      required_features
      supported_for_benchmark
      unsupported_reason
      license
    ].freeze

    VALID_DIRECTIONS = %w[bug_fixed bug_introduced].freeze
    SHA40_RE = /\A[0-9a-f]{40}\z/
    CASE_ID_RE = /\A[a-z0-9_]+\z/
    DAWN_URL_RE = %r{\Ahttps://github\.com/Shopify/dawn/(issues|pull|commit)/[a-zA-Z0-9_-]+\z}
    BENCHMARK_STUBS_VERSION = "1.0.0"

    class VerificationError < StandardError; end

    module_function

    def benchmark_environment
      @benchmark_environment ||= Liquid::Environment.build(
        tags: Liquid::Tags::STANDARD_TAGS.dup,
        error_mode: :strict2,
        file_system: LiquidReference::Renderer::DisabledFileSystem.new,
      ) do |env|
        env.register_filter(Liquid::StandardFilters)
        env.register_filter(DawnBenchmarkFilters)
        env.default_resource_limits = {
          render_length_limit: LiquidReference::Renderer::MAX_OUTPUT_BYTES,
          render_score_limit: LiquidReference::Renderer::MAX_STEPS,
        }.freeze
      end
    end

    def render_benchmark_liquid(source, assigns)
      template = Liquid::Template.parse(
        source,
        environment: benchmark_environment,
        line_numbers: true,
      )
      context = Liquid::Context.build(
        environments: [assigns],
        outer_scope: {},
        registers: {},
        rethrow_errors: true,
        environment: benchmark_environment,
      )
      template.render!(context)
    end

    def render_stage2_liquid(source, assigns)
      compiled = LiquidInterpreter::Template.compile(source)
      result = LiquidInterpreter::Evaluator.new(trace: false).evaluate(
        compiled.ast,
        assigns: LiquidReference::Projection.deep_copy(assigns),
      )
      result.html
    end

    def resolve_repo_path(repo_root, rel_path)
      raise VerificationError, "Expected relative path String, got #{rel_path.inspect}" unless rel_path.is_a?(String) && !rel_path.empty?

      pn = Pathname.new(rel_path)
      raise VerificationError, "Path must be relative: #{rel_path.inspect}" if pn.absolute?

      full = File.expand_path(rel_path, repo_root)
      prefix = repo_root.end_with?("/") ? repo_root : "#{repo_root}/"
      raise VerificationError, "Path escapes repo root: #{rel_path.inspect}" unless full.start_with?(prefix)
      raise VerificationError, "Missing file: #{rel_path}" unless File.file?(full)

      full
    end

    def validate_case_metadata!(entry, seen_ids:, seen_tuples:)
      missing = REQUIRED_CASE_KEYS.reject { |k| entry.key?(k) }
      raise VerificationError, "Case #{entry['id'].inspect} missing required keys: #{missing.join(', ')}" unless missing.empty?

      case_id = entry["id"]
      raise VerificationError, "Invalid case id #{case_id.inspect}" unless case_id.is_a?(String) && CASE_ID_RE.match?(case_id)
      raise VerificationError, "Duplicate case id #{case_id.inspect}" if seen_ids.include?(case_id)

      seen_ids << case_id

      observable = entry["observable"]
      unless LiquidReference::Observer.benchmark_supported?(observable)
        raise VerificationError, "Case #{case_id} has unsupported observable #{observable.inspect}"
      end

      %w[symptom extraction_notes observer_selector license].each do |text_key|
        val = entry[text_key]
        raise VerificationError, "Case #{case_id} #{text_key} must be non-empty String" unless val.is_a?(String) && !val.strip.empty?
      end
      unless entry["license"].include?("MIT") && entry["license"].include?("Shopify/dawn")
        raise VerificationError, "Case #{case_id} license must attribute MIT and Shopify/dawn"
      end

      unless entry["issue_or_pr_url"].is_a?(String) && DAWN_URL_RE.match?(entry["issue_or_pr_url"])
        raise VerificationError, "Case #{case_id} invalid issue_or_pr_url #{entry['issue_or_pr_url'].inspect}"
      end

      before_sha = entry["before_sha"]
      after_sha = entry["after_sha"]
      raise VerificationError, "Case #{case_id} invalid before_sha #{before_sha.inspect}" unless before_sha.is_a?(String) && SHA40_RE.match?(before_sha)
      raise VerificationError, "Case #{case_id} invalid after_sha #{after_sha.inspect}" unless after_sha.is_a?(String) && SHA40_RE.match?(after_sha)
      raise VerificationError, "Case #{case_id} has identical before_sha and after_sha" if before_sha == after_sha

      upstream_paths = entry["upstream_paths"]
      unless upstream_paths.is_a?(Array) && !upstream_paths.empty? && upstream_paths.all? { |p| p.is_a?(String) && !p.strip.empty? }
        raise VerificationError, "Case #{case_id} upstream_paths must be non-empty Array<String>"
      end

      tuple = [before_sha, after_sha, upstream_paths.sort]
      raise VerificationError, "Duplicate (before_sha, after_sha, upstream_paths) tuple on #{case_id}" if seen_tuples.include?(tuple)

      seen_tuples << tuple

      direction = entry["direction"]
      raise VerificationError, "Case #{case_id} invalid direction #{direction.inspect}" unless VALID_DIRECTIONS.include?(direction)

      unless entry["fixed_context"].is_a?(Hash) && !entry["fixed_context"].key?("product")
        raise VerificationError, "Case #{case_id} fixed_context must be Hash without 'product' key"
      end

      eb = entry["expected_before_observed"]
      ea = entry["expected_after_observed"]
      raise VerificationError, "Case #{case_id} expected_before_observed must be boolean" unless [true, false].include?(eb)
      raise VerificationError, "Case #{case_id} expected_after_observed must be boolean" unless [true, false].include?(ea)
      raise VerificationError, "Case #{case_id} must satisfy expected_before_observed != expected_after_observed" if eb == ea

      s2 = entry["supported_in_stage2"]
      sb = entry["supported_for_benchmark"]
      raise VerificationError, "Case #{case_id} supported_in_stage2 must be boolean" unless [true, false].include?(s2)
      raise VerificationError, "Case #{case_id} supported_for_benchmark must be boolean" unless [true, false].include?(sb)
      raise VerificationError, "Case #{case_id} cannot have supported_in_stage2=true with supported_for_benchmark=false" if s2 && !sb

      reason = entry["unsupported_reason"]
      if sb
        raise VerificationError, "Case #{case_id} supported_for_benchmark=true requires unsupported_reason=nil" unless reason.nil?
      elsif !(reason.is_a?(String) && !reason.strip.empty?)
        raise VerificationError, "Case #{case_id} supported_for_benchmark=false requires non-empty unsupported_reason"
      end

      feats = entry["required_features"]
      unless feats.is_a?(Array) && !feats.empty? && feats.all? { |f| f.is_a?(String) && !f.strip.empty? }
        raise VerificationError, "Case #{case_id} required_features must be non-empty Array<String>"
      end

      expected_witness = "fixtures/witnesses/#{case_id}.json"
      expected_before = "bench/corpus/cases/#{case_id}/before.liquid"
      expected_after = "bench/corpus/cases/#{case_id}/after.liquid"
      raise VerificationError, "Case #{case_id} witness_fixture_path must be #{expected_witness}" unless entry["witness_fixture_path"] == expected_witness
      raise VerificationError, "Case #{case_id} before_path must be #{expected_before}" unless entry["before_path"] == expected_before
      raise VerificationError, "Case #{case_id} after_path must be #{expected_after}" unless entry["after_path"] == expected_after
    end

    def validate_unverified!(repo_root)
      unverified_path = File.join(repo_root, "bench/corpus/unverified_candidates.json")
      raise VerificationError, "Missing bench/corpus/unverified_candidates.json" unless File.file?(unverified_path)

      data = JSON.parse(File.read(unverified_path, encoding: Encoding::UTF_8))
      candidates = data["candidates"]
      unless candidates.is_a?(Array) && !candidates.empty?
        raise VerificationError, "unverified_candidates.json must contain a non-empty 'candidates' array"
      end

      candidates.each_with_index do |cand, idx|
        %w[url title status reason notes].each do |key|
          val = cand[key]
          raise VerificationError, "Unverified candidate ##{idx} missing #{key}" unless val.is_a?(String) && !val.strip.empty?
        end
        unless cand["url"].start_with?("https://github.com/Shopify/dawn/")
          raise VerificationError, "Unverified candidate ##{idx} url must belong to Shopify/dawn"
        end
      end

      data
    end

    def verify!(repo_root: File.expand_path("../..", __dir__))
      license_path = File.join(repo_root, "bench/corpus/LICENSE-DAWN-MIT.txt")
      raise VerificationError, "Missing Dawn license file at bench/corpus/LICENSE-DAWN-MIT.txt" unless File.file?(license_path)

      manifest_path = File.join(repo_root, "bench/corpus/manifest.json")
      raise VerificationError, "Missing bench/corpus/manifest.json" unless File.file?(manifest_path)

      manifest = JSON.parse(File.read(manifest_path, encoding: Encoding::UTF_8))
      cases = manifest["cases"]
      raise VerificationError, "manifest.json must contain a 'cases' array" unless cases.is_a?(Array)

      unless cases.length.between?(10, 20)
        raise VerificationError, "Corpus must contain 10..20 verified cases, got #{cases.length}"
      end

      unverified = validate_unverified!(repo_root)

      seen_ids = []
      seen_tuples = []
      counts_by_observable = Hash.new(0)
      case_results = []

      cases.each do |entry|
        validate_case_metadata!(entry, seen_ids: seen_ids, seen_tuples: seen_tuples)
        case_id = entry["id"]
        counts_by_observable[entry["observable"]] += 1

        witness_full = resolve_repo_path(repo_root, entry["witness_fixture_path"])
        before_full = resolve_repo_path(repo_root, entry["before_path"])
        after_full = resolve_repo_path(repo_root, entry["after_path"])

        fixture_hash = JSON.parse(File.read(witness_full, encoding: Encoding::UTF_8))
        validated_fixture = LiquidReference::FixtureValidator.validate!(fixture_hash)
        projected = LiquidReference::Projection.project_for_render(validated_fixture)

        before_src = File.read(before_full, encoding: Encoding::UTF_8)
        after_src = File.read(after_full, encoding: Encoding::UTF_8)

        fixed_ctx = LiquidReference::Projection.deep_copy(entry["fixed_context"])
        before_assigns = fixed_ctx.merge(projected.fresh_assigns)
        after_assigns = LiquidReference::Projection.deep_copy(fixed_ctx).merge(projected.fresh_assigns)

        ref_before_html = render_benchmark_liquid(before_src, before_assigns)
        ref_after_html = render_benchmark_liquid(after_src, after_assigns)

        before_observed = LiquidReference::Observer.observe_benchmark(
          entry["observable"],
          ref_before_html,
          selector: entry["observer_selector"],
        )
        after_observed = LiquidReference::Observer.observe_benchmark(
          entry["observable"],
          ref_after_html,
          selector: entry["observer_selector"],
        )

        unless before_observed == entry["expected_before_observed"]
          raise VerificationError,
                "Case #{case_id}: Liquid 5.14.0 before_observed=#{before_observed} != expected=#{entry['expected_before_observed']}"
        end
        unless after_observed == entry["expected_after_observed"]
          raise VerificationError,
                "Case #{case_id}: Liquid 5.14.0 after_observed=#{after_observed} != expected=#{entry['expected_after_observed']}"
        end
        unless before_observed != after_observed
          raise VerificationError,
                "Case #{case_id}: Witness fixture did not separate before (#{before_observed}) from after (#{after_observed})"
        end

        stage2_status = "skipped_unsupported"
        if entry["supported_in_stage2"]
          custom_before_html = render_stage2_liquid(before_src, fixed_ctx.merge(projected.fresh_assigns))
          custom_after_html = render_stage2_liquid(after_src, fixed_ctx.merge(projected.fresh_assigns))
          unless custom_before_html == ref_before_html
            raise VerificationError,
                  "Case #{case_id}: Stage 2 before HTML mismatch:\nCustom: #{custom_before_html.inspect}\nLiquid: #{ref_before_html.inspect}"
          end
          unless custom_after_html == ref_after_html
            raise VerificationError,
                  "Case #{case_id}: Stage 2 after HTML mismatch:\nCustom: #{custom_after_html.inspect}\nLiquid: #{ref_after_html.inspect}"
          end
          stage2_status = "matched"
        end

        case_results << {
          "id" => case_id,
          "observable" => entry["observable"],
          "direction" => entry["direction"],
          "issue_or_pr_url" => entry["issue_or_pr_url"],
          "before_sha" => entry["before_sha"],
          "after_sha" => entry["after_sha"],
          "upstream_paths" => entry["upstream_paths"],
          "before_sha256" => Digest::SHA256.hexdigest(before_src),
          "after_sha256" => Digest::SHA256.hexdigest(after_src),
          "observer_selector" => entry["observer_selector"],
          "before_observed" => before_observed,
          "after_observed" => after_observed,
          "witness_fixture_path" => entry["witness_fixture_path"],
          "supported_in_stage2" => entry["supported_in_stage2"],
          "supported_for_benchmark" => entry["supported_for_benchmark"],
          "stage2_parity_status" => stage2_status,
          "required_features" => entry["required_features"],
          "unsupported_reason" => entry["unsupported_reason"],
        }
      end

      LiquidReference::Observer::BENCHMARK_OBSERVERS.each_key do |obs|
        if counts_by_observable[obs] < 1
          raise VerificationError, "Corpus must contain at least 1 verified case for observable #{obs}"
        end
      end

      # Verify no stray witness files exist outside manifest
      witness_dir = File.join(repo_root, "fixtures/witnesses")
      disk_witnesses = Dir.glob(File.join(witness_dir, "*.json")).map { |p| "fixtures/witnesses/#{File.basename(p)}" }.sort
      manifest_witnesses = cases.map { |c| c["witness_fixture_path"] }.sort
      if disk_witnesses != manifest_witnesses
        raise VerificationError, "Witness directory mismatch: disk=#{disk_witnesses.inspect} manifest=#{manifest_witnesses.inspect}"
      end

      {
        "schema_version" => 1,
        "status" => "passed",
        "liquid_version" => Liquid::VERSION,
        "benchmark_stubs_version" => BENCHMARK_STUBS_VERSION,
        "verified_case_count" => case_results.length,
        "unverified_candidate_count" => unverified["candidates"].length,
        "counts_by_observable" => counts_by_observable,
        "counts_by_direction" => case_results.group_by { |c| c["direction"] }.transform_values(&:length),
        "stage2_supported_count" => case_results.count { |c| c["supported_in_stage2"] },
        "benchmark_supported_count" => case_results.count { |c| c["supported_for_benchmark"] },
        "benchmark_unsupported_count" => case_results.count { |c| !c["supported_for_benchmark"] },
        "cases" => case_results,
      }
    end

    def render_markdown_summary(report, unverified)
      lines = []
      lines << "# Stage 6: Shopify Dawn Corpus Verification Summary"
      lines << ""
      lines << "- Status: `#{report['status']}`"
      lines << "- Official Liquid Engine: `liquid #{report['liquid_version']}` (`DawnBenchmarkFilters v#{report['benchmark_stubs_version']}`)"
      lines << "- Verified Cases: **#{report['verified_case_count']}** (sale_badge: `#{report['counts_by_observable']['sale_badge']}`, sold_out_badge: `#{report['counts_by_observable']['sold_out_badge']}`, price_range: `#{report['counts_by_observable']['price_range']}`)"
      lines << "- Support Breakdown: `supported_in_stage2=#{report['stage2_supported_count']}`, `supported_for_benchmark=#{report['benchmark_supported_count']}`, `unsupported=#{report['benchmark_unsupported_count']}`"
      lines << "- Directions: `bug_fixed=#{report['counts_by_direction']['bug_fixed'] || 0}`, `bug_introduced=#{report['counts_by_direction']['bug_introduced'] || 0}`"
      lines << "- Unverified Leads Documented Separately: **#{report['unverified_candidate_count']}** (`bench/corpus/unverified_candidates.json`)"
      lines << ""
      lines << "## Verified Corpus Cases"
      lines << ""
      lines << "| Case ID | Observable | Direction | Before -> After | Stage 2 | Benchmark | Selector |"
      lines << "| --- | --- | --- | --- | --- | --- | --- |"
      report["cases"].each do |c|
        lines << "| `#{c['id']}` | `#{c['observable']}` | `#{c['direction']}` | `#{c['before_observed']}` -> `#{c['after_observed']}` | `#{c['stage2_parity_status']}` | `#{c['supported_for_benchmark']}` | `#{c['observer_selector']}` |"
      end
      lines << ""
      lines << "## Unverified Candidates (Excluded from Verified Benchmark)"
      lines << ""
      unverified["candidates"].each do |cand|
        lines << "- **#{cand['title']}** (#{cand['status']}) — #{cand['url']}: #{cand['reason']}"
      end
      lines << ""
      lines.join("\n")
    end
  end
end

# frozen_string_literal: true

require "json"
require "minitest/autorun"

$LOAD_PATH.unshift(File.expand_path("../lib", __dir__))
require "dawn_corpus_verifier"

class DawnCorpusTest < Minitest::Test
  REPO_ROOT = File.expand_path("../..", __dir__)

  def test_corpus_verification_passes_all_invariants
    report = DawnCorpus::Verifier.verify!(repo_root: REPO_ROOT)
    assert_equal "passed", report["status"]
    assert_equal "5.14.0", report["liquid_version"]
    assert_includes 10..20, report["verified_case_count"]

    counts = report["counts_by_observable"]
    assert_operator counts["sale_badge"], :>=, 2
    assert_operator counts["sold_out_badge"], :>=, 2
    assert_operator counts["price_range"], :>=, 2

    assert_operator report["stage2_supported_count"], :>=, 3
    assert_operator report["benchmark_supported_count"], :>=, 8
    assert_operator report["benchmark_unsupported_count"], :>=, 1

    report["cases"].each do |c|
      assert_equal c["before_observed"] != c["after_observed"], true
      if c["supported_in_stage2"]
        assert_equal "matched", c["stage2_parity_status"], "Expected Stage 2 parity on #{c['id']}"
      else
        assert_equal "skipped_unsupported", c["stage2_parity_status"]
      end
    end
  end

  def test_manifest_and_unverified_leads_separation
    manifest = JSON.parse(File.read(File.join(REPO_ROOT, "bench/corpus/manifest.json"), encoding: Encoding::UTF_8))
    unverified = JSON.parse(File.read(File.join(REPO_ROOT, "bench/corpus/unverified_candidates.json"), encoding: Encoding::UTF_8))

    unverified_urls = unverified["candidates"].map { |c| c["url"] }
    assert_includes unverified_urls, "https://github.com/Shopify/dawn/issues/3581"
    assert_includes unverified_urls, "https://github.com/Shopify/dawn/issues/871"
    assert_includes unverified_urls, "https://github.com/Shopify/dawn/issues/3924"

    verified_urls = manifest["cases"].map { |c| c["issue_or_pr_url"] }
    assert_empty (verified_urls & unverified_urls), "Verified and unverified candidate URLs must remain separated"

    tuples = manifest["cases"].map { |c| [c["before_sha"], c["after_sha"], c["upstream_paths"].sort] }
    assert_equal tuples.uniq.length, tuples.length, "Verified cases must represent distinct upstream commit/path tuples"
  end

  def test_benchmark_stubs_do_not_leak_into_stage3_reference_renderer_or_public_observer
    ref_money = LiquidReference::Renderer.render_reference("{{ 1999 | money }}", {}, observer: "sale_badge")
    assert_equal "ok", ref_money["status"]
    assert_equal "1999", ref_money["html"]

    ref_t = LiquidReference::Renderer.render_reference("{{ 'products.product.on_sale' | t }}", {}, observer: "sale_badge")
    assert_equal "ok", ref_t["status"]
    assert_equal "products.product.on_sale", ref_t["html"]

    assert_equal "$19.99", DawnCorpus::Verifier.render_benchmark_liquid("{{ 1999 | money }}", {})
    assert_equal "Sale", DawnCorpus::Verifier.render_benchmark_liquid("{{ 'products.product.on_sale' | t }}", {})

    assert_raises(LiquidReference::Observer::UnsupportedObserverError) do
      LiquidReference::Observer.observe("sold_out_badge", '<span data-regression-badge="sold_out">Sold out</span>')
    end
    assert_raises(LiquidReference::Observer::UnsupportedObserverError) do
      LiquidReference::Observer.observe("price_range", '<span data-regression-price-range>$10 - $20</span>')
    end
  end

  def test_verifier_rejects_duplicate_bugs_and_invalid_metadata
    manifest = JSON.parse(File.read(File.join(REPO_ROOT, "bench/corpus/manifest.json"), encoding: Encoding::UTF_8))
    base = LiquidReference::Projection.deep_copy(manifest["cases"].first)

    dup = LiquidReference::Projection.deep_copy(base)
    dup["id"] = "duplicate_variant_of_same_bug"

    seen_ids = []
    seen_tuples = []
    DawnCorpus::Verifier.validate_case_metadata!(base, seen_ids: seen_ids, seen_tuples: seen_tuples)
    assert_raises(DawnCorpus::Verifier::VerificationError) do
      DawnCorpus::Verifier.validate_case_metadata!(dup, seen_ids: seen_ids, seen_tuples: seen_tuples)
    end

    bad_sha = LiquidReference::Projection.deep_copy(base)
    bad_sha["before_sha"] = "deadbeef"
    assert_raises(DawnCorpus::Verifier::VerificationError) do
      DawnCorpus::Verifier.validate_case_metadata!(bad_sha, seen_ids: [], seen_tuples: [])
    end

    bad_non_diff = LiquidReference::Projection.deep_copy(base)
    bad_non_diff["expected_after_observed"] = bad_non_diff["expected_before_observed"]
    assert_raises(DawnCorpus::Verifier::VerificationError) do
      DawnCorpus::Verifier.validate_case_metadata!(bad_non_diff, seen_ids: [], seen_tuples: [])
    end

    bad_unsupported = LiquidReference::Projection.deep_copy(base)
    bad_unsupported["supported_in_stage2"] = false
    bad_unsupported["supported_for_benchmark"] = false
    bad_unsupported["unsupported_reason"] = nil
    assert_raises(DawnCorpus::Verifier::VerificationError) do
      DawnCorpus::Verifier.validate_case_metadata!(bad_unsupported, seen_ids: [], seen_tuples: [])
    end

    bad_ctx = LiquidReference::Projection.deep_copy(base)
    bad_ctx["fixed_context"] = { "product" => { "price" => 100 } }
    assert_raises(DawnCorpus::Verifier::VerificationError) do
      DawnCorpus::Verifier.validate_case_metadata!(bad_ctx, seen_ids: [], seen_tuples: [])
    end
  end

  def test_stage6_artifacts_exist_and_match_report
    report_path = File.join(REPO_ROOT, "artifacts/stage-6/corpus-verification.json")
    summary_path = File.join(REPO_ROOT, "artifacts/stage-6/corpus-summary.md")
    assert File.file?(report_path), "Missing #{report_path}"
    assert File.file?(summary_path), "Missing #{summary_path}"

    disk_report = JSON.parse(File.read(report_path, encoding: Encoding::UTF_8))
    live_report = DawnCorpus::Verifier.verify!(repo_root: REPO_ROOT)
    assert_equal live_report, disk_report

    summary = File.read(summary_path, encoding: Encoding::UTF_8)
    assert_includes summary, "Verified Cases: **#{live_report['verified_case_count']}**"
    live_report["cases"].each do |c|
      assert_includes summary, c["id"]
    end
  end
end

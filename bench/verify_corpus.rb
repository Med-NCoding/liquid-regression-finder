#!/usr/bin/env ruby
# frozen_string_literal: true

require "fileutils"
require "json"
require "optparse"

$LOAD_PATH.unshift(File.expand_path("lib", __dir__))
require "dawn_corpus_verifier"

repo_root = File.expand_path("..", __dir__)
report_out = File.join(repo_root, "artifacts/stage-6/corpus-verification.json")
summary_out = File.join(repo_root, "artifacts/stage-6/corpus-summary.md")

OptionParser.new do |opts|
  opts.on("--report-out PATH") { |v| report_out = File.expand_path(v) }
  opts.on("--summary-out PATH") { |v| summary_out = File.expand_path(v) }
end.parse!(ARGV)

report = DawnCorpus::Verifier.verify!(repo_root: repo_root)
unverified = DawnCorpus::Verifier.validate_unverified!(repo_root)
markdown = DawnCorpus::Verifier.render_markdown_summary(report, unverified)

FileUtils.mkdir_p(File.dirname(report_out))
FileUtils.mkdir_p(File.dirname(summary_out))
File.write(report_out, "#{JSON.pretty_generate(report)}\n", encoding: Encoding::UTF_8)
File.write(summary_out, markdown, encoding: Encoding::UTF_8)

puts "[stage-6] Verified #{report['verified_case_count']} Dawn cases " \
     "(sale_badge=#{report['counts_by_observable']['sale_badge']}, " \
     "sold_out_badge=#{report['counts_by_observable']['sold_out_badge']}, " \
     "price_range=#{report['counts_by_observable']['price_range']}); " \
     "stage2=#{report['stage2_supported_count']}, " \
     "benchmark_supported=#{report['benchmark_supported_count']}, " \
     "unsupported=#{report['benchmark_unsupported_count']}, " \
     "unverified=#{report['unverified_candidate_count']}."

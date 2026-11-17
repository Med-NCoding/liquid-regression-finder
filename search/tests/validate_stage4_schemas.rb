#!/usr/bin/env ruby
# frozen_string_literal: true

require "digest"
require "json"
require "json_schemer"
require "optparse"

REPO_ROOT = File.expand_path("../..", __dir__)
SCHEMAS_DIR = File.join(REPO_ROOT, "contracts/schemas")

def canonical_sort(obj)
  case obj
  when Hash
    obj.keys.sort.each_with_object({}) { |k, out| out[k] = canonical_sort(obj[k]) }
  when Array
    obj.map { |item| canonical_sort(item) }
  else
    obj
  end
end

def load_schemer(name)
  ref_resolver = lambda do |uri|
    JSON.parse(File.read(File.join(SCHEMAS_DIR, File.basename(uri.path)), encoding: Encoding::UTF_8))
  end
  raw = JSON.parse(File.read(File.join(SCHEMAS_DIR, "#{name}.schema.json"), encoding: Encoding::UTF_8))
  JSONSchemer.schema(raw, ref_resolver: ref_resolver)
end

def validate_or_raise!(schemer, payload, label)
  errors = schemer.validate(payload).to_a
  return if errors.empty?

  details = errors.map { |e| "#{e['data_pointer']}: #{e['error']}" }.join("; ")
  abort("Schema validation failed for #{label}: #{details}")
end

def validate_replay_bundle(path, check_canonical:)
  raw = File.read(path, encoding: Encoding::UTF_8)
  abort("Replay bundle is not valid UTF-8: #{path}") unless raw.valid_encoding?

  bundle = JSON.parse(raw)
  validate_or_raise!(load_schemer("replay_bundle"), bundle, "replay_bundle(#{path})")

  expected_before = Digest::SHA256.hexdigest(bundle.dig("request", "before", "source").encode(Encoding::UTF_8))
  expected_after = Digest::SHA256.hexdigest(bundle.dig("request", "after", "source").encode(Encoding::UTF_8))
  abort("before_sha256 mismatch in #{path}") unless bundle["before_sha256"] == expected_before
  abort("after_sha256 mismatch in #{path}") unless bundle["after_sha256"] == expected_after

  if check_canonical
    expected_canonical = JSON.generate(canonical_sort(bundle))
    unless raw == expected_canonical
      abort("Replay bundle #{path} is not compact sorted-key canonical JSON")
    end
  end

  puts "VALID replay_bundle: #{path} (variants=#{bundle['fixture']['variants'].size})"
end

def validate_compare_report(path)
  raw = File.read(path, encoding: Encoding::UTF_8)
  report = JSON.parse(raw)

  compare_request_schemer = load_schemer("compare_request")
  job_schemer = load_schemer("comparison_job")
  stats_schemer = job_schemer.ref("#/$defs/stats")
  finding_schemer = load_schemer("finding")
  diagnostic_schemer = load_schemer("render_result").ref("#/$defs/diagnostic")

  validate_or_raise!(compare_request_schemer, report.fetch("request"), "report.request(#{path})")
  validate_or_raise!(stats_schemer, report.fetch("stats"), "report.stats(#{path})")

  case report.fetch("status")
  when "difference_found"
    abort("Expected error to be null in #{path}") unless report["error"].nil?
    finding = report.fetch("finding")
    validate_or_raise!(finding_schemer, finding, "report.finding(#{path})")
    puts "VALID compare_report (difference_found): #{path} (search_pairs=#{report['stats']['search_pairs']}, direction=#{report['direction']})"
  when "no_difference_found"
    abort("Expected finding to be null in #{path}") unless report["finding"].nil?
    abort("Expected error to be null in #{path}") unless report["error"].nil?
    abort("Unexpected negative message in #{path}") unless report["message"] == "no difference found within this search"
    puts "VALID compare_report (no_difference_found): #{path} (search_pairs=#{report['stats']['search_pairs']}, exhausted_by=#{report['stats']['exhausted_by']})"
  when "failed"
    abort("Expected finding to be null in #{path}") unless report["finding"].nil?
    validate_or_raise!(diagnostic_schemer, report.fetch("error"), "report.error(#{path})")
    puts "VALID compare_report (failed): #{path} (code=#{report['error']['code']})"
  else
    abort("Unexpected report status #{report['status'].inspect} in #{path}")
  end
end

options = { compare_reports: [], replay_bundles: [], check_canonical: true }
OptionParser.new do |opts|
  opts.on("--compare-report PATH", "Validate a CLI compare JSON report") { |p| options[:compare_reports] << p }
  opts.on("--replay-bundle PATH", "Validate a ReplayBundle JSON file") { |p| options[:replay_bundles] << p }
  opts.on("--[no-]canonical", "Check compact sorted-key canonical JSON for replay bundles") { |v| options[:check_canonical] = v }
end.parse!

abort("Provide --compare-report or --replay-bundle") if options[:compare_reports].empty? && options[:replay_bundles].empty?

options[:compare_reports].each { |p| validate_compare_report(p) }
options[:replay_bundles].each { |p| validate_replay_bundle(p, check_canonical: options[:check_canonical]) }

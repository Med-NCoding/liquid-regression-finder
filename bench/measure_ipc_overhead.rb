#!/usr/bin/env ruby
# frozen_string_literal: true

require "bundler/setup"
require "json"
require "optparse"

repo_root = File.expand_path("..", __dir__)
$LOAD_PATH.unshift(File.join(repo_root, "interpreter/lib"))
$LOAD_PATH.unshift(File.join(repo_root, "reference/lib"))

require "liquid_reference"

options = {
  iterations: 256,
  engine: "custom",
  case_id: "dawn_pr_794_price_badge_sale_aria_hidden",
  sample_path: File.join(repo_root, "bench/sample_baseline/sample_products.json"),
}

OptionParser.new do |opts|
  opts.on("--iterations N", Integer, "Number of render_pair iterations") { |v| options[:iterations] = v }
  opts.on("--engine ENGINE", "Engine: custom or reference") { |v| options[:engine] = v }
  opts.on("--case-id ID", "Case ID from bench/corpus/manifest.json") { |v| options[:case_id] = v }
end.parse!

manifest = JSON.parse(File.read(File.join(repo_root, "bench/corpus/manifest.json"), encoding: Encoding::UTF_8))
entry = manifest.fetch("cases").find { |c| c["id"] == options[:case_id] }
abort("Unknown case_id #{options[:case_id].inspect}") unless entry

samples_payload = JSON.parse(File.read(options[:sample_path], encoding: Encoding::UTF_8))
fixtures = samples_payload.fetch("products").map { |p| p.fetch("fixture") }
abort("No sample fixtures found") if fixtures.empty?

before_src = File.read(File.join(repo_root, entry.fetch("before_path")), encoding: Encoding::UTF_8)
after_src = File.read(File.join(repo_root, entry.fetch("after_path")), encoding: Encoding::UTF_8)

t_compile_start = Process.clock_gettime(Process::CLOCK_MONOTONIC)
pair = LiquidReference::Renderer.compile_pair(
  before: before_src,
  after: after_src,
  observer: entry.fetch("observable"),
  benchmark: true,
  selector: entry.fetch("observer_selector"),
  fixed_context: entry.fetch("fixed_context"),
)
compile_ms = (Process.clock_gettime(Process::CLOCK_MONOTONIC) - t_compile_start) * 1000.0

engine = options[:engine]
before_tpl = engine == "custom" ? pair.custom_before : pair.reference_before
after_tpl = engine == "custom" ? pair.custom_after : pair.reference_after

# Warmup once
warm_proj = LiquidReference::Projection.project_for_render(fixtures[0])
LiquidReference::Renderer.render(
  engine: engine,
  template: before_tpl,
  assigns: LiquidReference::Projection.deep_copy(pair.fixed_context || {}).merge(warm_proj.fresh_assigns),
  observer: pair.observer,
  trace: false,
  benchmark: true,
  selector: pair.selector,
)

per_iter_ms = []
t_total_start = Process.clock_gettime(Process::CLOCK_MONOTONIC)
options[:iterations].times do |idx|
  fixture = fixtures[idx % fixtures.length]
  t0 = Process.clock_gettime(Process::CLOCK_MONOTONIC)
  projected = LiquidReference::Projection.project_for_render(fixture)
  ctx_b = LiquidReference::Projection.deep_copy(pair.fixed_context || {}).merge(projected.fresh_assigns)
  ctx_a = LiquidReference::Projection.deep_copy(pair.fixed_context || {}).merge(projected.fresh_assigns)
  res_b = LiquidReference::Renderer.render(
    engine: engine,
    template: before_tpl,
    assigns: ctx_b,
    observer: pair.observer,
    trace: false,
    benchmark: true,
    selector: pair.selector,
  )
  res_a = LiquidReference::Renderer.render(
    engine: engine,
    template: after_tpl,
    assigns: ctx_a,
    observer: pair.observer,
    trace: false,
    benchmark: true,
    selector: pair.selector,
  )
  raise "Render error in overhead probe" unless res_b["status"] == "ok" && res_a["status"] == "ok"

  per_iter_ms << ((Process.clock_gettime(Process::CLOCK_MONOTONIC) - t0) * 1000.0)
end
total_ms = (Process.clock_gettime(Process::CLOCK_MONOTONIC) - t_total_start) * 1000.0

sorted = per_iter_ms.sort
median_ms = sorted[sorted.length / 2]
p95_ms = sorted[[(sorted.length * 0.95).ceil - 1, sorted.length - 1].min]

puts JSON.generate(
  {
    "engine" => engine,
    "case_id" => options[:case_id],
    "iterations" => options[:iterations],
    "compile_ms" => compile_ms.round(3),
    "total_ms" => total_ms.round(3),
    "mean_ms" => (total_ms / options[:iterations]).round(4),
    "median_ms" => median_ms.round(4),
    "p95_ms" => p95_ms.round(4),
  },
)

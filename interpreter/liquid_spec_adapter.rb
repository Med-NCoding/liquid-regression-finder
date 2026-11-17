# frozen_string_literal: true

LiquidSpec.setup do |ctx|
  # Required by liquid-spec's internal test-drop harness (deps/liquid_ruby.rb).
  require "liquid"
  lib_dir = File.expand_path("lib", __dir__)
  $LOAD_PATH.unshift(lib_dir) unless $LOAD_PATH.include?(lib_dir)
  require "liquid_interpreter"
  ctx[:interpreter] = LiquidInterpreter
end

LiquidSpec.configure do |config|
  config.suite = :all
  config.error_modes = [:strict2, :strict]
  config.render_error_modes = [:raise]
  config.missing_features = [
    :drops,
    :ruby_drops,
    :drop_class_output,
    :ruby_types,
    :template_factory,
    :binary_data,
    :shopify_tags,
    :shopify_objects,
    :shopify_filters,
    :shopify_error_handling,
    :shopify_blank,
    :shopify_string_access,
    :shopify_error_format,
    :shopify_includes,
    :shopify_resource_limits,
    :range_resource_limits,
    :strict2_blank_body_errors,
    :self_environment_shadowing,
    :randomness,
  ]
end

LiquidSpec.compile do |ctx, source, parse_options|
  template = LiquidInterpreter::Template.compile(source, **(parse_options || {}))
  ctx[:template] = template
  ctx[:ast] = template.ast
end

LiquidSpec.render do |ctx, assigns, render_options|
  ctx[:template].render(assigns || {}, **(render_options || {}))
end

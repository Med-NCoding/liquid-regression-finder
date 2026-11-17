# frozen_string_literal: true

$LOAD_PATH.unshift(File.expand_path("../../interpreter/lib", __dir__)) unless $LOAD_PATH.include?(File.expand_path("../../interpreter/lib", __dir__))

require "liquid"
require "nokogiri"
require "liquid_interpreter"

require_relative "liquid_reference/version"
require_relative "liquid_reference/fixture_validator"
require_relative "liquid_reference/projection"
require_relative "liquid_reference/observer"
require_relative "liquid_reference/renderer"
require_relative "liquid_reference/worker"

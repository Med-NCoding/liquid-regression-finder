# frozen_string_literal: true

require "json"
require "json_schemer"
require "pathname"

module ContractSchemas
  module_function

  def repo_root
    Pathname.new(ENV.fetch("LIQUID_REGRESSION_REPO_ROOT") { Rails.root.join("..").cleanpath.to_s })
  end

  def schemas_dir
    repo_root.join("contracts", "schemas")
  end

  def ref_resolver
    @ref_resolver ||= lambda do |uri|
      path = schemas_dir.join(File.basename(uri.path))
      JSON.parse(File.read(path, encoding: Encoding::UTF_8))
    end
  end

  def schema(name)
    @schemas ||= {}
    @schemas[name.to_s] ||= begin
      raw = JSON.parse(File.read(schemas_dir.join("#{name}.schema.json"), encoding: Encoding::UTF_8))
      JSONSchemer.schema(raw, ref_resolver: ref_resolver)
    end
  end

  def stats_schemer
    @stats_schemer ||= schema("comparison_job").ref("#/$defs/stats")
  end

  def diagnostic_schemer
    @diagnostic_schemer ||= schema("render_result").ref("#/$defs/diagnostic")
  end

  def valid_finding?(obj)
    schema("finding").valid?(obj)
  end

  def valid_stats?(obj)
    stats_schemer.valid?(obj)
  end

  def valid_diagnostic?(obj)
    diagnostic_schemer.valid?(obj)
  end

  def valid_comparison_job?(obj)
    schema("comparison_job").valid?(obj)
  end
end

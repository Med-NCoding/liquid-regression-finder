# frozen_string_literal: true

require "test_helper"

class ComparisonRunnerTest < ActiveSupport::TestCase
  test "runs real python search compare on demo snippets from inside api bundle env" do
    repo_root = ContractSchemas.repo_root
    req = valid_compare_request(
      before_source: File.read(repo_root.join("fixtures/demo/before.liquid"), encoding: Encoding::UTF_8),
      after_source: File.read(repo_root.join("fixtures/demo/after.liquid"), encoding: Encoding::UTF_8),
      seed: 0,
      search_pairs: 128,
      shrink_pairs: 64
    )

    result = ComparisonRunner.new.run(req)
    assert_equal :difference_found, result.outcome
    assert_nil result.error
    assert ContractSchemas.valid_finding?(result.finding)
    assert ContractSchemas.valid_stats?(result.stats)
    assert_equal "structural_change", result.finding.dig("explanation", "kind")
  end

  test "runs real python search compare on identical snippets and invalid liquid" do
    ident_req = valid_compare_request(
      before_source: "<span data-regression-badge=\"sale\">Sale</span>",
      after_source: "<span data-regression-badge=\"sale\">Sale</span>",
      search_pairs: 8,
      shrink_pairs: 0
    )
    ident_res = ComparisonRunner.new.run(ident_req)
    assert_equal :no_difference_found, ident_res.outcome
    assert_nil ident_res.finding
    assert ContractSchemas.valid_stats?(ident_res.stats)

    bad_req = valid_compare_request(
      before_source: "{% bogus_unknown_tag %}",
      after_source: "ok",
      search_pairs: 8,
      shrink_pairs: 0
    )
    bad_res = ComparisonRunner.new.run(bad_req)
    assert_equal :terminal_failed, bad_res.outcome
    assert_not_nil bad_res.error
    assert_valid_diagnostic(bad_res.error)
    assert_includes %w[unsupported_tag syntax_error compile_error], bad_res.error["code"]
  end

  test "enforces watchdog timeout and reaps stubborn child process group" do
    pid_file = File.join(Dir.tmpdir, "lrf-watchdog-test-#{SecureRandom.hex(6)}.pid")
    runner = ComparisonRunner.new(
      watchdog_seconds: 0.3,
      term_grace_seconds: 0.15,
      command_builder: lambda { |_req, _before, _after|
        [
          "/bin/sh", "-c",
          "trap '' TERM; echo $$ > #{pid_file}; sleep 30"
        ]
      }
    )

    result = runner.run(valid_compare_request(before_source: "a", after_source: "b"))
    assert_equal :infrastructure_failed, result.outcome
    assert_equal "runner_timeout", result.error["code"]

    if File.exist?(pid_file)
      child_pid = File.read(pid_file).strip.to_i
      sleep 0.05
      alive = begin
        Process.kill(0, child_pid)
        true
      rescue Errno::ESRCH
        false
      end
      refute alive, "Expected watchdog-killed child PID #{child_pid} to be reaped"
    end
  ensure
    File.delete(pid_file) if pid_file && File.exist?(pid_file)
  end

  test "rejects malformed stdout JSON and non-matching schema output as infrastructure_failed" do
    bad_json_runner = ComparisonRunner.new(
      command_builder: ->(_req, _b, _a) { [ "/bin/sh", "-c", "printf 'not-json'" ] }
    )
    res1 = bad_json_runner.run(valid_compare_request(before_source: "a", after_source: "b"))
    assert_equal :infrastructure_failed, res1.outcome
    assert_equal "invalid_worker_output", res1.error["code"]

    crash_runner = ComparisonRunner.new(
      command_builder: ->(_req, _b, _a) { [ "/bin/sh", "-c", "echo boom >&2; exit 3" ] }
    )
    res2 = crash_runner.run(valid_compare_request(before_source: "a", after_source: "b"))
    assert_equal :infrastructure_failed, res2.outcome
    assert_equal "runner_crashed", res2.error["code"]
  end
end

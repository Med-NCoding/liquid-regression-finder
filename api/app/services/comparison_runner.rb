# frozen_string_literal: true

require "json"
require "pathname"
require "tmpdir"

class ComparisonRunner
  WATCHDOG_SECONDS = 90.0
  TERM_GRACE_SECONDS = 1.0
  MAX_STDOUT_BYTES = 16 * 1024 * 1024
  MAX_STDERR_BYTES = 256 * 1024

  INFRASTRUCTURE_ERROR_CODES = %w[
    worker_launch_error
    worker_timeout
    job_deadline_exceeded
    protocol_error
    response_too_large
    internal_error
    worker_error
    input_file_error
    replay_write_error
    runner_timeout
    runner_crashed
    runner_launch_error
    invalid_worker_output
  ].freeze

  Result = Struct.new(
    :outcome, # :difference_found | :no_difference_found | :terminal_failed | :infrastructure_failed
    :finding,
    :stats,
    :error,
    keyword_init: true
  )

  def self.resolve_python_bin
    override = ENV["LIQUID_REGRESSION_PYTHON_BIN"]
    return override if override && !override.empty?

    homebrew_py = "/opt/homebrew/opt/python@3.11/bin/python3.11"
    return homebrew_py if File.executable?(homebrew_py)

    "python3.11"
  end

  def initialize(
    repo_root: ContractSchemas.repo_root.to_s,
    python_bin: self.class.resolve_python_bin,
    watchdog_seconds: WATCHDOG_SECONDS,
    term_grace_seconds: TERM_GRACE_SECONDS,
    max_stdout_bytes: MAX_STDOUT_BYTES,
    command_builder: nil
  )
    @repo_root = repo_root.to_s
    @python_bin = python_bin.to_s
    @watchdog_seconds = Float(watchdog_seconds)
    @term_grace_seconds = Float(term_grace_seconds)
    @max_stdout_bytes = Integer(max_stdout_bytes)
    @command_builder = command_builder
  end

  def run(request_hash)
    Dir.mktmpdir("lrf-compare-") do |tmpdir|
      before_path = File.join(tmpdir, "before.liquid")
      after_path = File.join(tmpdir, "after.liquid")

      File.binwrite(before_path, request_hash.dig("before", "source").encode(Encoding::UTF_8))
      File.binwrite(after_path, request_hash.dig("after", "source").encode(Encoding::UTF_8))

      cmd = build_command(request_hash, before_path, after_path)
      exec_result = execute_process(cmd)

      return exec_result[:failure] if exec_result[:failure]

      parse_and_validate_output(
        stdout: exec_result[:stdout],
        stderr: exec_result[:stderr],
        status: exec_result[:status],
        request_hash: request_hash
      )
    end
  end

  private

  def build_command(request_hash, before_path, after_path)
    return @command_builder.call(request_hash, before_path, after_path) if @command_builder

    [
      @python_bin,
      "-m", "search", "compare",
      "--before", before_path,
      "--after", after_path,
      "--observer", request_hash.fetch("observer").to_s,
      "--seed", request_hash.fetch("seed").to_s,
      "--search-pairs", request_hash.dig("budget", "search_pairs").to_s,
      "--shrink-pairs", request_hash.dig("budget", "shrink_pairs").to_s
    ]
  end

  def clean_child_env
    base = defined?(Bundler) && Bundler.respond_to?(:unbundled_env) ? Bundler.unbundled_env : ENV.to_h
    env = base.dup
    env["PYTHONUTF8"] = "1"
    ruby_bin_dir = "/opt/homebrew/opt/ruby@3.3/bin"
    if File.directory?(ruby_bin_dir)
      path_entries = env.fetch("PATH", "").split(File::PATH_SEPARATOR)
      unless path_entries.include?(ruby_bin_dir)
        env["PATH"] = ([ ruby_bin_dir ] + path_entries).join(File::PATH_SEPARATOR)
      end
    end
    env
  end

  def execute_process(cmd)
    out_r, out_w = IO.pipe
    err_r, err_w = IO.pipe
    out_r.binmode
    err_r.binmode

    pid = nil
    status = nil
    stdout_buf = +""
    stderr_buf = +""
    deadline = monotonic_now + @watchdog_seconds

    begin
      pid = Process.spawn(
        clean_child_env,
        *cmd,
        unsetenv_others: true,
        chdir: @repo_root,
        pgroup: true,
        in: :close,
        out: out_w,
        err: err_w
      )
    rescue SystemCallError => e
      return {
        failure: infrastructure_failure(
          "runner_launch_error",
          "Failed to spawn search process (#{e.class}): #{e.message}"
        )
      }
    ensure
      out_w.close unless out_w.closed?
      err_w.close unless err_w.closed?
    end

    readers = [ out_r, err_r ]
    until readers.empty?
      remaining = deadline - monotonic_now
      if remaining <= 0
        terminate_process_group(pid)
        return {
          failure: infrastructure_failure(
            "runner_timeout",
            "Search subprocess exceeded #{@watchdog_seconds.to_i}s hard watchdog"
          )
        }
      end

      ready, = IO.select(readers, nil, nil, [ remaining, 0.25 ].min)
      next unless ready

      ready.each do |io|
        chunk = io.read_nonblock(65_536, exception: false)
        next if chunk == :wait_readable

        if chunk.nil?
          io.close
          readers.delete(io)
        elsif io == out_r
          if stdout_buf.bytesize + chunk.bytesize > @max_stdout_bytes
            terminate_process_group(pid)
            return {
              failure: infrastructure_failure(
                "response_too_large",
                "Search subprocess stdout exceeded #{@max_stdout_bytes} bytes"
              )
            }
          end
          stdout_buf << chunk
        elsif stderr_buf.bytesize < MAX_STDERR_BYTES
          remaining_err = MAX_STDERR_BYTES - stderr_buf.bytesize
          stderr_buf << chunk.byteslice(0, remaining_err)
        end
      end
    end

    loop do
      status = reap_pid(pid)
      break if status

      if monotonic_now >= deadline
        terminate_process_group(pid)
        return {
          failure: infrastructure_failure(
            "runner_timeout",
            "Search subprocess exceeded #{@watchdog_seconds.to_i}s hard watchdog before exiting"
          )
        }
      end
      sleep(0.02)
    end

    { stdout: stdout_buf, stderr: stderr_buf, status: status }
  ensure
    out_r.close unless out_r.closed?
    err_r.close unless err_r.closed?
    terminate_process_group(pid) if pid && status.nil?
  end

  def parse_and_validate_output(stdout:, stderr:, status:, request_hash:)
    stdout_utf8 = stdout.dup.force_encoding(Encoding::UTF_8)
    unless stdout_utf8.valid_encoding?
      return infrastructure_failure(
        "invalid_worker_output",
        "Search subprocess emitted invalid UTF-8 on stdout"
      )
    end

    if stdout_utf8.strip.empty?
      exit_desc = status.signaled? ? "signal #{status.termsig}" : "exit #{status.exitstatus}"
      stderr_hint = stderr.dup.force_encoding(Encoding::UTF_8).encode(Encoding::UTF_8, invalid: :replace, undef: :replace).strip
      detail = stderr_hint.empty? ? "" : ": #{stderr_hint[-256..]}"
      return infrastructure_failure(
        "runner_crashed",
        "Search subprocess exited (#{exit_desc}) with empty stdout#{detail}"
      )
    end

    report = begin
      JSON.parse(stdout_utf8)
    rescue JSON::ParserError => e
      return infrastructure_failure(
        "invalid_worker_output",
        "Search subprocess emitted malformed JSON (#{e.message})"
      )
    end

    unless report.is_a?(Hash)
      return infrastructure_failure(
        "invalid_worker_output",
        "Search subprocess JSON output must be an object"
      )
    end

    exit_code = status.exitstatus
    case [ report["status"], exit_code ]
    when [ "difference_found", 1 ]
      validate_difference_found(report, request_hash)
    when [ "no_difference_found", 0 ]
      validate_no_difference_found(report)
    when [ "failed", 2 ]
      validate_failed_report(report)
    else
      infrastructure_failure(
        "invalid_worker_output",
        "Unexpected search report status=#{report['status'].inspect} with exit_code=#{exit_code.inspect}"
      )
    end
  end

  def validate_difference_found(report, request_hash)
    finding = report["finding"]
    stats = report["stats"]
    unless report["error"].nil? &&
           ContractSchemas.valid_finding?(finding) &&
           ContractSchemas.valid_stats?(stats) &&
           finding.dig("replay", "request") == request_hash
      return infrastructure_failure(
        "invalid_worker_output",
        "Search subprocess difference_found payload failed contract schema verification"
      )
    end

    Result.new(outcome: :difference_found, finding: finding, stats: stats)
  end

  def validate_no_difference_found(report)
    stats = report["stats"]
    unless report["finding"].nil? &&
           report["error"].nil? &&
           ContractSchemas.valid_stats?(stats)
      return infrastructure_failure(
        "invalid_worker_output",
        "Search subprocess no_difference_found payload failed contract schema verification"
      )
    end

    Result.new(outcome: :no_difference_found, stats: stats)
  end

  def validate_failed_report(report)
    error = report["error"]
    stats = report["stats"]
    unless report["finding"].nil? &&
           ContractSchemas.valid_diagnostic?(error) &&
           (stats.nil? || ContractSchemas.valid_stats?(stats))
      return infrastructure_failure(
        "invalid_worker_output",
        "Search subprocess failed payload failed contract schema verification"
      )
    end

    outcome = INFRASTRUCTURE_ERROR_CODES.include?(error["code"]) ? :infrastructure_failed : :terminal_failed
    Result.new(outcome: outcome, stats: stats, error: error)
  end

  def infrastructure_failure(code, message)
    Result.new(
      outcome: :infrastructure_failed,
      stats: nil,
      error: { "code" => code, "message" => message, "span" => nil }
    )
  end

  def terminate_process_group(pid)
    return unless pid

    begin
      Process.kill("TERM", -pid)
    rescue Errno::ESRCH, Errno::EPERM
      return reap_pid(pid)
    end

    term_deadline = monotonic_now + @term_grace_seconds
    loop do
      reaped = reap_pid(pid)
      return reaped if reaped
      break if monotonic_now >= term_deadline

      sleep(0.02)
    end

    begin
      Process.kill("KILL", -pid)
    rescue Errno::ESRCH, Errno::EPERM
      nil
    end
    reap_pid(pid, block: true)
  end

  def reap_pid(pid, block: false)
    flags = block ? 0 : Process::WNOHANG
    waited_pid, status = Process.waitpid2(pid, flags)
    waited_pid ? status : nil
  rescue Errno::ECHILD
    nil
  end

  def monotonic_now
    Process.clock_gettime(Process::CLOCK_MONOTONIC)
  end
end

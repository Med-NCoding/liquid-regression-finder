import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CliError, resolveEngineRoot } from "./paths.mjs";

const HOMEBREW_PYTHON_311 = "/opt/homebrew/opt/python@3.11/bin/python3.11";
const HOMEBREW_RUBY_BUNDLE = "/opt/homebrew/opt/ruby@3.3/bin/bundle";
const DEFAULT_TIMEOUT_MS = 100_000;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

function isExecutableFile(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function findExecutableOnPath(cmdName) {
  const pathEnv = process.env.PATH || "";
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, cmdName);
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }
  return null;
}

function probePythonVersion(pythonBin) {
  try {
    const out = execFileSync(
      pythonBin,
      ["-c", "import sys; print(f'{sys.version_info[0]}.{sys.version_info[1]}')"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: false, timeout: 5000 },
    ).trim();
    const parts = out.split(".");
    if (parts.length !== 2) return null;
    const major = Number(parts[0]);
    const minor = Number(parts[1]);
    if (!Number.isInteger(major) || !Number.isInteger(minor)) return null;
    return { major, minor };
  } catch {
    return null;
  }
}

/**
 * Resolve Python >= 3.10: LRF_PYTHON -> python3.11 / Homebrew 3.11 -> python3 >= 3.10.
 */
export function resolvePythonExecutable() {
  const override = (process.env.LRF_PYTHON || "").trim();
  if (override) {
    const ver = probePythonVersion(override);
    if (!ver) {
      throw new CliError("python_not_found", `LRF_PYTHON='${override}' is not a runnable Python executable.`);
    }
    if (ver.major < 3 || (ver.major === 3 && ver.minor < 10)) {
      throw new CliError(
        "python_version_error",
        `LRF_PYTHON='${override}' is Python ${ver.major}.${ver.minor}; Python >= 3.10 is required.`,
      );
    }
    return override;
  }

  const candidates = [];
  const py311OnPath = findExecutableOnPath("python3.11");
  if (py311OnPath) candidates.push(py311OnPath);
  if (isExecutableFile(HOMEBREW_PYTHON_311)) candidates.push(HOMEBREW_PYTHON_311);
  if (isExecutableFile("/usr/local/bin/python3.11")) candidates.push("/usr/local/bin/python3.11");
  const py3OnPath = findExecutableOnPath("python3");
  if (py3OnPath) candidates.push(py3OnPath);

  for (const candidate of candidates) {
    const ver = probePythonVersion(candidate);
    if (ver && (ver.major > 3 || (ver.major === 3 && ver.minor >= 10))) {
      return candidate;
    }
  }

  throw new CliError(
    "python_not_found",
    "Python 3.10+ (python3.11 recommended) was not found. Install Python 3.11 or set LRF_PYTHON.",
  );
}

/**
 * Resolve Ruby Bundler executable: LRF_RUBY_BUNDLE -> bundle avoiding macOS /usr/bin/bundle stub when Homebrew Ruby exists.
 */
export function resolveBundleExecutable() {
  const override = (process.env.LRF_RUBY_BUNDLE || "").trim();
  if (override) {
    if (isExecutableFile(override)) {
      return override;
    }
    const foundOverride = findExecutableOnPath(override);
    if (foundOverride) {
      return foundOverride;
    }
    throw new CliError("bundle_not_found", `LRF_RUBY_BUNDLE='${override}' is not an executable file or command.`);
  }

  const hasHomebrewBundle = isExecutableFile(HOMEBREW_RUBY_BUNDLE);
  const pathEnv = process.env.PATH || "";
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, "bundle");
    if (isExecutableFile(candidate)) {
      if (candidate === "/usr/bin/bundle" && hasHomebrewBundle) {
        continue;
      }
      return candidate;
    }
  }

  if (hasHomebrewBundle) {
    return HOMEBREW_RUBY_BUNDLE;
  }
  if (isExecutableFile("/usr/local/bin/bundle")) {
    return "/usr/local/bin/bundle";
  }

  throw new CliError(
    "bundle_not_found",
    "Ruby Bundler executable was not found. Install Ruby 3.3 + Bundler or set LRF_RUBY_BUNDLE.",
  );
}

/**
 * Construct child environment for Python + Ruby worker invocation.
 */
export function buildEngineEnv({ engineRoot, bundleBin }) {
  const env = { ...process.env };
  env.LRF_ENGINE_ROOT = engineRoot;
  env.LRF_RUBY_BUNDLE = bundleBin;
  env.PYTHONUTF8 = "1";
  env.PYTHONPATH = env.PYTHONPATH
    ? `${engineRoot}${path.delimiter}${env.PYTHONPATH}`
    : engineRoot;

  const bundleDir = path.dirname(bundleBin);
  if (bundleDir) {
    const existingPath = env.PATH || "";
    const parts = existingPath ? existingPath.split(path.delimiter) : [];
    if (!parts.includes(bundleDir)) {
      env.PATH = existingPath ? `${bundleDir}${path.delimiter}${existingPath}` : bundleDir;
    }
  }

  if (!env.BUNDLE_GEMFILE) {
    const engineGemfile = path.join(engineRoot, "engine", "Gemfile");
    const engineVendor = path.join(engineRoot, "engine", "vendor", "bundle");
    const rootGemfile = path.join(engineRoot, "Gemfile");
    const rootVendor = path.join(engineRoot, "vendor", "bundle");
    const engineBundleCfg = path.join(engineRoot, "engine", ".bundle");

    if (fs.existsSync(engineGemfile) && fs.existsSync(engineVendor)) {
      env.BUNDLE_GEMFILE = engineGemfile;
      if (!env.BUNDLE_PATH) {
        env.BUNDLE_PATH = engineVendor;
      }
      if (!env.BUNDLE_APP_CONFIG && fs.existsSync(engineBundleCfg)) {
        env.BUNDLE_APP_CONFIG = engineBundleCfg;
      }
    } else if (fs.existsSync(rootGemfile)) {
      env.BUNDLE_GEMFILE = rootGemfile;
      if (!env.BUNDLE_PATH && fs.existsSync(rootVendor)) {
        env.BUNDLE_PATH = rootVendor;
      }
    }
  }

  return env;
}

function terminateChildGroup(child, { graceMs = 600 } = {}) {
  if (!child || child.pid === undefined) return;
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      return;
    }
  }
  const killTimer = setTimeout(() => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already exited.
      }
    }
  }, graceMs);
  if (typeof killTimer.unref === "function") {
    killTimer.unref();
  }
  child.once("close", () => {
    clearTimeout(killTimer);
  });
}

/**
 * Execute `[pythonBin, "-m", "search", ...args]` with process-group reaping on timeout/signals/abort.
 */
export async function runPythonSearch(
  args,
  {
    engineRoot = resolveEngineRoot(),
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal = null,
    waitForCloseOnAbort = false,
  } = {},
) {
  if (signal?.aborted) {
    throw new CliError("aborted", "Search engine run was aborted.");
  }

  const pythonBin = resolvePythonExecutable();
  const bundleBin = resolveBundleExecutable();
  const env = buildEngineEnv({ engineRoot, bundleBin });

  return new Promise((resolve, reject) => {
    let settled = false;
    let aborted = false;
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;

    let child;
    try {
      child = spawn(pythonBin, ["-m", "search", ...args], {
        cwd: engineRoot,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        detached: true,
      });
    } catch (err) {
      reject(new CliError("engine_launch_error", `Failed starting Python search engine: ${err.message}`));
      return;
    }

    const cleanupListeners = () => {
      clearTimeout(timeoutId);
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      } else {
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
        process.off("SIGHUP", onSignal);
      }
    };

    const failOnce = (cliErr) => {
      if (settled) return;
      settled = true;
      cleanupListeners();
      terminateChildGroup(child);
      reject(cliErr);
    };

    const onSignal = (sig) => {
      failOnce(new CliError("interrupted", `Interrupted by signal ${sig} while running Liquid engine.`));
    };

    const onAbort = () => {
      if (settled || aborted) return;
      aborted = true;
      clearTimeout(timeoutId);
      terminateChildGroup(child);
      if (!waitForCloseOnAbort) {
        failOnce(new CliError("aborted", "Search engine run was aborted."));
      }
    };

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    } else {
      process.on("SIGINT", onSignal);
      process.on("SIGTERM", onSignal);
      process.on("SIGHUP", onSignal);
    }

    const timeoutId = setTimeout(() => {
      failOnce(
        new CliError(
          "engine_timeout",
          `Liquid comparison engine exceeded ${Math.round(timeoutMs / 1000)}s timeout.`,
        ),
      );
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      if (aborted) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_OUTPUT_BYTES) {
        failOnce(new CliError("response_too_large", "Search engine output exceeded 32 MiB limit."));
        return;
      }
      stdoutChunks.push(chunk);
    });

    child.stderr.on("data", (chunk) => {
      if (aborted) return;
      if (stderrBytes < 262_144) {
        const take = Math.min(chunk.length, 262_144 - stderrBytes);
        stderrChunks.push(chunk.subarray(0, take));
        stderrBytes += take;
      }
    });

    child.on("error", (err) => {
      if (aborted) {
        if (settled) return;
        settled = true;
        cleanupListeners();
        reject(new CliError("aborted", "Search engine run was aborted."));
        return;
      }
      failOnce(new CliError("engine_launch_error", `Failed executing Python search engine: ${err.message}`));
    });

    child.on("close", (code, signalName) => {
      if (settled) return;
      settled = true;
      cleanupListeners();

      if (aborted) {
        reject(new CliError("aborted", "Search engine run was aborted."));
        return;
      }

      const stdoutText = Buffer.concat(stdoutChunks).toString("utf8");
      const stderrText = Buffer.concat(stderrChunks).toString("utf8").trim();

      if (signalName) {
        reject(
          new CliError(
            "engine_killed",
            `Search engine process terminated by signal ${signalName}${stderrText ? `: ${stderrText}` : ""}`,
          ),
        );
        return;
      }

      if (!stdoutText.trim()) {
        reject(
          new CliError(
            "engine_error",
            `Search engine exited (${code}) with empty output${stderrText ? `: ${stderrText}` : ""}`,
          ),
        );
        return;
      }

      let payload;
      try {
        payload = JSON.parse(stdoutText);
      } catch (err) {
        reject(
          new CliError(
            "invalid_engine_output",
            `Search engine emitted malformed JSON (exit ${code}): ${err.message}${stderrText ? ` (stderr: ${stderrText})` : ""}`,
          ),
        );
        return;
      }

      resolve({
        exitCode: code ?? 2,
        report: payload,
        stderr: stderrText,
      });
    });
  });
}

/**
 * Run `python -m search compare` asynchronously, supporting optional priority fixtures and AbortSignal cancellation.
 */
export async function runCompareAsync({
  beforeBytes,
  afterBytes,
  observer = "sale_badge",
  seed = 0,
  searchPairs = 256,
  shrinkPairs = 128,
  priorityFixtures = [],
  engineRoot = resolveEngineRoot(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal = null,
}) {
  if (signal?.aborted) {
    throw new CliError("aborted", "Search engine run was aborted.");
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lrf-compare-"));
  const beforeTmp = path.join(tmpDir, "before.liquid");
  const afterTmp = path.join(tmpDir, "after.liquid");

  try {
    fs.writeFileSync(beforeTmp, beforeBytes);
    fs.writeFileSync(afterTmp, afterBytes);

    const args = [
      "compare",
      "--before",
      beforeTmp,
      "--after",
      afterTmp,
      "--observer",
      String(observer),
      "--seed",
      String(seed),
      "--search-pairs",
      String(searchPairs),
      "--shrink-pairs",
      String(shrinkPairs),
    ];

    for (let idx = 0; idx < priorityFixtures.length; idx += 1) {
      const pfPath = path.join(tmpDir, `priority-${idx}.json`);
      fs.writeFileSync(pfPath, JSON.stringify(priorityFixtures[idx]), "utf8");
      args.push("--priority-fixture", pfPath);
    }

    return await runPythonSearch(args, {
      engineRoot,
      timeoutMs,
      signal,
      waitForCloseOnAbort: Boolean(signal),
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Start a cancellable `runCompareAsync` task returning `{ promise, cancel }`.
 */
export function startCompareTask(options) {
  const controller = new AbortController();
  const promise = runCompareAsync({
    ...options,
    signal: controller.signal,
  });
  return {
    promise,
    cancel: () => controller.abort(),
  };
}

/**
 * Run `python -m search compare` passing raw source byte Buffers via secure temp files.
 */
export async function runCompare(options) {
  return runCompareAsync(options);
}

/**
 * Run `python -m search replay --bundle <bundlePath>`.
 */
export async function runReplay({
  bundlePath,
  engineRoot = resolveEngineRoot(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  return runPythonSearch(["replay", "--bundle", bundlePath], { engineRoot, timeoutMs });
}

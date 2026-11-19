import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CliError, resolveEngineRoot, resolveUserGemCacheDir } from "./paths.mjs";

const HOMEBREW_PYTHON_311 = "/opt/homebrew/opt/python@3.11/bin/python3.11";
const HOMEBREW_RUBY_33 = "/opt/homebrew/opt/ruby@3.3/bin/ruby";
const HOMEBREW_RUBY_BUNDLE = "/opt/homebrew/opt/ruby@3.3/bin/bundle";
const DEFAULT_TIMEOUT_MS = 100_000;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

const MIN_NODE_VERSION = [18, 0, 0];
const MIN_PYTHON_VERSION = [3, 10, 0];
const MIN_RUBY_VERSION = [3, 1, 0];
const MIN_BUNDLER_VERSION = [2, 0, 0];

const REMEDIATION = {
  git: {
    required: "any runnable git executable on PATH",
    commands: [
      "macOS: xcode-select --install  (or: brew install git)",
      "Ubuntu/Debian: sudo apt-get update && sudo apt-get install -y git",
    ],
  },
  node: {
    required: ">= 18.0.0",
    commands: [
      "macOS: brew install node@24  (or: nvm install 24)",
      "Ubuntu/Debian: nvm install 24  (or install Node.js >= 18 from https://nodejs.org/)",
    ],
  },
  python: {
    required: ">= 3.10.0",
    commands: [
      "macOS: brew install python@3.11 && export PATH=\"/opt/homebrew/opt/python@3.11/bin:$PATH\"  (or set LRF_PYTHON=/opt/homebrew/opt/python@3.11/bin/python3.11)",
      "Ubuntu/Debian: sudo apt-get update && sudo apt-get install -y python3.11  (or: pyenv install 3.11)",
    ],
  },
  ruby: {
    required: ">= 3.1.0",
    commands: [
      "macOS: brew install ruby@3.3 && export PATH=\"/opt/homebrew/opt/ruby@3.3/bin:$PATH\"  (or set LRF_RUBY=/opt/homebrew/opt/ruby@3.3/bin/ruby)",
      "Ubuntu/Debian: sudo apt-get update && sudo apt-get install -y ruby-full  (or install Ruby 3.3 via rbenv / mise)",
    ],
  },
  bundler: {
    required: ">= 2.0.0 running on Ruby >= 3.1.0",
    commands: [
      "macOS: brew install ruby@3.3 && export PATH=\"/opt/homebrew/opt/ruby@3.3/bin:$PATH\"  (or set LRF_RUBY_BUNDLE=/opt/homebrew/opt/ruby@3.3/bin/bundle)",
      "Ubuntu/Debian: gem install bundler  (under Ruby >= 3.1, or: sudo apt-get install -y ruby-bundler)",
    ],
  },
};

function isExecutableFile(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function findAllExecutablesOnPath(cmdName) {
  const pathEnv = process.env.PATH || "";
  const seen = new Set();
  const matches = [];
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, cmdName);
    if (!seen.has(candidate) && isExecutableFile(candidate)) {
      seen.add(candidate);
      matches.push(candidate);
    }
  }
  return matches;
}

function findExecutableOnPath(cmdName) {
  return findAllExecutablesOnPath(cmdName)[0] || null;
}

function resolveOverrideExecutable(rawOverride) {
  if (isExecutableFile(rawOverride)) {
    return rawOverride;
  }
  return findExecutableOnPath(rawOverride);
}

function parseVersionTuple(rawVersion) {
  if (typeof rawVersion !== "string") return null;
  const match = rawVersion.trim().match(/^v?(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = match[3] !== undefined ? Number(match[3]) : 0;
  if (!Number.isInteger(major) || !Number.isInteger(minor) || !Number.isInteger(patch)) {
    return null;
  }
  return {
    major,
    minor,
    patch,
    version: `${major}.${minor}.${patch}`,
  };
}

function isTupleAtLeast(ver, minTuple) {
  if (!ver) return false;
  if (ver.major !== minTuple[0]) return ver.major > minTuple[0];
  if (ver.minor !== minTuple[1]) return ver.minor > minTuple[1];
  return ver.patch >= minTuple[2];
}

function formatRemediationHint(tool) {
  const info = REMEDIATION[tool];
  if (!info) return "";
  return ` Install/configure:\n  ${info.commands.join("\n  ")}`;
}

function probeGitVersion(gitBin) {
  try {
    const out = execFileSync(gitBin, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      timeout: 5000,
    }).trim();
    const match = out.match(/\b(\d+\.\d+(?:\.\d+)?)/);
    return { ok: true, version: match ? match[1] : out };
  } catch {
    return { ok: false, version: null };
  }
}

/**
 * Inspect Git prerequisite availability and version.
 */
export function inspectGitPrerequisite() {
  const candidates = findAllExecutablesOnPath("git");
  if (candidates.length === 0) {
    return {
      ok: false,
      tool: "git",
      code: "git_missing",
      executable: null,
      detected_version: null,
      required_version: REMEDIATION.git.required,
      message: "Git executable ('git') was not found on PATH.",
      remediation: [...REMEDIATION.git.commands],
    };
  }
  for (const cand of candidates) {
    const probed = probeGitVersion(cand);
    if (probed.ok) {
      return {
        ok: true,
        tool: "git",
        executable: cand,
        version: probed.version,
      };
    }
  }
  return {
    ok: false,
    tool: "git",
    code: "git_missing",
    executable: candidates[0],
    detected_version: null,
    required_version: REMEDIATION.git.required,
    message: `Git executable '${candidates[0]}' failed to run.`,
    remediation: [...REMEDIATION.git.commands],
  };
}

/**
 * Inspect Node.js prerequisite version (`>= 18.0.0`).
 */
export function inspectNodePrerequisite() {
  const parsed = parseVersionTuple(process.versions?.node || "");
  if (!parsed || !isTupleAtLeast(parsed, MIN_NODE_VERSION)) {
    return {
      ok: false,
      tool: "node",
      code: "node_version_error",
      executable: process.execPath,
      detected_version: parsed ? parsed.version : (process.versions?.node || "unknown"),
      required_version: REMEDIATION.node.required,
      message: `Node.js ${parsed ? parsed.version : "unknown"} is unsupported; Node.js >= 18.0.0 is required.`,
      remediation: [...REMEDIATION.node.commands],
    };
  }
  return {
    ok: true,
    tool: "node",
    executable: process.execPath,
    version: parsed.version,
  };
}

function probePythonVersion(pythonBin) {
  try {
    const out = execFileSync(
      pythonBin,
      ["-c", "import sys; print('.'.join(map(str, sys.version_info[:3])))"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: false, timeout: 5000 },
    ).trim();
    return parseVersionTuple(out);
  } catch {
    return null;
  }
}

/**
 * Inspect Python `>= 3.10` prerequisite (`LRF_PYTHON` -> `python3.11` / Homebrew 3.11 -> `python3 >= 3.10`).
 */
export function inspectPythonPrerequisite() {
  const override = (process.env.LRF_PYTHON || "").trim();
  if (override) {
    const resolved = resolveOverrideExecutable(override);
    if (!resolved) {
      return {
        ok: false,
        tool: "python",
        code: "python_not_found",
        executable: override,
        detected_version: null,
        required_version: REMEDIATION.python.required,
        message: `LRF_PYTHON='${override}' is not a runnable Python executable.`,
        remediation: [...REMEDIATION.python.commands],
      };
    }
    const ver = probePythonVersion(resolved);
    if (!ver) {
      return {
        ok: false,
        tool: "python",
        code: "python_not_found",
        executable: resolved,
        detected_version: null,
        required_version: REMEDIATION.python.required,
        message: `LRF_PYTHON='${override}' failed Python version probe.`,
        remediation: [...REMEDIATION.python.commands],
      };
    }
    if (!isTupleAtLeast(ver, MIN_PYTHON_VERSION)) {
      return {
        ok: false,
        tool: "python",
        code: "python_version_error",
        executable: resolved,
        detected_version: ver.version,
        required_version: REMEDIATION.python.required,
        message: `LRF_PYTHON='${override}' is Python ${ver.version}; Python >= 3.10 is required.`,
        remediation: [...REMEDIATION.python.commands],
      };
    }
    return {
      ok: true,
      tool: "python",
      executable: resolved,
      version: ver.version,
      major: ver.major,
      minor: ver.minor,
      patch: ver.patch,
    };
  }

  const candidates = [];
  const seen = new Set();
  const pushUnique = (cand) => {
    if (cand && !seen.has(cand) && isExecutableFile(cand)) {
      seen.add(cand);
      candidates.push(cand);
    }
  };

  for (const name of ["python3.11", "python3.12", "python3.13", "python3.10"]) {
    for (const found of findAllExecutablesOnPath(name)) {
      pushUnique(found);
    }
  }
  pushUnique(HOMEBREW_PYTHON_311);
  pushUnique("/usr/local/opt/python@3.11/bin/python3.11");
  pushUnique("/usr/local/bin/python3.11");
  for (const found of findAllExecutablesOnPath("python3")) {
    pushUnique(found);
  }
  pushUnique("/opt/homebrew/bin/python3");
  pushUnique("/usr/local/bin/python3");

  let rejected = null;
  for (const candidate of candidates) {
    const ver = probePythonVersion(candidate);
    if (!ver) continue;
    if (isTupleAtLeast(ver, MIN_PYTHON_VERSION)) {
      return {
        ok: true,
        tool: "python",
        executable: candidate,
        version: ver.version,
        major: ver.major,
        minor: ver.minor,
        patch: ver.patch,
      };
    }
    if (!rejected) {
      rejected = { executable: candidate, version: ver.version };
    }
  }

  if (rejected) {
    return {
      ok: false,
      tool: "python",
      code: "python_version_error",
      executable: rejected.executable,
      detected_version: rejected.version,
      required_version: REMEDIATION.python.required,
      message: `Detected Python ${rejected.version} at '${rejected.executable}'; Python >= 3.10 (python3.11 recommended) is required.`,
      remediation: [...REMEDIATION.python.commands],
    };
  }

  return {
    ok: false,
    tool: "python",
    code: "python_not_found",
    executable: null,
    detected_version: null,
    required_version: REMEDIATION.python.required,
    message: "Python 3.10+ (python3.11 recommended) was not found. Install Python 3.11 or set LRF_PYTHON.",
    remediation: [...REMEDIATION.python.commands],
  };
}

/**
 * Resolve Python >= 3.10 executable path or throw actionable CliError.
 */
export function resolvePythonExecutable() {
  const check = inspectPythonPrerequisite();
  if (!check.ok) {
    throw new CliError(check.code, `${check.message}${formatRemediationHint("python")}`);
  }
  return check.executable;
}

/**
 * Probe Ruby version, Ruby API/ABI version, and platform from `rubyBin`.
 */
export function probeRubyInfo(rubyBin) {
  try {
    const out = execFileSync(
      rubyBin,
      [
        "-rrbconfig",
        "-e",
        'puts [RUBY_VERSION, RbConfig::CONFIG["ruby_version"], RUBY_PLATFORM].join("\\n")',
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: false, timeout: 5000 },
    );
    const lines = out.trim().split(/\r?\n/).map((line) => line.trim());
    if (lines.length < 3 || !lines[0] || !lines[1] || !lines[2]) {
      return null;
    }
    const parsed = parseVersionTuple(lines[0]);
    if (!parsed) return null;
    let realExecutable = rubyBin;
    try {
      realExecutable = fs.realpathSync(rubyBin);
    } catch {
      realExecutable = rubyBin;
    }
    return {
      executable: rubyBin,
      realExecutable,
      version: parsed.version,
      major: parsed.major,
      minor: parsed.minor,
      patch: parsed.patch,
      abi: lines[1],
      platform: lines[2],
    };
  } catch {
    return null;
  }
}

function buildCleanBundleProbeEnv(rubyInfo = null) {
  const env = { ...process.env };
  delete env.BUNDLE_GEMFILE;
  delete env.BUNDLE_PATH;
  delete env.BUNDLE_APP_CONFIG;
  delete env.BUNDLE_BIN_PATH;
  delete env.RUBYOPT;
  delete env.RUBYGEMS_GEMDEPS;
  if (rubyInfo?.executable) {
    const rubyDir = path.dirname(rubyInfo.executable);
    const parts = (env.PATH || "").split(path.delimiter).filter(Boolean);
    if (!parts.includes(rubyDir)) {
      env.PATH = parts.length > 0 ? `${rubyDir}${path.delimiter}${parts.join(path.delimiter)}` : rubyDir;
    }
  }
  return env;
}

/**
 * Probe Bundler version and underlying Ruby version via `bundle env`.
 */
export function probeBundleInfo(bundleBin, { rubyInfo = null } = {}) {
  try {
    const out = execFileSync(bundleBin, ["env"], {
      cwd: os.tmpdir(),
      env: buildCleanBundleProbeEnv(rubyInfo),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      timeout: 5000,
    });
    const bundlerMatch = out.match(/^\s*Bundler\s+(\d+\.\d+(?:\.\d+)?)/m);
    const rubyMatch = out.match(/^\s*Ruby\s+(\d+\.\d+\.\d+)/m);
    const fullPathMatch = out.match(/^\s*Full Path\s+(.+)$/m);
    if (!bundlerMatch || !rubyMatch) {
      return {
        ok: false,
        executable: bundleBin,
        code: "bundle_version_error",
        detected_version: bundlerMatch ? bundlerMatch[1] : null,
        ruby_version: rubyMatch ? rubyMatch[1] : null,
        message: `Bundler '${bundleBin}' did not report Bundler and Ruby versions cleanly.`,
      };
    }

    const bundlerVer = parseVersionTuple(bundlerMatch[1]);
    const bundleRubyVer = parseVersionTuple(rubyMatch[1]);
    const rubyFullPath = fullPathMatch ? fullPathMatch[1].trim() : null;

    if (!bundleRubyVer || !isTupleAtLeast(bundleRubyVer, MIN_RUBY_VERSION)) {
      return {
        ok: false,
        executable: bundleBin,
        code: "bundle_version_error",
        detected_version: bundlerVer ? bundlerVer.version : bundlerMatch[1],
        ruby_version: bundleRubyVer ? bundleRubyVer.version : rubyMatch[1],
        ruby_full_path: rubyFullPath,
        message: `Bundler '${bundleBin}' (${bundlerMatch[1]}) runs under Ruby ${rubyMatch[1]}; Ruby >= 3.1.0 is required.`,
      };
    }

    if (!bundlerVer || !isTupleAtLeast(bundlerVer, MIN_BUNDLER_VERSION)) {
      return {
        ok: false,
        executable: bundleBin,
        code: "bundle_version_error",
        detected_version: bundlerVer ? bundlerVer.version : bundlerMatch[1],
        ruby_version: bundleRubyVer.version,
        ruby_full_path: rubyFullPath,
        message: `Bundler '${bundleBin}' is version ${bundlerMatch[1]}; Bundler >= 2.0.0 is required.`,
      };
    }

    if (rubyInfo && (bundleRubyVer.major !== rubyInfo.major || bundleRubyVer.minor !== rubyInfo.minor || bundleRubyVer.version !== rubyInfo.version)) {
      return {
        ok: false,
        executable: bundleBin,
        code: "bundle_toolchain_mismatch",
        detected_version: bundlerVer.version,
        ruby_version: bundleRubyVer.version,
        ruby_full_path: rubyFullPath,
        message: `Bundler '${bundleBin}' runs under Ruby ${bundleRubyVer.version}, which does not match selected Ruby ${rubyInfo.version} ('${rubyInfo.executable}').`,
      };
    }

    return {
      ok: true,
      tool: "bundler",
      executable: bundleBin,
      version: bundlerVer.version,
      rubyVersion: bundleRubyVer.version,
      rubyFullPath,
    };
  } catch (err) {
    const stderr = err?.stderr ? String(err.stderr).trim() : "";
    return {
      ok: false,
      executable: bundleBin,
      code: "bundle_not_found",
      detected_version: null,
      ruby_version: null,
      message: `Bundler '${bundleBin}' failed to execute${stderr ? `: ${stderr}` : "."}`,
    };
  }
}

function collectBundleCandidatesForRuby(rubyInfo) {
  const candidates = [];
  const seen = new Set();
  const push = (cand) => {
    if (cand && !seen.has(cand) && isExecutableFile(cand)) {
      seen.add(cand);
      candidates.push(cand);
    }
  };
  if (rubyInfo) {
    push(path.join(path.dirname(rubyInfo.executable), "bundle"));
    push(path.join(path.dirname(rubyInfo.realExecutable), "bundle"));
  }
  for (const found of findAllExecutablesOnPath("bundle")) {
    push(found);
  }
  push(HOMEBREW_RUBY_BUNDLE);
  push("/usr/local/opt/ruby@3.3/bin/bundle");
  push("/opt/homebrew/opt/ruby/bin/bundle");
  push("/usr/local/opt/ruby/bin/bundle");
  push("/opt/homebrew/bin/bundle");
  push("/usr/local/bin/bundle");
  return candidates;
}

/**
 * Inspect Ruby >= 3.1 and matching Bundler prerequisites together.
 */
export function inspectRubyAndBundlerPrerequisites() {
  const rubyOverride = (process.env.LRF_RUBY || "").trim();
  const bundleOverride = (process.env.LRF_RUBY_BUNDLE || "").trim();

  let resolvedBundleOverride = null;
  if (bundleOverride) {
    resolvedBundleOverride = resolveOverrideExecutable(bundleOverride);
  }

  let rubyResult = null;
  let rejectedRuby = null;

  if (rubyOverride) {
    const resolvedRuby = resolveOverrideExecutable(rubyOverride);
    if (!resolvedRuby) {
      rubyResult = {
        ok: false,
        tool: "ruby",
        code: "ruby_not_found",
        executable: rubyOverride,
        detected_version: null,
        required_version: REMEDIATION.ruby.required,
        message: `LRF_RUBY='${rubyOverride}' is not an executable Ruby binary.`,
        remediation: [...REMEDIATION.ruby.commands],
      };
    } else {
      const info = probeRubyInfo(resolvedRuby);
      if (!info) {
        rubyResult = {
          ok: false,
          tool: "ruby",
          code: "ruby_not_found",
          executable: resolvedRuby,
          detected_version: null,
          required_version: REMEDIATION.ruby.required,
          message: `LRF_RUBY='${rubyOverride}' failed Ruby version/ABI probe.`,
          remediation: [...REMEDIATION.ruby.commands],
        };
      } else if (!isTupleAtLeast(info, MIN_RUBY_VERSION)) {
        rubyResult = {
          ok: false,
          tool: "ruby",
          code: "ruby_version_error",
          executable: resolvedRuby,
          detected_version: info.version,
          required_version: REMEDIATION.ruby.required,
          message: `LRF_RUBY='${rubyOverride}' is Ruby ${info.version}; Ruby >= 3.1.0 is required.`,
          remediation: [...REMEDIATION.ruby.commands],
        };
      } else {
        rubyResult = { ok: true, tool: "ruby", ...info };
      }
    }
  } else {
    const rubyCandidates = [];
    const seenRuby = new Set();
    const pushRuby = (cand) => {
      if (cand && !seenRuby.has(cand) && isExecutableFile(cand)) {
        seenRuby.add(cand);
        rubyCandidates.push(cand);
      }
    };

    if (resolvedBundleOverride) {
      pushRuby(path.join(path.dirname(resolvedBundleOverride), "ruby"));
      try {
        pushRuby(path.join(path.dirname(fs.realpathSync(resolvedBundleOverride)), "ruby"));
      } catch {
        // Ignore realpath failure.
      }
    }

    for (const found of findAllExecutablesOnPath("ruby")) {
      pushRuby(found);
    }
    pushRuby(HOMEBREW_RUBY_33);
    pushRuby("/usr/local/opt/ruby@3.3/bin/ruby");
    pushRuby("/opt/homebrew/opt/ruby/bin/ruby");
    pushRuby("/usr/local/opt/ruby/bin/ruby");
    pushRuby("/opt/homebrew/bin/ruby");
    pushRuby("/usr/local/bin/ruby");

    const compatibleRubies = [];
    for (const cand of rubyCandidates) {
      const info = probeRubyInfo(cand);
      if (!info) continue;
      if (isTupleAtLeast(info, MIN_RUBY_VERSION)) {
        compatibleRubies.push(info);
      } else if (!rejectedRuby) {
        rejectedRuby = info;
      }
    }

    if (compatibleRubies.length === 0) {
      if (rejectedRuby) {
        rubyResult = {
          ok: false,
          tool: "ruby",
          code: "ruby_version_error",
          executable: rejectedRuby.executable,
          detected_version: rejectedRuby.version,
          required_version: REMEDIATION.ruby.required,
          message: `Detected Ruby ${rejectedRuby.version} at '${rejectedRuby.executable}'; Ruby >= 3.1.0 (Homebrew ruby@3.3 recommended) is required.`,
          remediation: [...REMEDIATION.ruby.commands],
        };
      } else {
        rubyResult = {
          ok: false,
          tool: "ruby",
          code: "ruby_not_found",
          executable: null,
          detected_version: null,
          required_version: REMEDIATION.ruby.required,
          message: "Ruby >= 3.1.0 was not found. Install Ruby 3.3+ or set LRF_RUBY.",
          remediation: [...REMEDIATION.ruby.commands],
        };
      }
    } else if (bundleOverride) {
      rubyResult = { ok: true, tool: "ruby", ...compatibleRubies[0] };
    } else {
      // Prefer the first compatible Ruby that also has a matching compatible `bundle` in the same dir or on PATH.
      let pairedRuby = null;
      let pairedBundle = null;
      for (const info of compatibleRubies) {
        const siblingBundles = [
          path.join(path.dirname(info.executable), "bundle"),
          path.join(path.dirname(info.realExecutable), "bundle"),
        ];
        for (const sib of siblingBundles) {
          if (isExecutableFile(sib)) {
            const bInfo = probeBundleInfo(sib, { rubyInfo: info });
            if (bInfo.ok) {
              pairedRuby = info;
              pairedBundle = bInfo;
              break;
            }
          }
        }
        if (pairedRuby) break;
      }

      if (pairedRuby && pairedBundle) {
        return {
          ruby: { ok: true, tool: "ruby", ...pairedRuby },
          bundler: pairedBundle,
        };
      }
      rubyResult = { ok: true, tool: "ruby", ...compatibleRubies[0] };
    }
  }

  // Resolve Bundler now
  let bundleResult = null;
  if (bundleOverride) {
    if (!resolvedBundleOverride) {
      bundleResult = {
        ok: false,
        tool: "bundler",
        code: "bundle_not_found",
        executable: bundleOverride,
        detected_version: null,
        required_version: REMEDIATION.bundler.required,
        message: `LRF_RUBY_BUNDLE='${bundleOverride}' is not an executable file or command.`,
        remediation: [...REMEDIATION.bundler.commands],
      };
    } else {
      const probed = probeBundleInfo(resolvedBundleOverride, { rubyInfo: rubyResult.ok ? rubyResult : null });
      if (probed.ok) {
        bundleResult = probed;
      } else {
        bundleResult = {
          ok: false,
          tool: "bundler",
          code: probed.code,
          executable: resolvedBundleOverride,
          detected_version: probed.detected_version || null,
          ruby_version: probed.ruby_version || null,
          required_version: REMEDIATION.bundler.required,
          message: probed.message,
          remediation: [...REMEDIATION.bundler.commands],
        };
      }
    }
  } else {
    const candidates = collectBundleCandidatesForRuby(rubyResult.ok ? rubyResult : null);
    let rejectedBundle = null;
    for (const cand of candidates) {
      const probed = probeBundleInfo(cand, { rubyInfo: rubyResult.ok ? rubyResult : null });
      if (probed.ok) {
        bundleResult = probed;
        break;
      }
      if (!rejectedBundle) {
        rejectedBundle = probed;
      }
    }

    if (!bundleResult) {
      if (rejectedBundle) {
        bundleResult = {
          ok: false,
          tool: "bundler",
          code: rejectedBundle.code,
          executable: rejectedBundle.executable,
          detected_version: rejectedBundle.detected_version || null,
          ruby_version: rejectedBundle.ruby_version || null,
          required_version: REMEDIATION.bundler.required,
          message: rejectedBundle.message,
          remediation: [...REMEDIATION.bundler.commands],
        };
      } else {
        bundleResult = {
          ok: false,
          tool: "bundler",
          code: "bundle_not_found",
          executable: null,
          detected_version: null,
          required_version: REMEDIATION.bundler.required,
          message: "Compatible Ruby Bundler executable was not found. Install Ruby 3.3 + Bundler or set LRF_RUBY_BUNDLE.",
          remediation: [...REMEDIATION.bundler.commands],
        };
      }
    }
  }

  return { ruby: rubyResult, bundler: bundleResult };
}

/**
 * Inspect all 5 system prerequisites (`git`, `node`, `python`, `ruby`, `bundler`).
 */
export function inspectAllPrerequisites() {
  const git = inspectGitPrerequisite();
  const node = inspectNodePrerequisite();
  const python = inspectPythonPrerequisite();
  const { ruby, bundler } = inspectRubyAndBundlerPrerequisites();

  const tools = { git, node, python, ruby, bundler };
  const failures = [git, node, python, ruby, bundler].filter((entry) => !entry.ok);
  return {
    ok: failures.length === 0,
    tools,
    failures,
  };
}

/**
 * Resolve compatible Ruby (>= 3.1) + Bundler toolchain or throw actionable CliError.
 */
export function resolveRubyToolchain() {
  const { ruby, bundler } = inspectRubyAndBundlerPrerequisites();
  if (!ruby.ok) {
    throw new CliError(ruby.code, `${ruby.message}${formatRemediationHint("ruby")}`);
  }
  if (!bundler.ok) {
    throw new CliError(bundler.code, `${bundler.message}${formatRemediationHint("bundler")}`);
  }
  return { rubyInfo: ruby, bundleInfo: bundler, bundleBin: bundler.executable };
}

/**
 * Resolve Ruby >= 3.1 executable info or throw actionable CliError.
 */
export function resolveRubyExecutable() {
  const { ruby } = inspectRubyAndBundlerPrerequisites();
  if (!ruby.ok) {
    throw new CliError(ruby.code, `${ruby.message}${formatRemediationHint("ruby")}`);
  }
  return ruby;
}

/**
 * Resolve Ruby Bundler executable compatible with Ruby >= 3.1.
 */
export function resolveBundleExecutable({ rubyInfo = null } = {}) {
  if (rubyInfo) {
    const override = (process.env.LRF_RUBY_BUNDLE || "").trim();
    if (override) {
      const resolved = resolveOverrideExecutable(override);
      if (!resolved) {
        throw new CliError(
          "bundle_not_found",
          `LRF_RUBY_BUNDLE='${override}' is not an executable file or command.${formatRemediationHint("bundler")}`,
        );
      }
      const probed = probeBundleInfo(resolved, { rubyInfo });
      if (!probed.ok) {
        throw new CliError(probed.code, `${probed.message}${formatRemediationHint("bundler")}`);
      }
      return probed.executable;
    }

    const candidates = collectBundleCandidatesForRuby(rubyInfo);
    let rejected = null;
    for (const cand of candidates) {
      const probed = probeBundleInfo(cand, { rubyInfo });
      if (probed.ok) return probed.executable;
      if (!rejected) rejected = probed;
    }
    if (rejected) {
      throw new CliError(rejected.code, `${rejected.message}${formatRemediationHint("bundler")}`);
    }
    throw new CliError(
      "bundle_not_found",
      `Ruby Bundler executable was not found for Ruby ${rubyInfo.version}.${formatRemediationHint("bundler")}`,
    );
  }

  return resolveRubyToolchain().bundleBin;
}

/**
 * Return true if the versioned user gem cache entry exists, matches lockfile/ABI/version, and passed smoke check.
 */
export function isUserCacheReady(cachePaths, rubyInfo, engineRoot) {
  try {
    const engineGemfile = path.join(engineRoot, "engine", "Gemfile");
    const engineLockfile = path.join(engineRoot, "engine", "Gemfile.lock");
    if (
      !fs.existsSync(cachePaths.gemfilePath) ||
      !fs.existsSync(cachePaths.lockfilePath) ||
      !fs.existsSync(cachePaths.markerPath) ||
      !fs.existsSync(cachePaths.bundleAppConfig)
    ) {
      return false;
    }

    const specsDir = path.join(cachePaths.bundlePath, "ruby", rubyInfo.abi, "specifications");
    if (!fs.existsSync(specsDir) || !fs.statSync(specsDir).isDirectory()) {
      return false;
    }

    const marker = JSON.parse(fs.readFileSync(cachePaths.markerPath, "utf8"));
    if (
      marker?.smoke_check_passed !== true ||
      marker?.gemfile_lock_sha256 !== cachePaths.lockSha256 ||
      marker?.package_version !== cachePaths.pkgVersion ||
      marker?.ruby_abi !== rubyInfo.abi ||
      marker?.ruby_platform !== rubyInfo.platform
    ) {
      return false;
    }

    const srcGemfile = fs.readFileSync(engineGemfile);
    const dstGemfile = fs.readFileSync(cachePaths.gemfilePath);
    if (!srcGemfile.equals(dstGemfile)) {
      return false;
    }

    const srcLock = fs.readFileSync(engineLockfile);
    const dstLock = fs.readFileSync(cachePaths.lockfilePath);
    if (!srcLock.equals(dstLock)) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Return repo-local `engine/vendor/bundle` config when populated for the active Ruby ABI.
 */
export function resolveRepoEngineBundleConfig(engineRoot, rubyInfo) {
  const engineGemfile = path.join(engineRoot, "engine", "Gemfile");
  const engineLockfile = path.join(engineRoot, "engine", "Gemfile.lock");
  const engineVendor = path.join(engineRoot, "engine", "vendor", "bundle");
  const engineBundleCfg = path.join(engineRoot, "engine", ".bundle");
  const specsDir = path.join(engineVendor, "ruby", rubyInfo.abi, "specifications");

  if (
    fs.existsSync(engineGemfile) &&
    fs.existsSync(engineLockfile) &&
    fs.existsSync(specsDir) &&
    fs.statSync(specsDir).isDirectory()
  ) {
    return {
      ready: true,
      bundleGemfile: engineGemfile,
      bundlePath: engineVendor,
      bundleAppConfig: fs.existsSync(engineBundleCfg) ? engineBundleCfg : null,
    };
  }
  return { ready: false };
}

function prependPathDirs(existingPath, dirs) {
  const parts = existingPath ? existingPath.split(path.delimiter).filter(Boolean) : [];
  const toAdd = [];
  for (const dir of dirs) {
    if (dir && !parts.includes(dir) && !toAdd.includes(dir)) {
      toAdd.push(dir);
    }
  }
  return [...toAdd, ...parts].join(path.delimiter);
}

/**
 * Construct child environment for Python + Ruby worker invocation.
 */
export function buildEngineEnv({
  engineRoot,
  bundleBin,
  rubyInfo = null,
  envOverride = null,
}) {
  const resolvedRuby = rubyInfo || resolveRubyExecutable();
  const env = { ...(envOverride || process.env) };
  env.LRF_ENGINE_ROOT = engineRoot;
  env.LRF_RUBY = resolvedRuby.executable;
  env.LRF_RUBY_BUNDLE = bundleBin;
  env.PYTHONUTF8 = "1";
  env.PYTHONPATH = env.PYTHONPATH
    ? `${engineRoot}${path.delimiter}${env.PYTHONPATH}`
    : engineRoot;

  env.PATH = prependPathDirs(env.PATH || "", [
    path.dirname(resolvedRuby.executable),
    path.dirname(bundleBin),
  ]);

  if (!env.BUNDLE_GEMFILE) {
    const cachePaths = resolveUserGemCacheDir({
      engineRoot,
      rubyAbi: resolvedRuby.abi,
      rubyPlatform: resolvedRuby.platform,
    });

    if (isUserCacheReady(cachePaths, resolvedRuby, engineRoot)) {
      env.BUNDLE_GEMFILE = cachePaths.gemfilePath;
      if (!env.BUNDLE_PATH) {
        env.BUNDLE_PATH = cachePaths.bundlePath;
      }
      if (!env.BUNDLE_APP_CONFIG) {
        env.BUNDLE_APP_CONFIG = cachePaths.bundleAppConfig;
      }
      delete env.BUNDLE_BIN_PATH;
      delete env.RUBYOPT;
      delete env.RUBYGEMS_GEMDEPS;
    } else {
      const repoBundle = resolveRepoEngineBundleConfig(engineRoot, resolvedRuby);
      if (repoBundle.ready) {
        env.BUNDLE_GEMFILE = repoBundle.bundleGemfile;
        if (!env.BUNDLE_PATH) {
          env.BUNDLE_PATH = repoBundle.bundlePath;
        }
        if (!env.BUNDLE_APP_CONFIG && repoBundle.bundleAppConfig) {
          env.BUNDLE_APP_CONFIG = repoBundle.bundleAppConfig;
        }
      } else {
        throw new CliError(
          "setup_required",
          `Engine Ruby dependencies are not installed in '${cachePaths.cacheDir}' (and no repo-local engine/vendor/bundle was found). Run 'npx liquid-regression-finder setup' first.`,
        );
      }
    }
  }

  return env;
}

/**
 * Resolve Python, Ruby >= 3.1, Bundler, and engine environment once for reuse (e.g., watch mode).
 */
export function resolveEngineRuntime({ engineRoot = resolveEngineRoot(), envOverride = null } = {}) {
  const pythonBin = resolvePythonExecutable();
  const { rubyInfo, bundleBin } = resolveRubyToolchain();
  const env = buildEngineEnv({ engineRoot, bundleBin, rubyInfo, envOverride });
  return { engineRoot, pythonBin, rubyInfo, bundleBin, env };
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
    runtime = null,
    envOverride = null,
  } = {},
) {
  if (signal?.aborted) {
    throw new CliError("aborted", "Search engine run was aborted.");
  }

  let pythonBin;
  let env;
  if (runtime && !envOverride) {
    pythonBin = runtime.pythonBin;
    env = runtime.env;
  } else {
    pythonBin = resolvePythonExecutable();
    const { rubyInfo, bundleBin } = resolveRubyToolchain();
    env = buildEngineEnv({ engineRoot, bundleBin, rubyInfo, envOverride });
  }

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
  runtime = null,
  envOverride = null,
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
      runtime,
      envOverride,
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
  runtime = null,
  envOverride = null,
}) {
  return runPythonSearch(["replay", "--bundle", bundlePath], {
    engineRoot,
    timeoutMs,
    runtime,
    envOverride,
  });
}

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  inspectAllPrerequisites,
  isUserCacheReady,
  runCompare,
} from "./engine_runner.mjs";
import {
  CliError,
  resolveEngineRoot,
  resolvePackageMetadata,
  resolveUserGemCacheDir,
} from "./paths.mjs";

const SMOKE_BEFORE_LIQUID = Buffer.from(
  [
    "{%- assign on_sale = false -%}",
    "{%- for variant in product.variants -%}",
    "  {%- if variant.compare_at_price != nil and variant.compare_at_price > variant.price -%}",
    "    {%- assign on_sale = true -%}",
    "  {%- endif -%}",
    "{%- endfor -%}",
    "{%- if on_sale -%}",
    '<span class="badge" data-regression-badge="sale">Sale</span>',
    "{%- endif -%}",
  ].join("\n") + "\n",
  "utf8",
);

const SMOKE_AFTER_LIQUID = Buffer.from(
  [
    "{%- if product.compare_at_price != nil and product.compare_at_price > product.price -%}",
    '<span class="badge" data-regression-badge="sale">Sale</span>',
    "{%- endif -%}",
  ].join("\n") + "\n",
  "utf8",
);

function writeJsonAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.tmp.${process.pid}.${crypto.randomBytes(6).toString("hex")}`,
  );
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n", "utf8");
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // Ignore cleanup failure.
    }
    throw err;
  }
}

function buildBundlerInstallEnv({ realCacheDir, rubyInfo, bundleBin }) {
  const env = { ...process.env };
  env.BUNDLE_GEMFILE = path.join(realCacheDir, "Gemfile");
  env.BUNDLE_PATH = path.join(realCacheDir, "vendor", "bundle");
  env.BUNDLE_APP_CONFIG = path.join(realCacheDir, ".bundle");
  delete env.BUNDLE_BIN_PATH;
  delete env.RUBYOPT;
  delete env.RUBYGEMS_GEMDEPS;
  delete env.BUNDLE_WITHOUT;
  delete env.BUNDLE_ONLY;

  const extraDirs = [path.dirname(rubyInfo.executable), path.dirname(bundleBin)].filter(Boolean);
  const parts = (env.PATH || "").split(path.delimiter).filter(Boolean);
  const merged = [];
  for (const dir of [...extraDirs, ...parts]) {
    if (!merged.includes(dir)) merged.push(dir);
  }
  env.PATH = merged.join(path.delimiter);
  return env;
}

function runBundleCmd(bundleBin, args, { cwd, env, timeoutMs = 120_000 }) {
  try {
    return execFileSync(bundleBin, args, {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (err) {
    const stdout = err?.stdout ? String(err.stdout).trim() : "";
    const stderr = err?.stderr ? String(err.stderr).trim() : "";
    const detail = [stderr, stdout].filter(Boolean).join("\n");
    throw new CliError(
      "bundle_install_failed",
      `Bundler command 'bundle ${args.join(" ")}' failed${detail ? `: ${detail}` : `: ${err.message}`}`,
    );
  }
}

function tryBundleCheck(bundleBin, { cwd, env }) {
  try {
    execFileSync(bundleBin, ["check"], {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      timeout: 30_000,
    });
    return true;
  } catch {
    return false;
  }
}

function listGemFiles(dirPath) {
  if (!dirPath || !fs.existsSync(dirPath)) return [];
  let stat;
  try {
    stat = fs.statSync(dirPath);
  } catch {
    return [];
  }
  if (!stat.isDirectory()) return [];
  return fs
    .readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".gem"))
    .map((entry) => entry.name)
    .sort();
}

function copyLocalGemCache(srcDir, dstDir) {
  const gemFiles = listGemFiles(srcDir);
  if (gemFiles.length === 0) {
    throw new CliError(
      "gem_cache_invalid",
      `LRF_GEM_CACHE='${srcDir}' does not contain any '.gem' files.`,
    );
  }
  fs.mkdirSync(dstDir, { recursive: true });
  for (const gemName of gemFiles) {
    fs.copyFileSync(path.join(srcDir, gemName), path.join(dstDir, gemName));
  }
  return gemFiles.length;
}

function installLockedGemsIntoCache({ engineRoot, cachePaths, rubyInfo, bundleInfo }) {
  const srcGemfile = path.join(engineRoot, "engine", "Gemfile");
  const srcLockfile = path.join(engineRoot, "engine", "Gemfile.lock");

  if (!fs.existsSync(srcGemfile) || !fs.existsSync(srcLockfile)) {
    throw new CliError(
      "missing_engine_lockfile",
      `Missing engine Gemfile/Gemfile.lock under '${path.join(engineRoot, "engine")}'.`,
    );
  }

  fs.mkdirSync(cachePaths.cacheDir, { recursive: true });
  const realCacheDir = fs.realpathSync(cachePaths.cacheDir);
  const bundleEnv = buildBundlerInstallEnv({
    realCacheDir,
    rubyInfo,
    bundleBin: bundleInfo.executable,
  });

  if (isUserCacheReady(cachePaths, rubyInfo, engineRoot)) {
    if (tryBundleCheck(bundleInfo.executable, { cwd: realCacheDir, env: bundleEnv })) {
      return { cacheReused: true, realCacheDir, bundleEnv };
    }
  }

  fs.copyFileSync(srcGemfile, path.join(realCacheDir, "Gemfile"));
  fs.copyFileSync(srcLockfile, path.join(realCacheDir, "Gemfile.lock"));

  runBundleCmd(bundleInfo.executable, ["config", "set", "--local", "path", "vendor/bundle"], {
    cwd: realCacheDir,
    env: bundleEnv,
  });
  runBundleCmd(bundleInfo.executable, ["config", "set", "--local", "deployment", "true"], {
    cwd: realCacheDir,
    env: bundleEnv,
  });

  const gemCacheOverride = (process.env.LRF_GEM_CACHE || "").trim();
  const installEnv = { ...bundleEnv, BUNDLE_FROZEN: "true" };
  const targetVendorCache = path.join(realCacheDir, "vendor", "cache");

  if (gemCacheOverride) {
    copyLocalGemCache(path.resolve(gemCacheOverride), targetVendorCache);
    runBundleCmd(bundleInfo.executable, ["install", "--local"], {
      cwd: realCacheDir,
      env: installEnv,
    });
  } else if (listGemFiles(targetVendorCache).length > 0) {
    try {
      runBundleCmd(bundleInfo.executable, ["install", "--local"], {
        cwd: realCacheDir,
        env: installEnv,
      });
    } catch {
      runBundleCmd(bundleInfo.executable, ["install"], {
        cwd: realCacheDir,
        env: installEnv,
      });
    }
  } else {
    try {
      runBundleCmd(bundleInfo.executable, ["install"], {
        cwd: realCacheDir,
        env: installEnv,
      });
    } catch (err) {
      throw new CliError(
        err.code || "bundle_install_failed",
        `${err.message}\nIf running offline, set LRF_GEM_CACHE to a directory containing the locked .gem files.`,
      );
    }
  }

  runBundleCmd(bundleInfo.executable, ["check"], {
    cwd: realCacheDir,
    env: bundleEnv,
  });

  return { cacheReused: false, realCacheDir, bundleEnv };
}

async function runSetupSmokeCheck({ engineRoot, realCacheDir }) {
  const smokeEnv = {
    ...process.env,
    BUNDLE_GEMFILE: path.join(realCacheDir, "Gemfile"),
    BUNDLE_PATH: path.join(realCacheDir, "vendor", "bundle"),
    BUNDLE_APP_CONFIG: path.join(realCacheDir, ".bundle"),
  };
  delete smokeEnv.BUNDLE_BIN_PATH;
  delete smokeEnv.RUBYOPT;
  delete smokeEnv.RUBYGEMS_GEMDEPS;

  const unchanged = await runCompare({
    beforeBytes: SMOKE_BEFORE_LIQUID,
    afterBytes: SMOKE_BEFORE_LIQUID,
    observer: "sale_badge",
    seed: 0,
    searchPairs: 8,
    shrinkPairs: 0,
    engineRoot,
    envOverride: smokeEnv,
  });

  if (unchanged.exitCode !== 0 || unchanged.report?.status !== "no_difference_found") {
    throw new CliError(
      "smoke_check_failed",
      `Setup smoke check (unchanged case) failed: exit=${unchanged.exitCode}, status=${unchanged.report?.status}.`,
    );
  }

  const regression = await runCompare({
    beforeBytes: SMOKE_BEFORE_LIQUID,
    afterBytes: SMOKE_AFTER_LIQUID,
    observer: "sale_badge",
    seed: 0,
    searchPairs: 64,
    shrinkPairs: 16,
    engineRoot,
    envOverride: smokeEnv,
  });

  if (
    regression.exitCode !== 1 ||
    regression.report?.status !== "difference_found" ||
    regression.report?.reference_status !== "confirmed"
  ) {
    throw new CliError(
      "smoke_check_failed",
      `Setup smoke check (regression case) failed: exit=${regression.exitCode}, status=${regression.report?.status}, reference_status=${regression.report?.reference_status}.`,
    );
  }

  const replay = regression.report?.finding?.replay || {};
  return {
    passed: true,
    unchanged_status: unchanged.report.status,
    regression_status: regression.report.status,
    reference_status: regression.report.reference_status,
    interpreter_version: replay.interpreter_version || null,
    liquid_version: replay.liquid_version || null,
    projection_version: replay.projection_version || null,
    search_pairs: regression.report?.stats?.search_pairs ?? null,
    shrink_pairs: regression.report?.stats?.shrink_pairs ?? null,
  };
}

function formatPrerequisiteFailureText(failures) {
  const lines = ["Error [setup_prerequisite_failed]: Missing or incompatible prerequisite(s):"];
  for (const item of failures) {
    const detected = item.detected_version ? `detected ${item.detected_version}` : "not found / unrunnable";
    lines.push(`  - ${item.tool} (required ${item.required_version}; ${detected}): ${item.message}`);
    for (const cmd of item.remediation || []) {
      lines.push(`      ${cmd}`);
    }
  }
  return lines.join("\n");
}

function summarizeToolsForOutput(tools) {
  const out = {};
  for (const [name, info] of Object.entries(tools)) {
    if (info.ok) {
      out[name] = {
        ok: true,
        executable: info.executable,
        version: info.version,
        ...(info.abi ? { abi: info.abi } : {}),
        ...(info.platform ? { platform: info.platform } : {}),
        ...(info.rubyVersion ? { ruby_version: info.rubyVersion } : {}),
      };
    } else {
      out[name] = {
        ok: false,
        code: info.code,
        executable: info.executable ?? null,
        detected_version: info.detected_version ?? null,
        required_version: info.required_version ?? null,
        message: info.message,
        remediation: info.remediation || [],
      };
    }
  }
  return out;
}

/**
 * Execute `liquid-regression-finder setup` returning `{ exitCode, payload, stdoutText, stderrText }`.
 */
export async function runSetup() {
  const engineRoot = resolveEngineRoot();
  const pkgMeta = resolvePackageMetadata(engineRoot);
  const prereqs = inspectAllPrerequisites();
  const serializedTools = summarizeToolsForOutput(prereqs.tools);

  if (!prereqs.ok) {
    const primary = prereqs.failures[0];
    const stderrText = formatPrerequisiteFailureText(prereqs.failures);
    const payload = {
      schema_version: 1,
      status: "error",
      package_version: pkgMeta.version,
      engine_root: engineRoot,
      cache_dir: null,
      tools: serializedTools,
      failures: prereqs.failures.map((item) => ({
        tool: item.tool,
        code: item.code,
        executable: item.executable ?? null,
        detected_version: item.detected_version ?? null,
        required_version: item.required_version ?? null,
        message: item.message,
        remediation: item.remediation || [],
      })),
      error: {
        code: primary.code,
        message: stderrText,
        span: null,
      },
    };
    return {
      exitCode: 2,
      payload,
      stdoutText: "",
      stderrText,
    };
  }

  const { git, node, python, ruby, bundler } = prereqs.tools;
  const cachePaths = resolveUserGemCacheDir({
    engineRoot,
    rubyAbi: ruby.abi,
    rubyPlatform: ruby.platform,
  });

  try {
    const { cacheReused, realCacheDir } = installLockedGemsIntoCache({
      engineRoot,
      cachePaths,
      rubyInfo: ruby,
      bundleInfo: bundler,
    });

    const smokeCheck = await runSetupSmokeCheck({
      engineRoot,
      realCacheDir,
    });

    const marker = {
      schema_version: 1,
      package_version: pkgMeta.version,
      ruby_version: ruby.version,
      ruby_abi: ruby.abi,
      ruby_platform: ruby.platform,
      ruby_executable: ruby.executable,
      bundle_executable: bundler.executable,
      bundler_version: bundler.version,
      gemfile_lock_sha256: cachePaths.lockSha256,
      cache_dir: cachePaths.cacheDir,
      bundle_gemfile: cachePaths.gemfilePath,
      bundle_path: cachePaths.bundlePath,
      bundle_app_config: cachePaths.bundleAppConfig,
      smoke_check_passed: true,
      installed_at: new Date().toISOString(),
    };
    writeJsonAtomic(cachePaths.markerPath, marker);

    const completionMsg = "Setup complete. Run 'npx liquid-regression-finder watch' or 'npx liquid-regression-finder check --base-ref HEAD'.";
    const payload = {
      schema_version: 1,
      status: "ok",
      package_version: pkgMeta.version,
      engine_root: engineRoot,
      cache_dir: cachePaths.cacheDir,
      cache_key: cachePaths.cacheKey,
      cache_reused: cacheReused,
      tools: serializedTools,
      smoke_check: smokeCheck,
      message: completionMsg,
    };

    const humanLines = [
      "Prerequisites verified:",
      `  git:     ${git.version} (${git.executable})`,
      `  node:    ${node.version} (${node.executable})`,
      `  python:  ${python.version} (${python.executable})`,
      `  ruby:    ${ruby.version} (ABI ${ruby.abi}, ${ruby.executable})`,
      `  bundler: ${bundler.version} (${bundler.executable})`,
      `User gem cache: ${cachePaths.cacheDir} (${cacheReused ? "verified existing cache" : "installed locked gems"})`,
      `Smoke check: passed (unchanged=${smokeCheck.unchanged_status}; regression=${smokeCheck.regression_status}, official Liquid ${smokeCheck.liquid_version || "5.14.0"} ${smokeCheck.reference_status})`,
      completionMsg,
    ];

    return {
      exitCode: 0,
      payload,
      stdoutText: humanLines.join("\n"),
      stderrText: "",
    };
  } catch (err) {
    const code = err instanceof CliError ? err.code : "setup_failed";
    const message = err?.message || String(err);
    const payload = {
      schema_version: 1,
      status: "error",
      package_version: pkgMeta.version,
      engine_root: engineRoot,
      cache_dir: cachePaths.cacheDir,
      tools: serializedTools,
      failures: [],
      error: {
        code,
        message,
        span: null,
      },
    };
    return {
      exitCode: 2,
      payload,
      stdoutText: "",
      stderrText: `Error [${code}]: ${message}`,
    };
  }
}

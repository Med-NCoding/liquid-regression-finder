import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TESTS_DIR, "../..");
const DEMO_AFTER_PATH = path.join(REPO_ROOT, "fixtures", "demo", "after.liquid");
const CARD_PRODUCT_PATH = path.join(REPO_ROOT, "snippets", "card-product.liquid");
const EXAMPLE_CONFIG_PATH = path.join(REPO_ROOT, "liquid-regression.example.json");

const TEMP_ROOTS = [];
const ACTIVE_WATCHERS = new Set();

function makeTempDir(prefix = "lrf-stage3-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  TEMP_ROOTS.push(dir);
  return dir;
}

function resolveNpmBin() {
  const nodeDir = path.dirname(process.execPath);
  const siblingNpm = path.join(nodeDir, "npm");
  if (fs.existsSync(siblingNpm)) return siblingNpm;
  return "npm";
}

function resolveNpxBin() {
  const nodeDir = path.dirname(process.execPath);
  const siblingNpx = path.join(nodeDir, "npx");
  if (fs.existsSync(siblingNpx)) return siblingNpx;
  return "npx";
}

function resolveLocalGemCacheDir() {
  const rubyBase = path.join(REPO_ROOT, "engine", "vendor", "bundle", "ruby");
  if (fs.existsSync(rubyBase)) {
    for (const abiDir of fs.readdirSync(rubyBase)) {
      const candidate = path.join(rubyBase, abiDir, "cache");
      if (fs.existsSync(candidate) && fs.readdirSync(candidate).some((f) => f.endsWith(".gem"))) {
        return candidate;
      }
    }
  }
  const rootRubyBase = path.join(REPO_ROOT, "vendor", "bundle", "ruby");
  if (fs.existsSync(rootRubyBase)) {
    for (const abiDir of fs.readdirSync(rootRubyBase)) {
      const candidate = path.join(rootRubyBase, abiDir, "cache");
      if (fs.existsSync(candidate) && fs.readdirSync(candidate).some((f) => f.endsWith(".gem"))) {
        return candidate;
      }
    }
  }
  throw new Error("Expected local .gem cache under engine/vendor/bundle or vendor/bundle for deterministic Stage 3 test.");
}

function runGit(repoDir, args) {
  return execFileSync("git", args, {
    cwd: repoDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function initExternalThemeRepo(repoDir) {
  fs.mkdirSync(repoDir, { recursive: true });
  runGit(repoDir, ["init"]);
  runGit(repoDir, ["config", "user.name", "Theme Author"]);
  runGit(repoDir, ["config", "user.email", "theme@example.com"]);

  fs.writeFileSync(
    path.join(repoDir, ".gitignore"),
    "node_modules/\n.liquid-regression/\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(repoDir, "package.json"),
    JSON.stringify(
      {
        name: "external-shopify-theme",
        version: "1.0.0",
        private: true,
        scripts: {
          "liquid:setup": "liquid-regression-finder setup",
          "liquid:watch": "liquid-regression-finder watch",
          "liquid:check": "liquid-regression-finder check --base-ref HEAD",
        },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  fs.mkdirSync(path.join(repoDir, "snippets"), { recursive: true });
  fs.copyFileSync(CARD_PRODUCT_PATH, path.join(repoDir, "snippets", "card-product.liquid"));
  fs.copyFileSync(EXAMPLE_CONFIG_PATH, path.join(repoDir, "liquid-regression.json"));

  runGit(repoDir, ["add", "-A"]);
  runGit(repoDir, ["commit", "-m", "Initial external theme baseline"]);
  return runGit(repoDir, ["rev-parse", "HEAD"]);
}

function buildIsolatedEnv(extra = {}, { replacePath = null } = {}) {
  const env = { ...process.env };
  for (const key of [
    "BUNDLE_GEMFILE",
    "BUNDLE_PATH",
    "BUNDLE_APP_CONFIG",
    "BUNDLE_BIN_PATH",
    "RUBYOPT",
    "RUBYGEMS_GEMDEPS",
    "LRF_ENGINE_ROOT",
    "LRF_CACHE_DIR",
    "LRF_GEM_CACHE",
    "LRF_PYTHON",
    "LRF_RUBY",
    "LRF_RUBY_BUNDLE",
  ]) {
    delete env[key];
  }
  const nodeDir = path.dirname(process.execPath);
  if (replacePath !== null) {
    env.PATH = replacePath;
  } else {
    const parts = (env.PATH || "").split(path.delimiter).filter(Boolean);
    if (!parts.includes(nodeDir)) {
      env.PATH = [nodeDir, ...parts].join(path.delimiter);
    }
  }
  return { ...env, ...extra };
}

async function runCmd(bin, args, { cwd, env }) {
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      cwd,
      env,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return {
      code: typeof err.code === "number" ? err.code : 2,
      stdout: err.stdout || "",
      stderr: err.stderr || "",
    };
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function listProcesses() {
  const raw = execFileSync("ps", ["-axo", "pid=,ppid=,command="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const rows = [];
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    if (!m) continue;
    rows.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      command: m[3],
    });
  }
  return rows;
}

function getDescendants(rootPid) {
  const procs = listProcesses();
  const byParent = new Map();
  for (const p of procs) {
    if (!byParent.has(p.ppid)) byParent.set(p.ppid, []);
    byParent.get(p.ppid).push(p);
  }
  const result = [];
  const queue = [rootPid];
  const seen = new Set([rootPid]);
  while (queue.length > 0) {
    const cur = queue.shift();
    for (const child of byParent.get(cur) || []) {
      if (!seen.has(child.pid)) {
        seen.add(child.pid);
        result.push(child);
        queue.push(child.pid);
      }
    }
  }
  return result;
}

function getEngineDescendants(rootPid) {
  return getDescendants(rootPid).filter(
    (p) =>
      !p.command.includes("liquid-regression-finder") &&
      (p.command.includes("-m search") ||
        p.command.includes("reference/bin/worker") ||
        /\bbundle\b/.test(p.command)),
  );
}

async function waitForCondition(fn, { timeoutMs = 15_000, pollMs = 30, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const val = await fn();
      if (val) return val;
    } catch (err) {
      lastErr = err;
    }
    await sleep(pollMs);
  }
  throw new Error(`Timed out waiting for ${label}${lastErr ? `: ${lastErr.message}` : ""}`);
}

async function waitForChildIdle(rootPid, { settleMs = 350, timeoutMs = 15_000 } = {}) {
  await sleep(settleMs);
  await waitForCondition(
    () => {
      const descendants = getDescendants(rootPid);
      const watchProc = descendants.find((p) => p.command.includes("liquid-regression-finder"));
      if (watchProc) {
        return getDescendants(watchProc.pid).length === 0;
      }
      return getEngineDescendants(rootPid).length === 0;
    },
    { timeoutMs, pollMs: 40, label: `engine descendants of ${rootPid} to finish` },
  );
}

function spawnNpxWatch(args, { cwd, env }) {
  const child = spawn(resolveNpxBin(), ["--no-install", "liquid-regression-finder", "watch", ...args], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    detached: true,
  });

  let stdout = "";
  let stderr = "";
  let exited = false;
  let exitInfo = null;

  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  const exitPromise = new Promise((resolve) => {
    child.on("close", (code, signal) => {
      exited = true;
      exitInfo = { code, signal };
      ACTIVE_WATCHERS.delete(handle);
      resolve(exitInfo);
    });
  });

  const killGroupAndSnapshot = (sig, snapshotPids) => {
    try {
      process.kill(-child.pid, sig);
    } catch {
      try {
        child.kill(sig);
      } catch {
        // Ignore if already exited.
      }
    }
    for (const pid of snapshotPids) {
      try {
        process.kill(pid, sig);
      } catch {
        // Ignore if already exited.
      }
    }
  };

  const handle = {
    get pid() {
      return child.pid;
    },
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    get exited() {
      return exited;
    },
    async waitForStdout(predicate, timeoutMs = 15_000) {
      return waitForCondition(
        () => (typeof predicate === "function" ? predicate(stdout) : predicate.test(stdout)),
        { timeoutMs, pollMs: 25, label: `stdout match; stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}` },
      );
    },
    async stop(sig = "SIGINT", timeoutMs = 8_000) {
      if (exited) return exitInfo;
      const snapshotPids = getDescendants(child.pid).map((p) => p.pid);
      try {
        process.kill(-child.pid, sig);
      } catch {
        killGroupAndSnapshot(sig, snapshotPids);
      }
      const timer = setTimeout(() => {
        if (!exited) {
          killGroupAndSnapshot("SIGKILL", snapshotPids);
        }
      }, timeoutMs);
      try {
        return await exitPromise;
      } finally {
        clearTimeout(timer);
      }
    },
  };

  ACTIVE_WATCHERS.add(handle);
  return handle;
}

after(async () => {
  for (const w of [...ACTIVE_WATCHERS]) {
    await w.stop("SIGKILL", 1_000);
  }
  for (const dir of TEMP_ROOTS) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("Migration Stage 3: npm package, setup, and external theme workflow", () => {
  let packedTgzPath = null;

  it("1. packs clean npm tarball with strict runtime allowlist and excludes api/web/bench/tests/vendor", () => {
    const packDir = makeTempDir("lrf-pack-");
    const npmBin = resolveNpmBin();
    const out = execFileSync(npmBin, ["pack", "--pack-destination", packDir], {
      cwd: REPO_ROOT,
      env: buildIsolatedEnv(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();

    const packedFilename = out.split(/\r?\n/).pop().trim();
    assert.equal(packedFilename, "liquid-regression-finder-0.1.0.tgz");
    packedTgzPath = path.join(packDir, packedFilename);
    assert.equal(fs.existsSync(packedTgzPath), true);

    // Ensure no .tgz was left in repository root.
    const rootTgzs = fs.readdirSync(REPO_ROOT).filter((name) => name.endsWith(".tgz"));
    assert.deepEqual(rootTgzs, []);

    const tarListRaw = execFileSync("tar", ["-ztf", packedTgzPath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const entries = new Set(tarListRaw.trim().split(/\r?\n/));

    const requiredEntries = [
      "package/package.json",
      "package/LICENSE",
      "package/README.md",
      "package/docs/setup-guide.md",
      "package/cli/bin/liquid-regression-finder.js",
      "package/cli/lib/cli.mjs",
      "package/cli/lib/config.mjs",
      "package/cli/lib/engine_runner.mjs",
      "package/cli/lib/format.mjs",
      "package/cli/lib/git.mjs",
      "package/cli/lib/paths.mjs",
      "package/cli/lib/setup.mjs",
      "package/cli/lib/watch.mjs",
      "package/engine/Gemfile",
      "package/engine/Gemfile.lock",
      "package/interpreter/lib/liquid_interpreter.rb",
      "package/interpreter/lib/liquid_interpreter/version.rb",
      "package/interpreter/lib/liquid_interpreter/template.rb",
      "package/reference/bin/worker",
      "package/reference/lib/liquid_reference.rb",
      "package/reference/lib/liquid_reference/worker.rb",
      "package/search/__init__.py",
      "package/search/__main__.py",
      "package/search/cli.py",
      "package/search/engine.py",
      "package/search/worker_client.py",
      "package/contracts/schemas/compare_request.schema.json",
      "package/contracts/schemas/replay_bundle.schema.json",
      "package/liquid-regression.example.json",
      "package/snippets/card-product.liquid",
    ];
    for (const reqEntry of requiredEntries) {
      assert.equal(entries.has(reqEntry), true, `Missing required tarball entry: ${reqEntry}`);
    }

    const forbiddenPrefixes = [
      "package/api/",
      "package/web/",
      "package/bench/",
      "package/engine/vendor/",
      "package/engine/.bundle/",
      "package/vendor/",
      "package/search/tests/",
      "package/cli/tests/",
      "package/.git/",
      "package/artifacts/",
      "package/fixtures/",
      "package/bin/",
      "package/.github/",
    ];
    for (const entry of entries) {
      assert.equal(entry.includes("__pycache__"), false, `Unexpected __pycache__ in tarball: ${entry}`);
      assert.notEqual(entry, "package/Gemfile", "Root Gemfile should not be in tarball");
      assert.notEqual(entry, "package/Gemfile.lock", "Root Gemfile.lock should not be in tarball");
      for (const prefix of forbiddenPrefixes) {
        assert.equal(entry.startsWith(prefix), false, `Forbidden entry in tarball (${prefix}): ${entry}`);
      }
    }

    const pkgRaw = execFileSync("tar", ["-zxOf", packedTgzPath, "package/package.json"], { encoding: "utf8" });
    const pkgJson = JSON.parse(pkgRaw);
    assert.equal(pkgJson.name, "liquid-regression-finder");
    assert.equal(pkgJson.private, false);
    assert.equal(pkgJson.bin["liquid-regression-finder"], "cli/bin/liquid-regression-finder.js");
    assert.equal(pkgJson.dependencies, undefined);
  });

  it("2-3. installs into external theme repo, enforces setup_required and prereq checks, runs setup + check + replay + watch without Rails/React", async () => {
    assert.ok(packedTgzPath, "Tarball should be packed in test 1");
    const npmBin = resolveNpmBin();
    const npxBin = resolveNpxBin();
    const localGemCache = resolveLocalGemCacheDir();

    const themeDir = makeTempDir("lrf-external-theme-");
    const baseSha = initExternalThemeRepo(themeDir);
    const shortSha = baseSha.slice(0, 7);

    const cacheRoot = makeTempDir("lrf-cache-");
    const fakeHome = makeTempDir("lrf-home-");

    // Install tarball offline inside external theme repo
    const installRes = await runCmd(
      npmBin,
      ["install", "--offline", "--no-audit", "--no-fund", "--save-dev", packedTgzPath],
      { cwd: themeDir, env: buildIsolatedEnv({ HOME: fakeHome }) },
    );
    assert.equal(installRes.code, 0, `npm install failed: ${installRes.stderr}`);

    const installedPkgRoot = path.join(themeDir, "node_modules", "liquid-regression-finder");
    assert.equal(fs.existsSync(path.join(installedPkgRoot, "engine", "Gemfile.lock")), true);
    assert.equal(fs.existsSync(path.join(installedPkgRoot, "engine", "vendor")), false);

    const baseEnv = buildIsolatedEnv({
      HOME: fakeHome,
      LRF_CACHE_DIR: cacheRoot,
    });

    // A. Before setup: check and watch must fail fast with actionable setup_required (exit 2)
    {
      const preCheck = await runCmd(
        npxBin,
        ["--no-install", "liquid-regression-finder", "check", "--base-ref", "HEAD"],
        { cwd: themeDir, env: baseEnv },
      );
      assert.equal(preCheck.code, 2, `Expected exit 2 before setup, got ${preCheck.code}; stdout=${preCheck.stdout}`);
      assert.ok(preCheck.stderr.includes("setup_required"), preCheck.stderr);
      assert.ok(preCheck.stderr.includes("liquid-regression-finder setup"), preCheck.stderr);

      const preWatch = await runCmd(
        npxBin,
        ["--no-install", "liquid-regression-finder", "watch"],
        { cwd: themeDir, env: baseEnv },
      );
      assert.equal(preWatch.code, 2, `Expected watch exit 2 before setup, got ${preWatch.code}`);
      assert.ok(preWatch.stderr.includes("setup_required"), preWatch.stderr);
    }

    // B. Missing / incompatible prerequisite checks must exit 2 with remediation instructions and --json status="error"
    {
      // Incompatible Python 3.9 (/usr/bin/python3 on macOS, or fake 3.9 script fallback)
      const py39Candidate = fs.existsSync("/usr/bin/python3") ? "/usr/bin/python3" : (() => {
        const fakeDir = makeTempDir("lrf-fake-py-");
        const fakePy = path.join(fakeDir, "python3");
        fs.writeFileSync(fakePy, "#!/bin/sh\necho '3.9.6'\n", { mode: 0o755 });
        return fakePy;
      })();
      const pyFail = await runCmd(
        npxBin,
        ["--no-install", "liquid-regression-finder", "setup", "--json"],
        { cwd: themeDir, env: buildIsolatedEnv({ HOME: fakeHome, LRF_CACHE_DIR: cacheRoot, LRF_PYTHON: py39Candidate }) },
      );
      assert.equal(pyFail.code, 2);
      const pyJson = JSON.parse(pyFail.stdout);
      assert.equal(pyJson.status, "error");
      assert.equal(pyJson.tools.python.ok, false);
      assert.ok(pyFail.stderr.includes("3.9"), pyFail.stderr);
      assert.ok(pyFail.stderr.includes("brew install python@3.11"), pyFail.stderr);

      // Incompatible Ruby 2.6 (/usr/bin/ruby on macOS, or fake 2.6 script fallback)
      const rb26Candidate = fs.existsSync("/usr/bin/ruby") ? "/usr/bin/ruby" : (() => {
        const fakeDir = makeTempDir("lrf-fake-rb-");
        const fakeRb = path.join(fakeDir, "ruby");
        fs.writeFileSync(fakeRb, "#!/bin/sh\necho '2.6.10'\necho '2.6.0'\necho 'x86_64-darwin'\n", { mode: 0o755 });
        return fakeRb;
      })();
      const rbFail = await runCmd(
        npxBin,
        ["--no-install", "liquid-regression-finder", "setup", "--json"],
        { cwd: themeDir, env: buildIsolatedEnv({ HOME: fakeHome, LRF_CACHE_DIR: cacheRoot, LRF_RUBY: rb26Candidate }) },
      );
      assert.equal(rbFail.code, 2);
      const rbJson = JSON.parse(rbFail.stdout);
      assert.equal(rbJson.status, "error");
      assert.equal(rbJson.tools.ruby.ok, false);
      assert.ok(rbFail.stderr.includes("2.6.10"), rbFail.stderr);
      assert.ok(rbFail.stderr.includes("brew install ruby@3.3"), rbFail.stderr);

      // Fake failing Bundler binary
      const fakeBinDir = makeTempDir("lrf-fake-bin-");
      const fakeBundle = path.join(fakeBinDir, "bundle");
      fs.writeFileSync(fakeBundle, "#!/bin/sh\necho 'broken bundler' >&2\nexit 1\n", { mode: 0o755 });
      const bundleFail = await runCmd(
        npxBin,
        ["--no-install", "liquid-regression-finder", "setup"],
        { cwd: themeDir, env: buildIsolatedEnv({ HOME: fakeHome, LRF_CACHE_DIR: cacheRoot, LRF_RUBY_BUNDLE: fakeBundle }) },
      );
      assert.equal(bundleFail.code, 2);
      assert.ok(bundleFail.stderr.includes("bundler"), bundleFail.stderr);
      assert.ok(bundleFail.stderr.includes("gem install bundler"), bundleFail.stderr);

      // Poisoned PATH with missing/failing git (keep only node bin + temp bin dir)
      const fakeGit = path.join(fakeBinDir, "git");
      fs.writeFileSync(fakeGit, "#!/bin/sh\nexit 127\n", { mode: 0o755 });
      const nodeBinDir = path.dirname(process.execPath);
      const gitFail = await runCmd(
        process.execPath,
        [path.join(installedPkgRoot, "cli", "bin", "liquid-regression-finder.js"), "setup"],
        {
          cwd: themeDir,
          env: buildIsolatedEnv(
            { HOME: fakeHome, LRF_CACHE_DIR: cacheRoot },
            { replacePath: `${fakeBinDir}${path.delimiter}${nodeBinDir}` },
          ),
        },
      );
      assert.equal(gitFail.code, 2);
      assert.ok(gitFail.stderr.includes("git"), gitFail.stderr);
      assert.ok(gitFail.stderr.includes("xcode-select --install") || gitFail.stderr.includes("apt-get"), gitFail.stderr);
    }

    // C. Run setup with LRF_GEM_CACHE -> installs locked gems into LRF_CACHE_DIR, writes env.json, passes smoke check
    const setupEnv = buildIsolatedEnv({
      HOME: fakeHome,
      LRF_CACHE_DIR: cacheRoot,
      LRF_GEM_CACHE: localGemCache,
    });
    const setupRes = await runCmd(
      npxBin,
      ["--no-install", "liquid-regression-finder", "setup", "--json"],
      { cwd: themeDir, env: setupEnv },
    );
    assert.equal(setupRes.code, 0, `setup --json failed: ${setupRes.stderr}`);
    assert.equal(setupRes.stderr, "");
    const setupJson = JSON.parse(setupRes.stdout);
    assert.equal(setupJson.status, "ok");
    assert.equal(setupJson.cache_reused, false);
    assert.ok(setupJson.cache_dir.startsWith(path.resolve(cacheRoot)), setupJson.cache_dir);
    assert.match(setupJson.cache_dir, /gems\/v0\.1\.0-ruby\d+\.\d+\.\d+/);
    assert.equal(setupJson.tools.git.ok, true);
    assert.equal(setupJson.tools.node.ok, true);
    assert.equal(setupJson.tools.python.ok, true);
    assert.equal(setupJson.tools.ruby.ok, true);
    assert.equal(setupJson.tools.bundler.ok, true);
    assert.equal(setupJson.smoke_check.passed, true);
    assert.equal(setupJson.smoke_check.unchanged_status, "no_difference_found");
    assert.equal(setupJson.smoke_check.regression_status, "difference_found");
    assert.equal(setupJson.smoke_check.reference_status, "confirmed");
    assert.equal(setupJson.smoke_check.liquid_version, "5.14.0");

    // Verify marker env.json written and node_modules never mutated
    const markerPath = path.join(setupJson.cache_dir, "env.json");
    assert.equal(fs.existsSync(markerPath), true);
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    assert.equal(marker.smoke_check_passed, true);
    assert.equal(fs.existsSync(path.join(installedPkgRoot, "engine", "vendor")), false);

    // D. Re-running setup is idempotent (reuses cache) and prints Setup complete... in human mode
    const setupHumanRes = await runCmd(
      npxBin,
      ["--no-install", "liquid-regression-finder", "setup"],
      { cwd: themeDir, env: baseEnv },
    );
    assert.equal(setupHumanRes.code, 0, `setup human failed: ${setupHumanRes.stderr}`);
    assert.ok(setupHumanRes.stdout.includes("Setup complete"), setupHumanRes.stdout);
    assert.ok(setupHumanRes.stdout.includes(setupJson.cache_dir), setupHumanRes.stdout);
    assert.ok(setupHumanRes.stdout.includes("Smoke check: passed"), setupHumanRes.stdout);
    assert.ok(setupHumanRes.stdout.includes("verified existing cache"), setupHumanRes.stdout);

    // E. Check unchanged -> exit 0; breaking edit -> exit 1 + replay file; replay -> exit 0
    const unchangedCheck = await runCmd(
      npxBin,
      ["--no-install", "liquid-regression-finder", "check", "--base-ref", "HEAD"],
      { cwd: themeDir, env: baseEnv },
    );
    assert.equal(unchangedCheck.code, 0, `unchanged check failed: ${unchangedCheck.stderr}`);
    assert.equal(unchangedCheck.stdout, "");
    assert.equal(unchangedCheck.stderr, "");

    const npmScriptCheck = await runCmd(npmBin, ["run", "liquid:check"], {
      cwd: themeDir,
      env: baseEnv,
    });
    assert.equal(npmScriptCheck.code, 0, `npm run liquid:check failed: ${npmScriptCheck.stderr}`);

    const themeSnippetPath = path.join(themeDir, "snippets", "card-product.liquid");
    fs.copyFileSync(DEMO_AFTER_PATH, themeSnippetPath);

    const breakingCheck = await runCmd(
      npxBin,
      ["--no-install", "liquid-regression-finder", "check", "--base-ref", "HEAD"],
      { cwd: themeDir, env: baseEnv },
    );
    assert.equal(breakingCheck.code, 1, `expected exit 1 on breaking edit, got ${breakingCheck.code}; stderr=${breakingCheck.stderr}`);
    assert.equal(breakingCheck.stderr, "");
    const expected4Line = [
      "snippets/card-product.liquid:1 Sale badge disappeared",
      "Before: v2 compared 1c > 0c, true. Badge shown.",
      "After:  product compared 0c > 0c, false. Badge absent.",
      "Official Liquid confirmed. Replay in .liquid-regression/result.json.",
    ].join("\n") + "\n";
    assert.equal(breakingCheck.stdout, expected4Line);

    const replayFile = path.join(themeDir, ".liquid-regression", "result.json");
    assert.equal(fs.existsSync(replayFile), true);

    const replayRes = await runCmd(
      npxBin,
      ["--no-install", "liquid-regression-finder", "replay", ".liquid-regression/result.json"],
      { cwd: themeDir, env: baseEnv },
    );
    assert.equal(replayRes.code, 0, `replay failed: ${replayRes.stderr}`);
    assert.ok(replayRes.stdout.includes("Official Liquid 5.14.0 parity confirmed"), replayRes.stdout);

    // F. Watch mode from external repo: quiet initial check, prints finding on break, quiet on fix, clean SIGINT
    fs.copyFileSync(CARD_PRODUCT_PATH, themeSnippetPath);
    fs.rmSync(path.join(themeDir, ".liquid-regression"), { recursive: true, force: true });

    const watcher = spawnNpxWatch(["--search-pairs", "64", "--shrink-pairs", "32"], {
      cwd: themeDir,
      env: baseEnv,
    });
    try {
      const banner = `Watching snippets/card-product.liquid against HEAD (${shortSha})\n`;
      await watcher.waitForStdout((s) => s.startsWith(banner));
      await waitForChildIdle(watcher.pid);
      assert.equal(watcher.stdout, banner);
      assert.equal(watcher.stderr, "");

      fs.copyFileSync(DEMO_AFTER_PATH, themeSnippetPath);
      await watcher.waitForStdout((s) => s === banner + expected4Line);
      await waitForChildIdle(watcher.pid, { settleMs: 150 });
      assert.equal(fs.existsSync(replayFile), true);

      // Revert to baseline -> quiet check
      fs.copyFileSync(CARD_PRODUCT_PATH, themeSnippetPath);
      await waitForChildIdle(watcher.pid, { settleMs: 450 });
      assert.equal(watcher.stdout, banner + expected4Line);
      assert.equal(watcher.stderr, "");

      const descendantsBeforeStop = getDescendants(watcher.pid).map((p) => p.pid);
      assert.ok(descendantsBeforeStop.length >= 1, "Expected watch process descendant under npx");

      const exitInfo = await watcher.stop("SIGINT");
      assert.ok(
        (exitInfo.code === 0 && exitInfo.signal === null) ||
          (exitInfo.code === null && exitInfo.signal === "SIGINT"),
        `Unexpected npx watch SIGINT exitInfo: ${JSON.stringify(exitInfo)}`,
      );
      assert.equal(watcher.stderr, "");
      const remainingPids = new Set(listProcesses().map((p) => p.pid));
      assert.equal(remainingPids.has(watcher.pid), false, "npx watcher parent should have exited");
      for (const descPid of descendantsBeforeStop) {
        assert.equal(remainingPids.has(descPid), false, `Descendant PID ${descPid} orphaned after SIGINT`);
      }
    } finally {
      await watcher.stop("SIGKILL", 1_000);
    }
  });

  it("4. supports external theme repo path AND LRF_CACHE_DIR containing spaces", async () => {
    assert.ok(packedTgzPath, "Tarball should be packed in test 1");
    const npmBin = resolveNpmBin();
    const npxBin = resolveNpxBin();
    const localGemCache = resolveLocalGemCacheDir();

    const spaceRoot = makeTempDir("lrf-space-root-");
    const themeDir = path.join(spaceRoot, "my theme repo");
    const cacheRoot = path.join(spaceRoot, "my lrf cache");
    const fakeHome = path.join(spaceRoot, "my home");
    fs.mkdirSync(fakeHome, { recursive: true });

    initExternalThemeRepo(themeDir);

    const installRes = await runCmd(
      npmBin,
      ["install", "--offline", "--no-audit", "--no-fund", "--save-dev", packedTgzPath],
      { cwd: themeDir, env: buildIsolatedEnv({ HOME: fakeHome }) },
    );
    assert.equal(installRes.code, 0, `npm install in space path failed: ${installRes.stderr}`);

    const setupEnv = buildIsolatedEnv({
      HOME: fakeHome,
      LRF_CACHE_DIR: cacheRoot,
      LRF_GEM_CACHE: localGemCache,
    });
    const setupRes = await runCmd(
      npxBin,
      ["--no-install", "liquid-regression-finder", "setup", "--json"],
      { cwd: themeDir, env: setupEnv },
    );
    assert.equal(setupRes.code, 0, `setup in space path failed: ${setupRes.stderr}`);
    const setupJson = JSON.parse(setupRes.stdout);
    assert.equal(setupJson.status, "ok");
    assert.ok(setupJson.cache_dir.includes("my lrf cache"), setupJson.cache_dir);

    const runtimeEnv = buildIsolatedEnv({
      HOME: fakeHome,
      LRF_CACHE_DIR: cacheRoot,
    });
    const okCheck = await runCmd(
      npxBin,
      ["--no-install", "liquid-regression-finder", "check", "--base-ref", "HEAD"],
      { cwd: themeDir, env: runtimeEnv },
    );
    assert.equal(okCheck.code, 0, okCheck.stderr);

    fs.copyFileSync(DEMO_AFTER_PATH, path.join(themeDir, "snippets", "card-product.liquid"));
    const failCheck = await runCmd(
      npxBin,
      ["--no-install", "liquid-regression-finder", "check", "--base-ref", "HEAD"],
      { cwd: themeDir, env: runtimeEnv },
    );
    assert.equal(failCheck.code, 1, failCheck.stderr);
    assert.ok(failCheck.stdout.includes("snippets/card-product.liquid:1 Sale badge disappeared"), failCheck.stdout);

    const replayRes = await runCmd(
      npxBin,
      ["--no-install", "liquid-regression-finder", "replay", ".liquid-regression/result.json"],
      { cwd: themeDir, env: runtimeEnv },
    );
    assert.equal(replayRes.code, 0, replayRes.stderr);
    assert.ok(replayRes.stdout.includes("Official Liquid 5.14.0 parity confirmed"), replayRes.stdout);
  });
});

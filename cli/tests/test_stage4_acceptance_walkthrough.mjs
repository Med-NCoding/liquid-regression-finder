import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { canonicalJson } from "../lib/format.mjs";

const execFileAsync = promisify(execFile);

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TESTS_DIR, "../..");
const DEMO_AFTER_PATH = path.join(REPO_ROOT, "fixtures", "demo", "after.liquid");
const CARD_PRODUCT_PATH = path.join(REPO_ROOT, "snippets", "card-product.liquid");

const TEMP_ROOTS = [];
const ACTIVE_WATCHERS = new Set();

function makeTempDir(prefix = "lrf-stage4-") {
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
  for (const base of [
    path.join(REPO_ROOT, "engine", "vendor", "bundle", "ruby"),
    path.join(REPO_ROOT, "vendor", "bundle", "ruby"),
  ]) {
    if (!fs.existsSync(base)) continue;
    for (const abiDir of fs.readdirSync(base)) {
      const candidate = path.join(base, abiDir, "cache");
      if (fs.existsSync(candidate) && fs.readdirSync(candidate).some((f) => f.endsWith(".gem"))) {
        return candidate;
      }
    }
  }
  throw new Error("Expected local .gem cache under engine/vendor/bundle or vendor/bundle.");
}

function runGit(repoDir, args) {
  return execFileSync("git", args, {
    cwd: repoDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function buildIsolatedEnv(extra = {}) {
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
  const parts = (env.PATH || "").split(path.delimiter).filter(Boolean);
  if (!parts.includes(nodeDir)) {
    env.PATH = [nodeDir, ...parts].join(path.delimiter);
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

async function waitForCondition(fn, { timeoutMs = 20_000, pollMs = 30, label = "condition" } = {}) {
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

async function waitForChildIdle(rootPid, { settleMs = 350, timeoutMs = 20_000 } = {}) {
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
    async waitForStdout(predicate, timeoutMs = 20_000) {
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

function exportCleanSnapshot(srcRoot, dstRoot) {
  const excludedRelPrefixes = [
    ".git",
    "vendor/bundle",
    "api/vendor/bundle",
    "engine/vendor/bundle",
    ".bundle",
    "api/.bundle",
    "engine/.bundle",
    "node_modules",
    "web/node_modules",
    "web/dist",
    "web/.vite",
    ".liquid-regression",
    "artifacts/tmp",
    "api/tmp",
    "api/log",
  ];

  fs.cpSync(srcRoot, dstRoot, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(srcRoot, src).split(path.sep).join("/");
      if (!rel) return true;
      const base = path.basename(src);
      if (
        base === "__pycache__" ||
        base === ".DS_Store" ||
        base.endsWith(".pyc") ||
        base.endsWith(".tgz") ||
        base.endsWith(".log")
      ) {
        return false;
      }
      if (/^api\/storage\/.*\.(?:sqlite3|db)/.test(rel)) {
        return false;
      }
      for (const prefix of excludedRelPrefixes) {
        if (rel === prefix || rel.startsWith(`${prefix}/`)) {
          return false;
        }
      }
      return true;
    },
  });
}

after(async () => {
  for (const w of [...ACTIVE_WATCHERS]) {
    await w.stop("SIGKILL", 1_000);
  }
  for (const dir of TEMP_ROOTS) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("Migration Stage 4: clean-checkout acceptance walkthrough & registry tarball", () => {
  it("completes clean export, pack metadata verification, external theme install, watch, replay, and CI parity", async () => {
    const npmBin = resolveNpmBin();
    const npxBin = resolveNpxBin();
    const localGemCache = resolveLocalGemCacheDir();

    // -------------------------------------------------------------------------
    // Step 1: Clean checkout export + Registry Tarball Verification
    // -------------------------------------------------------------------------
    const cleanSnapshotDir = makeTempDir("lrf-clean-export-");
    const packDestDir = makeTempDir("lrf-clean-pack-");
    exportCleanSnapshot(REPO_ROOT, cleanSnapshotDir);

    for (const absentRel of [
      ".git",
      "vendor/bundle",
      "engine/vendor/bundle",
      "node_modules",
      ".liquid-regression",
    ]) {
      assert.equal(
        fs.existsSync(path.join(cleanSnapshotDir, absentRel)),
        false,
        `Clean export should exclude ${absentRel}`,
      );
    }
    assert.deepEqual(
      fs.readdirSync(cleanSnapshotDir).filter((name) => name.endsWith(".tgz")),
      [],
    );

    const pkgMeta = JSON.parse(fs.readFileSync(path.join(cleanSnapshotDir, "package.json"), "utf8"));
    assert.equal(pkgMeta.name, "liquid-regression-finder");
    assert.equal(pkgMeta.version, "0.1.0");
    assert.equal(pkgMeta.license, "MIT");
    assert.equal(pkgMeta.author, "Medhansh Negi");
    assert.equal(pkgMeta.private, false);
    assert.ok(String(pkgMeta.repository?.url || "").includes("Med-NCoding/liquid-regression-finder"));

    const dryRunRes = await runCmd(npmBin, ["pack", "--dry-run", "--json"], {
      cwd: cleanSnapshotDir,
      env: buildIsolatedEnv(),
    });
    assert.equal(dryRunRes.code, 0, `npm pack --dry-run failed: ${dryRunRes.stderr}`);
    const dryRunPayload = JSON.parse(dryRunRes.stdout);
    assert.equal(dryRunPayload.length, 1);
    assert.equal(dryRunPayload[0].name, "liquid-regression-finder");
    assert.equal(dryRunPayload[0].version, "0.1.0");
    assert.equal(dryRunPayload[0].filename, "liquid-regression-finder-0.1.0.tgz");

    const packRes = await runCmd(npmBin, ["pack", "--pack-destination", packDestDir], {
      cwd: cleanSnapshotDir,
      env: buildIsolatedEnv(),
    });
    assert.equal(packRes.code, 0, `npm pack failed: ${packRes.stderr}`);
    const packedName = packRes.stdout.trim().split(/\r?\n/).pop().trim();
    assert.equal(packedName, "liquid-regression-finder-0.1.0.tgz");
    const packedTgzPath = path.join(packDestDir, packedName);
    assert.equal(fs.existsSync(packedTgzPath), true);
    assert.deepEqual(
      fs.readdirSync(cleanSnapshotDir).filter((name) => name.endsWith(".tgz")),
      [],
    );

    // -------------------------------------------------------------------------
    // Step 2: Install & Setup & Watch Banner in Separate Theme Repo
    // -------------------------------------------------------------------------
    const themeDir = makeTempDir("lrf-accept-theme-");
    const fakeHome = makeTempDir("lrf-accept-home-");
    const cacheRoot = makeTempDir("lrf-accept-cache-");

    runGit(themeDir, ["init"]);
    runGit(themeDir, ["config", "user.name", "Theme Maintainer"]);
    runGit(themeDir, ["config", "user.email", "maintainer@example.com"]);

    fs.writeFileSync(path.join(themeDir, ".gitignore"), "node_modules/\n.liquid-regression/\n", "utf8");
    fs.writeFileSync(
      path.join(themeDir, "package.json"),
      JSON.stringify(
        {
          name: "dawn-store-theme",
          version: "1.0.0",
          private: true,
          scripts: {
            dev: "echo theme dev server",
            "liquid:watch": "liquid-regression-finder watch",
            "liquid:check": "liquid-regression-finder check --base-ref HEAD",
          },
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(themeDir, "liquid-regression.json"),
      JSON.stringify(
        {
          snippet_path: "snippets/card-product.liquid",
          observer: "sale_badge",
          seed: 0,
          budget: { search_pairs: 256, shrink_pairs: 128 },
          watch_budget: { search_pairs: 32, shrink_pairs: 16 },
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    const snippetRel = "snippets/card-product.liquid";
    const absSnippet = path.join(themeDir, snippetRel);
    fs.mkdirSync(path.dirname(absSnippet), { recursive: true });
    const baselineBytes = fs.readFileSync(CARD_PRODUCT_PATH);
    fs.writeFileSync(absSnippet, baselineBytes);

    runGit(themeDir, ["add", "-A"]);
    runGit(themeDir, ["commit", "-m", "Baseline card-product snippet"]);
    const baseSha = runGit(themeDir, ["rev-parse", "HEAD"]);
    const shortSha = baseSha.slice(0, 7);

    const installRes = await runCmd(
      npmBin,
      ["install", "--offline", "--no-audit", "--no-fund", "--save-dev", packedTgzPath],
      { cwd: themeDir, env: buildIsolatedEnv({ HOME: fakeHome }) },
    );
    assert.equal(installRes.code, 0, `npm install failed: ${installRes.stderr}`);

    const setupRes = await runCmd(
      npxBin,
      ["--no-install", "liquid-regression-finder", "setup"],
      {
        cwd: themeDir,
        env: buildIsolatedEnv({
          HOME: fakeHome,
          LRF_CACHE_DIR: cacheRoot,
          LRF_GEM_CACHE: localGemCache,
        }),
      },
    );
    assert.equal(setupRes.code, 0, `setup failed: ${setupRes.stderr}`);
    assert.ok(setupRes.stdout.includes("Setup complete"), setupRes.stdout);
    assert.ok(setupRes.stdout.includes("Smoke check: passed"), setupRes.stdout);

    const runtimeEnv = buildIsolatedEnv({
      HOME: fakeHome,
      LRF_CACHE_DIR: cacheRoot,
    });

    const replayFile = path.join(themeDir, ".liquid-regression", "result.json");
    const savedLine1ReplayCopy = path.join(makeTempDir("lrf-watch-copy-"), "watch-line1-result.json");
    let watchLine1Bundle;

    const watcher = spawnNpxWatch(["--seed", "0", "--search-pairs", "64", "--shrink-pairs", "32"], {
      cwd: themeDir,
      env: runtimeEnv,
    });
    try {
      const banner = `Watching ${snippetRel} against HEAD (${shortSha})\n`;
      await watcher.waitForStdout((s) => s.startsWith(banner));
      await waitForChildIdle(watcher.pid);
      assert.equal(watcher.stdout, banner);
      assert.equal(watcher.stderr, "");

      // -----------------------------------------------------------------------
      // Step 3: Save Breaking Change, Save Again, Fix It & Rapid Saves
      // -----------------------------------------------------------------------
      // 3a. Save product-level breaking edit (conditional on line 1)
      const afterLine1Bytes = fs.readFileSync(DEMO_AFTER_PATH);
      const afterLine1Lines = afterLine1Bytes.toString("utf8").split("\n");
      assert.ok(afterLine1Lines[0].includes("product.compare_at_price"));
      fs.writeFileSync(absSnippet, afterLine1Bytes);

      const expectedFindingLine1 = [
        "snippets/card-product.liquid:1 Sale badge disappeared",
        "Before: v2 compared 1c > 0c, true. Badge shown.",
        "After:  product compared 0c > 0c, false. Badge absent.",
        "Official Liquid confirmed. Replay in .liquid-regression/result.json.",
      ].join("\n") + "\n";

      await watcher.waitForStdout((s) => s === banner + expectedFindingLine1);
      await waitForChildIdle(watcher.pid, { settleMs: 120 });
      assert.equal(watcher.stderr, "");
      assert.equal(fs.existsSync(replayFile), true);
      fs.copyFileSync(replayFile, savedLine1ReplayCopy);
      watchLine1Bundle = JSON.parse(fs.readFileSync(replayFile, "utf8"));
      assert.equal(watchLine1Bundle.before_sha256, sha256Hex(baselineBytes));
      assert.equal(watchLine1Bundle.after_sha256, sha256Hex(afterLine1Bytes));

      // 3b. Advance HEAD with an unrelated commit (to verify watch keeps original baseSha!)
      // and save an unrelated edit (2 prepended comment lines) shifting the conditional to line 3.
      fs.writeFileSync(path.join(themeDir, "unrelated.txt"), "advance HEAD mid-watch\n", "utf8");
      runGit(themeDir, ["add", "unrelated.txt"]);
      runGit(themeDir, ["commit", "-m", "Advance HEAD while watch is running"]);
      const midWatchHeadSha = runGit(themeDir, ["rev-parse", "HEAD"]);
      assert.notEqual(midWatchHeadSha, baseSha);

      const afterLine3Bytes = Buffer.from(
        "{#- unrelated comment line 1 -#}\n{#- unrelated comment line 2 -#}\n" +
          afterLine1Bytes.toString("utf8"),
        "utf8",
      );
      const afterLine3Lines = afterLine3Bytes.toString("utf8").split("\n");
      assert.ok(afterLine3Lines[2].includes("product.compare_at_price"));
      fs.writeFileSync(absSnippet, afterLine3Bytes);

      const expectedFindingLine3 = [
        "snippets/card-product.liquid:3 Sale badge disappeared",
        "Before: v2 compared 1c > 0c, true. Badge shown.",
        "After:  product compared 0c > 0c, false. Badge absent.",
        "Official Liquid confirmed. Replay in .liquid-regression/result.json.",
      ].join("\n") + "\n";

      await watcher.waitForStdout((s) => s === banner + expectedFindingLine1 + expectedFindingLine3);
      await waitForChildIdle(watcher.pid, { settleMs: 120 });
      const watchLine3Bundle = JSON.parse(fs.readFileSync(replayFile, "utf8"));
      assert.equal(watchLine3Bundle.before_sha256, sha256Hex(baselineBytes));
      assert.equal(watchLine3Bundle.after_sha256, sha256Hex(afterLine3Bytes));
      assert.deepEqual(watchLine3Bundle.fixture, watchLine1Bundle.fixture);

      // 3c. Revert to original variant logic -> next check is quiet (no new finding printed)
      fs.writeFileSync(absSnippet, baselineBytes);
      await waitForChildIdle(watcher.pid, { settleMs: 450 });
      assert.equal(watcher.stdout, banner + expectedFindingLine1 + expectedFindingLine3);
      assert.equal(watcher.stderr, "");

      // 3d. Rapid saves (<150 ms): broken edit followed 80 ms later by fixed edit -> quiet!
      fs.writeFileSync(absSnippet, afterLine1Bytes);
      await sleep(80);
      fs.writeFileSync(absSnippet, baselineBytes);
      await waitForChildIdle(watcher.pid, { settleMs: 450 });
      assert.equal(watcher.stdout, banner + expectedFindingLine1 + expectedFindingLine3);
      assert.equal(watcher.stderr, "");

      // 3e. Clean SIGINT shutdown with zero lingering child processes
      const descendantsBeforeStop = getDescendants(watcher.pid).map((p) => p.pid);
      assert.ok(descendantsBeforeStop.length >= 1);
      const exitInfo = await watcher.stop("SIGINT");
      assert.ok(
        (exitInfo.code === 0 && exitInfo.signal === null) ||
          (exitInfo.code === null && exitInfo.signal === "SIGINT"),
        `Unexpected SIGINT exitInfo: ${JSON.stringify(exitInfo)}`,
      );
      assert.equal(watcher.stderr, "");

      const remainingPids = new Set(listProcesses().map((p) => p.pid));
      assert.equal(remainingPids.has(watcher.pid), false);
      for (const descPid of descendantsBeforeStop) {
        assert.equal(remainingPids.has(descPid), false, `Orphaned descendant PID ${descPid}`);
      }
    } finally {
      await watcher.stop("SIGKILL", 1_000);
    }

    // -------------------------------------------------------------------------
    // Step 4: Replay & CI Terminal Parity
    // -------------------------------------------------------------------------
    // Replay saved watch finding in a fresh process -> exit 0 + official parity confirmed
    const replayHuman = await runCmd(
      npxBin,
      ["--no-install", "liquid-regression-finder", "replay", ".liquid-regression/result.json"],
      { cwd: themeDir, env: runtimeEnv },
    );
    assert.equal(replayHuman.code, 0, `replay failed: ${replayHuman.stderr}`);
    assert.ok(replayHuman.stdout.includes("Official Liquid 5.14.0 parity confirmed"), replayHuman.stdout);

    const replayLine1JsonRes = await runCmd(
      npxBin,
      ["--no-install", "liquid-regression-finder", "replay", savedLine1ReplayCopy, "--json"],
      { cwd: themeDir, env: runtimeEnv },
    );
    assert.equal(replayLine1JsonRes.code, 0, `replay --json failed: ${replayLine1JsonRes.stderr}`);
    const watchLine1ReplayReport = JSON.parse(replayLine1JsonRes.stdout);
    assert.equal(watchLine1ReplayReport.status, "replayed");
    assert.equal(watchLine1ReplayReport.reference.before.observed, true);
    assert.equal(watchLine1ReplayReport.reference.after.observed, false);

    // Commit broken DEMO_AFTER_PATH cleanly to create explicit CI headSha
    const afterLine1Bytes = fs.readFileSync(DEMO_AFTER_PATH);
    fs.writeFileSync(absSnippet, afterLine1Bytes);
    runGit(themeDir, ["add", snippetRel]);
    runGit(themeDir, ["commit", "-m", "Commit broken product-level snippet"]);
    const headSha = runGit(themeDir, ["rev-parse", "HEAD"]);

    // 4a. Identical refs -> exit 0
    const identicalCheck = await runCmd(
      npxBin,
      [
        "--no-install",
        "liquid-regression-finder",
        "check",
        "--base-ref",
        baseSha,
        "--head-ref",
        baseSha,
        "--seed",
        "0",
        "--search-pairs",
        "256",
        "--shrink-pairs",
        "128",
      ],
      { cwd: themeDir, env: runtimeEnv },
    );
    assert.equal(identicalCheck.code, 0, `Expected exit 0 for identical refs: ${identicalCheck.stderr}`);
    assert.equal(identicalCheck.stdout, "");
    assert.equal(identicalCheck.stderr, "");

    // 4b. Regression (--json) -> exit 1 & identical shrunk fixture / product to terminal watch run
    const ciReplayPath = path.join(makeTempDir("lrf-ci-replay-"), "ci-result.json");
    const ciJsonCheck = await runCmd(
      npxBin,
      [
        "--no-install",
        "liquid-regression-finder",
        "check",
        "--base-ref",
        baseSha,
        "--head-ref",
        headSha,
        "--seed",
        "0",
        "--search-pairs",
        "256",
        "--shrink-pairs",
        "128",
        "--replay-out",
        ciReplayPath,
        "--json",
      ],
      { cwd: themeDir, env: runtimeEnv },
    );
    assert.equal(ciJsonCheck.code, 1, `Expected exit 1 for CI regression: ${ciJsonCheck.stderr}`);
    assert.equal(ciJsonCheck.stderr, "");
    const ciReport = JSON.parse(ciJsonCheck.stdout);
    assert.equal(ciReport.status, "difference_found");
    assert.equal(ciReport.reference_status, "confirmed");
    assert.deepEqual(ciReport.finding.replay.fixture, watchLine1Bundle.fixture);
    assert.deepEqual(ciReport.finding.product, watchLine1ReplayReport.product);
    assert.equal(fs.existsSync(ciReplayPath), true);
    assert.equal(
      fs.readFileSync(ciReplayPath, "utf8"),
      canonicalJson(ciReport.finding.replay),
    );

    // 4c. Regression (human text) -> exit 1 & exact 4-line terminal parity
    const ciTextReplayPath = path.join(makeTempDir("lrf-ci-replay-text-"), "ci-text-result.json");
    const ciTextCheck = await runCmd(
      npxBin,
      [
        "--no-install",
        "liquid-regression-finder",
        "check",
        "--base-ref",
        baseSha,
        "--head-ref",
        headSha,
        "--seed",
        "0",
        "--search-pairs",
        "256",
        "--shrink-pairs",
        "128",
        "--replay-out",
        ciTextReplayPath,
      ],
      { cwd: themeDir, env: runtimeEnv },
    );
    assert.equal(ciTextCheck.code, 1, `Expected exit 1 for CI text regression: ${ciTextCheck.stderr}`);
    assert.equal(ciTextCheck.stderr, "");
    assert.equal(
      ciTextCheck.stdout,
      [
        "snippets/card-product.liquid:1 Sale badge disappeared",
        "Before: v2 compared 1c > 0c, true. Badge shown.",
        "After:  product compared 0c > 0c, false. Badge absent.",
        `Official Liquid confirmed. Replay in ${ciTextReplayPath}.`,
      ].join("\n") + "\n",
    );

    // 4d. Missing baseline ref & invalid Liquid syntax -> exit 2
    const missingRefCheck = await runCmd(
      npxBin,
      [
        "--no-install",
        "liquid-regression-finder",
        "check",
        "--base-ref",
        "refs/heads/does-not-exist",
        "--head-ref",
        headSha,
      ],
      { cwd: themeDir, env: runtimeEnv },
    );
    assert.equal(missingRefCheck.code, 2, `Expected exit 2 for missing base-ref, got ${missingRefCheck.code}`);
    assert.ok(missingRefCheck.stderr.includes("missing_commit"), missingRefCheck.stderr);

    fs.writeFileSync(absSnippet, "{% bogus %}\n", "utf8");
    runGit(themeDir, ["add", snippetRel]);
    runGit(themeDir, ["commit", "-m", "Commit invalid Liquid syntax"]);
    const invalidSyntaxSha = runGit(themeDir, ["rev-parse", "HEAD"]);

    const invalidSyntaxCheck = await runCmd(
      npxBin,
      [
        "--no-install",
        "liquid-regression-finder",
        "check",
        "--base-ref",
        baseSha,
        "--head-ref",
        invalidSyntaxSha,
      ],
      { cwd: themeDir, env: runtimeEnv },
    );
    assert.equal(invalidSyntaxCheck.code, 2, `Expected exit 2 for invalid syntax, got ${invalidSyntaxCheck.code}`);
    assert.ok(
      invalidSyntaxCheck.stderr.includes("unsupported_tag") || invalidSyntaxCheck.stderr.includes("bogus"),
      invalidSyntaxCheck.stderr,
    );
  });
});

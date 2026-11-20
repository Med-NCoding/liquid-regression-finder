import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../lib/format.mjs";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TESTS_DIR, "../..");
const CLI_BIN = path.join(REPO_ROOT, "cli", "bin", "liquid-regression-finder.js");
const DEMO_BEFORE_PATH = path.join(REPO_ROOT, "fixtures", "demo", "before.liquid");
const DEMO_AFTER_PATH = path.join(REPO_ROOT, "fixtures", "demo", "after.liquid");
const CARD_PRODUCT_PATH = path.join(REPO_ROOT, "snippets", "card-product.liquid");
const REAL_PYTHON_311 = "/opt/homebrew/opt/python@3.11/bin/python3.11";

const TEMP_ROOTS = [];
const ACTIVE_WATCHERS = new Set();

function makeTempDir(prefix = "lrf-watch-test-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  TEMP_ROOTS.push(dir);
  return dir;
}

function runGit(repoDir, args) {
  return execFileSync("git", args, {
    cwd: repoDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function initGitRepo(repoDir) {
  fs.mkdirSync(repoDir, { recursive: true });
  runGit(repoDir, ["init"]);
  runGit(repoDir, ["config", "user.name", "Test Author"]);
  runGit(repoDir, ["config", "user.email", "test@example.com"]);
}

function commitAll(repoDir, message) {
  runGit(repoDir, ["add", "-A"]);
  runGit(repoDir, ["commit", "-m", message]);
  return runGit(repoDir, ["rev-parse", "HEAD"]);
}

function writeRepoConfig(repoDir, configObj) {
  fs.writeFileSync(
    path.join(repoDir, "liquid-regression.json"),
    JSON.stringify(configObj, null, 2) + "\n",
    "utf8",
  );
}

function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
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

async function waitForChildIdle(watchPid, { settleMs = 400, timeoutMs = 15_000 } = {}) {
  await sleep(settleMs);
  await waitForCondition(
    () => getDescendants(watchPid).length === 0,
    { timeoutMs, pollMs: 40, label: `children of ${watchPid} to become idle` },
  );
}

function spawnWatch(args, { cwd, env = {} } = {}) {
  const child = spawn(process.execPath, [CLI_BIN, "watch", ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });

  let stdout = "";
  let stderr = "";
  let exited = false;
  let exitInfo = null;
  const waiters = [];

  const notify = () => {
    for (const w of [...waiters]) w();
  };

  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
    notify();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
    notify();
  });

  const exitPromise = new Promise((resolve) => {
    child.on("close", (code, signal) => {
      exited = true;
      exitInfo = { code, signal };
      ACTIVE_WATCHERS.delete(handle);
      notify();
      resolve(exitInfo);
    });
  });

  const handle = {
    child,
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
    get exitInfo() {
      return exitInfo;
    },
    exitPromise,
    async waitForStdout(predicate, timeoutMs = 15_000) {
      return waitForCondition(
        () => (typeof predicate === "function" ? predicate(stdout) : predicate.test(stdout)),
        { timeoutMs, pollMs: 25, label: `stdout match (${predicate}); current stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}` },
      );
    },
    async waitForStderr(predicate, timeoutMs = 15_000) {
      return waitForCondition(
        () => (typeof predicate === "function" ? predicate(stderr) : predicate.test(stderr)),
        { timeoutMs, pollMs: 25, label: `stderr match (${predicate}); current stderr=${JSON.stringify(stderr)}` },
      );
    },
    async stop(sig = "SIGINT", timeoutMs = 8_000) {
      if (exited) return exitInfo;
      try {
        child.kill(sig);
      } catch {
        // Ignore if already exited.
      }
      const timer = setTimeout(() => {
        if (!exited) {
          try {
            child.kill("SIGKILL");
          } catch {
            // Ignore.
          }
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
  for (const watcher of [...ACTIVE_WATCHERS]) {
    await watcher.stop("SIGKILL", 1_000);
  }
  for (const dir of TEMP_ROOTS) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("Migration Stage 2: Watch mode", () => {
  it("1-4. watches edits, preserves session baseline across commits, warms cache, deduplicates, handles line shifts, and stays quiet on revert", async () => {
    const repoDir = makeTempDir("lrf-watch-lifecycle-");
    initGitRepo(repoDir);

    const snippetRel = "snippets/card-product.liquid";
    const absSnippet = path.join(repoDir, snippetRel);
    fs.mkdirSync(path.dirname(absSnippet), { recursive: true });
    const baselineBytes = fs.readFileSync(CARD_PRODUCT_PATH);
    fs.writeFileSync(absSnippet, baselineBytes);

    writeRepoConfig(repoDir, {
      snippet_path: snippetRel,
      observer: "sale_badge",
      seed: 0,
      budget: { search_pairs: 256, shrink_pairs: 128 },
      watch_budget: { search_pairs: 64, shrink_pairs: 32 },
    });
    const baseSha = commitAll(repoDir, "Baseline variant-loop snippet");
    const shortSha = baseSha.slice(0, 7);

    // Wrap python to verify warm fixture caching (--priority-fixture + search_pairs === 1 on subsequent bug-preserving edit).
    const logDir = makeTempDir("lrf-py-log-");
    const pyLogPath = path.join(logDir, "calls.jsonl");
    const wrapperPy = path.join(logDir, "wrap_python.py");
    const realPy = fs.existsSync(REAL_PYTHON_311) ? REAL_PYTHON_311 : "python3";
    fs.writeFileSync(
      wrapperPy,
      [
        `#!${realPy}`,
        "import json, subprocess, sys",
        `LOG_PATH = ${JSON.stringify(pyLogPath)}`,
        `proc = subprocess.run([${JSON.stringify(realPy)}, *sys.argv[1:]], capture_output=True, text=True, encoding="utf-8")`,
        "if len(sys.argv) >= 4 and sys.argv[1] == '-m' and sys.argv[2] == 'search' and sys.argv[3] == 'compare':",
        "    report = None",
        "    try:",
        "        report = json.loads(proc.stdout)",
        "    except Exception:",
        "        pass",
        "    with open(LOG_PATH, 'a', encoding='utf-8') as fh:",
        "        fh.write(json.dumps({",
        "            'argv': sys.argv[1:],",
        "            'has_priority': '--priority-fixture' in sys.argv[1:],",
        "            'status': report.get('status') if isinstance(report, dict) else None,",
        "            'search_pairs': report.get('stats', {}).get('search_pairs') if isinstance(report, dict) else None,",
        "        }) + '\\n')",
        "sys.stdout.write(proc.stdout)",
        "sys.stderr.write(proc.stderr)",
        "raise SystemExit(proc.returncode)",
      ].join("\n") + "\n",
      { mode: 0o755 },
    );

    const watcher = spawnWatch([], {
      cwd: repoDir,
      env: { LRF_PYTHON: wrapperPy },
    });

    try {
      // 1. Startup banner and initial quiet clean check.
      const banner = `Watching ${snippetRel} against HEAD (${shortSha})\n`;
      await watcher.waitForStdout((s) => s.startsWith(banner));
      await waitForChildIdle(watcher.pid);
      assert.equal(watcher.stdout, banner);
      assert.equal(watcher.stderr, "");

      // 2. Breaking edit on line 1 -> prints 4-line finding & writes .liquid-regression/result.json.
      const afterLine1 = fs.readFileSync(DEMO_AFTER_PATH);
      fs.writeFileSync(absSnippet, afterLine1);

      const expectedFinding1 = [
        "snippets/card-product.liquid:1 Sale badge disappeared",
        "Before: v2 compared 1c > 0c, true. Badge shown.",
        "After:  product compared 0c > 0c, false. Badge absent.",
        "Official Liquid confirmed. Replay in .liquid-regression/result.json.",
      ].join("\n") + "\n";

      await watcher.waitForStdout((s) => s === banner + expectedFinding1);
      await waitForChildIdle(watcher.pid, { settleMs: 100 });
      assert.equal(watcher.stderr, "");

      const replayPath = path.join(repoDir, ".liquid-regression", "result.json");
      assert.equal(fs.existsSync(replayPath), true);
      const replay1 = JSON.parse(fs.readFileSync(replayPath, "utf8"));
      assert.equal(replay1.before_sha256, sha256Hex(baselineBytes));
      assert.equal(replay1.after_sha256, sha256Hex(afterLine1));
      assert.deepEqual(replay1.request.budget, { search_pairs: 64, shrink_pairs: 32 });

      // 3a. Make a new commit advancing HEAD while watch is running + save a second edit that preserves line 1.
      // Baseline must stay frozen at original baseSha, replay must update after_sha256, warm cache hits in 1 pair,
      // and identical 4-line message must be deduplicated!
      fs.writeFileSync(path.join(repoDir, "unrelated.txt"), "new commit on HEAD\n", "utf8");
      const newHeadSha = commitAll(repoDir, "Advance HEAD mid-watch");
      assert.notEqual(newHeadSha, baseSha);

      const afterLine1Commented = Buffer.from(
        afterLine1.toString("utf8") + "{#- harmless trailing comment -#}\n",
        "utf8",
      );
      fs.writeFileSync(absSnippet, afterLine1Commented);

      await waitForCondition(
        () => {
          if (!fs.existsSync(replayPath)) return false;
          const r = JSON.parse(fs.readFileSync(replayPath, "utf8"));
          return r.after_sha256 === sha256Hex(afterLine1Commented);
        },
        { label: "result.json after_sha256 to update on bug-preserving edit" },
      );
      await waitForChildIdle(watcher.pid, { settleMs: 100 });

      const replay2 = JSON.parse(fs.readFileSync(replayPath, "utf8"));
      assert.equal(replay2.before_sha256, sha256Hex(baselineBytes));
      assert.equal(replay2.after_sha256, sha256Hex(afterLine1Commented));
      // Identical finding must be deduplicated on stdout.
      assert.equal(watcher.stdout, banner + expectedFinding1);

      // 3b. Shift condition from line 1 to line 2 -> emits updated 4-line output!
      const afterLine2 = Buffer.from(
        "{#- shifted down one line -#}\n" + afterLine1.toString("utf8"),
        "utf8",
      );
      fs.writeFileSync(absSnippet, afterLine2);

      const expectedFinding2 = [
        "snippets/card-product.liquid:2 Sale badge disappeared",
        "Before: v2 compared 1c > 0c, true. Badge shown.",
        "After:  product compared 0c > 0c, false. Badge absent.",
        "Official Liquid confirmed. Replay in .liquid-regression/result.json.",
      ].join("\n") + "\n";

      await watcher.waitForStdout((s) => s === banner + expectedFinding1 + expectedFinding2);
      await waitForChildIdle(watcher.pid, { settleMs: 100 });
      const replay3 = JSON.parse(fs.readFileSync(replayPath, "utf8"));
      assert.equal(replay3.before_sha256, sha256Hex(baselineBytes));
      assert.equal(replay3.after_sha256, sha256Hex(afterLine2));

      // Verify warm fixture cache calls in wrapper log:
      // Call 0: initial clean (no priority)
      // Call 1: breaking line 1 (no priority, 9 pairs via Phase 1 stratified prefix)
      // Call 2: line 1 commented (has priority, 1 pair!)
      // Call 3: line 2 shifted (has priority, 1 pair!)
      const pyCalls = fs.readFileSync(pyLogPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      assert.equal(pyCalls.length, 4);
      assert.equal(pyCalls[0].has_priority, false);
      assert.equal(pyCalls[1].has_priority, false);
      assert.equal(pyCalls[1].search_pairs, 9);
      assert.equal(pyCalls[2].has_priority, true);
      assert.equal(pyCalls[2].search_pairs, 1);
      assert.equal(pyCalls[3].has_priority, true);
      assert.equal(pyCalls[3].search_pairs, 1);

      // 4. Revert to baseline fix -> quiet check, then re-break -> prints again!
      fs.writeFileSync(absSnippet, baselineBytes);
      await waitForCondition(
        () => fs.readFileSync(pyLogPath, "utf8").trim().split("\n").length >= 5,
        { label: "revert clean check completion" },
      );
      await waitForChildIdle(watcher.pid, { settleMs: 100 });
      assert.equal(watcher.stdout, banner + expectedFinding1 + expectedFinding2);

      // Re-break with line 2 -> lastPrintedSignature was reset on clean revert, so it prints again!
      fs.writeFileSync(absSnippet, afterLine2);
      await watcher.waitForStdout((s) => s === banner + expectedFinding1 + expectedFinding2 + expectedFinding2);

      // 3c. Operand/outcome shift on line 1 (product.price == 0) emits updated 4-line output!
      const afterOperandShift = Buffer.from(
        '{%- if product.price == 0 -%}\n<span class="badge" data-regression-badge="sale">Sale</span>\n{%- endif -%}\n',
        "utf8",
      );
      fs.writeFileSync(absSnippet, afterOperandShift);
      await watcher.waitForStdout((s) => s.includes("snippets/card-product.liquid:1 Sale badge appeared"));
      assert.ok(watcher.stdout.includes("0c == 0c, true. Badge shown."), watcher.stdout);
      assert.equal(watcher.stderr, "");

      const exitInfo = await watcher.stop("SIGINT");
      assert.equal(exitInfo.code, 0);
      assert.equal(exitInfo.signal, null);
    } finally {
      await watcher.stop("SIGKILL", 1_000);
    }
  });

  it("5a. coalesces rapid saves within 250ms (broken save followed <150ms by clean save produces zero finding)", async () => {
    const repoDir = makeTempDir("lrf-watch-coalesce-");
    initGitRepo(repoDir);

    const snippetRel = "snippets/card-product.liquid";
    const absSnippet = path.join(repoDir, snippetRel);
    fs.mkdirSync(path.dirname(absSnippet), { recursive: true });
    const cleanBytes = fs.readFileSync(DEMO_BEFORE_PATH);
    fs.writeFileSync(absSnippet, cleanBytes);
    writeRepoConfig(repoDir, {
      snippet_path: snippetRel,
      observer: "sale_badge",
      seed: 0,
      watch_budget: { search_pairs: 64, shrink_pairs: 32 },
    });
    const baseSha = commitAll(repoDir, "Baseline");

    const watcher = spawnWatch([], { cwd: repoDir });
    try {
      const banner = `Watching ${snippetRel} against HEAD (${baseSha.slice(0, 7)})\n`;
      await watcher.waitForStdout((s) => s.startsWith(banner));
      await waitForChildIdle(watcher.pid);

      // Broken save followed 80ms (< 150ms) later by clean save -> coalesced to clean!
      fs.writeFileSync(absSnippet, fs.readFileSync(DEMO_AFTER_PATH));
      await sleep(80);
      fs.writeFileSync(absSnippet, cleanBytes);

      await waitForChildIdle(watcher.pid, { settleMs: 450 });
      assert.equal(watcher.stdout, banner);
      assert.equal(watcher.stderr, "");
      assert.equal(fs.existsSync(path.join(repoDir, ".liquid-regression", "result.json")), false);

      const exitInfo = await watcher.stop("SIGINT");
      assert.equal(exitInfo.code, 0);
    } finally {
      await watcher.stop("SIGKILL", 1_000);
    }
  });

  it("5b. supersedes in-flight check on settled save, suppresses superseded output/replay, and runs final snapshot", async () => {
    // Part A: Real unmodified Python+Ruby engine running 5000 pairs on a clean edit,
    // superseded mid-flight by rapid breaking edits -> only final breaking line 2 runs & prints.
    {
      const repoDir = makeTempDir("lrf-watch-supersede-real-");
      initGitRepo(repoDir);
      const snippetRel = "snippets/card-product.liquid";
      const absSnippet = path.join(repoDir, snippetRel);
      fs.mkdirSync(path.dirname(absSnippet), { recursive: true });
      const cleanBytes = fs.readFileSync(DEMO_BEFORE_PATH);
      fs.writeFileSync(absSnippet, cleanBytes);
      writeRepoConfig(repoDir, {
        snippet_path: snippetRel,
        observer: "sale_badge",
        seed: 0,
        watch_budget: { search_pairs: 5000, shrink_pairs: 32 },
      });
      const baseSha = commitAll(repoDir, "Baseline");

      const watcher = spawnWatch([], { cwd: repoDir });
      try {
        const banner = `Watching ${snippetRel} against HEAD (${baseSha.slice(0, 7)})\n`;
        await watcher.waitForStdout((s) => s.startsWith(banner));
        await waitForChildIdle(watcher.pid);

        // Start a ~1.7s 5000-pair clean check.
        fs.writeFileSync(absSnippet, Buffer.from(cleanBytes.toString("utf8") + "{#- clean edit -#}\n", "utf8"));
        await waitForCondition(
          () => getDescendants(watcher.pid).length > 0,
          { label: "in-flight 5000-pair check to start" },
        );

        // Rapid breaking edits while clean check is still running.
        const brokenLine1 = fs.readFileSync(DEMO_AFTER_PATH);
        const brokenLine2 = Buffer.from("{#- final settled -#}\n" + brokenLine1.toString("utf8"), "utf8");
        fs.writeFileSync(absSnippet, brokenLine1);
        await sleep(70);
        fs.writeFileSync(absSnippet, brokenLine2);

        await watcher.waitForStdout((s) => s.includes("snippets/card-product.liquid:2 Sale badge disappeared"));
        await waitForChildIdle(watcher.pid, { settleMs: 100 });

        assert.equal(watcher.stdout.includes(":1 Sale badge disappeared"), false);
        assert.equal(watcher.stderr, "");
        const replay = JSON.parse(
          fs.readFileSync(path.join(repoDir, ".liquid-regression", "result.json"), "utf8"),
        );
        assert.equal(replay.after_sha256, sha256Hex(brokenLine2));

        const exitInfo = await watcher.stop("SIGINT");
        assert.equal(exitInfo.code, 0);
      } finally {
        await watcher.stop("SIGKILL", 1_000);
      }
    }

    // Part B: Deterministic supersession of an in-flight BREAKING run whose finding & replay MUST be suppressed.
    {
      const repoDir = makeTempDir("lrf-watch-supersede-break-");
      initGitRepo(repoDir);
      const snippetRel = "snippets/card-product.liquid";
      const absSnippet = path.join(repoDir, snippetRel);
      fs.mkdirSync(path.dirname(absSnippet), { recursive: true });
      const cleanBytes = fs.readFileSync(DEMO_BEFORE_PATH);
      fs.writeFileSync(absSnippet, cleanBytes);
      writeRepoConfig(repoDir, {
        snippet_path: snippetRel,
        observer: "sale_badge",
        seed: 0,
        watch_budget: { search_pairs: 64, shrink_pairs: 32 },
      });
      const baseSha = commitAll(repoDir, "Baseline");

      // Wrapper delays execution by 0.8s so the first breaking run is reliably mid-flight when clean settles at 250ms.
      const helperDir = makeTempDir("lrf-delay-py-");
      const delayPy = path.join(helperDir, "delay_python.py");
      const realPy = fs.existsSync(REAL_PYTHON_311) ? REAL_PYTHON_311 : "python3";
      fs.writeFileSync(
        delayPy,
        [
          `#!${realPy}`,
          "import os, sys, time",
          "if '-m' in sys.argv:",
          "    time.sleep(0.8)",
          `os.execv(${JSON.stringify(realPy)}, [${JSON.stringify(realPy)}, *sys.argv[1:]])`,
        ].join("\n") + "\n",
        { mode: 0o755 },
      );

      const watcher = spawnWatch([], { cwd: repoDir, env: { LRF_PYTHON: delayPy } });
      try {
        const banner = `Watching ${snippetRel} against HEAD (${baseSha.slice(0, 7)})\n`;
        await watcher.waitForStdout((s) => s.startsWith(banner));
        await waitForChildIdle(watcher.pid);

        // Save breaking edit -> settles at 250ms, sleeps 800ms inside Python.
        fs.writeFileSync(absSnippet, fs.readFileSync(DEMO_AFTER_PATH));
        await waitForCondition(
          () => getDescendants(watcher.pid).length > 0,
          { label: "delayed breaking check to start" },
        );

        // Immediately save clean revert while breaking check is in-flight -> settles at +250ms (< 800ms).
        fs.writeFileSync(absSnippet, cleanBytes);
        await waitForChildIdle(watcher.pid, { settleMs: 500 });

        assert.equal(watcher.stdout, banner);
        assert.equal(watcher.stderr, "");
        assert.equal(fs.existsSync(path.join(repoDir, ".liquid-regression", "result.json")), false);

        const exitInfo = await watcher.stop("SIGINT");
        assert.equal(exitInfo.code, 0);
      } finally {
        await watcher.stop("SIGKILL", 1_000);
      }
    }
  });

  it("6. catches atomic file replacement (write temp -> fs.renameSync) cleanly", async () => {
    const repoDir = makeTempDir("lrf-watch-atomic-");
    initGitRepo(repoDir);

    const snippetRel = "snippets/card-product.liquid";
    const absSnippet = path.join(repoDir, snippetRel);
    fs.mkdirSync(path.dirname(absSnippet), { recursive: true });
    fs.writeFileSync(absSnippet, fs.readFileSync(DEMO_BEFORE_PATH));
    writeRepoConfig(repoDir, {
      snippet_path: snippetRel,
      observer: "sale_badge",
      seed: 0,
      watch_budget: { search_pairs: 64, shrink_pairs: 32 },
    });
    const baseSha = commitAll(repoDir, "Baseline");

    const watcher = spawnWatch([], { cwd: repoDir });
    try {
      const banner = `Watching ${snippetRel} against HEAD (${baseSha.slice(0, 7)})\n`;
      await watcher.waitForStdout((s) => s.startsWith(banner));
      await waitForChildIdle(watcher.pid);

      const tmpSwap = path.join(path.dirname(absSnippet), ".card-product.liquid.swap");
      const afterBytes = fs.readFileSync(DEMO_AFTER_PATH);
      fs.writeFileSync(tmpSwap, afterBytes);
      fs.renameSync(tmpSwap, absSnippet);

      await watcher.waitForStdout((s) => s.includes("snippets/card-product.liquid:1 Sale badge disappeared"));
      await waitForChildIdle(watcher.pid, { settleMs: 100 });
      assert.equal(watcher.stderr, "");

      const replay = JSON.parse(
        fs.readFileSync(path.join(repoDir, ".liquid-regression", "result.json"), "utf8"),
      );
      assert.equal(replay.after_sha256, sha256Hex(afterBytes));

      const exitInfo = await watcher.stop("SIGINT");
      assert.equal(exitInfo.code, 0);
    } finally {
      await watcher.stop("SIGKILL", 1_000);
    }
  });

  it("7. reports invalid Liquid syntax on stderr without crashing and recovers on next valid save", async () => {
    const repoDir = makeTempDir("lrf-watch-error-recover-");
    initGitRepo(repoDir);

    const snippetRel = "snippets/card-product.liquid";
    const absSnippet = path.join(repoDir, snippetRel);
    fs.mkdirSync(path.dirname(absSnippet), { recursive: true });
    fs.writeFileSync(absSnippet, fs.readFileSync(DEMO_BEFORE_PATH));
    writeRepoConfig(repoDir, {
      snippet_path: snippetRel,
      observer: "sale_badge",
      seed: 0,
      watch_budget: { search_pairs: 64, shrink_pairs: 32 },
    });
    const baseSha = commitAll(repoDir, "Baseline");

    const watcher = spawnWatch([], { cwd: repoDir });
    try {
      const banner = `Watching ${snippetRel} against HEAD (${baseSha.slice(0, 7)})\n`;
      await watcher.waitForStdout((s) => s.startsWith(banner));
      await waitForChildIdle(watcher.pid);

      fs.writeFileSync(absSnippet, "{% if broken %}\n", "utf8");
      await watcher.waitForStderr((s) => s.includes("Error [") && s.includes("snippets/card-product.liquid"));
      await waitForChildIdle(watcher.pid, { settleMs: 100 });
      assert.equal(watcher.exited, false);

      // Recover by saving a valid broken edit -> finding prints cleanly!
      fs.writeFileSync(absSnippet, fs.readFileSync(DEMO_AFTER_PATH));
      await watcher.waitForStdout((s) => s.includes("snippets/card-product.liquid:1 Sale badge disappeared"));

      // Deleting working file reports missing_working_file without crashing, and recreating recovers!
      fs.unlinkSync(absSnippet);
      await watcher.waitForStderr((s) => s.includes("Error [missing_working_file]"));
      await waitForChildIdle(watcher.pid, { settleMs: 100 });
      assert.equal(watcher.exited, false);

      const line2After = Buffer.from("{#- recreated -#}\n" + fs.readFileSync(DEMO_AFTER_PATH, "utf8"), "utf8");
      fs.writeFileSync(absSnippet, line2After);
      await watcher.waitForStdout((s) => s.includes("snippets/card-product.liquid:2 Sale badge disappeared"));

      const exitInfo = await watcher.stop("SIGINT");
      assert.equal(exitInfo.code, 0);
    } finally {
      await watcher.stop("SIGKILL", 1_000);
    }
  });

  it("8. exits 0 on SIGINT while child Python+Ruby processes are running and leaves zero lingering processes", async () => {
    const repoDir = makeTempDir("lrf-watch-sigint-ps-");
    initGitRepo(repoDir);

    const snippetRel = "snippets/card-product.liquid";
    const absSnippet = path.join(repoDir, snippetRel);
    fs.mkdirSync(path.dirname(absSnippet), { recursive: true });
    fs.writeFileSync(absSnippet, fs.readFileSync(DEMO_BEFORE_PATH));
    writeRepoConfig(repoDir, {
      snippet_path: snippetRel,
      observer: "sale_badge",
      seed: 0,
    });
    const baseSha = commitAll(repoDir, "Baseline");

    // Large search budget so Python + Ruby stay alive long enough for us to observe both PIDs and interrupt them mid-flight.
    const watcher = spawnWatch(["--search-pairs", "5000"], { cwd: repoDir });
    try {
      await watcher.waitForStdout((s) => s.startsWith(`Watching ${snippetRel} against HEAD (${baseSha.slice(0, 7)})\n`));

      let capturedTree = null;
      await waitForCondition(
        () => {
          const desc = getDescendants(watcher.pid);
          const pyProc = desc.find((p) => p.command.includes("-m search compare"));
          const rbProc = desc.find((p) => p.command.includes("reference/bin/worker"));
          if (pyProc && rbProc) {
            capturedTree = { pyPid: pyProc.pid, rbPid: rbProc.pid };
            return true;
          }
          return false;
        },
        { timeoutMs: 8_000, pollMs: 25, label: "Python search and Ruby worker processes to spawn" },
      );

      const exitInfo = await watcher.stop("SIGINT", 5_000);
      assert.equal(exitInfo.code, 0);
      assert.equal(exitInfo.signal, null);

      const remaining = listProcesses();
      const pids = new Set(remaining.map((p) => p.pid));
      assert.equal(pids.has(watcher.pid), false, "Watcher process should have exited");
      assert.equal(pids.has(capturedTree.pyPid), false, `Python process ${capturedTree.pyPid} leaked after SIGINT`);
      assert.equal(pids.has(capturedTree.rbPid), false, `Ruby worker process ${capturedTree.rbPid} leaked after SIGINT`);
    } finally {
      await watcher.stop("SIGKILL", 1_000);
    }

    // Also verify SIGTERM while idle exits cleanly with code 0.
    const idleWatcher = spawnWatch([], { cwd: repoDir });
    try {
      await idleWatcher.waitForStdout((s) => s.startsWith(`Watching ${snippetRel} against HEAD (`));
      await waitForChildIdle(idleWatcher.pid);
      const termInfo = await idleWatcher.stop("SIGTERM", 5_000);
      assert.equal(termInfo.code, 0);
      assert.equal(termInfo.signal, null);
    } finally {
      await idleWatcher.stop("SIGKILL", 1_000);
    }
  });

  it("honors default watch budget (32/16), config watch_budget override, and CLI --search-pairs / --shrink-pairs / --base-ref / --config / --replay-out overrides", async () => {
    // A. Default watch budget = 32 / 16 (4-variant-only Phase 2 edit stays quiet under 32 pairs, while 2-variant demo bug confirms within default 32/16 in replay)
    {
      const repoDir = makeTempDir("lrf-watch-default-budget-");
      initGitRepo(repoDir);
      const snippetRel = "snippets/card-product.liquid";
      const absSnippet = path.join(repoDir, snippetRel);
      fs.mkdirSync(path.dirname(absSnippet), { recursive: true });
      fs.writeFileSync(absSnippet, fs.readFileSync(DEMO_BEFORE_PATH));
      writeRepoConfig(repoDir, {
        snippet_path: snippetRel,
        observer: "sale_badge",
        seed: 0,
        budget: { search_pairs: 256, shrink_pairs: 128 },
      });
      const baseSha = commitAll(repoDir, "Baseline");

      const watcher = spawnWatch([], { cwd: repoDir });
      try {
        const banner = `Watching ${snippetRel} against HEAD (${baseSha.slice(0, 7)})\n`;
        await watcher.waitForStdout((s) => s.startsWith(banner));
        await waitForChildIdle(watcher.pid);

        // Save 4-variant-only edit (Phase 1 only tests 1..3 variants, so Phase 2 4-variant trigger is outside default 32-pair watch budget).
        const fourVariantEdit = [
          '{%- if product.variants.size >= 4 -%}',
          '<span class="badge" data-regression-badge="sale">Bulk Sale</span>',
          '{%- else -%}',
          fs.readFileSync(DEMO_BEFORE_PATH, "utf8").trimEnd(),
          '{%- endif -%}',
          "",
        ].join("\n");
        fs.writeFileSync(absSnippet, fourVariantEdit, "utf8");
        await waitForChildIdle(watcher.pid, { settleMs: 400 });
        assert.equal(watcher.stdout, banner);

        // Save 2-variant demo bug -> confirms directly within default 32/16 watch budget!
        fs.writeFileSync(absSnippet, fs.readFileSync(DEMO_AFTER_PATH));
        await watcher.waitForStdout((s) => s.includes("Sale badge disappeared"));
        await waitForChildIdle(watcher.pid, { settleMs: 100 });

        const replay = JSON.parse(
          fs.readFileSync(path.join(repoDir, ".liquid-regression", "result.json"), "utf8"),
        );
        assert.deepEqual(replay.request.budget, { search_pairs: 32, shrink_pairs: 16 });

        const exitInfo = await watcher.stop("SIGINT");
        assert.equal(exitInfo.code, 0);
      } finally {
        await watcher.stop("SIGKILL", 1_000);
      }
    }

    // B. Config watch_budget vs CLI --search-pairs / --shrink-pairs / --base-ref / --config / --replay-out overrides
    {
      const repoDir = makeTempDir("lrf-watch-overrides-");
      initGitRepo(repoDir);
      const snippetRel = "snippets/card.liquid";
      const absSnippet = path.join(repoDir, snippetRel);
      fs.mkdirSync(path.dirname(absSnippet), { recursive: true });
      const v1Bytes = fs.readFileSync(DEMO_BEFORE_PATH);
      fs.writeFileSync(absSnippet, v1Bytes);
      const baseSha = commitAll(repoDir, "v1 baseline");
      runGit(repoDir, ["tag", "v1-tag"]);

      // Commit a different HEAD to prove --base-ref v1-tag pins to v1-tag, not HEAD.
      fs.writeFileSync(absSnippet, fs.readFileSync(DEMO_AFTER_PATH));
      commitAll(repoDir, "v2 broken on HEAD");

      const customCfg = path.join(repoDir, "custom-watch.json");
      fs.writeFileSync(
        customCfg,
        JSON.stringify(
          {
            schema_version: 1,
            snippet_path: snippetRel,
            observer: "sale_badge",
            seed: 2,
            budget: { search_pairs: 256, shrink_pairs: 128 },
            watch_budget: { search_pairs: 60, shrink_pairs: 20 },
          },
          null,
          2,
        ) + "\n",
        "utf8",
      );

      const watcher = spawnWatch(
        [
          "--base-ref",
          "v1-tag",
          "--config",
          "custom-watch.json",
          "--seed",
          "1",
          "--search-pairs",
          "70",
          "--shrink-pairs",
          "30",
          "--replay-out",
          "out/watch-replay.json",
        ],
        { cwd: repoDir },
      );

      try {
        const expectedBanner = `Watching ${snippetRel} against v1-tag (${baseSha.slice(0, 7)})\n`;
        await watcher.waitForStdout((s) => s.startsWith(expectedBanner));
        await watcher.waitForStdout((s) => s.includes("Replay in out/watch-replay.json."));
        await waitForChildIdle(watcher.pid, { settleMs: 100 });

        const replayFile = path.join(repoDir, "out", "watch-replay.json");
        assert.equal(fs.existsSync(replayFile), true);
        const replayRaw = fs.readFileSync(replayFile, "utf8");
        const replayObj = JSON.parse(replayRaw);
        assert.equal(replayRaw, canonicalJson(replayObj));
        assert.equal(replayObj.before_sha256, sha256Hex(v1Bytes));
        assert.equal(replayObj.request.seed, 1);
        assert.deepEqual(replayObj.request.budget, { search_pairs: 70, shrink_pairs: 30 });

        const exitInfo = await watcher.stop("SIGINT");
        assert.equal(exitInfo.code, 0);
      } finally {
        await watcher.stop("SIGKILL", 1_000);
      }
    }
  });
});

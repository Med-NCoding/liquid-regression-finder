import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { canonicalJson, formatCompareFinding } from "../lib/format.mjs";

const execFileAsync = promisify(execFile);

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TESTS_DIR, "../..");
const CLI_BIN = path.join(REPO_ROOT, "cli", "bin", "liquid-regression-finder.js");
const DEMO_BEFORE_PATH = path.join(REPO_ROOT, "fixtures", "demo", "before.liquid");
const DEMO_AFTER_PATH = path.join(REPO_ROOT, "fixtures", "demo", "after.liquid");
const CARD_PRODUCT_PATH = path.join(REPO_ROOT, "snippets", "card-product.liquid");

const TEMP_ROOTS = [];

function makeTempDir(prefix = "lrf-cli-test-") {
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

async function runCliBin(args, { cwd, env = {} } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI_BIN, ...args], {
      cwd,
      env: { ...process.env, ...env },
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

function resolveBundleExecutable() {
  const hb = "/opt/homebrew/opt/ruby@3.3/bin/bundle";
  if (fs.existsSync(hb)) return hb;
  return "bundle";
}

after(() => {
  for (const dir of TEMP_ROOTS) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("Migration Stage 1: CLI check and replay", () => {
  it("uses only Node built-in modules inside cli/", () => {
    const cliDir = path.join(REPO_ROOT, "cli");
    assert.equal(fs.existsSync(path.join(cliDir, "node_modules")), false);
    assert.equal(fs.existsSync(path.join(cliDir, "package.json")), false);

    const files = [];
    function walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".js") || entry.name.endsWith(".mjs")) files.push(full);
      }
    }
    walk(cliDir);
    assert.ok(files.length >= 7);

    const importRe = /(?:from\s+["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\))/g;
    for (const file of files) {
      const text = fs.readFileSync(file, "utf8");
      for (const match of text.matchAll(importRe)) {
        const spec = match[1] || match[2];
        assert.ok(
          spec.startsWith("node:") || spec.startsWith("./") || spec.startsWith("../"),
          `Disallowed non-builtin import '${spec}' in ${file}`,
        );
      }
    }
  });

  it("1. returns exit 0 for unchanged snippets/card-product.liquid vs HEAD", async () => {
    const res = await runCliBin(["check"], { cwd: REPO_ROOT });
    assert.equal(res.code, 0, `Unexpected stderr: ${res.stderr}`);
    assert.equal(res.stdout, "");
    assert.equal(res.stderr, "");
  });

  it("2. detects known badge disappearance, emits exact 4-line finding, and writes canonical replay", async () => {
    const repoDir = makeTempDir("lrf-known-change-");
    initGitRepo(repoDir);

    const snippetRel = "snippets/card-product.liquid";
    const absSnippet = path.join(repoDir, snippetRel);
    fs.mkdirSync(path.dirname(absSnippet), { recursive: true });
    const beforeBytes = fs.readFileSync(CARD_PRODUCT_PATH);
    fs.writeFileSync(absSnippet, beforeBytes);

    writeRepoConfig(repoDir, {
      snippet_path: snippetRel,
      observer: "sale_badge",
      seed: 0,
      budget: { search_pairs: 256, shrink_pairs: 128 },
    });
    commitAll(repoDir, "Baseline variant-loop card-product");

    // Replace working tree file with product-level compare_at_price > price (line 1).
    const afterBytes = fs.readFileSync(DEMO_AFTER_PATH);
    fs.writeFileSync(absSnippet, afterBytes);

    const res = await runCliBin(["check"], { cwd: repoDir });
    assert.equal(res.code, 1, `Expected exit 1, got ${res.code}; stderr=${res.stderr}`);
    assert.equal(res.stderr, "");

    const expectedOutput = [
      "snippets/card-product.liquid:1 Sale badge disappeared",
      "Before: v2 compared 1c > 0c, true. Badge shown.",
      "After:  product compared 0c > 0c, false. Badge absent.",
      "Official Liquid confirmed. Replay in .liquid-regression/result.json.",
    ].join("\n") + "\n";
    assert.equal(res.stdout, expectedOutput);

    const replayFile = path.join(repoDir, ".liquid-regression", "result.json");
    assert.equal(fs.existsSync(replayFile), true);

    const replayRaw = fs.readFileSync(replayFile, "utf8");
    const replayObj = JSON.parse(replayRaw);
    assert.equal(replayRaw, canonicalJson(replayObj));
    assert.equal(replayObj.before_sha256, sha256Hex(beforeBytes));
    assert.equal(replayObj.after_sha256, sha256Hex(afterBytes));
    assert.equal(replayObj.liquid_version, "5.14.0");

    // Validate generated replay file against ReplayBundle contract schema using Ruby JSONSchemer.
    execFileSync(
      resolveBundleExecutable(),
      [
        "exec",
        "ruby",
        path.join(REPO_ROOT, "search", "tests", "validate_stage5_schemas.rb"),
        "--replay-bundle",
        replayFile,
      ],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          BUNDLE_GEMFILE: path.join(REPO_ROOT, "engine", "Gemfile"),
        },
        encoding: "utf8",
      },
    );
  });

  it("formats non-comparison truthiness branches and after_only appearance cleanly", () => {
    const fakeReport = {
      finding: {
        before: {
          observed: false,
          events: [
            {
              seq: 0,
              node_id: "n0:conditional.a0.cond:lookup",
              scope: [],
              span: { start_byte: 6, end_byte: 23, line: 1, column: 7 },
              data: { kind: "lookup", path: "product.available", found: true, value: false },
            },
            {
              seq: 1,
              node_id: "n0:conditional.a0:branch",
              scope: [],
              span: { start_byte: 0, end_byte: 27, line: 1, column: 1 },
              data: { kind: "branch", expression: "product.available", condition: false, taken: false },
            },
          ],
        },
        after: {
          observed: true,
          events: [
            {
              seq: 0,
              node_id: "n0:conditional.a0.cond:lookup",
              scope: [],
              span: { start_byte: 6, end_byte: 23, line: 2, column: 7 },
              data: { kind: "lookup", path: "product.available", found: true, value: true },
            },
            {
              seq: 1,
              node_id: "n0:conditional.a0:branch",
              scope: [],
              span: { start_byte: 0, end_byte: 27, line: 2, column: 1 },
              data: { kind: "branch", expression: "product.available", condition: true, taken: true },
            },
          ],
        },
        explanation: {
          kind: "aligned_change",
          before: { line: 1, event_seq: 1 },
          after: { line: 2, event_seq: 1 },
        },
      },
    };
    const formatted = formatCompareFinding(fakeReport, {
      snippetPath: "snippets/card.liquid",
      replayRelPath: ".liquid-regression/result.json",
    });
    assert.equal(
      formatted,
      [
        "snippets/card.liquid:2 Sale badge appeared",
        "Before: product evaluated product.available, false. Badge absent.",
        "After:  product evaluated product.available, true. Badge shown.",
        "Official Liquid confirmed. Replay in .liquid-regression/result.json.",
      ].join("\n"),
    );
  });

  it("3. compares two committed Git blobs with --base-ref and --head-ref", async () => {
    const repoDir = makeTempDir("lrf-head-ref-");
    initGitRepo(repoDir);

    const snippetRel = "snippets/card-product.liquid";
    const absSnippet = path.join(repoDir, snippetRel);
    fs.mkdirSync(path.dirname(absSnippet), { recursive: true });
    writeRepoConfig(repoDir, {
      snippet_path: snippetRel,
      observer: "sale_badge",
      seed: 0,
      budget: { search_pairs: 256, shrink_pairs: 128 },
    });

    fs.writeFileSync(absSnippet, fs.readFileSync(DEMO_BEFORE_PATH));
    const baseSha = commitAll(repoDir, "Commit 1: variant loop");

    fs.writeFileSync(absSnippet, fs.readFileSync(DEMO_AFTER_PATH));
    const headSha = commitAll(repoDir, "Commit 2: aggregate check");

    // Restore working tree back to before so we prove --head-ref reads the committed blob, not working tree.
    fs.writeFileSync(absSnippet, fs.readFileSync(DEMO_BEFORE_PATH));

    const res = await runCliBin(
      ["check", "--base-ref", baseSha, "--head-ref", headSha],
      { cwd: repoDir },
    );
    assert.equal(res.code, 1, `stderr=${res.stderr}`);
    assert.ok(res.stdout.startsWith("snippets/card-product.liquid:1 Sale badge disappeared\n"));
    assert.ok(res.stdout.includes("Before: v2 compared 1c > 0c, true. Badge shown."));
    assert.ok(res.stdout.includes("After:  product compared 0c > 0c, false. Badge absent."));

    // Comparing identical committed blobs returns exit 0.
    const sameRes = await runCliBin(
      ["check", "--base-ref", baseSha, "--head-ref", baseSha],
      { cwd: repoDir },
    );
    assert.equal(sameRes.code, 0, `stderr=${sameRes.stderr}`);
  });

  it("4. supports repo directory paths AND snippet paths containing spaces", async () => {
    const parentDir = makeTempDir("lrf-spaces-");
    const repoDir = path.join(parentDir, "my theme repo");
    initGitRepo(repoDir);

    const snippetRel = "snippets/card product.liquid";
    const absSnippet = path.join(repoDir, snippetRel);
    fs.mkdirSync(path.dirname(absSnippet), { recursive: true });
    fs.writeFileSync(absSnippet, fs.readFileSync(DEMO_BEFORE_PATH));

    writeRepoConfig(repoDir, {
      snippet_path: snippetRel,
      observer: "sale_badge",
      seed: 0,
      budget: { search_pairs: 256, shrink_pairs: 128 },
    });
    commitAll(repoDir, "Initial commit in space path");

    // Unchanged check -> exit 0
    const okRes = await runCliBin(["check"], { cwd: repoDir });
    assert.equal(okRes.code, 0, `stderr=${okRes.stderr}`);

    // Regressed working tree -> exit 1
    fs.writeFileSync(absSnippet, fs.readFileSync(DEMO_AFTER_PATH));
    const diffRes = await runCliBin(["check"], { cwd: repoDir });
    assert.equal(diffRes.code, 1, `stderr=${diffRes.stderr}`);
    assert.ok(diffRes.stdout.startsWith("snippets/card product.liquid:1 Sale badge disappeared\n"));

    // Replay inside repo with spaces -> exit 0
    const replayRes = await runCliBin(["replay", ".liquid-regression/result.json"], { cwd: repoDir });
    assert.equal(replayRes.code, 0, `stderr=${replayRes.stderr}`);
    assert.ok(replayRes.stdout.includes("Official Liquid 5.14.0 parity confirmed"));
  });

  it("5. exits 2 with actionable messages for missing blobs, missing working files, path escapes, invalid configs, and unsupported Liquid", async () => {
    // 5a. Missing baseline blob (names ref, short SHA, and snippet path)
    {
      const repoDir = makeTempDir("lrf-missing-blob-");
      initGitRepo(repoDir);
      fs.writeFileSync(path.join(repoDir, "README.md"), "init\n", "utf8");
      const sha = commitAll(repoDir, "Empty repo");
      const shortSha = sha.slice(0, 7);

      const snippetRel = "snippets/card-product.liquid";
      fs.mkdirSync(path.join(repoDir, "snippets"), { recursive: true });
      fs.writeFileSync(path.join(repoDir, snippetRel), fs.readFileSync(DEMO_AFTER_PATH));
      writeRepoConfig(repoDir, { snippet_path: snippetRel });

      const res = await runCliBin(["check", "--base-ref", "HEAD"], { cwd: repoDir });
      assert.equal(res.code, 2);
      assert.equal(res.stdout, "");
      assert.ok(res.stderr.includes("HEAD"), `stderr missing ref: ${res.stderr}`);
      assert.ok(res.stderr.includes(shortSha), `stderr missing short sha: ${res.stderr}`);
      assert.ok(res.stderr.includes(snippetRel), `stderr missing snippet_path: ${res.stderr}`);
    }

    // 5b. Missing working file
    {
      const repoDir = makeTempDir("lrf-missing-work-");
      initGitRepo(repoDir);
      const snippetRel = "snippets/card-product.liquid";
      fs.mkdirSync(path.join(repoDir, "snippets"), { recursive: true });
      fs.writeFileSync(path.join(repoDir, snippetRel), fs.readFileSync(DEMO_BEFORE_PATH));
      writeRepoConfig(repoDir, { snippet_path: snippetRel });
      commitAll(repoDir, "Add snippet");
      fs.unlinkSync(path.join(repoDir, snippetRel));

      const res = await runCliBin(["check"], { cwd: repoDir });
      assert.equal(res.code, 2);
      assert.ok(res.stderr.includes("snippets/card-product.liquid"), res.stderr);
    }

    // 5c. Symlink escaping Git root
    {
      const outsideDir = makeTempDir("lrf-outside-");
      const outsideFile = path.join(outsideDir, "secret.liquid");
      fs.writeFileSync(outsideFile, "<span>outside</span>", "utf8");

      const repoDir = makeTempDir("lrf-symlink-");
      initGitRepo(repoDir);
      fs.mkdirSync(path.join(repoDir, "snippets"), { recursive: true });
      fs.symlinkSync(outsideFile, path.join(repoDir, "snippets", "escape.liquid"));
      writeRepoConfig(repoDir, { snippet_path: "snippets/escape.liquid" });
      commitAll(repoDir, "Add symlink");

      const res = await runCliBin(["check"], { cwd: repoDir });
      assert.equal(res.code, 2);
      assert.ok(res.stderr.includes("outside the Git root"), res.stderr);
    }

    // 5d. `..` traversal, absolute path, and directory path in config
    {
      const repoDir = makeTempDir("lrf-bad-paths-");
      initGitRepo(repoDir);
      fs.mkdirSync(path.join(repoDir, "snippets"), { recursive: true });
      fs.writeFileSync(path.join(repoDir, "snippets", "a.liquid"), "ok", "utf8");
      commitAll(repoDir, "Init");

      for (const badSnippet of ["../outside.liquid", "snippets/../../escape.liquid", "/etc/passwd", "snippets", "snippets/"]) {
        writeRepoConfig(repoDir, { snippet_path: badSnippet });
        const res = await runCliBin(["check"], { cwd: repoDir });
        assert.equal(res.code, 2, `Expected exit 2 for snippet_path=${badSnippet}`);
        assert.ok(res.stderr.length > 0);
      }
    }

    // 5e. Invalid JSON, unknown config key, non-UTF-8 config, and missing config
    {
      const repoDir = makeTempDir("lrf-bad-cfg-");
      initGitRepo(repoDir);
      fs.writeFileSync(path.join(repoDir, "README.md"), "init\n", "utf8");
      commitAll(repoDir, "Init");

      // Missing config
      const missingRes = await runCliBin(["check"], { cwd: repoDir });
      assert.equal(missingRes.code, 2);
      assert.ok(missingRes.stderr.includes("Config file not found"), missingRes.stderr);

      // Invalid JSON
      fs.writeFileSync(path.join(repoDir, "liquid-regression.json"), "{broken-json", "utf8");
      const jsonRes = await runCliBin(["check"], { cwd: repoDir });
      assert.equal(jsonRes.code, 2);
      assert.ok(jsonRes.stderr.includes("invalid JSON"), jsonRes.stderr);

      // Non-UTF-8 bytes
      fs.writeFileSync(path.join(repoDir, "liquid-regression.json"), Buffer.from([0xff, 0xfe, 0x7b, 0x7d]));
      const utf8Res = await runCliBin(["check"], { cwd: repoDir });
      assert.equal(utf8Res.code, 2);
      assert.ok(utf8Res.stderr.includes("UTF-8"), utf8Res.stderr);

      // Unknown key
      writeRepoConfig(repoDir, { snippet_path: "README.md", unexpected_key: true });
      const unknownRes = await runCliBin(["check"], { cwd: repoDir });
      assert.equal(unknownRes.code, 2);
      assert.ok(unknownRes.stderr.includes("unexpected_key"), unknownRes.stderr);
    }

    // 5f. Unsupported Liquid (`{% include 'x' %}`)
    {
      const repoDir = makeTempDir("lrf-unsupported-");
      initGitRepo(repoDir);
      const snippetRel = "snippets/card-product.liquid";
      fs.mkdirSync(path.join(repoDir, "snippets"), { recursive: true });
      fs.writeFileSync(path.join(repoDir, snippetRel), fs.readFileSync(DEMO_BEFORE_PATH));
      writeRepoConfig(repoDir, { snippet_path: snippetRel });
      commitAll(repoDir, "Add valid snippet");

      fs.writeFileSync(path.join(repoDir, snippetRel), "{% include 'x' %}\n", "utf8");
      const res = await runCliBin(["check"], { cwd: repoDir });
      assert.equal(res.code, 2);
      assert.ok(res.stderr.includes("unsupported_tag"), res.stderr);
      assert.ok(res.stderr.includes("include"), res.stderr);
    }

    // 5g. Invalid `watch` and `setup` flags return exit 2 (`invalid_args`)
    {
      const watchErrRes = await runCliBin(["watch", "--unknown-flag"], { cwd: REPO_ROOT });
      assert.equal(watchErrRes.code, 2);
      assert.ok(watchErrRes.stderr.includes("invalid_args"), watchErrRes.stderr);

      const setupErrRes = await runCliBin(["setup", "--unknown-flag"], { cwd: REPO_ROOT });
      assert.equal(setupErrRes.code, 2);
      assert.ok(setupErrRes.stderr.includes("invalid_args"), setupErrRes.stderr);
    }
  });

  it("6. replays saved .liquid-regression/result.json cleanly (exit 0) and rejects tampered bundles (exit 2)", async () => {
    const repoDir = makeTempDir("lrf-replay-");
    initGitRepo(repoDir);

    const snippetRel = "snippets/card-product.liquid";
    const absSnippet = path.join(repoDir, snippetRel);
    fs.mkdirSync(path.dirname(absSnippet), { recursive: true });
    fs.writeFileSync(absSnippet, fs.readFileSync(DEMO_BEFORE_PATH));
    writeRepoConfig(repoDir, { snippet_path: snippetRel });
    commitAll(repoDir, "Baseline");

    fs.writeFileSync(absSnippet, fs.readFileSync(DEMO_AFTER_PATH));
    const checkRes = await runCliBin(["check"], { cwd: repoDir });
    assert.equal(checkRes.code, 1, checkRes.stderr);

    // Positional replay
    const repPos = await runCliBin(["replay", ".liquid-regression/result.json"], { cwd: repoDir });
    assert.equal(repPos.code, 0, repPos.stderr);
    assert.equal(repPos.stderr, "");
    assert.ok(repPos.stdout.includes("Before: v2 compared 1c > 0c, true. Badge shown."));
    assert.ok(repPos.stdout.includes("After:  product compared 0c > 0c, false. Badge absent."));
    assert.ok(repPos.stdout.includes("Official Liquid 5.14.0 parity confirmed"));

    // --bundle replay
    const repFlag = await runCliBin(["replay", "--bundle", ".liquid-regression/result.json"], { cwd: repoDir });
    assert.equal(repFlag.code, 0, repFlag.stderr);
    assert.equal(repFlag.stdout, repPos.stdout);

    // Tampered hash -> exit 2
    const replayPath = path.join(repoDir, ".liquid-regression", "result.json");
    const tampered = JSON.parse(fs.readFileSync(replayPath, "utf8"));
    tampered.before_sha256 = "0".repeat(64);
    const tamperedPath = path.join(repoDir, ".liquid-regression", "tampered.json");
    fs.writeFileSync(tamperedPath, canonicalJson(tampered), "utf8");

    const repTampered = await runCliBin(["replay", tamperedPath], { cwd: repoDir });
    assert.equal(repTampered.code, 2);
    assert.ok(repTampered.stderr.includes("replay_hash_mismatch"), repTampered.stderr);

    // Missing replay file -> exit 2
    const repMissing = await runCliBin(["replay", ".liquid-regression/does-not-exist.json"], { cwd: repoDir });
    assert.equal(repMissing.code, 2);
    assert.ok(repMissing.stderr.includes("bundle_read_error"), repMissing.stderr);
  });

  it("7. emits valid structured JSON with --json for check (difference_found / no_difference_found / error) and replay", async () => {
    const repoDir = makeTempDir("lrf-json-");
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
    commitAll(repoDir, "Baseline");

    // no_difference_found --json
    const negRes = await runCliBin(["check", "--search-pairs", "16", "--json"], { cwd: repoDir });
    assert.equal(negRes.code, 0, negRes.stderr);
    const negJson = JSON.parse(negRes.stdout);
    assert.equal(negJson.status, "no_difference_found");
    assert.equal(negJson.stats.search_pairs, 16);
    assert.equal(negJson.finding, null);

    // difference_found --json (also writes custom --replay-out)
    fs.writeFileSync(absSnippet, fs.readFileSync(DEMO_AFTER_PATH));
    const customReplay = path.join(repoDir, "custom", "out.json");
    const posRes = await runCliBin(
      ["check", "--replay-out", "custom/out.json", "--json"],
      { cwd: repoDir },
    );
    assert.equal(posRes.code, 1, posRes.stderr);
    const posJson = JSON.parse(posRes.stdout);
    assert.equal(posJson.status, "difference_found");
    assert.equal(posJson.reference_status, "confirmed");
    assert.equal(posJson.finding.explanation.kind, "structural_change");
    assert.equal(fs.existsSync(customReplay), true);

    // replay --json
    const repRes = await runCliBin(["replay", "custom/out.json", "--json"], { cwd: repoDir });
    assert.equal(repRes.code, 0, repRes.stderr);
    const repJson = JSON.parse(repRes.stdout);
    assert.equal(repJson.status, "replayed");
    assert.equal(repJson.reference_status, "confirmed");
    assert.deepEqual(repJson.finding, posJson.finding);

    // error --json (missing baseline file / unknown option / bad config)
    fs.writeFileSync(absSnippet, "{% include 'x' %}\n", "utf8");
    const errRes = await runCliBin(["check", "--json"], { cwd: repoDir });
    assert.equal(errRes.code, 2);
    const errJson = JSON.parse(errRes.stdout);
    assert.equal(errJson.status, "failed");
    assert.equal(errJson.error.code, "unsupported_tag");
  });

  it("executes directly via executable shebang, honors --config/watch_budget/base_ref, and preserves raw CRLF bytes", async () => {
    const repoDir = makeTempDir("lrf-shebang-raw-");
    initGitRepo(repoDir);

    const snippetRel = "snippets/card.liquid";
    const absSnippet = path.join(repoDir, snippetRel);
    fs.mkdirSync(path.dirname(absSnippet), { recursive: true });

    const beforeRaw = Buffer.from(
      fs.readFileSync(DEMO_BEFORE_PATH, "utf8").replace(/\n/g, "\r\n") + "   \r\n",
      "utf8",
    );
    const afterRaw = Buffer.from(
      fs.readFileSync(DEMO_AFTER_PATH, "utf8").replace(/\n/g, "\r\n") + "\t \r\n",
      "utf8",
    );

    fs.writeFileSync(absSnippet, beforeRaw);
    commitAll(repoDir, "Baseline CRLF");
    runGit(repoDir, ["tag", "v-baseline"]);

    // Make a dummy second commit so --base-ref / config base_ref points back to v-baseline
    fs.writeFileSync(path.join(repoDir, "other.txt"), "x\n", "utf8");
    commitAll(repoDir, "Second commit");

    const customCfgPath = path.join(repoDir, "custom-lrf.json");
    fs.writeFileSync(
      customCfgPath,
      JSON.stringify(
        {
          schema_version: 1,
          snippet_path: snippetRel,
          observer: "sale_badge",
          seed: 0,
          budget: { search_pairs: 256, shrink_pairs: 128 },
          watch_budget: { search_pairs: 32, shrink_pairs: 16 },
          base_ref: "v-baseline",
          replay_path: ".liquid-regression/custom-result.json",
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    fs.writeFileSync(absSnippet, afterRaw);

    let shebangCode = 0;
    let shebangOut = "";
    let shebangErr = "";
    try {
      const out = await execFileAsync(CLI_BIN, ["check", "--config", "custom-lrf.json"], {
        cwd: repoDir,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      });
      shebangOut = out.stdout;
      shebangErr = out.stderr;
    } catch (err) {
      shebangCode = typeof err.code === "number" ? err.code : 2;
      shebangOut = err.stdout || "";
      shebangErr = err.stderr || "";
    }

    assert.equal(shebangCode, 1, `stderr=${shebangErr}`);
    assert.ok(shebangOut.includes("Replay in .liquid-regression/custom-result.json."));

    const savedReplay = JSON.parse(
      fs.readFileSync(path.join(repoDir, ".liquid-regression", "custom-result.json"), "utf8"),
    );
    assert.equal(savedReplay.before_sha256, sha256Hex(beforeRaw));
    assert.equal(savedReplay.after_sha256, sha256Hex(afterRaw));
  });
});

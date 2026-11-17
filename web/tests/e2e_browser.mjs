import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(WEB_ROOT, "..");
const API_ROOT = path.join(REPO_ROOT, "api");
const ARTIFACTS_DIR = path.join(REPO_ROOT, "artifacts", "stage-9");
const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

function resolveExecutable(candidates, name) {
  for (const cand of candidates) {
    if (fs.existsSync(cand)) return cand;
  }
  const which = spawnSync("which", [name], { encoding: "utf8" });
  if (which.status === 0 && which.stdout.trim()) {
    return which.stdout.trim();
  }
  throw new Error(`Unable to locate ${name} executable`);
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.setTimeout(3000, () => {
      req.destroy(new Error(`HTTP GET timeout for ${url}`));
    });
  });
}

async function waitForUrl(url, child, logPath, checkFn, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      const tail = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8").slice(-2000) : "";
      throw new Error(`Process exited early (code=${child.exitCode}) waiting for ${url}:\n${tail}`);
    }
    try {
      const res = await httpGet(url);
      if (checkFn(res)) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  const tail = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8").slice(-2000) : "";
  throw new Error(`Timed out waiting for ${url}:\n${tail}`);
}

async function stopProcessGroup(child, label) {
  if (!child || !child.pid || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // already exited
  }
  console.warn(`[stage-9 e2e] Force-killed ${label} (pid=${child.pid})`);
}

function runCommandSync(cmd, args, opts) {
  const res = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (res.status !== 0) {
    throw new Error(`Command failed (${res.status}): ${cmd} ${args.join(" ")}`);
  }
}

async function main() {
  if (!fs.existsSync(CHROME_PATH)) {
    throw new Error(`Headless Chrome executable not found at ${CHROME_PATH}`);
  }

  const bundleBin = resolveExecutable(["/opt/homebrew/opt/ruby@3.3/bin/bundle"], "bundle");
  const nodeBin = resolveExecutable(["/usr/local/bin/node"], "node");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lrf-stage9-e2e-"));
  const dbPath = path.join(tmpDir, "e2e_production.sqlite3");
  const serverLog = path.join(tmpDir, "rails_server.log");
  const workerLog = path.join(tmpDir, "solid_queue_worker.log");
  const viteLog = path.join(tmpDir, "vite_server.log");
  const pidfile = path.join(tmpDir, "puma.pid");

  const rubyBinDir = "/opt/homebrew/opt/ruby@3.3/bin";
  const pythonBinDir = "/opt/homebrew/opt/python@3.11/bin";
  const nodeBinDir = path.dirname(nodeBin);
  const pathParts = [rubyBinDir, pythonBinDir, nodeBinDir, process.env.PATH || ""].filter(Boolean);

  const apiEnv = {
    ...process.env,
    PATH: pathParts.join(path.delimiter),
    RAILS_ENV: "production",
    LIQUID_REGRESSION_DB_PATH: dbPath,
    LIQUID_REGRESSION_REPO_ROOT: REPO_ROOT,
    RAILS_FORCE_SSL: "false",
    SOLID_QUEUE_SKIP_RECURRING: "true",
    JOB_CONCURRENCY: "1",
  };
  delete apiEnv.BUNDLE_GEMFILE;
  delete apiEnv.BUNDLE_BIN_PATH;
  delete apiEnv.RUBYOPT;

  let workerProc = null;
  let serverProc = null;
  let viteProc = null;
  let browser = null;

  try {
    fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });

    console.log(`[stage-9 e2e] Migrating isolated SQLite DB at ${dbPath}...`);
    runCommandSync(bundleBin, ["exec", "bin/rails", "db:migrate"], {
      cwd: API_ROOT,
      env: apiEnv,
    });

    const apiPort = await getFreePort();
    const webPort = await getFreePort();

    console.log(`[stage-9 e2e] Starting Solid Queue worker and Rails Puma on 127.0.0.1:${apiPort}...`);
    const workerOut = fs.openSync(workerLog, "w");
    workerProc = spawn(bundleBin, ["exec", "bin/jobs"], {
      cwd: API_ROOT,
      env: apiEnv,
      detached: true,
      stdio: ["ignore", workerOut, workerOut],
    });
    fs.closeSync(workerOut);

    const serverOut = fs.openSync(serverLog, "w");
    serverProc = spawn(
      bundleBin,
      ["exec", "bin/rails", "server", "-b", "127.0.0.1", "-p", String(apiPort), "-P", pidfile],
      {
        cwd: API_ROOT,
        env: apiEnv,
        detached: true,
        stdio: ["ignore", serverOut, serverOut],
      },
    );
    fs.closeSync(serverOut);

    await waitForUrl(
      `http://127.0.0.1:${apiPort}/api/v1/health`,
      serverProc,
      serverLog,
      (res) => res.status === 200 && res.body.includes('"ok"'),
    );

    console.log(`[stage-9 e2e] Starting Vite dev server on 127.0.0.1:${webPort} proxying /api -> 127.0.0.1:${apiPort}...`);
    const viteOut = fs.openSync(viteLog, "w");
    viteProc = spawn(
      nodeBin,
      [path.join(WEB_ROOT, "node_modules/vite/bin/vite.js"), "--host", "127.0.0.1", "--port", String(webPort), "--strictPort"],
      {
        cwd: WEB_ROOT,
        env: {
          ...process.env,
          PATH: pathParts.join(path.delimiter),
          VITE_API_ORIGIN: `http://127.0.0.1:${apiPort}`,
        },
        detached: true,
        stdio: ["ignore", viteOut, viteOut],
      },
    );
    fs.closeSync(viteOut);

    await waitForUrl(
      `http://127.0.0.1:${webPort}/`,
      viteProc,
      viteLog,
      (res) => res.status === 200 && res.body.includes("<div id=\"root\">"),
    );

    await waitForUrl(
      `http://127.0.0.1:${webPort}/api/v1/health`,
      viteProc,
      viteLog,
      (res) => res.status === 200 && res.body.includes('"ok"'),
    );

    console.log("[stage-9 e2e] Launching headless Chrome via playwright-core...");
    browser = await chromium.launch({
      executablePath: CHROME_PATH,
      headless: true,
      args: ["--no-sandbox", "--disable-gpu"],
    });

    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      acceptDownloads: true,
    });
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));

    // 1. Submit demo snippets from /
    const baseUrl = `http://127.0.0.1:${webPort}`;
    await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Load Demo Snippets" }).click();

    const expectedBefore = fs.readFileSync(path.join(REPO_ROOT, "fixtures/demo/before.liquid"), "utf8");
    const expectedAfter = fs.readFileSync(path.join(REPO_ROOT, "fixtures/demo/after.liquid"), "utf8");
    assert.equal(await page.getByLabel("Before Liquid Snippet").inputValue(), expectedBefore);
    assert.equal(await page.getByLabel("After Liquid Snippet").inputValue(), expectedAfter);

    await page.getByRole("button", { name: "Run Comparison" }).click();
    await page.waitForURL(/\/comparisons\/[0-9a-f-]{36}$/, { timeout: 10000 });
    const demoResultUrl = page.url();
    const demoJobId = demoResultUrl.split("/").pop();
    console.log(`[stage-9 e2e] Navigated to ${demoResultUrl}; waiting for worker completion...`);

    await page.getByText("Difference Found", { exact: true }).waitFor({ timeout: 45000 });
    await page.getByText("Sale Badge Present in Before only").waitFor({ timeout: 5000 });
    await page.getByText("Confirmed by Official Liquid v5.14.0").waitFor({ timeout: 5000 });
    await page.getByText("Structural Change", { exact: true }).waitFor({ timeout: 5000 });
    await page.getByRole("button", { name: /Before Line L3/ }).waitFor({ timeout: 5000 });
    await page.getByRole("button", { name: /After Line L1/ }).waitFor({ timeout: 5000 });
    await page.getByText("product.compare_at_price_varies").waitFor({ timeout: 5000 });
    await page.getByText("python3.11 -m search replay --bundle replay.json").waitFor({ timeout: 5000 });

    const beforeAnchorText = await page
      .locator('[data-testid="before-source-lines"] [data-anchor-line="true"]')
      .innerText();
    assert.match(beforeAnchorText, /\b3\b/);
    assert.match(beforeAnchorText, /Anchor/);

    const afterAnchorText = await page
      .locator('[data-testid="after-source-lines"] [data-anchor-line="true"]')
      .innerText();
    assert.match(afterAnchorText, /\b1\b/);
    assert.match(afterAnchorText, /Anchor/);

    const bodyText = await page.locator("body").innerText();
    assert.match(bodyText, /variant_id="v2"/);

    // Expand full trace <details>
    await page.locator("details.trace-details summary").first().click();
    const traceOpen = await page.locator("details.trace-details").first().getAttribute("open");
    assert.notEqual(traceOpen, null);

    // Download replay JSON and verify canonical sorted-key UTF-8 format
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Download Replay JSON" }).click(),
    ]);
    assert.equal(download.suggestedFilename(), "replay.json");
    const replayDownloadPath = await download.path();
    assert.ok(replayDownloadPath, "Download path should exist");
    const downloadedReplayText = fs.readFileSync(replayDownloadPath, "utf8");
    const parsedReplay = JSON.parse(downloadedReplayText);
    assert.equal(parsedReplay.liquid_version, "5.14.0");
    assert.ok(downloadedReplayText.indexOf('"after_sha256"') < downloadedReplayText.indexOf('"before_sha256"'));
    assert.ok(!/\n/.test(downloadedReplayText), "Canonical replay JSON must be compact");

    // 2. Capture screenshot of desktop result page
    const screenshotPath = path.join(ARTIFACTS_DIR, "demo-result-page.png");
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`[stage-9 e2e] Captured screenshot: ${screenshotPath}`);

    // 3. Fresh second page load directly on /comparisons/:id
    const reloadPage = await context.newPage();
    reloadPage.on("pageerror", (err) => pageErrors.push(err.message));
    await reloadPage.goto(demoResultUrl, { waitUntil: "networkidle" });
    await reloadPage.getByText("Difference Found", { exact: true }).waitFor({ timeout: 15000 });
    await reloadPage.getByText("Confirmed by Official Liquid v5.14.0").waitFor({ timeout: 5000 });
    await reloadPage.getByRole("button", { name: /Before Line L3/ }).waitFor({ timeout: 5000 });
    await reloadPage.getByRole("button", { name: /After Line L1/ }).waitFor({ timeout: 5000 });
    const reloadedRenderedHtml = await reloadPage.getByTestId("before-rendered-html").innerText();
    assert.equal(reloadedRenderedHtml, '<span class="badge" data-regression-badge="sale">Sale</span>');
    await reloadPage.close();
    console.log("[stage-9 e2e] Verified fresh second page load reconstructs identical result view.");

    // 4. Submit XSS payload through real UI -> Rails -> Python -> Ruby pipeline
    const xssBefore =
      '<script>window.__lrf_xss_ran = true;</script><img src=x onerror="window.__lrf_xss_img = true"><span data-regression-badge="sale">Sale</span>';
    const xssAfter = "<span>plain</span>";

    await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" });
    await page.getByLabel("Before Liquid Snippet").fill(xssBefore);
    await page.getByLabel("After Liquid Snippet").fill(xssAfter);
    await page.getByLabel("Search Pairs").fill("32");
    await page.getByLabel("Shrink Pairs").fill("16");
    await page.getByRole("button", { name: "Run Comparison" }).click();

    await page.waitForURL(/\/comparisons\/[0-9a-f-]{36}$/, { timeout: 10000 });
    const xssJobId = page.url().split("/").pop();
    await page.getByText("Difference Found", { exact: true }).waitFor({ timeout: 45000 });

    const renderedXssText = await page.getByTestId("before-rendered-html").innerText();
    assert.ok(renderedXssText.includes("<script>window.__lrf_xss_ran = true;</script>"));
    assert.ok(renderedXssText.includes('<img src=x onerror="window.__lrf_xss_img = true">'));

    const xssProbe = await page.evaluate(() => ({
      ran: window.__lrf_xss_ran,
      img: window.__lrf_xss_img,
      scriptCount: document.querySelectorAll('[data-testid="before-rendered-html"] script').length,
      imgCount: document.querySelectorAll('[data-testid="before-rendered-html"] img').length,
    }));
    assert.equal(xssProbe.ran, undefined, "Submitted <script> executed in browser!");
    assert.equal(xssProbe.img, undefined, "Submitted <img onerror> executed in browser!");
    assert.equal(xssProbe.scriptCount, 0);
    assert.equal(xssProbe.imgCount, 0);
    console.log("[stage-9 e2e] Verified XSS payload rendered as escaped text and did not execute.");

    // 5. Responsive mobile viewport check (390x844) without horizontal overflow
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" });
    const homeOverflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    assert.ok(
      homeOverflow.scrollWidth <= homeOverflow.innerWidth,
      `Home page overflowed at 390px: scrollWidth=${homeOverflow.scrollWidth} > innerWidth=${homeOverflow.innerWidth}`,
    );

    await page.goto(demoResultUrl, { waitUntil: "networkidle" });
    await page.getByText("Difference Found", { exact: true }).waitFor({ timeout: 15000 });
    const resultOverflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    assert.ok(
      resultOverflow.scrollWidth <= resultOverflow.innerWidth,
      `Result page overflowed at 390px: scrollWidth=${resultOverflow.scrollWidth} > innerWidth=${resultOverflow.innerWidth}`,
    );
    console.log(
      `[stage-9 e2e] Responsive 390x844 verified: home=${homeOverflow.scrollWidth}/${homeOverflow.innerWidth}, result=${resultOverflow.scrollWidth}/${resultOverflow.innerWidth}`,
    );

    assert.equal(pageErrors.length, 0, `Uncaught page errors occurred: ${pageErrors.join("; ")}`);

    // Check Rails & worker logs for redaction
    for (const lp of [serverLog, workerLog]) {
      const content = fs.readFileSync(lp, "utf8");
      assert.ok(!content.includes("for variant in product.variants"), `Log leaked snippet: ${lp}`);
      assert.ok(!content.includes("window.__lrf_xss_ran"), `Log leaked XSS snippet: ${lp}`);
    }

    const report = {
      status: "passed",
      demo_job_id: demoJobId,
      demo_result_url: `/comparisons/${demoJobId}`,
      xss_job_id: xssJobId,
      screenshot: "artifacts/stage-9/demo-result-page.png",
      second_page_load_reconstructed: true,
      xss_non_execution_verified: true,
      replay_download_verified: true,
      responsive_390x844: {
        home_scroll_width: homeOverflow.scrollWidth,
        home_inner_width: homeOverflow.innerWidth,
        result_scroll_width: resultOverflow.scrollWidth,
        result_inner_width: resultOverflow.innerWidth,
      },
      uncaught_page_errors: pageErrors.length,
    };

    const reportPath = path.join(ARTIFACTS_DIR, "browser-e2e-report.json");
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
    console.log(`[stage-9 e2e] PASS: wrote ${reportPath}`);
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
    await stopProcessGroup(viteProc, "vite dev server");
    await stopProcessGroup(serverProc, "rails puma server");
    await stopProcessGroup(workerProc, "solid_queue worker");
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("[stage-9 e2e] FAILED:", err);
  process.exit(1);
});

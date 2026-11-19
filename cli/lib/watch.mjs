import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.mjs";
import { resolveEngineRuntime, runCompareAsync } from "./engine_runner.mjs";
import { formatCompareFinding, formatEngineFailure, writeReplayAtomic } from "./format.mjs";
import { readBlobAtCommit, readWorkingTreeFile, resolveCommitSha, resolveGitRoot } from "./git.mjs";
import { CliError, isPathInside, resolveEngineRoot, resolveReplayTarget } from "./paths.mjs";

export const WATCH_DEBOUNCE_MS = 250;

function snapshotsEqual(a, b) {
  if (!a || !b || !a.ok || !b.ok) return false;
  return a.bytes.equals(b.bytes);
}

/**
 * Execute `liquid-regression-finder watch`, returning exit code 0 on clean shutdown or throwing CliError on startup failure.
 */
export async function runWatch(
  opts,
  { cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr, signal = null } = {},
) {
  const gitRoot = resolveGitRoot(cwd);
  const config = loadConfig({ gitRoot, configPath: opts.configPath, cwd });
  const baseRef = opts.baseRef ?? config.base_ref;
  const seed = opts.seed ?? config.seed;
  const searchPairs = opts.searchPairs ?? config.watch_budget.search_pairs;
  const shrinkPairs = opts.shrinkPairs ?? config.watch_budget.shrink_pairs;
  const replayTarget = resolveReplayTarget({
    gitRoot,
    config,
    cliReplayOut: opts.replayOut,
    cwd,
  });
  const engineRoot = resolveEngineRoot();
  const runtime = resolveEngineRuntime({ engineRoot });

  const baseSha = resolveCommitSha(gitRoot, baseRef, "base-ref");
  const shortSha = baseSha.slice(0, 7);
  const beforeBytes = readBlobAtCommit(gitRoot, baseSha, baseRef, config.snippet_path);

  const watchDir = path.dirname(config.snippet_abs_path);
  const targetName = path.basename(config.snippet_abs_path);
  let dirStat;
  try {
    dirStat = fs.statSync(watchDir);
  } catch (err) {
    throw new CliError(
      "missing_watch_dir",
      `Cannot watch directory '${watchDir}' for '${config.snippet_path}': ${err.message}`,
    );
  }
  if (!dirStat.isDirectory()) {
    throw new CliError(
      "invalid_path",
      `Parent path '${watchDir}' for '${config.snippet_path}' is not a directory.`,
    );
  }
  const watchDirReal = fs.realpathSync(watchDir);
  if (!isPathInside(watchDirReal, config.gitRoot, { allowEqual: true })) {
    throw new CliError(
      "path_outside_repo",
      `Watched directory '${watchDir}' resolves outside the Git root (${config.gitRoot}).`,
    );
  }

  let stopping = false;
  let shutdownStarted = false;
  let watcher = null;
  let debounceTimer = null;
  let activeRun = null;
  let pendingSnapshot = null;
  let lastConfirmedFixture = null;
  let lastPrintedSignature = null;

  let resolveDone;
  const donePromise = new Promise((resolve) => {
    resolveDone = resolve;
  });

  function readWorkingSnapshot() {
    try {
      const bytes = readWorkingTreeFile(gitRoot, config.snippet_path);
      return { ok: true, bytes };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof CliError ? err : new CliError("working_file_read_error", err?.message || String(err)),
      };
    }
  }

  function clearDebounceTimer() {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  }

  function handleRunOutcome(snapshot, result, runErr) {
    if (!snapshot.ok) {
      lastPrintedSignature = null;
      stderr.write(`Error [${snapshot.error.code}]: ${snapshot.error.message}\n`);
      return;
    }

    if (runErr) {
      lastPrintedSignature = null;
      const code = runErr instanceof CliError ? runErr.code : "engine_error";
      stderr.write(`Error [${code}]: ${runErr?.message || String(runErr)}\n`);
      return;
    }

    const { exitCode, report } = result;
    const status = report?.status;

    if (status === "difference_found" && exitCode === 1) {
      if (report?.finding?.replay?.fixture) {
        lastConfirmedFixture = report.finding.replay.fixture;
      }
      try {
        writeReplayAtomic(report.finding.replay, replayTarget.absPath);
      } catch (writeErr) {
        const code = writeErr instanceof CliError ? writeErr.code : "replay_write_error";
        stderr.write(`Error [${code}]: ${writeErr?.message || String(writeErr)}\n`);
      }

      const formatted = formatCompareFinding(report, {
        snippetPath: config.snippet_path,
        replayRelPath: replayTarget.displayPath,
      });
      if (formatted !== lastPrintedSignature) {
        stdout.write(formatted + "\n");
        lastPrintedSignature = formatted;
      }
      return;
    }

    if (status === "no_difference_found" && exitCode === 0) {
      lastPrintedSignature = null;
      return;
    }

    lastPrintedSignature = null;
    stderr.write(formatEngineFailure(report, config.snippet_path) + "\n");
  }

  async function executeRun(initialSnapshot) {
    let currentSnapshot = initialSnapshot;

    while (!stopping && currentSnapshot !== null) {
      if (!currentSnapshot.ok) {
        handleRunOutcome(currentSnapshot, null, null);
        if (!stopping && pendingSnapshot !== null) {
          currentSnapshot = pendingSnapshot;
          pendingSnapshot = null;
          continue;
        }
        break;
      }

      const abortController = new AbortController();
      const priorityFixtures = lastConfirmedFixture ? [lastConfirmedFixture] : [];
      const runState = {
        abortController,
        superseded: false,
        snapshot: currentSnapshot,
        promise: null,
      };

      const runPromise = runCompareAsync({
        beforeBytes,
        afterBytes: currentSnapshot.bytes,
        observer: config.observer,
        seed,
        searchPairs,
        shrinkPairs,
        priorityFixtures,
        engineRoot,
        runtime,
        signal: abortController.signal,
      });
      runState.promise = runPromise;
      activeRun = runState;

      let result = null;
      let runErr = null;
      try {
        result = await runPromise;
      } catch (err) {
        runErr = err;
      }

      if (activeRun === runState) {
        activeRun = null;
      }

      // Suppress ALL stdout, stderr, replay writes, and cache updates from any superseded or stopping run.
      if (!stopping && !runState.superseded) {
        handleRunOutcome(currentSnapshot, result, runErr);
      }

      if (stopping) {
        pendingSnapshot = null;
        break;
      }

      if (pendingSnapshot !== null) {
        currentSnapshot = pendingSnapshot;
        pendingSnapshot = null;
      } else {
        currentSnapshot = null;
      }
    }

    if (stopping) {
      resolveDone();
    }
  }

  function scheduleSettledSnapshot(snapshot) {
    if (stopping) return;

    if (activeRun !== null) {
      if (!activeRun.superseded && pendingSnapshot === null && snapshotsEqual(snapshot, activeRun.snapshot)) {
        return;
      }
      pendingSnapshot = snapshot;
      if (!activeRun.superseded) {
        activeRun.superseded = true;
        activeRun.abortController.abort();
      }
      return;
    }

    void executeRun(snapshot);
  }

  function onWatchEvent(_eventType, filename) {
    if (stopping) return;
    if (filename !== null && filename !== undefined && String(filename) !== targetName) {
      return;
    }
    clearDebounceTimer();
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (stopping) return;
      const snapshot = readWorkingSnapshot();
      scheduleSettledSnapshot(snapshot);
    }, WATCH_DEBOUNCE_MS);
  }

  async function shutdown() {
    if (shutdownStarted) return;
    shutdownStarted = true;
    stopping = true;

    clearDebounceTimer();
    pendingSnapshot = null;

    if (watcher !== null) {
      try {
        watcher.close();
      } catch {
        // Ignore close errors.
      }
      watcher = null;
    }

    if (activeRun !== null) {
      activeRun.superseded = true;
      activeRun.abortController.abort();
      try {
        await activeRun.promise;
      } catch {
        // Child exited cleanly after abort.
      }
    }

    resolveDone();
  }

  const onSig = () => {
    void shutdown();
  };

  try {
    watcher = fs.watch(watchDirReal, onWatchEvent);
    watcher.on("error", (err) => {
      if (stopping) return;
      stderr.write(`Error [watch_error]: File watcher error on '${config.snippet_path}': ${err.message}\n`);
    });
  } catch (err) {
    throw new CliError("watch_error", `Failed watching '${watchDirReal}': ${err.message}`);
  }

  process.on("SIGINT", onSig);
  process.on("SIGTERM", onSig);
  process.on("SIGHUP", onSig);
  if (signal) {
    if (signal.aborted) {
      void shutdown();
    } else {
      signal.addEventListener("abort", onSig, { once: true });
    }
  }

  try {
    stdout.write(`Watching ${config.snippet_path} against ${baseRef} (${shortSha})\n`);
    scheduleSettledSnapshot(readWorkingSnapshot());
    await donePromise;
    return 0;
  } finally {
    process.off("SIGINT", onSig);
    process.off("SIGTERM", onSig);
    process.off("SIGHUP", onSig);
    if (signal) {
      signal.removeEventListener("abort", onSig);
    }
    clearDebounceTimer();
    if (watcher !== null) {
      try {
        watcher.close();
      } catch {
        // Ignore.
      }
      watcher = null;
    }
  }
}

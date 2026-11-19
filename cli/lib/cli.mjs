import path from "node:path";
import { loadConfig } from "./config.mjs";
import { runCompare, runReplay } from "./engine_runner.mjs";
import { formatCompareFinding, formatEngineFailure, formatReplaySummary, writeReplayAtomic } from "./format.mjs";
import { readBlobAtCommit, readWorkingTreeFile, resolveCommitSha, resolveGitRoot } from "./git.mjs";
import { CliError, resolveEngineRoot, resolveReplayTarget } from "./paths.mjs";
import { runWatch } from "./watch.mjs";

const CLI_VERSION = "0.1.0";
const MAX_SEED = 4_294_967_295;
const MAX_SEARCH_PAIRS = 5_000;
const MAX_SHRINK_PAIRS = 1_000;

function usageText() {
  return [
    "Usage:",
    "  liquid-regression-finder check [options]",
    "  liquid-regression-finder watch [options]",
    "  liquid-regression-finder replay <bundle_path> [--bundle <path>] [--json]",
    "",
    "Check options:",
    "  --base-ref <ref>       Git baseline revision (default: config base_ref or HEAD)",
    "  --head-ref <ref>       Optional Git target revision (default: working tree)",
    "  --config <path>        Path to liquid-regression.json (default: <git_root>/liquid-regression.json)",
    "  --seed <n>             Deterministic PRNG seed (0..4294967295)",
    "  --search-pairs <n>     Search fixture pair budget (1..5000, default: 256)",
    "  --shrink-pairs <n>     Shrink candidate pair budget (0..1000, default: 128)",
    "  --replay-out <path>    Replay JSON output path (default: .liquid-regression/result.json)",
    "  --json                 Emit structured JSON output",
    "  -h, --help             Show this help message",
    "",
    "Watch options:",
    "  --base-ref <ref>       Git baseline revision resolved once at startup (default: config base_ref or HEAD)",
    "  --config <path>        Path to liquid-regression.json (default: <git_root>/liquid-regression.json)",
    "  --seed <n>             Deterministic PRNG seed (0..4294967295)",
    "  --search-pairs <n>     Search fixture pair budget (1..5000, default: 32)",
    "  --shrink-pairs <n>     Shrink candidate pair budget (0..1000, default: 16)",
    "  --replay-out <path>    Replay JSON output path (default: .liquid-regression/result.json)",
    "  -h, --help             Show this help message",
  ].join("\n");
}

function parseStrictIntFlag(rawValue, flagName, min, max) {
  if (!/^\d+$/.test(rawValue)) {
    throw new CliError("invalid_args", `--${flagName} must be an integer in ${min}..${max}, got '${rawValue}'.`);
  }
  const num = Number(rawValue);
  if (!Number.isSafeInteger(num) || num < min || num > max) {
    throw new CliError("invalid_args", `--${flagName} must be an integer in ${min}..${max}, got '${rawValue}'.`);
  }
  return num;
}

function parseCompareLikeArgs(args, { commandName, allowHeadRef = false, allowJson = false } = {}) {
  const opts = {
    baseRef: null,
    headRef: null,
    configPath: null,
    seed: null,
    searchPairs: null,
    shrinkPairs: null,
    replayOut: null,
    json: false,
    help: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "-h" || arg === "--help") {
      opts.help = true;
      return opts;
    }
    if (allowJson && arg === "--json") {
      opts.json = true;
      continue;
    }

    const eqIdx = arg.indexOf("=");
    const flag = eqIdx !== -1 ? arg.slice(0, eqIdx) : arg;
    const takeValue = () => {
      if (eqIdx !== -1) return arg.slice(eqIdx + 1);
      if (i + 1 >= args.length) {
        throw new CliError("invalid_args", `Option '${flag}' requires a value.`);
      }
      i += 1;
      return args[i];
    };

    switch (flag) {
      case "--base-ref":
        opts.baseRef = takeValue();
        break;
      case "--head-ref":
        if (!allowHeadRef) {
          throw new CliError("invalid_args", `Unknown ${commandName} option '${arg}'.`);
        }
        opts.headRef = takeValue();
        break;
      case "--config":
        opts.configPath = takeValue();
        break;
      case "--seed":
        opts.seed = parseStrictIntFlag(takeValue(), "seed", 0, MAX_SEED);
        break;
      case "--search-pairs":
        opts.searchPairs = parseStrictIntFlag(takeValue(), "search-pairs", 1, MAX_SEARCH_PAIRS);
        break;
      case "--shrink-pairs":
        opts.shrinkPairs = parseStrictIntFlag(takeValue(), "shrink-pairs", 0, MAX_SHRINK_PAIRS);
        break;
      case "--replay-out":
        opts.replayOut = takeValue();
        if (!opts.replayOut.trim()) {
          throw new CliError("invalid_args", "--replay-out must be a non-empty file path.");
        }
        break;
      default:
        throw new CliError("invalid_args", `Unknown ${commandName} option '${arg}'.`);
    }
  }

  return opts;
}

function parseReplayArgs(args) {
  const opts = {
    bundlePath: null,
    json: false,
    help: false,
  };
  let positional = null;
  let flagBundle = null;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "-h" || arg === "--help") {
      opts.help = true;
      return opts;
    }
    if (arg === "--json") {
      opts.json = true;
      continue;
    }
    if (arg === "--bundle" || arg.startsWith("--bundle=")) {
      let val;
      if (arg.startsWith("--bundle=")) {
        val = arg.slice("--bundle=".length);
      } else {
        if (i + 1 >= args.length) {
          throw new CliError("invalid_args", "Option '--bundle' requires a file path.");
        }
        i += 1;
        val = args[i];
      }
      if (!val.trim()) {
        throw new CliError("invalid_args", "--bundle must be a non-empty file path.");
      }
      flagBundle = val;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new CliError("invalid_args", `Unknown replay option '${arg}'.`);
    }
    if (positional !== null) {
      throw new CliError("invalid_args", `Unexpected extra argument '${arg}' in replay command.`);
    }
    positional = arg;
  }

  if (positional !== null && flagBundle !== null && positional !== flagBundle) {
    throw new CliError("invalid_args", "Pass either positional <bundle_path> or --bundle <path>, not two different paths.");
  }
  opts.bundlePath = flagBundle ?? positional;
  if (!opts.bundlePath && !opts.help) {
    throw new CliError("invalid_args", "replay requires a <bundle_path> (or --bundle <path>).");
  }
  return opts;
}

function emitErrorOutput(err, { json, stdout, stderr }) {
  const code = err instanceof CliError ? err.code : "cli_error";
  const message = err?.message || String(err);
  const span = err instanceof CliError ? err.span : null;
  if (json) {
    const payload = {
      schema_version: 1,
      status: "failed",
      message,
      error: {
        code,
        message,
        span: span ?? null,
      },
    };
    stdout.write(JSON.stringify(payload, null, 2) + "\n");
  }
  stderr.write(`Error [${code}]: ${message}\n`);
  return err instanceof CliError ? err.exitCode : 2;
}

async function handleCheck(args, { cwd, stdout, stderr }) {
  let opts;
  try {
    opts = parseCompareLikeArgs(args, { commandName: "check", allowHeadRef: true, allowJson: true });
  } catch (err) {
    return emitErrorOutput(err, { json: args.includes("--json"), stdout, stderr });
  }

  if (opts.help) {
    stdout.write(usageText() + "\n");
    return 0;
  }

  try {
    const gitRoot = resolveGitRoot(cwd);
    const config = loadConfig({ gitRoot, configPath: opts.configPath, cwd });
    const baseRef = opts.baseRef ?? config.base_ref;
    const seed = opts.seed ?? config.seed;
    const searchPairs = opts.searchPairs ?? config.budget.search_pairs;
    const shrinkPairs = opts.shrinkPairs ?? config.budget.shrink_pairs;
    const replayTarget = resolveReplayTarget({
      gitRoot,
      config,
      cliReplayOut: opts.replayOut,
      cwd,
    });

    const baseSha = resolveCommitSha(gitRoot, baseRef, "base-ref");
    const beforeBytes = readBlobAtCommit(gitRoot, baseSha, baseRef, config.snippet_path);

    let afterBytes;
    if (opts.headRef !== null) {
      const headSha = resolveCommitSha(gitRoot, opts.headRef, "head-ref");
      afterBytes = readBlobAtCommit(gitRoot, headSha, opts.headRef, config.snippet_path);
    } else {
      afterBytes = readWorkingTreeFile(gitRoot, config.snippet_path);
    }

    const engineRoot = resolveEngineRoot();
    const { exitCode, report } = await runCompare({
      beforeBytes,
      afterBytes,
      observer: config.observer,
      seed,
      searchPairs,
      shrinkPairs,
      engineRoot,
    });

    const status = report?.status;
    if (status === "difference_found" && exitCode === 1) {
      writeReplayAtomic(report.finding.replay, replayTarget.absPath);
      if (opts.json) {
        stdout.write(JSON.stringify(report, null, 2) + "\n");
      } else {
        stdout.write(
          formatCompareFinding(report, {
            snippetPath: config.snippet_path,
            replayRelPath: replayTarget.displayPath,
          }) + "\n",
        );
      }
      return 1;
    }

    if (status === "no_difference_found" && exitCode === 0) {
      if (opts.json) {
        stdout.write(JSON.stringify(report, null, 2) + "\n");
      }
      return 0;
    }

    if (opts.json) {
      stdout.write(JSON.stringify(report, null, 2) + "\n");
    }
    stderr.write(formatEngineFailure(report, config.snippet_path) + "\n");
    return 2;
  } catch (err) {
    return emitErrorOutput(err, { json: opts.json, stdout, stderr });
  }
}

async function handleReplay(args, { cwd, stdout, stderr }) {
  let opts;
  try {
    opts = parseReplayArgs(args);
  } catch (err) {
    return emitErrorOutput(err, { json: args.includes("--json"), stdout, stderr });
  }

  if (opts.help) {
    stdout.write(usageText() + "\n");
    return 0;
  }

  try {
    const absBundlePath = path.resolve(cwd, opts.bundlePath);
    const engineRoot = resolveEngineRoot();
    const { exitCode, report } = await runReplay({
      bundlePath: absBundlePath,
      engineRoot,
    });

    if (report?.status === "replayed" && exitCode === 0) {
      if (opts.json) {
        stdout.write(JSON.stringify(report, null, 2) + "\n");
      } else {
        stdout.write(formatReplaySummary(report, { bundleDisplayPath: opts.bundlePath }) + "\n");
      }
      return 0;
    }

    if (opts.json) {
      stdout.write(JSON.stringify(report, null, 2) + "\n");
    }
    const err = report?.error || {};
    stderr.write(`Error [${err.code || "replay_failed"}]: ${err.message || "Replay failed."}\n`);
    return 2;
  } catch (err) {
    return emitErrorOutput(err, { json: opts.json, stdout, stderr });
  }
}

async function handleWatch(args, { cwd, stdout, stderr }) {
  let opts;
  try {
    opts = parseCompareLikeArgs(args, { commandName: "watch", allowHeadRef: false, allowJson: false });
  } catch (err) {
    return emitErrorOutput(err, { json: false, stdout, stderr });
  }

  if (opts.help) {
    stdout.write(usageText() + "\n");
    return 0;
  }

  try {
    return await runWatch(opts, { cwd, stdout, stderr });
  } catch (err) {
    return emitErrorOutput(err, { json: false, stdout, stderr });
  }
}

/**
 * Main Node CLI entrypoint returning process exit code (0, 1, or 2).
 */
export async function runCli(
  argv,
  { cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr } = {},
) {
  if (!argv || argv.length === 0 || argv[0] === "-h" || argv[0] === "--help" || argv[0] === "help") {
    stdout.write(usageText() + "\n");
    return 0;
  }
  if (argv[0] === "--version" || argv[0] === "-v") {
    stdout.write(`liquid-regression-finder ${CLI_VERSION}\n`);
    return 0;
  }

  const [subcommand, ...rest] = argv;
  const wantJson = rest.includes("--json");

  switch (subcommand) {
    case "check":
      return handleCheck(rest, { cwd, stdout, stderr });
    case "watch":
      return handleWatch(rest, { cwd, stdout, stderr });
    case "replay":
      return handleReplay(rest, { cwd, stdout, stderr });
    case "setup":
      return emitErrorOutput(
        new CliError("not_implemented", "'setup' is not implemented until Stage 3."),
        { json: wantJson, stdout, stderr },
      );
    default:
      stderr.write(`Error [unknown_command]: Unknown subcommand '${subcommand}'.\n\n${usageText()}\n`);
      return 2;
  }
}

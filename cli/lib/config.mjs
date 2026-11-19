import fs from "node:fs";
import path from "node:path";
import { CliError, decodeStrictUtf8, resolveRepoRelativePath } from "./paths.mjs";

export const DEFAULT_BUDGET = Object.freeze({ search_pairs: 256, shrink_pairs: 128 });
export const DEFAULT_WATCH_BUDGET = Object.freeze({ search_pairs: 32, shrink_pairs: 16 });
export const DEFAULT_BASE_REF = "HEAD";
export const DEFAULT_REPLAY_PATH = ".liquid-regression/result.json";

const MAX_SEED = 4_294_967_295;
const MAX_SEARCH_PAIRS = 5_000;
const MAX_SHRINK_PAIRS = 1_000;

const ALLOWED_TOP_KEYS = new Set([
  "schema_version",
  "snippet_path",
  "observer",
  "seed",
  "budget",
  "watch_budget",
  "base_ref",
  "replay_path",
]);

const ALLOWED_BUDGET_KEYS = new Set(["search_pairs", "shrink_pairs"]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateIntInRange(value, fieldName, min, max) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new CliError(
      "invalid_config",
      `Config '${fieldName}' must be an integer in ${min}..${max}, got ${JSON.stringify(value)}.`,
    );
  }
  return value;
}

function validateBudgetObject(rawBudget, fieldName, defaults) {
  if (rawBudget === undefined) {
    return { ...defaults };
  }
  if (!isPlainObject(rawBudget)) {
    throw new CliError("invalid_config", `Config '${fieldName}' must be a JSON object.`);
  }
  for (const key of Object.keys(rawBudget)) {
    if (!ALLOWED_BUDGET_KEYS.has(key)) {
      throw new CliError(
        "invalid_config",
        `Unknown key '${key}' in config '${fieldName}'; allowed keys: search_pairs, shrink_pairs.`,
      );
    }
  }
  const search_pairs = Object.hasOwn(rawBudget, "search_pairs")
    ? validateIntInRange(rawBudget.search_pairs, `${fieldName}.search_pairs`, 1, MAX_SEARCH_PAIRS)
    : defaults.search_pairs;
  const shrink_pairs = Object.hasOwn(rawBudget, "shrink_pairs")
    ? validateIntInRange(rawBudget.shrink_pairs, `${fieldName}.shrink_pairs`, 0, MAX_SHRINK_PAIRS)
    : defaults.shrink_pairs;
  return { search_pairs, shrink_pairs };
}

function validateBaseRef(rawBaseRef) {
  if (rawBaseRef === undefined) {
    return DEFAULT_BASE_REF;
  }
  if (typeof rawBaseRef !== "string" || rawBaseRef.trim().length === 0) {
    throw new CliError("invalid_config", "Config 'base_ref' must be a non-empty string.");
  }
  if (rawBaseRef.startsWith("-") || rawBaseRef.includes("\0") || /\s/.test(rawBaseRef)) {
    throw new CliError("invalid_config", `Config 'base_ref' is not a valid Git ref: '${rawBaseRef}'.`);
  }
  return rawBaseRef;
}

/**
 * Load and validate `<gitRoot>/liquid-regression.json` (or `--config <path>`).
 */
export function loadConfig({ gitRoot, configPath = null, cwd = process.cwd() }) {
  const realGitRoot = fs.realpathSync(gitRoot);
  const resolvedConfigPath = configPath
    ? path.resolve(cwd, configPath)
    : path.join(realGitRoot, "liquid-regression.json");

  let stat;
  try {
    stat = fs.statSync(resolvedConfigPath);
  } catch (err) {
    if (err && err.code === "ENOENT") {
      throw new CliError(
        "missing_config",
        `Config file not found at '${resolvedConfigPath}'. Create liquid-regression.json at the Git root or pass --config <path>.`,
      );
    }
    throw new CliError("invalid_config", `Unable to access config '${resolvedConfigPath}': ${err.message}`);
  }

  if (stat.isDirectory()) {
    throw new CliError("invalid_config", `Config path '${resolvedConfigPath}' is a directory, expected a JSON file.`);
  }
  if (!stat.isFile()) {
    throw new CliError("invalid_config", `Config path '${resolvedConfigPath}' is not a regular file.`);
  }

  let rawBytes;
  try {
    rawBytes = fs.readFileSync(resolvedConfigPath);
  } catch (err) {
    throw new CliError("invalid_config", `Failed reading config '${resolvedConfigPath}': ${err.message}`);
  }

  const rawText = decodeStrictUtf8(rawBytes, `Config file '${resolvedConfigPath}'`);

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    throw new CliError("invalid_config", `Config file '${resolvedConfigPath}' contains invalid JSON: ${err.message}`);
  }

  if (!isPlainObject(parsed)) {
    throw new CliError("invalid_config", `Config file '${resolvedConfigPath}' must contain a JSON object.`);
  }

  const unknownKeys = Object.keys(parsed).filter((key) => !ALLOWED_TOP_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw new CliError(
      "invalid_config",
      `Unknown key(s) in config '${resolvedConfigPath}': ${unknownKeys.join(", ")}.`,
    );
  }

  let schemaVersion = 1;
  if (Object.hasOwn(parsed, "schema_version")) {
    schemaVersion = validateIntInRange(parsed.schema_version, "schema_version", 1, 1);
  }

  if (!Object.hasOwn(parsed, "snippet_path")) {
    throw new CliError("invalid_config", `Config '${resolvedConfigPath}' is missing required key 'snippet_path'.`);
  }
  const snippetResolved = resolveRepoRelativePath(realGitRoot, parsed.snippet_path, "snippet_path", {
    mustExist: false,
  });

  const observer = Object.hasOwn(parsed, "observer") ? parsed.observer : "sale_badge";
  if (observer !== "sale_badge") {
    throw new CliError(
      "unsupported_observer",
      `Config 'observer' must be "sale_badge", got ${JSON.stringify(observer)}.`,
    );
  }

  const seed = Object.hasOwn(parsed, "seed")
    ? validateIntInRange(parsed.seed, "seed", 0, MAX_SEED)
    : 0;

  const budget = validateBudgetObject(parsed.budget, "budget", DEFAULT_BUDGET);
  const watchBudget = validateBudgetObject(parsed.watch_budget, "watch_budget", DEFAULT_WATCH_BUDGET);
  const baseRef = validateBaseRef(parsed.base_ref);

  const rawReplayPath = Object.hasOwn(parsed, "replay_path") ? parsed.replay_path : DEFAULT_REPLAY_PATH;
  const replayResolved = resolveRepoRelativePath(realGitRoot, rawReplayPath, "replay_path", {
    mustExist: false,
  });

  return {
    configPath: resolvedConfigPath,
    gitRoot: realGitRoot,
    schema_version: schemaVersion,
    snippet_path: snippetResolved.relPosixPath,
    snippet_abs_path: snippetResolved.absPath,
    observer,
    seed,
    budget,
    watch_budget: watchBudget,
    base_ref: baseRef,
    replay_path: replayResolved.relPosixPath,
    replay_abs_path: replayResolved.absPath,
  };
}

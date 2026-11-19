import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ENGINE_ROOT = path.resolve(LIB_DIR, "../..");

/**
 * Structured CLI error carrying exit code (default 2) and diagnostic metadata.
 */
export class CliError extends Error {
  constructor(code, message, { exitCode = 2, span = null, details = null } = {}) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.exitCode = exitCode;
    this.span = span;
    this.details = details;
  }
}

/**
 * Resolve the engine root directory (containing `search/`, `reference/`, `interpreter/`).
 */
export function resolveEngineRoot() {
  const override = (process.env.LRF_ENGINE_ROOT || "").trim();
  if (override) {
    try {
      const resolved = fs.realpathSync(override);
      if (
        fs.statSync(resolved).isDirectory() &&
        fs.existsSync(path.join(resolved, "search")) &&
        fs.existsSync(path.join(resolved, "reference"))
      ) {
        return resolved;
      }
    } catch {
      // Fall through to packaged/repo root.
    }
  }
  return fs.realpathSync(DEFAULT_ENGINE_ROOT);
}

/**
 * Return true if `candidateRealPath` is strictly inside `rootRealPath` (or equal when allowed).
 */
export function isPathInside(candidateRealPath, rootRealPath, { allowEqual = false } = {}) {
  const normalizedRoot = rootRealPath.endsWith(path.sep) ? rootRealPath : rootRealPath + path.sep;
  if (allowEqual && candidateRealPath === rootRealPath) {
    return true;
  }
  return candidateRealPath.startsWith(normalizedRoot);
}

/**
 * Resolve the realpath of `targetPath` if it exists, or its deepest existing ancestor + remaining suffix.
 * Rejects dangling symlinks cleanly.
 */
export function resolveRealPathWithAncestors(targetPath, label) {
  const absTarget = path.resolve(targetPath);
  try {
    const lstat = fs.lstatSync(absTarget);
    if (lstat.isSymbolicLink()) {
      try {
        return { exists: true, lstat, realPath: fs.realpathSync(absTarget) };
      } catch (err) {
        if (err && err.code === "ENOENT") {
          throw new CliError("invalid_path", `${label} '${targetPath}' is a broken symlink.`);
        }
        throw err;
      }
    }
    return { exists: true, lstat, realPath: fs.realpathSync(absTarget) };
  } catch (err) {
    if (!err || err.code !== "ENOENT") {
      if (err instanceof CliError) throw err;
      throw new CliError("invalid_path", `Cannot inspect ${label} '${targetPath}': ${err.message}`);
    }
  }

  // Walk upward to the deepest existing ancestor so symlinked parent directories are resolved.
  const suffixParts = [];
  let cursor = absTarget;
  while (true) {
    const parent = path.dirname(cursor);
    suffixParts.unshift(path.basename(cursor));
    if (parent === cursor) {
      return { exists: false, lstat: null, realPath: absTarget };
    }
    cursor = parent;
    try {
      const ancestorLstat = fs.lstatSync(cursor);
      let realAncestor;
      try {
        realAncestor = fs.realpathSync(cursor);
      } catch (err) {
        if (err && err.code === "ENOENT" && ancestorLstat.isSymbolicLink()) {
          throw new CliError("invalid_path", `${label} '${targetPath}' traverses a broken symlink.`);
        }
        throw err;
      }
      return {
        exists: false,
        lstat: null,
        realPath: path.join(realAncestor, ...suffixParts),
      };
    } catch (err) {
      if (err instanceof CliError) throw err;
      if (!err || err.code !== "ENOENT") {
        throw new CliError("invalid_path", `Cannot inspect parent directory of ${label}: ${err.message}`);
      }
    }
  }
}

/**
 * Validate and normalize a repo-relative POSIX file path without allowing traversal or absolute paths.
 */
export function normalizeRelativePosixPath(rawPath, fieldName) {
  if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
    throw new CliError("invalid_path", `${fieldName} must be a non-empty relative path string.`);
  }
  if (rawPath.includes("\0")) {
    throw new CliError("invalid_path", `${fieldName} must not contain NUL bytes.`);
  }
  if (rawPath.includes("\\")) {
    throw new CliError("invalid_path", `${fieldName} must use forward slashes ('/'), got '${rawPath}'.`);
  }
  if (path.isAbsolute(rawPath) || rawPath.startsWith("/")) {
    throw new CliError("invalid_path", `${fieldName} must be a relative path inside the Git root, got '${rawPath}'.`);
  }
  if (rawPath.endsWith("/")) {
    throw new CliError("invalid_path", `${fieldName} must name a file, not a directory ('${rawPath}').`);
  }

  const rawSegments = rawPath.split("/");
  if (rawSegments.some((seg) => seg === "..")) {
    throw new CliError("invalid_path", `${fieldName} must not contain '..' path traversal ('${rawPath}').`);
  }

  const normalized = path.posix.normalize(rawPath);
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new CliError("invalid_path", `${fieldName} must resolve to a file inside the Git root, got '${rawPath}'.`);
  }
  if (normalized.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) {
    throw new CliError("invalid_path", `${fieldName} contains invalid path segments ('${rawPath}').`);
  }
  return normalized;
}

/**
 * Resolve a repo-relative path inside `gitRoot`, rejecting directories and escaping symlinks.
 */
export function resolveRepoRelativePath(gitRoot, rawRelPath, fieldName, { mustExist = false } = {}) {
  const realRoot = fs.realpathSync(gitRoot);
  const relPosixPath = normalizeRelativePosixPath(rawRelPath, fieldName);
  const absPath = path.resolve(realRoot, ...relPosixPath.split("/"));
  const inspected = resolveRealPathWithAncestors(absPath, fieldName);

  if (!isPathInside(inspected.realPath, realRoot)) {
    throw new CliError(
      "path_outside_repo",
      `${fieldName} '${relPosixPath}' resolves outside the Git root (${realRoot}).`,
    );
  }

  if (inspected.exists) {
    if (inspected.lstat && inspected.lstat.isDirectory()) {
      throw new CliError("invalid_path", `${fieldName} '${relPosixPath}' is a directory, expected a regular file.`);
    }
    let stat;
    try {
      stat = fs.statSync(inspected.realPath);
    } catch (err) {
      throw new CliError("invalid_path", `Failed to stat ${fieldName} '${relPosixPath}': ${err.message}`);
    }
    if (stat.isDirectory()) {
      throw new CliError("invalid_path", `${fieldName} '${relPosixPath}' resolves to a directory.`);
    }
    if (!stat.isFile()) {
      throw new CliError("invalid_path", `${fieldName} '${relPosixPath}' is not a regular file.`);
    }
  } else if (mustExist) {
    throw new CliError(
      "missing_working_file",
      `Working tree file '${relPosixPath}' does not exist in '${realRoot}'.`,
    );
  }

  return {
    relPosixPath,
    absPath,
    realPath: inspected.realPath,
    exists: inspected.exists,
  };
}

/**
 * Strictly decode a Buffer as UTF-8, rejecting invalid byte sequences without alteration.
 */
export function decodeStrictUtf8(buf, label) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    return decoder.decode(buf);
  } catch (err) {
    throw new CliError("invalid_utf8", `${label} is not valid UTF-8: ${err.message}`);
  }
}

/**
 * Resolve the replay JSON output target path and display path.
 */
export function resolveReplayTarget({ gitRoot, config, cliReplayOut, cwd }) {
  if (!cliReplayOut) {
    return {
      absPath: config.replay_abs_path,
      displayPath: config.replay_path,
    };
  }
  const absPath = path.resolve(cwd, cliReplayOut);
  const inspected = resolveRealPathWithAncestors(absPath, "--replay-out");
  let displayPath = cliReplayOut;
  if (isPathInside(inspected.realPath, gitRoot)) {
    displayPath = path.relative(gitRoot, inspected.realPath).split(path.sep).join("/");
  }
  return { absPath, displayPath };
}

function sanitizeCacheSegment(value) {
  return String(value).replace(/[^A-Za-z0-9._-]/g, "_");
}

/**
 * Read package name and version from `<engineRoot>/package.json`.
 */
export function resolvePackageMetadata(engineRoot = resolveEngineRoot()) {
  const pkgPath = path.join(engineRoot, "package.json");
  try {
    if (fs.existsSync(pkgPath)) {
      const parsed = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      return {
        name: typeof parsed?.name === "string" && parsed.name ? parsed.name : "liquid-regression-finder",
        version: typeof parsed?.version === "string" && parsed.version ? parsed.version : "0.1.0",
      };
    }
  } catch {
    // Fall back to default package metadata.
  }
  return { name: "liquid-regression-finder", version: "0.1.0" };
}

/**
 * Resolve the base user cache directory (`LRF_CACHE_DIR` or `~/.cache/liquid-regression-finder`).
 */
export function resolveCacheBaseDir() {
  const override = (process.env.LRF_CACHE_DIR || "").trim();
  if (override) {
    return path.resolve(override);
  }

  let homeDir = "";
  try {
    homeDir = os.homedir();
  } catch {
    homeDir = "";
  }
  if (homeDir && homeDir.trim()) {
    return path.join(homeDir, ".cache", "liquid-regression-finder");
  }

  const winLocalAppData = (process.env.LOCALAPPDATA || "").trim();
  if (process.platform === "win32" && winLocalAppData) {
    return path.join(winLocalAppData, "liquid-regression-finder", "Cache");
  }

  return path.join(os.tmpdir(), "liquid-regression-finder-cache");
}

/**
 * Compute SHA-256 hex digest of `<engineRoot>/engine/Gemfile.lock`.
 */
export function computeEngineLockSha256(engineRoot = resolveEngineRoot()) {
  const lockPath = path.join(engineRoot, "engine", "Gemfile.lock");
  let bytes;
  try {
    bytes = fs.readFileSync(lockPath);
  } catch (err) {
    throw new CliError(
      "missing_engine_lockfile",
      `Engine lockfile not found at '${lockPath}': ${err.message}`,
    );
  }
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

/**
 * Resolve the versioned user gem cache directory and file layout for the active package, Ruby ABI, and lockfile.
 */
export function resolveUserGemCacheDir({
  engineRoot = resolveEngineRoot(),
  rubyAbi,
  rubyPlatform = null,
  cacheBaseDir = resolveCacheBaseDir(),
} = {}) {
  const pkgMeta = resolvePackageMetadata(engineRoot);
  const lockSha256 = computeEngineLockSha256(engineRoot);
  const lockSha12 = lockSha256.slice(0, 12);
  const versionToken = sanitizeCacheSegment(pkgMeta.version);
  const abiToken = sanitizeCacheSegment(rubyAbi || "unknown");
  const platformToken = rubyPlatform ? `-${sanitizeCacheSegment(rubyPlatform)}` : "";
  const cacheKey = `v${versionToken}-ruby${abiToken}${platformToken}-${lockSha12}`;
  const cacheDir = path.join(cacheBaseDir, "gems", cacheKey);

  return {
    cacheBaseDir,
    pkgVersion: pkgMeta.version,
    lockSha256,
    lockSha12,
    rubyAbi,
    rubyPlatform,
    cacheKey,
    cacheDir,
    gemfilePath: path.join(cacheDir, "Gemfile"),
    lockfilePath: path.join(cacheDir, "Gemfile.lock"),
    bundlePath: path.join(cacheDir, "vendor", "bundle"),
    bundleAppConfig: path.join(cacheDir, ".bundle"),
    vendorCacheDir: path.join(cacheDir, "vendor", "cache"),
    markerPath: path.join(cacheDir, "env.json"),
  };
}

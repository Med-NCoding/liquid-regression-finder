import fs from "node:fs";
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

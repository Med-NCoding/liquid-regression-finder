import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { CliError, decodeStrictUtf8, resolveRepoRelativePath } from "./paths.mjs";

const MAX_GIT_BUFFER = 32 * 1024 * 1024;
const COMMIT_SHA_RE = /^[0-9a-f]{40,}$/i;

function execGit(args, { cwd, encoding = "utf8" }) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding,
      maxBuffer: MAX_GIT_BUFFER,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
  } catch (err) {
    if (err && err.code === "ENOENT") {
      throw new CliError("git_missing", "Git executable ('git') was not found on PATH.");
    }
    throw err;
  }
}

function formatGitStderr(err) {
  if (!err || !err.stderr) return "";
  if (Buffer.isBuffer(err.stderr)) {
    return err.stderr.toString("utf8").trim();
  }
  return String(err.stderr).trim();
}

/**
 * Validate a Git ref string to block empty values, whitespace, NUL bytes, and flag injection.
 */
export function validateGitRef(ref, flagName = "ref") {
  if (typeof ref !== "string" || ref.trim().length === 0) {
    throw new CliError("invalid_git_ref", `Git --${flagName} must be a non-empty ref string.`);
  }
  if (ref.startsWith("-") || ref.includes("\0") || /\s/.test(ref)) {
    throw new CliError("invalid_git_ref", `Invalid Git --${flagName}: '${ref}'.`);
  }
  return ref;
}

/**
 * Resolve the canonical realpath of the Git repository root from `cwd`.
 */
export function resolveGitRoot(cwd = process.cwd()) {
  let rawTop;
  try {
    rawTop = execGit(["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
  } catch (err) {
    if (err instanceof CliError) throw err;
    const detail = formatGitStderr(err);
    throw new CliError(
      "not_git_repo",
      `Must run inside a Git repository (cwd: '${cwd}')${detail ? `: ${detail}` : "."}`,
    );
  }

  const trimmed = rawTop.replace(/\r?\n$/, "");
  if (!trimmed) {
    throw new CliError("not_git_repo", `git rev-parse --show-toplevel returned empty output for '${cwd}'.`);
  }
  try {
    return fs.realpathSync(trimmed);
  } catch (err) {
    throw new CliError("git_error", `Unable to resolve Git root '${trimmed}': ${err.message}`);
  }
}

/**
 * Resolve `<ref>` to a full commit SHA via `git rev-parse --verify <ref>^{commit}`.
 */
export function resolveCommitSha(gitRoot, ref, flagName = "base-ref") {
  const safeRef = validateGitRef(ref, flagName);
  let out;
  try {
    out = execGit(["-C", gitRoot, "rev-parse", "--verify", `${safeRef}^{commit}`], {
      cwd: gitRoot,
      encoding: "utf8",
    });
  } catch (err) {
    if (err instanceof CliError) throw err;
    const detail = formatGitStderr(err);
    throw new CliError(
      "missing_commit",
      `Unable to resolve --${flagName} '${safeRef}' to a Git commit${detail ? `: ${detail}` : "."}`,
    );
  }

  const sha = out.trim();
  if (!COMMIT_SHA_RE.test(sha)) {
    throw new CliError(
      "missing_commit",
      `git rev-parse --verify returned unexpected commit SHA '${sha}' for --${flagName} '${safeRef}'.`,
    );
  }
  return sha.toLowerCase();
}

/**
 * Read exact raw UTF-8 bytes of `<relPosixPath>` at `<commitSha>` via `git cat-file`.
 */
export function readBlobAtCommit(gitRoot, commitSha, refLabel, relPosixPath) {
  const shortSha = commitSha.slice(0, 7);
  const spec = `${commitSha}:${relPosixPath}`;

  try {
    execGit(["-C", gitRoot, "cat-file", "-e", spec], {
      cwd: gitRoot,
      encoding: "buffer",
    });
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw new CliError(
      "missing_blob",
      `Missing baseline file '${relPosixPath}' at ${refLabel} (${shortSha}).`,
      { details: { ref: refLabel, commit_sha: commitSha, short_sha: shortSha, snippet_path: relPosixPath } },
    );
  }

  let objType;
  try {
    objType = execGit(["-C", gitRoot, "cat-file", "-t", spec], {
      cwd: gitRoot,
      encoding: "utf8",
    }).trim();
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw new CliError(
      "missing_blob",
      `Failed inspecting Git object '${relPosixPath}' at ${refLabel} (${shortSha}): ${formatGitStderr(err)}`,
    );
  }

  if (objType !== "blob") {
    throw new CliError(
      "invalid_blob",
      `Expected file blob for '${relPosixPath}' at ${refLabel} (${shortSha}), found '${objType}'.`,
    );
  }

  let rawBuffer;
  try {
    rawBuffer = execGit(["-C", gitRoot, "cat-file", "blob", spec], {
      cwd: gitRoot,
      encoding: "buffer",
    });
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw new CliError(
      "missing_blob",
      `Failed reading Git blob '${relPosixPath}' at ${refLabel} (${shortSha}): ${formatGitStderr(err)}`,
    );
  }

  decodeStrictUtf8(rawBuffer, `'${relPosixPath}' at ${refLabel} (${shortSha})`);
  return rawBuffer;
}

/**
 * Read exact raw UTF-8 bytes of `<relPosixPath>` from the working tree inside `gitRoot`.
 */
export function readWorkingTreeFile(gitRoot, relPosixPath) {
  const resolved = resolveRepoRelativePath(gitRoot, relPosixPath, "snippet_path", {
    mustExist: true,
  });

  let rawBuffer;
  try {
    rawBuffer = fs.readFileSync(resolved.realPath);
  } catch (err) {
    throw new CliError(
      "working_file_read_error",
      `Failed reading working tree file '${resolved.relPosixPath}': ${err.message}`,
    );
  }

  decodeStrictUtf8(rawBuffer, `Working tree file '${resolved.relPosixPath}'`);
  return rawBuffer;
}

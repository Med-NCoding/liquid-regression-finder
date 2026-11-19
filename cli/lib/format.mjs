import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CliError } from "./paths.mjs";

const CENT_PATH_RE = /(?:^|\.)(?:compare_at_)?price(?:_min|_max)?$/;

/**
 * Deterministic sorted-key compact UTF-8 JSON serializer matching Python `search/generator.py:canonical_json`.
 */
export function canonicalJson(value) {
  if (value === null) {
    return "null";
  }

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number": {
      if (!Number.isFinite(value)) {
        throw new RangeError("canonicalJson does not allow NaN or Infinity");
      }
      return Object.is(value, -0) ? "0" : JSON.stringify(value);
    }
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        const items = value.map((item) => (item === undefined ? "null" : canonicalJson(item)));
        return `[${items.join(",")}]`;
      }
      const keys = Object.keys(value)
        .filter((k) => value[k] !== undefined)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const entries = keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`);
      return `{${entries.join(",")}}`;
    }
    default:
      throw new TypeError(`Unsupported value type in canonicalJson: ${typeof value}`);
  }
}

/**
 * Atomically write `replayBundle` as canonical sorted-key compact UTF-8 JSON to `targetPath`.
 */
export function writeReplayAtomic(replayBundle, targetPath) {
  const absTarget = path.resolve(targetPath);
  const dir = path.dirname(absTarget);
  try {
    if (fs.existsSync(absTarget) && fs.lstatSync(absTarget).isDirectory()) {
      throw new CliError("replay_write_error", `Replay output path '${absTarget}' is a directory.`);
    }
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw new CliError("replay_write_error", `Failed preparing replay directory '${dir}': ${err.message}`);
  }

  const payloadBytes = Buffer.from(canonicalJson(replayBundle), "utf8");
  const tmpName = `.${path.basename(absTarget)}.tmp.${process.pid}.${crypto.randomBytes(6).toString("hex")}`;
  const tmpPath = path.join(dir, tmpName);

  try {
    fs.writeFileSync(tmpPath, payloadBytes);
    fs.renameSync(tmpPath, absTarget);
  } catch (err) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // Ignore cleanup failure.
    }
    throw new CliError("replay_write_error", `Failed writing replay file '${absTarget}': ${err.message}`);
  }
}

function sameScope(scopeA, scopeB) {
  if (!Array.isArray(scopeA) || !Array.isArray(scopeB) || scopeA.length !== scopeB.length) {
    return false;
  }
  for (let i = 0; i < scopeA.length; i += 1) {
    const a = scopeA[i];
    const b = scopeB[i];
    if (a.loop_id !== b.loop_id || a.iteration !== b.iteration || a.variant_id !== b.variant_id) {
      return false;
    }
  }
  return true;
}

function collectBranchOperands(events, branchIdx) {
  const branchEv = events[branchIdx];
  const nodeId = branchEv?.node_id;
  if (typeof nodeId !== "string" || !nodeId.endsWith(":branch")) {
    return { lookups: [], comparisons: [] };
  }

  const condPrefix = nodeId.slice(0, -":branch".length) + ".cond";
  const scope = branchEv.scope;
  const collected = [];

  for (let idx = branchIdx - 1; idx >= 0; idx -= 1) {
    const ev = events[idx];
    if (!sameScope(ev.scope, scope) || typeof ev.node_id !== "string" || !ev.node_id.startsWith(condPrefix)) {
      break;
    }
    const kind = ev.data?.kind;
    if (kind !== "lookup" && kind !== "comparison") {
      break;
    }
    collected.push(ev);
  }

  collected.reverse();
  const lookups = [];
  const comparisons = [];
  for (const ev of collected) {
    if (ev.data.kind === "lookup") {
      lookups.push(ev);
    } else if (ev.data.kind === "comparison") {
      comparisons.push(ev);
    }
  }
  return { lookups, comparisons };
}

function resolveElseSiblingBranchIdx(events, branchIdx) {
  const ev = events[branchIdx];
  const nodeId = ev?.node_id;
  if (typeof nodeId !== "string" || !nodeId.endsWith(".else:branch") || !nodeId.includes(":conditional.else:branch")) {
    return branchIdx;
  }
  const condBase = nodeId.slice(0, -".else:branch".length);
  const siblingArms = [];
  for (let idx = branchIdx - 1; idx >= 0; idx -= 1) {
    const prev = events[idx];
    if (sameScope(prev.scope, ev.scope) && prev.data?.kind === "branch") {
      const prevId = prev.node_id;
      if (prevId.startsWith(`${condBase}.a`) && prevId.endsWith(":branch")) {
        siblingArms.push(idx);
      } else if (!prevId.startsWith(`${condBase}.`)) {
        break;
      }
    }
  }
  return siblingArms.length === 1 ? siblingArms[0] : branchIdx;
}

function findEnclosingBranchForAssignment(events, assignIdx) {
  const assignEv = events[assignIdx];
  const assignNodeId = assignEv.node_id;
  const assignScope = assignEv.scope;
  for (let idx = assignIdx - 1; idx >= 0; idx -= 1) {
    const cand = events[idx];
    if (cand.data?.kind !== "branch" || cand.data?.taken !== true) continue;
    const candScope = cand.scope;
    if (candScope.length > assignScope.length) continue;
    if (!sameScope(assignScope.slice(0, candScope.length), candScope)) continue;
    const candId = cand.node_id;
    if (typeof candId !== "string" || !candId.endsWith(":branch")) continue;
    const armPrefix = candId.slice(0, -":branch".length);
    if (assignNodeId.startsWith(`${armPrefix}.b`) || assignNodeId.startsWith(`${armPrefix}.e`)) {
      return idx;
    }
  }
  return null;
}

function unwrapFlagGateBranch(events, startIdx) {
  let curIdx = resolveElseSiblingBranchIdx(events, startIdx);
  const visited = new Set();

  for (let hop = 0; hop < 4; hop += 1) {
    const { lookups, comparisons } = collectBranchOperands(events, curIdx);
    if (lookups.length !== 1 || comparisons.length > 0) {
      break;
    }
    const varName = lookups[0].data.path;
    const readVal = lookups[0].data.value;
    if (typeof varName !== "string" || varName.includes(".")) {
      break;
    }

    let matchingAssignIdx = null;
    let fallbackAssignIdx = null;
    for (let idx = curIdx - 1; idx >= 0; idx -= 1) {
      const cand = events[idx];
      if (cand.data?.kind === "assignment" && cand.data?.name === varName) {
        if (fallbackAssignIdx === null) fallbackAssignIdx = idx;
        if (cand.data?.value === readVal) {
          matchingAssignIdx = idx;
          break;
        }
      }
    }

    const assignIdx = matchingAssignIdx !== null ? matchingAssignIdx : fallbackAssignIdx;
    if (assignIdx === null || visited.has(assignIdx)) break;
    visited.add(assignIdx);

    const enclosingIdx = findEnclosingBranchForAssignment(events, assignIdx);
    if (enclosingIdx === null) break;
    curIdx = enclosingIdx;
  }

  return curIdx;
}

function findFallbackBranchIdx(events, observed) {
  if (observed) {
    const emits = events.filter((ev) => ev.data?.kind === "emit" && Array.isArray(ev.data.active_branch_seqs) && ev.data.active_branch_seqs.length > 0);
    if (emits.length > 0) {
      const lastSeq = emits[emits.length - 1].data.active_branch_seqs[emits[emits.length - 1].data.active_branch_seqs.length - 1];
      const idx = events.findIndex((ev) => ev.seq === lastSeq);
      if (idx !== -1) return idx;
    }
    for (let i = events.length - 1; i >= 0; i -= 1) {
      if (events[i].data?.kind === "branch" && events[i].data?.taken === true) return i;
    }
  } else {
    let fallback = -1;
    for (let i = events.length - 1; i >= 0; i -= 1) {
      if (events[i].data?.kind === "branch" && events[i].data?.taken === false) {
        const { comparisons } = collectBranchOperands(events, i);
        if (comparisons.length > 0) return i;
        if (fallback === -1) fallback = i;
      }
    }
    if (fallback !== -1) return fallback;
  }
  return events.findIndex((ev) => ev.data?.kind === "branch");
}

function isNilGuardComparison(cmpEvent) {
  const { op, left, right } = cmpEvent.data;
  return (op === "!=" || op === "==") && (left === null || right === null);
}

function pickDecisiveComparison(comparisons, branchCondition) {
  if (comparisons.length === 0) return null;
  if (comparisons.length === 1) return comparisons[0];

  if (branchCondition === false) {
    const falseCmps = comparisons.filter((ev) => ev.data.result === false);
    if (falseCmps.length > 0) {
      const nonGuard = falseCmps.filter((ev) => !isNilGuardComparison(ev));
      const pool = nonGuard.length > 0 ? nonGuard : falseCmps;
      return pool[pool.length - 1];
    }
  }

  const nonGuard = comparisons.filter((ev) => !isNilGuardComparison(ev));
  const pool = nonGuard.length > 0 ? nonGuard : comparisons;
  const matchingOutcome = pool.filter((ev) => ev.data.result === branchCondition);
  const chosenPool = matchingOutcome.length > 0 ? matchingOutcome : pool;
  return chosenPool[chosenPool.length - 1];
}

function isCentPath(lookupPath) {
  return typeof lookupPath === "string" && CENT_PATH_RE.test(lookupPath);
}

function formatOperand(val, isCents) {
  if (val === null) return "nil";
  if (typeof val === "boolean") return val ? "true" : "false";
  if (typeof val === "number") {
    if (isCents && Number.isInteger(val)) {
      return `${val}c`;
    }
    return String(val);
  }
  return JSON.stringify(val);
}

function resolveSubject(branchEvent, lookupPaths) {
  const scope = Array.isArray(branchEvent.scope) ? branchEvent.scope : [];
  for (let i = scope.length - 1; i >= 0; i -= 1) {
    const vid = scope[i]?.variant_id;
    if (typeof vid === "string" && vid.length > 0) {
      return vid;
    }
  }
  for (const p of lookupPaths) {
    if (typeof p === "string" && p.includes(".")) {
      return p.split(".", 1)[0];
    }
  }
  return "product";
}

function describeSideExecution(sideResult, anchor) {
  const events = Array.isArray(sideResult?.events) ? sideResult.events : [];
  const observed = Boolean(sideResult?.observed);
  const badgeClause = observed ? "Badge shown." : "Badge absent.";

  let branchIdx = -1;
  if (anchor && typeof anchor.event_seq === "number") {
    branchIdx = events.findIndex((ev) => ev.seq === anchor.event_seq);
  }
  if (branchIdx === -1) {
    branchIdx = findFallbackBranchIdx(events, observed);
  }
  if (branchIdx === -1 || events[branchIdx]?.data?.kind !== "branch") {
    return `product evaluated unconditionally. ${badgeClause}`;
  }

  const effectiveIdx = unwrapFlagGateBranch(events, branchIdx);
  const branchEv = events[effectiveIdx];
  const { lookups, comparisons } = collectBranchOperands(events, effectiveIdx);
  const decisiveCmp = pickDecisiveComparison(comparisons, branchEv.data.condition);

  if (decisiveCmp) {
    const cmpBase = decisiveCmp.node_id.replace(/:comparison$/, "");
    const leftLookup = lookups.find(
      (l) => l.node_id === `${cmpBase}.l:lookup` || l.node_id.startsWith(`${cmpBase}.l.`),
    );
    const rightLookup = lookups.find(
      (l) => l.node_id === `${cmpBase}.r:lookup` || l.node_id.startsWith(`${cmpBase}.r.`),
    );
    const relevantPaths = [
      leftLookup?.data?.path,
      rightLookup?.data?.path,
      ...lookups.map((l) => l.data?.path),
    ].filter(Boolean);

    const subject = resolveSubject(branchEv, relevantPaths);
    const exprText = branchEv.data?.expression || "";
    const useCents =
      isCentPath(leftLookup?.data?.path) ||
      isCentPath(rightLookup?.data?.path) ||
      (!leftLookup && !rightLookup && /\b(?:compare_at_)?price(?:_min|_max)?\b/.test(exprText));

    const { op, left, right, result } = decisiveCmp.data;
    return `${subject} compared ${formatOperand(left, useCents)} ${op} ${formatOperand(right, useCents)}, ${result ? "true" : "false"}. ${badgeClause}`;
  }

  const lookupPaths = lookups.map((l) => l.data?.path).filter(Boolean);
  const subject = resolveSubject(branchEv, lookupPaths);
  const expr = branchEv.data?.expression || "condition";
  const condResult = branchEv.data?.condition ? "true" : "false";
  return `${subject} evaluated ${expr}, ${condResult}. ${badgeClause}`;
}

/**
 * Format a confirmed `difference_found` compare report into the exact 4-line human block.
 */
export function formatCompareFinding(report, { snippetPath, replayRelPath }) {
  const finding = report.finding;
  const explanation = finding.explanation || {};
  const anchorLine = explanation.after?.line ?? explanation.before?.line ?? 1;
  const headline = finding.before.observed && !finding.after.observed
    ? "Sale badge disappeared"
    : "Sale badge appeared";

  const beforeLine = describeSideExecution(finding.before, explanation.before);
  const afterLine = describeSideExecution(finding.after, explanation.after);

  return [
    `${snippetPath}:${anchorLine} ${headline}`,
    `Before: ${beforeLine}`,
    `After:  ${afterLine}`,
    `Official Liquid confirmed. Replay in ${replayRelPath}.`,
  ].join("\n");
}

/**
 * Format a `replayed` report into a concise human summary with Before/After outcomes and Official Liquid parity.
 */
export function formatReplaySummary(report, { bundleDisplayPath }) {
  const explanation = report.explanation || {};
  const headline = report.before.observed && !report.after.observed
    ? "Sale badge disappeared"
    : "Sale badge appeared";
  const variantCount = report.replay?.fixture?.variants?.length ?? 0;
  const liquidVersion = report.replay?.liquid_version || "5.14.0";
  const beforeLine = describeSideExecution(report.before, explanation.before);
  const afterLine = describeSideExecution(report.after, explanation.after);
  const refBefore = report.reference?.before?.observed ? "shown" : "absent";
  const refAfter = report.reference?.after?.observed ? "shown" : "absent";

  return [
    `Replay verified (${bundleDisplayPath}, ${variantCount} variant(s)): ${headline}`,
    `Before: ${beforeLine}`,
    `After:  ${afterLine}`,
    `Official Liquid ${liquidVersion} parity confirmed (before: ${refBefore}, after: ${refAfter}).`,
  ].join("\n");
}

/**
 * Format an engine failure report into an actionable single-line diagnostic.
 */
export function formatEngineFailure(report, snippetPath) {
  const err = report?.error || {};
  const code = err.code || "engine_error";
  const msg = err.message || report?.message || "Comparison engine failed.";
  const span = err.span;
  if (span && typeof span.line === "number" && typeof span.column === "number") {
    return `Error [${code}] (${snippetPath}:${span.line}:${span.column}): ${msg}`;
  }
  return `Error [${code}] (${snippetPath}): ${msg}`;
}

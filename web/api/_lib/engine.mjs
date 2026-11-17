import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

function getJobsDir() {
  return process.env.LRF_TMP_JOBS_DIR || "/tmp/lrf-jobs";
}

const MAX_SNIPPET_BYTES = 16_384;
const MAX_BODY_BYTES = 1_048_576;
const MAX_SEED = 4_294_967_295;
const MAX_SEARCH_PAIRS = 5_000;
const MAX_SHRINK_PAIRS = 1_000;
const MAX_DEPTH = 32;
const MAX_STEPS = 50_000;
const MAX_OUTPUT_BYTES = 131_072;
const MAX_TRACE_EVENTS = 10_000;

const INTERPRETER_VERSION = "0.1.0";
const LIQUID_VERSION = "5.14.0";
const PROJECTION_VERSION = "1.0.0";

const FORBIDDEN_PATH_KEYS = new Set(["path", "file", "before_path", "after_path"]);
const TOP_LEVEL_KEYS = ["after", "before", "budget", "observer", "schema_version", "seed"];
const BUDGET_KEYS = ["search_pairs", "shrink_pairs"];

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RangeError("Non-finite number");
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  throw new TypeError(`Unsupported JSON type: ${typeof value}`);
}

function sha256Hex(str) {
  return crypto.createHash("sha256").update(str, "utf8").digest("hex");
}

function makeDiagnostic(code, message, span = null) {
  return { code, message, span };
}

class EngineDiagnosticError extends Error {
  constructor(code, message, span = null, statusCode = 422) {
    super(message);
    this.code = code;
    this.span = span;
    this.statusCode = statusCode;
  }
}

export async function readRawRequestBody(req) {
  if (typeof req.body === "string") return req.body;
  if (Buffer.isBuffer(req.body)) return utf8Decoder.decode(req.body);
  if (req.body && typeof req.body === "object") return JSON.stringify(req.body);

  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      throw new EngineDiagnosticError(
        "snippet_too_large",
        `Request body exceeds maximum payload limit (${MAX_BODY_BYTES} bytes)`,
      );
    }
    chunks.push(buf);
  }
  try {
    return utf8Decoder.decode(Buffer.concat(chunks));
  } catch {
    throw new EngineDiagnosticError("invalid_utf8", "Request body is not valid UTF-8");
  }
}

export function validateCompareRequest(rawBody) {
  if (typeof rawBody !== "string") {
    throw new EngineDiagnosticError("invalid_request", "Request body must be a JSON object");
  }
  const bodyBytes = utf8Encoder.encode(rawBody).length;
  if (bodyBytes > MAX_BODY_BYTES) {
    throw new EngineDiagnosticError(
      "snippet_too_large",
      `Request body (${bodyBytes} bytes) exceeds maximum payload limit (${MAX_BODY_BYTES} bytes)`,
    );
  }
  if (rawBody.trim().length === 0) {
    throw new EngineDiagnosticError("invalid_json", "Request body must not be empty");
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (err) {
    throw new EngineDiagnosticError("invalid_json", `Malformed JSON request body: ${err.message}`);
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new EngineDiagnosticError("invalid_request", "CompareRequest must be a JSON object");
  }

  for (const key of Object.keys(payload)) {
    if (FORBIDDEN_PATH_KEYS.has(key)) {
      throw new EngineDiagnosticError(
        "invalid_request",
        `Arbitrary filesystem source keys (${key}) are not permitted on CompareRequest`,
      );
    }
  }

  const keys = Object.keys(payload).sort();
  if (JSON.stringify(keys) !== JSON.stringify(TOP_LEVEL_KEYS)) {
    throw new EngineDiagnosticError(
      "invalid_request",
      "CompareRequest must contain exact keys: schema_version, before, after, observer, seed, budget",
    );
  }

  if (!Number.isInteger(payload.schema_version) || payload.schema_version !== 1) {
    throw new EngineDiagnosticError("invalid_request", "CompareRequest.schema_version must be integer 1");
  }

  for (const side of ["before", "after"]) {
    const snip = payload[side];
    if (!snip || typeof snip !== "object" || Array.isArray(snip)) {
      throw new EngineDiagnosticError("invalid_request", `CompareRequest.${side} must be a JSON object`);
    }
    for (const key of Object.keys(snip)) {
      if (FORBIDDEN_PATH_KEYS.has(key)) {
        throw new EngineDiagnosticError(
          "invalid_request",
          `Arbitrary filesystem source keys (${key}) are not permitted on CompareRequest.${side}`,
        );
      }
    }
    if (JSON.stringify(Object.keys(snip)) !== JSON.stringify(["source"])) {
      throw new EngineDiagnosticError("invalid_request", `CompareRequest.${side} must have exact key 'source'`);
    }
    if (typeof snip.source !== "string") {
      throw new EngineDiagnosticError("invalid_request", `CompareRequest.${side}.source must be a string`);
    }
    const len = utf8Encoder.encode(snip.source).length;
    if (len > MAX_SNIPPET_BYTES) {
      throw new EngineDiagnosticError(
        "snippet_too_large",
        `CompareRequest.${side}.source (${len} bytes) exceeds ${MAX_SNIPPET_BYTES} byte limit`,
      );
    }
  }

  if (payload.observer !== "sale_badge") {
    throw new EngineDiagnosticError(
      "unsupported_observer",
      `Unsupported observer ${JSON.stringify(payload.observer)}; only 'sale_badge' is supported`,
    );
  }

  if (!Number.isInteger(payload.seed) || payload.seed < 0 || payload.seed > MAX_SEED) {
    throw new EngineDiagnosticError("invalid_request", `CompareRequest.seed must be an integer in 0..${MAX_SEED}`);
  }

  const budget = payload.budget;
  if (
    !budget ||
    typeof budget !== "object" ||
    Array.isArray(budget) ||
    JSON.stringify(Object.keys(budget).sort()) !== JSON.stringify(BUDGET_KEYS)
  ) {
    throw new EngineDiagnosticError(
      "invalid_request",
      "CompareRequest.budget must have exact keys search_pairs and shrink_pairs",
    );
  }

  if (!Number.isInteger(budget.search_pairs) || budget.search_pairs < 1 || budget.search_pairs > MAX_SEARCH_PAIRS) {
    throw new EngineDiagnosticError(
      "invalid_request",
      `CompareRequest.budget.search_pairs must be an integer in 1..${MAX_SEARCH_PAIRS}`,
    );
  }

  if (!Number.isInteger(budget.shrink_pairs) || budget.shrink_pairs < 0 || budget.shrink_pairs > MAX_SHRINK_PAIRS) {
    throw new EngineDiagnosticError(
      "invalid_request",
      `CompareRequest.budget.shrink_pairs must be an integer in 0..${MAX_SHRINK_PAIRS}`,
    );
  }

  return payload;
}

class SpanMapper {
  constructor(source) {
    this.source = source;
    this.utf8Bytes = Buffer.from(source, "utf8");
    this.charToByte = [0];
    this.lineStartChars = [0];
    let byteOffset = 0;
    for (let i = 0; i < source.length; ) {
      const cp = source.codePointAt(i);
      const charLen = cp > 0xffff ? 2 : 1;
      const ch = source.slice(i, i + charLen);
      byteOffset += Buffer.byteLength(ch, "utf8");
      for (let k = 0; k < charLen; k++) {
        this.charToByte.push(byteOffset);
      }
      if (ch === "\n") {
        this.lineStartChars.push(i + 1);
      }
      i += charLen;
    }
  }

  spanForChars(startChar, endChar) {
    const start = Math.max(0, Math.min(startChar, this.source.length));
    const end = Math.max(start, Math.min(endChar, this.source.length));
    let lo = 0;
    let hi = this.lineStartChars.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.lineStartChars[mid] <= start) lo = mid + 1;
      else hi = mid - 1;
    }
    const lineIdx = Math.max(0, hi);
    const lineStart = this.lineStartChars[lineIdx];
    const colPrefix = this.source.slice(lineStart, start);
    const column = Array.from(colPrefix).length + 1;
    return {
      start_byte: this.charToByte[start],
      end_byte: this.charToByte[end],
      line: lineIdx + 1,
      column,
    };
  }
}

function lexLiquid(source) {
  const mapper = new SpanMapper(source);
  const tokens = [];
  let pos = 0;

  while (pos < source.length) {
    const nextOut = source.indexOf("{{", pos);
    const nextTag = source.indexOf("{%", pos);
    let next = -1;
    let kind = null;

    if (nextOut !== -1 && (nextTag === -1 || nextOut < nextTag)) {
      next = nextOut;
      kind = "output";
    } else if (nextTag !== -1) {
      next = nextTag;
      kind = "tag";
    }

    if (next === -1) {
      if (pos < source.length) {
        tokens.push({ kind: "text", content: source.slice(pos), rawStart: pos, rawEnd: source.length });
      }
      break;
    }

    if (next > pos) {
      tokens.push({ kind: "text", content: source.slice(pos, next), rawStart: pos, rawEnd: next });
    }

    const closeDelim = kind === "output" ? "}}" : "%}";
    const closeIdx = findLiquidTagEnd(source, next + 2, closeDelim);
    if (closeIdx === -1) {
      throw new EngineDiagnosticError(
        "syntax_error",
        `Unclosed Liquid ${kind === "output" ? "output" : "tag"} delimiter`,
        mapper.spanForChars(next, source.length),
      );
    }

    let inner = source.slice(next + 2, closeIdx);
    let trimLeft = false;
    let trimRight = false;
    if (inner.startsWith("-")) {
      trimLeft = true;
      inner = inner.slice(1);
    }
    if (inner.endsWith("-")) {
      trimRight = true;
      inner = inner.slice(0, -1);
    }

    tokens.push({
      kind,
      content: inner.trim(),
      trimLeft,
      trimRight,
      rawStart: next,
      rawEnd: closeIdx + 2,
    });
    pos = closeIdx + 2;
  }

  // Apply Liquid whitespace trimming on adjacent text tokens
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.kind === "text") continue;
    if (tok.trimLeft && i > 0 && tokens[i - 1].kind === "text") {
      tokens[i - 1].content = tokens[i - 1].content.replace(/[ \t\r\n]+$/, "");
    }
    if (tok.trimRight && i + 1 < tokens.length && tokens[i + 1].kind === "text") {
      tokens[i + 1].content = tokens[i + 1].content.replace(/^[ \t\r\n]+/, "");
    }
  }

  return { tokens, mapper };
}

function findLiquidTagEnd(source, start, closeDelim) {
  let quote = null;
  for (let i = start; i < source.length - 1; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (source[i] === closeDelim[0] && source[i + 1] === closeDelim[1]) {
      return i;
    }
  }
  return -1;
}

function tokenizeExpression(expr, mapper, baseOffset) {
  const out = [];
  let i = 0;
  while (i < expr.length) {
    if (/\s/.test(expr[i])) {
      i++;
      continue;
    }
    const two = expr.slice(i, i + 2);
    if (two === "==" || two === "!=" || two === "<=" || two === ">=") {
      out.push({ type: "op", value: two, start: baseOffset + i, end: baseOffset + i + 2 });
      i += 2;
      continue;
    }
    if (expr[i] === "<" || expr[i] === ">" || expr[i] === "|") {
      out.push({ type: expr[i] === "|" ? "pipe" : "op", value: expr[i], start: baseOffset + i, end: baseOffset + i + 1 });
      i++;
      continue;
    }
    if (expr[i] === '"' || expr[i] === "'") {
      const q = expr[i];
      let j = i + 1;
      while (j < expr.length && expr[j] !== q) j++;
      if (j >= expr.length) {
        throw new EngineDiagnosticError("syntax_error", "Unterminated string literal", mapper.spanForChars(baseOffset + i, baseOffset + expr.length));
      }
      out.push({ type: "string", value: expr.slice(i + 1, j), start: baseOffset + i, end: baseOffset + j + 1 });
      i = j + 1;
      continue;
    }
    const numMatch = expr.slice(i).match(/^-?\d+(?:\.\d+)?(?![A-Za-z_])/);
    if (numMatch) {
      out.push({ type: "number", value: Number(numMatch[0]), start: baseOffset + i, end: baseOffset + i + numMatch[0].length });
      i += numMatch[0].length;
      continue;
    }
    const idMatch = expr.slice(i).match(/^[A-Za-z_][A-Za-z0-9_.-]*\??/);
    if (idMatch) {
      const word = idMatch[0];
      out.push({ type: "word", value: word, start: baseOffset + i, end: baseOffset + i + word.length });
      i += word.length;
      continue;
    }
    throw new EngineDiagnosticError(
      "syntax_error",
      `Unexpected character ${JSON.stringify(expr[i])} in expression`,
      mapper.spanForChars(baseOffset + i, baseOffset + i + 1),
    );
  }
  return out;
}

function parseAtom(token) {
  if (token.type === "string") return { type: "literal", value: token.value, token };
  if (token.type === "number") return { type: "literal", value: token.value, token };
  if (token.type === "word") {
    if (token.value === "true") return { type: "literal", value: true, token };
    if (token.value === "false") return { type: "literal", value: false, token };
    if (token.value === "nil" || token.value === "null") return { type: "literal", value: null, token };
    return { type: "path", path: token.value, token };
  }
  return null;
}

function parseBooleanExpression(rawExpr, mapper, baseOffset, nodePrefix) {
  const tokens = tokenizeExpression(rawExpr, mapper, baseOffset);
  if (tokens.length === 0) {
    throw new EngineDiagnosticError("syntax_error", "Empty condition expression", mapper.spanForChars(baseOffset, baseOffset + rawExpr.length));
  }

  // Split by logical `and` / `or` respecting right-associative grouping of Liquid
  const groups = [];
  let cur = [];
  const ops = [];
  for (const tok of tokens) {
    if (tok.type === "word" && (tok.value === "and" || tok.value === "or")) {
      groups.push(cur);
      ops.push(tok.value);
      cur = [];
    } else {
      cur.push(tok);
    }
  }
  groups.push(cur);

  const parseComparisonGroup = (gTokens, pathPrefix) => {
    if (gTokens.length === 1) {
      const atom = parseAtom(gTokens[0]);
      if (!atom) throw new EngineDiagnosticError("syntax_error", "Invalid condition operand", mapper.spanForChars(baseOffset, baseOffset + rawExpr.length));
      if (atom.type === "path") atom.nodeId = `${pathPrefix}:lookup`;
      return atom;
    }
    if (gTokens.length === 3 && (gTokens[1].type === "op" || (gTokens[1].type === "word" && gTokens[1].value === "contains"))) {
      const left = parseAtom(gTokens[0]);
      const right = parseAtom(gTokens[2]);
      if (!left || !right) {
        throw new EngineDiagnosticError("syntax_error", "Invalid comparison operands", mapper.spanForChars(baseOffset, baseOffset + rawExpr.length));
      }
      if (left.type === "path") left.nodeId = `${pathPrefix}.l:lookup`;
      if (right.type === "path") right.nodeId = `${pathPrefix}.r:lookup`;
      return {
        type: "compare",
        op: gTokens[1].value,
        left,
        right,
        nodeId: `${pathPrefix}:comparison`,
        span: mapper.spanForChars(gTokens[0].start, gTokens[2].end),
      };
    }
    throw new EngineDiagnosticError("syntax_error", `Unsupported expression syntax: ${rawExpr}`, mapper.spanForChars(baseOffset, baseOffset + rawExpr.length));
  };

  if (ops.length === 0) {
    return parseComparisonGroup(groups[0], `${nodePrefix}.cond`);
  }

  // Right-associative grouping: a op1 (b op2 c)
  const buildChain = (idx, prefix) => {
    if (idx === ops.length) {
      return parseComparisonGroup(groups[idx], prefix);
    }
    const left = parseComparisonGroup(groups[idx], `${prefix}.l`);
    const right = buildChain(idx + 1, `${prefix}.r`);
    return {
      type: "logical",
      op: ops[idx],
      left,
      right,
    };
  };

  return buildChain(0, `${nodePrefix}.cond`);
}

function parseTemplate(source) {
  const { tokens, mapper } = lexLiquid(source);
  let index = 0;

  function parseBlock(stopKeywords, pathPrefix, depth) {
    if (depth > MAX_DEPTH) {
      throw new EngineDiagnosticError(
        "depth_limit_exceeded",
        `Template nesting depth ${depth} exceeds maximum ${MAX_DEPTH}`,
        null,
      );
    }
    const body = [];
    let stmtIdx = 0;

    while (index < tokens.length) {
      const tok = tokens[index];
      if (tok.kind === "text") {
        index++;
        if (tok.content.length > 0) {
          body.push({
            type: "text",
            text: tok.content,
            nodeId: `${pathPrefix}n${stmtIdx++}:text`,
            span: mapper.spanForChars(tok.rawStart, tok.rawEnd),
          });
        }
        continue;
      }

      if (tok.kind === "output") {
        index++;
        const rawInner = source.slice(tok.rawStart + 2, tok.rawEnd - 2);
        const trimOffset = rawInner.startsWith("-") ? 1 : 0;
        const trimmedStart = tok.rawStart + 2 + trimOffset + (rawInner.slice(trimOffset).match(/^\s*/)?.[0].length || 0);
        const exprTokens = tokenizeExpression(tok.content, mapper, trimmedStart);
        if (exprTokens.length === 0) {
          body.push({
            type: "output",
            expr: { type: "literal", value: "", token: { start: trimmedStart, end: trimmedStart } },
            filters: [],
            nodeId: `${pathPrefix}n${stmtIdx++}:output`,
            span: mapper.spanForChars(tok.rawStart, tok.rawEnd),
          });
          continue;
        }
        const atom = parseAtom(exprTokens[0]);
        if (!atom) {
          throw new EngineDiagnosticError("syntax_error", `Unsupported output expression: ${tok.content}`, mapper.spanForChars(tok.rawStart, tok.rawEnd));
        }
        const nodeId = `${pathPrefix}n${stmtIdx++}:output`;
        if (atom.type === "path") atom.nodeId = `${nodeId}:lookup`;
        body.push({
          type: "output",
          expr: atom,
          nodeId,
          span: mapper.spanForChars(tok.rawStart, tok.rawEnd),
        });
        continue;
      }

      // Tag token
      const kwMatch = tok.content.match(/^([A-Za-z_][A-Za-z0-9_]*)\b(.*)$/s);
      if (!kwMatch) {
        throw new EngineDiagnosticError("syntax_error", `Invalid Liquid tag: ${tok.content}`, mapper.spanForChars(tok.rawStart, tok.rawEnd));
      }
      const kw = kwMatch[1];
      const rest = kwMatch[2].trim();

      if (stopKeywords.includes(kw)) {
        return { body, stopToken: tok, stopKeyword: kw, stopRest: rest };
      }

      index++;
      const tagNodeBase = `${pathPrefix}n${stmtIdx++}`;

      if (kw === "comment") {
        while (index < tokens.length) {
          const innerTok = tokens[index++];
          if (innerTok.kind === "tag" && innerTok.content === "endcomment") break;
        }
        continue;
      }

      if (kw === "assign") {
        const assignMatch = rest.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(.+)$/s);
        if (!assignMatch) {
          throw new EngineDiagnosticError("syntax_error", `Malformed assign tag: ${tok.content}`, mapper.spanForChars(tok.rawStart, tok.rawEnd));
        }
        const rawOffset = source.indexOf(assignMatch[2], tok.rawStart);
        const exprTokens = tokenizeExpression(assignMatch[2], mapper, rawOffset >= 0 ? rawOffset : tok.rawStart);
        const atom = exprTokens.length === 1 ? parseAtom(exprTokens[0]) : null;
        if (!atom) {
          throw new EngineDiagnosticError("syntax_error", `Unsupported assign RHS: ${assignMatch[2]}`, mapper.spanForChars(tok.rawStart, tok.rawEnd));
        }
        const nodeId = `${tagNodeBase}:assign`;
        if (atom.type === "path") atom.nodeId = `${nodeId}:lookup`;
        body.push({
          type: "assign",
          name: assignMatch[1],
          expr: atom,
          nodeId,
          span: mapper.spanForChars(tok.rawStart, tok.rawEnd),
        });
        continue;
      }

      if (kw === "for") {
        const forMatch = rest.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s+in\s+([A-Za-z_][A-Za-z0-9_.-]*)$/);
        if (!forMatch) {
          throw new EngineDiagnosticError("syntax_error", `Malformed for tag: ${tok.content}`, mapper.spanForChars(tok.rawStart, tok.rawEnd));
        }
        const loopId = `${tagNodeBase}:for`;
        const collStart = source.indexOf(forMatch[2], tok.rawStart);
        const parsedLoopBody = parseBlock(["else", "endfor"], `${loopId}.b0:`, depth + 1);
        if (!parsedLoopBody.stopToken) {
          throw new EngineDiagnosticError("syntax_error", "Missing {% endfor %}", mapper.spanForChars(tok.rawStart, tok.rawEnd));
        }
        let elseBody = [];
        if (parsedLoopBody.stopKeyword === "else") {
          index++;
          const parsedElse = parseBlock(["endfor"], `${loopId}.else:`, depth + 1);
          if (!parsedElse.stopToken) {
            throw new EngineDiagnosticError("syntax_error", "Missing {% endfor %}", mapper.spanForChars(tok.rawStart, tok.rawEnd));
          }
          elseBody = parsedElse.body;
        }
        index++;
        body.push({
          type: "for",
          binder: forMatch[1],
          collectionPath: forMatch[2],
          collNodeId: `${loopId}.coll:lookup`,
          collSpan: mapper.spanForChars(collStart >= 0 ? collStart : tok.rawStart, (collStart >= 0 ? collStart : tok.rawStart) + forMatch[2].length),
          loopId,
          body: parsedLoopBody.body,
          elseBody,
          span: mapper.spanForChars(tok.rawStart, tok.rawEnd),
        });
        continue;
      }

      if (kw === "if" || kw === "unless") {
        const condBase = `${tagNodeBase}:conditional`;
        const arms = [];
        let armIdx = 0;
        let currentKw = kw;
        let currentRest = rest;
        let currentTok = tok;
        let elseBody = null;

        while (true) {
          const armPrefix = `${condBase}.a${armIdx}`;
          const condOffset = source.indexOf(currentRest, currentTok.rawStart);
          const condition = parseBooleanExpression(currentRest, mapper, condOffset >= 0 ? condOffset : currentTok.rawStart, armPrefix);
          const parsedArm = parseBlock(["elsif", "else", "endif", "endunless"], `${armPrefix}.b0:`, depth + 1);
          if (!parsedArm.stopToken) {
            throw new EngineDiagnosticError(
              "syntax_error",
              `Unclosed {% ${kw} %} block`,
              mapper.spanForChars(currentTok.rawStart, currentTok.rawEnd),
            );
          }
          arms.push({
            inverted: currentKw === "unless",
            rawExpression: currentRest,
            condition,
            body: parsedArm.body,
            nodeId: `${armPrefix}:branch`,
            span: mapper.spanForChars(currentTok.rawStart, currentTok.rawEnd),
          });
          armIdx++;

          if (parsedArm.stopKeyword === "elsif") {
            index++;
            currentKw = "elsif";
            currentRest = parsedArm.stopRest;
            currentTok = parsedArm.stopToken;
            continue;
          }
          if (parsedArm.stopKeyword === "else") {
            index++;
            const parsedElse = parseBlock([kw === "unless" ? "endunless" : "endif"], `${condBase}.else:`, depth + 1);
            if (!parsedElse.stopToken) {
              throw new EngineDiagnosticError("syntax_error", `Missing {% end${kw} %}`, mapper.spanForChars(tok.rawStart, tok.rawEnd));
            }
            elseBody = {
              body: parsedElse.body,
              nodeId: `${condBase}.else:branch`,
              span: mapper.spanForChars(parsedArm.stopToken.rawStart, parsedArm.stopToken.rawEnd),
            };
          }
          index++;
          break;
        }

        body.push({
          type: "conditional",
          arms,
          elseBody,
          nodeId: condBase,
        });
        continue;
      }

      throw new EngineDiagnosticError(
        "unsupported_feature",
        `Unsupported Liquid tag '{% ${kw} %}'`,
        mapper.spanForChars(tok.rawStart, tok.rawEnd),
      );
    }

    return { body, stopToken: null, stopKeyword: null, stopRest: null };
  }

  const root = parseBlock([], "", 0);
  if (root.stopToken) {
    throw new EngineDiagnosticError(
      "syntax_error",
      `Unexpected tag '{% ${root.stopKeyword} %}'`,
      mapper.spanForChars(root.stopToken.rawStart, root.stopToken.rawEnd),
    );
  }
  return { body: root.body, mapper };
}

function isTruthy(val) {
  return val !== false && val !== null && val !== undefined;
}

function liquidCompare(op, left, right) {
  if (op === "==") {
    if (left === null || right === null) return left === right;
    return JSON.stringify(left) === JSON.stringify(right);
  }
  if (op === "!=") {
    if (left === null || right === null) return left !== right;
    return JSON.stringify(left) !== JSON.stringify(right);
  }
  if (op === "contains") {
    if (typeof left === "string" && typeof right === "string") return left.includes(right);
    if (Array.isArray(left)) return left.some((item) => item === right);
    return false;
  }
  if (typeof left === "number" && typeof right === "number") {
    if (op === "<") return left < right;
    if (op === "<=") return left <= right;
    if (op === ">") return left > right;
    if (op === ">=") return left >= right;
  }
  if (typeof left === "string" && typeof right === "string") {
    if (op === "<") return left < right;
    if (op === "<=") return left <= right;
    if (op === ">") return left > right;
    if (op === ">=") return left >= right;
  }
  return false;
}

function evaluateAst(ast, assigns, trace) {
  const rootScope = structuredClone(assigns);
  const loopScopes = [];
  const scopeFrames = [];
  const activeBranchSeqs = [];
  const events = [];
  const outputChunks = [];
  let outputBytes = 0;
  let steps = 0;

  const snapshotScope = () => scopeFrames.map((f) => ({ ...f }));
  const emitEvent = (nodeId, span, data) => {
    if (!trace) return;
    if (events.length >= MAX_TRACE_EVENTS) {
      throw new EngineDiagnosticError("trace_limit_exceeded", `Trace events exceeded ${MAX_TRACE_EVENTS}`);
    }
    events.push({
      seq: events.length,
      node_id: nodeId,
      scope: snapshotScope(),
      span,
      data,
    });
  };

  const lookupPath = (pathStr, nodeId, span) => {
    const parts = pathStr.split(".");
    let cur = undefined;
    let found = false;

    for (let i = loopScopes.length - 1; i >= 0; i--) {
      if (Object.prototype.hasOwnProperty.call(loopScopes[i], parts[0])) {
        cur = loopScopes[i][parts[0]];
        found = true;
        break;
      }
    }
    if (!found && Object.prototype.hasOwnProperty.call(rootScope, parts[0])) {
      cur = rootScope[parts[0]];
      found = true;
    }

    for (let i = 1; i < parts.length && found; i++) {
      const seg = parts[i];
      if (cur !== null && typeof cur === "object" && !Array.isArray(cur) && Object.prototype.hasOwnProperty.call(cur, seg)) {
        cur = cur[seg];
      } else if (seg === "size" && (Array.isArray(cur) || typeof cur === "string" || (cur !== null && typeof cur === "object"))) {
        cur = Array.isArray(cur) ? cur.length : typeof cur === "string" ? Array.from(cur).length : Object.keys(cur).length;
      } else {
        cur = null;
        found = false;
      }
    }

    const value = found ? structuredClone(cur) : null;
    if (nodeId && span) {
      emitEvent(nodeId, span, { kind: "lookup", path: pathStr, found, value });
    }
    return value;
  };

  const evalExpr = (expr, fallbackSpan) => {
    steps++;
    if (steps > MAX_STEPS) {
      throw new EngineDiagnosticError("step_limit_exceeded", `Evaluation exceeded ${MAX_STEPS} steps`);
    }
    if (expr.type === "literal") return expr.value;
    if (expr.type === "path") {
      const span = ast.mapper.spanForChars(expr.token.start, expr.token.end);
      return lookupPath(expr.path, expr.nodeId, span);
    }
    if (expr.type === "compare") {
      const lVal = evalExpr(expr.left, expr.span);
      const rVal = evalExpr(expr.right, expr.span);
      const res = liquidCompare(expr.op, lVal, rVal);
      if (expr.op !== "contains") {
        emitEvent(expr.nodeId, expr.span, {
          kind: "comparison",
          op: expr.op,
          left: lVal,
          right: rVal,
          result: res,
        });
      }
      return res;
    }
    if (expr.type === "logical") {
      const lVal = evalExpr(expr.left, fallbackSpan);
      const lTruth = isTruthy(lVal);
      if (expr.op === "and") {
        return lTruth ? isTruthy(evalExpr(expr.right, fallbackSpan)) : false;
      }
      return lTruth ? true : isTruthy(evalExpr(expr.right, fallbackSpan));
    }
    return null;
  };

  const evalBody = (nodes) => {
    for (const node of nodes) {
      steps++;
      if (steps > MAX_STEPS) {
        throw new EngineDiagnosticError("step_limit_exceeded", `Evaluation exceeded ${MAX_STEPS} steps`);
      }

      if (node.type === "text") {
        const bytes = Buffer.byteLength(node.text, "utf8");
        if (outputBytes + bytes > MAX_OUTPUT_BYTES) {
          throw new EngineDiagnosticError("output_limit_exceeded", `Rendered output exceeded ${MAX_OUTPUT_BYTES} bytes`);
        }
        const startByte = outputBytes;
        outputChunks.push(node.text);
        outputBytes += bytes;
        emitEvent(node.nodeId, node.span, {
          kind: "emit",
          output_start_byte: startByte,
          output_end_byte: outputBytes,
          active_branch_seqs: [...activeBranchSeqs],
        });
      } else if (node.type === "output") {
        const val = evalExpr(node.expr, node.span);
        const rendered = val === null || val === undefined ? "" : String(val);
        const bytes = Buffer.byteLength(rendered, "utf8");
        if (outputBytes + bytes > MAX_OUTPUT_BYTES) {
          throw new EngineDiagnosticError("output_limit_exceeded", `Rendered output exceeded ${MAX_OUTPUT_BYTES} bytes`);
        }
        const startByte = outputBytes;
        outputChunks.push(rendered);
        outputBytes += bytes;
        emitEvent(node.nodeId, node.span, {
          kind: "emit",
          output_start_byte: startByte,
          output_end_byte: outputBytes,
          active_branch_seqs: [...activeBranchSeqs],
        });
      } else if (node.type === "assign") {
        const val = evalExpr(node.expr, node.span);
        rootScope[node.name] = structuredClone(val);
        emitEvent(node.nodeId, node.span, {
          kind: "assignment",
          name: node.name,
          value: structuredClone(val),
        });
      } else if (node.type === "conditional") {
        let matched = false;
        for (const arm of node.arms) {
          const rawCond = isTruthy(evalExpr(arm.condition, arm.span));
          const taken = arm.inverted ? !rawCond : rawCond;
          const seqBefore = events.length;
          emitEvent(arm.nodeId, arm.span, {
            kind: "branch",
            expression: arm.rawExpression,
            condition: rawCond,
            taken,
          });
          if (taken) {
            activeBranchSeqs.push(seqBefore);
            evalBody(arm.body);
            activeBranchSeqs.pop();
            matched = true;
            break;
          }
        }
        if (!matched && node.elseBody) {
          const seqBefore = events.length;
          emitEvent(node.elseBody.nodeId, node.elseBody.span, {
            kind: "branch",
            expression: "else",
            condition: true,
            taken: true,
          });
          activeBranchSeqs.push(seqBefore);
          evalBody(node.elseBody.body);
          activeBranchSeqs.pop();
        }
      } else if (node.type === "for") {
        const coll = lookupPath(node.collectionPath, node.collNodeId, node.collSpan);
        if (Array.isArray(coll) && coll.length > 0) {
          for (let i = 0; i < coll.length; i++) {
            const item = coll[i];
            const variantId =
              item && typeof item === "object" && typeof item.id === "string" ? item.id : null;
            scopeFrames.push({ loop_id: node.loopId, iteration: i, variant_id: variantId });
            loopScopes.push({ [node.binder]: item });
            evalBody(node.body);
            loopScopes.pop();
            scopeFrames.pop();
          }
        } else if (node.elseBody.length > 0) {
          evalBody(node.elseBody);
        }
      }
    }
  };

  evalBody(ast.body);
  return { html: outputChunks.join(""), events };
}

export function projectProduct(fixture) {
  const variants = fixture.variants;
  const prices = variants.map((v) => v.price);
  const priceMin = Math.min(...prices);
  const priceMax = Math.max(...prices);
  const caps = variants.map((v) => v.compare_at_price).filter((c) => c !== null);
  const capMin = caps.length > 0 ? Math.min(...caps) : null;
  const capMax = caps.length > 0 ? Math.max(...caps) : null;
  const distinctCaps = new Set(caps);
  const available = variants.some((v) => v.available);

  const product = {
    price: priceMin,
    price_min: priceMin,
    price_max: priceMax,
    price_varies: priceMin !== priceMax,
    compare_at_price: capMin,
    compare_at_price_min: capMin,
    compare_at_price_max: capMax,
    compare_at_price_varies: distinctCaps.size > 1,
    available,
  };

  return {
    projection: product,
    assigns: {
      product: {
        ...product,
        variants: structuredClone(variants),
      },
    },
  };
}

function findSaleBadgeTags(html) {
  const matches = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) break;
    if (html.startsWith("<!--", lt)) {
      const endComment = html.indexOf("-->", lt + 4);
      i = endComment === -1 ? html.length : endComment + 3;
      continue;
    }
    if (html[lt + 1] === "/" || html[lt + 1] === "!" || html[lt + 1] === "?") {
      const gt = html.indexOf(">", lt + 1);
      i = gt === -1 ? html.length : gt + 1;
      continue;
    }
    const tagMatch = html.slice(lt).match(/^<([A-Za-z][A-Za-z0-9:-]*)/);
    if (!tagMatch) {
      i = lt + 1;
      continue;
    }
    const tagName = tagMatch[1].toLowerCase();
    let j = lt + tagMatch[0].length;
    let quote = null;
    while (j < html.length) {
      const ch = html[j];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === ">") {
        break;
      }
      j++;
    }
    if (j >= html.length) break;
    const rawTag = html.slice(lt, j + 1);
    const attrRegex = /\bdata-regression-badge\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
    const attrMatch = rawTag.match(attrRegex);
    if (attrMatch) {
      const val = attrMatch[1] ?? attrMatch[2] ?? attrMatch[3] ?? "";
      if (val === "sale") {
        const startByte = Buffer.byteLength(html.slice(0, lt), "utf8");
        const endByte = startByte + Buffer.byteLength(rawTag, "utf8");
        matches.push({ startByte, endByte });
      }
    }
    i = j + 1;
    if (tagName === "script" || tagName === "style" || tagName === "textarea" || tagName === "title") {
      const closeRe = new RegExp(`</${tagName}\\s*>`, "i");
      const closeMatch = closeRe.exec(html.slice(i));
      i = closeMatch ? i + closeMatch.index + closeMatch[0].length : html.length;
    }
  }
  return matches;
}

export function observeSaleBadge(html) {
  return findSaleBadgeTags(html).length > 0;
}

function renderSnippet(ast, assigns, trace) {
  try {
    const { html, events } = evaluateAst(ast, assigns, trace);
    return {
      status: "ok",
      html,
      observed: observeSaleBadge(html),
      events: trace ? events : [],
      error: null,
    };
  } catch (err) {
    if (err instanceof EngineDiagnosticError) {
      return {
        status: "error",
        html: null,
        observed: null,
        events: [],
        error: makeDiagnostic(err.code, err.message, err.span),
      };
    }
    throw err;
  }
}

function createMulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function* generateCandidates(seed, maxPairs) {
  const seen = new Set();
  const emit = (variants) => {
    const fixture = { schema_version: 1, currency: "USD", variants };
    const key = canonicalJson(fixture);
    if (seen.has(key)) return null;
    seen.add(key);
    return fixture;
  };

  const singleCases = [
    [{ id: "v1", price: 0, compare_at_price: null, available: true }],
    [{ id: "v1", price: 0, compare_at_price: 0, available: true }],
    [{ id: "v1", price: 0, compare_at_price: 100, available: true }],
    [{ id: "v1", price: 100, compare_at_price: null, available: true }],
    [{ id: "v1", price: 100, compare_at_price: 0, available: true }],
    [{ id: "v1", price: 100, compare_at_price: 100, available: true }],
    [{ id: "v1", price: 100, compare_at_price: 200, available: true }],
    [{ id: "v1", price: 100, compare_at_price: 50, available: true }],
    [{ id: "v1", price: 100, compare_at_price: 200, available: false }],
  ];

  const multiCases = [
    [
      { id: "v1", price: 1000, compare_at_price: 1000, available: true },
      { id: "v2", price: 1000, compare_at_price: 1500, available: true },
    ],
    [
      { id: "v1", price: 1000, compare_at_price: null, available: true },
      { id: "v2", price: 1000, compare_at_price: 1500, available: true },
    ],
    [
      { id: "v1", price: 1000, compare_at_price: 0, available: true },
      { id: "v2", price: 1000, compare_at_price: 1500, available: true },
    ],
    [
      { id: "v1", price: 1000, compare_at_price: 1500, available: true },
      { id: "v2", price: 2000, compare_at_price: 1500, available: true },
    ],
    [
      { id: "v1", price: 1000, compare_at_price: 1000, available: false },
      { id: "v2", price: 1000, compare_at_price: 1500, available: false },
    ],
    [
      { id: "v1", price: 1000, compare_at_price: null, available: false },
      { id: "v2", price: 2000, compare_at_price: 2500, available: true },
    ],
  ];

  let emitted = 0;
  for (const variants of [...singleCases, ...multiCases]) {
    if (emitted >= maxPairs) return;
    const f = emit(variants);
    if (f) {
      emitted++;
      yield f;
    }
  }

  const rng = createMulberry32(seed);
  const pricePool = [0, 1, 500, 1000, 1500, 2000, 2500];
  let dupes = 0;
  while (emitted < maxPairs && dupes < 2000) {
    const count = 1 + Math.floor(rng() * 4);
    const sharedPrice = pricePool[Math.floor(rng() * pricePool.length)];
    const variants = [];
    for (let i = 0; i < count; i++) {
      const price = rng() < 0.5 ? sharedPrice : pricePool[Math.floor(rng() * pricePool.length)];
      const capRoll = rng();
      let cap = null;
      if (capRoll >= 0.25) {
        if (capRoll < 0.4) cap = 0;
        else if (capRoll < 0.65) cap = price;
        else if (capRoll < 0.9) cap = price + pricePool[1 + Math.floor(rng() * (pricePool.length - 1))];
        else cap = Math.max(0, price - 250);
      }
      variants.push({
        id: `v${i + 1}`,
        price,
        compare_at_price: cap,
        available: rng() < 0.5,
      });
    }
    const f = emit(variants);
    if (f) {
      dupes = 0;
      emitted++;
      yield f;
    } else {
      dupes++;
    }
  }
}

function fixtureMeasure(fixture) {
  const variants = fixture.variants;
  const nonNullCap = variants.filter((v) => v.compare_at_price !== null).length;
  const totalCents = variants.reduce((acc, v) => acc + v.price + (v.compare_at_price || 0), 0);
  const availCount = variants.filter((v) => v.available).length;
  const bytes = Buffer.byteLength(canonicalJson(fixture), "utf8");
  return [variants.length, nonNullCap, totalCents, availCount, bytes];
}

function measureLt(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}

function shrinkFixture(beforeAst, afterAst, initialFixture, targetBefore, targetAfter, shrinkBudget) {
  let current = structuredClone(initialFixture);
  let curMeasure = fixtureMeasure(current);
  let shrinkPairs = 0;

  if (shrinkBudget <= 0) {
    return { fixture: current, shrinkPairs: 0 };
  }

  const tested = new Set([canonicalJson(current)]);
  let improved = true;

  while (improved && shrinkPairs < shrinkBudget) {
    improved = false;
    const proposals = [];

    if (current.variants.length > 1) {
      for (let i = 0; i < current.variants.length; i++) {
        const next = structuredClone(current);
        next.variants.splice(i, 1);
        proposals.push(next);
      }
    }

    for (let i = 0; i < current.variants.length; i++) {
      const v = current.variants[i];
      if (v.available) {
        const next = structuredClone(current);
        next.variants[i].available = false;
        proposals.push(next);
      }
      if (v.compare_at_price !== null) {
        const toNull = structuredClone(current);
        toNull.variants[i].compare_at_price = null;
        proposals.push(toNull);
        if (v.compare_at_price > 0) {
          const toZero = structuredClone(current);
          toZero.variants[i].compare_at_price = 0;
          proposals.push(toZero);
        }
        if (v.compare_at_price > v.price + 1) {
          const toPlus1 = structuredClone(current);
          toPlus1.variants[i].compare_at_price = v.price + 1;
          proposals.push(toPlus1);
        }
      }
      if (v.price > 0) {
        const toZero = structuredClone(current);
        toZero.variants[i].price = 0;
        proposals.push(toZero);
        if (v.compare_at_price !== null && v.compare_at_price > v.price) {
          const paired = structuredClone(current);
          paired.variants[i].price = 0;
          paired.variants[i].compare_at_price = 1;
          proposals.push(paired);
        }
      }
    }

    for (const cand of proposals) {
      if (shrinkPairs >= shrinkBudget) break;
      const key = canonicalJson(cand);
      if (tested.has(key)) continue;
      tested.add(key);

      const candMeasure = fixtureMeasure(cand);
      if (!measureLt(candMeasure, curMeasure)) continue;

      shrinkPairs++;
      const { assigns } = projectProduct(cand);
      const bRes = renderSnippet(beforeAst, assigns, false);
      const aRes = renderSnippet(afterAst, assigns, false);
      if (
        bRes.status === "ok" &&
        aRes.status === "ok" &&
        bRes.observed === targetBefore &&
        aRes.observed === targetAfter
      ) {
        current = cand;
        curMeasure = candMeasure;
        improved = true;
        break;
      }
    }
  }

  return { fixture: current, shrinkPairs };
}

function resolveAnchorForRender(renderResult) {
  if (!renderResult.observed || !renderResult.html) return null;
  const tags = findSaleBadgeTags(renderResult.html);
  if (tags.length !== 1) return null;
  const tag = tags[0];
  const overlappingEmits = renderResult.events.filter(
    (ev) =>
      ev.data.kind === "emit" &&
      ev.data.output_end_byte > tag.startByte &&
      ev.data.output_start_byte < tag.endByte,
  );
  if (overlappingEmits.length === 0) return null;
  const chain = overlappingEmits[0].data.active_branch_seqs;
  if (!chain || chain.length === 0) return null;

  let branchEv = renderResult.events.find((ev) => ev.seq === chain[chain.length - 1]);
  if (!branchEv) return null;

  // Follow simple assigned boolean flag variables back inside the trace
  const branchIdx = renderResult.events.indexOf(branchEv);
  if (branchEv.data.kind === "branch" && /^[A-Za-z_][A-Za-z0-9_-]*$/.test(branchEv.data.expression.trim())) {
    const varName = branchEv.data.expression.trim();
    for (let i = branchIdx - 1; i >= 0; i--) {
      const ev = renderResult.events[i];
      if (ev.data.kind === "assignment" && ev.data.name === varName) {
        for (let j = i - 1; j >= 0; j--) {
          const cand = renderResult.events[j];
          if (cand.data.kind === "branch" && cand.data.taken === true) {
            branchEv = cand;
            break;
          }
        }
        break;
      }
    }
  }

  return {
    line: branchEv.span.line,
    event_seq: branchEv.seq,
    event: branchEv,
  };
}

function fallbackNonEmittingAnchor(renderResult) {
  if (renderResult.observed) return null;
  const branches = renderResult.events.filter((ev) => ev.data.kind === "branch");
  if (branches.length === 0) return null;
  const branchEv = branches[branches.length - 1];
  return {
    line: branchEv.span.line,
    event_seq: branchEv.seq,
    event: branchEv,
  };
}

function buildExplanation(beforeResult, afterResult) {
  const bAnchor = resolveAnchorForRender(beforeResult) || fallbackNonEmittingAnchor(beforeResult);
  const aAnchor = resolveAnchorForRender(afterResult) || fallbackNonEmittingAnchor(afterResult);

  if (!bAnchor && !aAnchor) {
    return {
      kind: "undetermined",
      before: null,
      after: null,
      summary: "Unable to attribute sale_badge change unambiguously to a single branch anchor.",
    };
  }

  const sameExpr =
    bAnchor &&
    aAnchor &&
    bAnchor.event.data.expression.replace(/\s+/g, " ") ===
      aAnchor.event.data.expression.replace(/\s+/g, " ");

  const kind = sameExpr ? "aligned_change" : "structural_change";
  const prefix = kind === "aligned_change" ? "Aligned change" : "Structural change";
  const parts = [];
  if (bAnchor) {
    parts.push(
      `before at line ${bAnchor.line} [${bAnchor.event.data.expression}] -> ${bAnchor.event.data.condition}`,
    );
  }
  if (aAnchor) {
    parts.push(
      `after at line ${aAnchor.line} [${aAnchor.event.data.expression}] -> ${aAnchor.event.data.condition}`,
    );
  }

  return {
    kind,
    before: bAnchor ? { line: bAnchor.line, event_seq: bAnchor.event_seq } : null,
    after: aAnchor ? { line: aAnchor.line, event_seq: aAnchor.event_seq } : null,
    summary: `${prefix}: ${parts.join("; ")}.`,
  };
}

export function runComparisonEngine(request) {
  const startMs = Date.now();
  const beforeSrc = request.before.source;
  const afterSrc = request.after.source;
  const beforeSha = sha256Hex(beforeSrc);
  const afterSha = sha256Hex(afterSrc);

  let beforeAst;
  let afterAst;
  try {
    beforeAst = parseTemplate(beforeSrc);
    afterAst = parseTemplate(afterSrc);
  } catch (err) {
    const diag =
      err instanceof EngineDiagnosticError
        ? makeDiagnostic(err.code, err.message, err.span)
        : makeDiagnostic("internal_error", String(err));
    return {
      status: "failed",
      finding: null,
      stats: {
        search_pairs: 0,
        shrink_pairs: 0,
        parity_rejections: 0,
        exhausted_by: null,
        first_difference_ms: null,
        elapsed_ms: Math.max(0, Date.now() - startMs),
      },
      error: diag,
    };
  }

  let searchPairs = 0;
  for (const fixture of generateCandidates(request.seed, request.budget.search_pairs)) {
    searchPairs++;
    const { assigns } = projectProduct(fixture);
    const bRes = renderSnippet(beforeAst, assigns, false);
    if (bRes.status === "error") {
      return {
        status: "failed",
        finding: null,
        stats: {
          search_pairs: searchPairs,
          shrink_pairs: 0,
          parity_rejections: 0,
          exhausted_by: null,
          first_difference_ms: null,
          elapsed_ms: Math.max(0, Date.now() - startMs),
        },
        error: bRes.error,
      };
    }
    const aRes = renderSnippet(afterAst, assigns, false);
    if (aRes.status === "error") {
      return {
        status: "failed",
        finding: null,
        stats: {
          search_pairs: searchPairs,
          shrink_pairs: 0,
          parity_rejections: 0,
          exhausted_by: null,
          first_difference_ms: null,
          elapsed_ms: Math.max(0, Date.now() - startMs),
        },
        error: aRes.error,
      };
    }

    if (bRes.observed !== aRes.observed) {
      const firstDiffMs = Math.max(0, Date.now() - startMs);
      const { fixture: minFixture, shrinkPairs } = shrinkFixture(
        beforeAst,
        afterAst,
        fixture,
        bRes.observed,
        aRes.observed,
        request.budget.shrink_pairs,
      );
      const { projection, assigns: finalAssigns } = projectProduct(minFixture);
      const tracedBefore = renderSnippet(beforeAst, finalAssigns, true);
      const tracedAfter = renderSnippet(afterAst, finalAssigns, true);
      const refBefore = { ...tracedBefore, events: [] };
      const refAfter = { ...tracedAfter, events: [] };
      const explanation = buildExplanation(tracedBefore, tracedAfter);

      return {
        status: "difference_found",
        finding: {
          product: projection,
          replay: {
            request,
            fixture: minFixture,
            before_sha256: beforeSha,
            after_sha256: afterSha,
            interpreter_version: INTERPRETER_VERSION,
            liquid_version: LIQUID_VERSION,
            projection_version: PROJECTION_VERSION,
          },
          before: tracedBefore,
          after: tracedAfter,
          reference: {
            before: refBefore,
            after: refAfter,
          },
          explanation,
        },
        stats: {
          search_pairs: searchPairs,
          shrink_pairs: shrinkPairs,
          parity_rejections: 0,
          exhausted_by: null,
          first_difference_ms: firstDiffMs,
          elapsed_ms: Math.max(firstDiffMs, Date.now() - startMs),
        },
        error: null,
      };
    }
  }

  return {
    status: "no_difference_found",
    finding: null,
    stats: {
      search_pairs: searchPairs,
      shrink_pairs: 0,
      parity_rejections: 0,
      exhausted_by: searchPairs < request.budget.search_pairs ? "candidate_space" : "pair_limit",
      first_difference_ms: null,
      elapsed_ms: Math.max(0, Date.now() - startMs),
    },
    error: null,
  };
}

async function ensureJobsDir() {
  await fs.mkdir(getJobsDir(), { recursive: true });
}

export async function createOrGetComparisonJob(rawBody, idempotencyKey = null) {
  const validated = validateCompareRequest(rawBody);
  const requestDigest = sha256Hex(canonicalJson(validated));

  await ensureJobsDir();

  if (idempotencyKey !== null) {
    const keyHash = sha256Hex(idempotencyKey);
    const keyPath = path.join(getJobsDir(), `idempotency-${keyHash}.json`);
    try {
      const existingMeta = JSON.parse(await fs.readFile(keyPath, "utf8"));
      if (existingMeta.request_digest !== requestDigest) {
        throw new EngineDiagnosticError(
          "idempotency_conflict",
          "Idempotency-Key was already used with a different comparison request",
          null,
          409,
        );
      }
      const existingJob = await getComparisonJob(existingMeta.id);
      if (existingJob) {
        const isActive = existingJob.status === "queued" || existingJob.status === "running";
        return { statusCode: isActive ? 202 : 200, job: existingJob };
      }
    } catch (err) {
      if (err instanceof EngineDiagnosticError) throw err;
    }
  }

  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const outcome = runComparisonEngine(validated);
  const completedAt = new Date().toISOString();

  const job = {
    schema_version: 1,
    id,
    status: outcome.status,
    request: validated,
    finding: outcome.finding,
    stats: outcome.stats,
    error: outcome.error,
    result_url: `/comparisons/${id}`,
    created_at: createdAt,
    completed_at: completedAt,
  };

  await fs.writeFile(path.join(getJobsDir(), `${id}.json`), JSON.stringify(job), "utf8");
  if (idempotencyKey !== null) {
    const keyHash = sha256Hex(idempotencyKey);
    await fs.writeFile(
      path.join(getJobsDir(), `idempotency-${keyHash}.json`),
      JSON.stringify({ id, request_digest: requestDigest }),
      "utf8",
    );
  }

  return { statusCode: 202, job };
}

export async function getComparisonJob(id) {
  if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(id)) {
    return null;
  }
  try {
    const raw = await fs.readFile(path.join(getJobsDir(), `${id}.json`), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function sendJson(res, statusCode, payload, extraHeaders = {}) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  for (const [k, v] of Object.entries(extraHeaders)) {
    res.setHeader(k, v);
  }
  res.end(JSON.stringify(payload));
}

export function handleError(res, err) {
  if (err instanceof EngineDiagnosticError) {
    sendJson(res, err.statusCode, { error: makeDiagnostic(err.code, err.message, err.span) });
    return;
  }
  sendJson(res, 500, {
    error: makeDiagnostic("internal_error", err instanceof Error ? err.message : "Internal server error"),
  });
}

export function extractIdempotencyHeader(req) {
  const headerVal = req.headers?.["idempotency-key"];
  if (headerVal === undefined) return null;
  const raw = Array.isArray(headerVal) ? headerVal[0] : headerVal;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new EngineDiagnosticError(
      "invalid_idempotency_key",
      "Idempotency-Key header cannot be blank when provided",
      null,
      422,
    );
  }
  if (Buffer.byteLength(raw, "utf8") > 255) {
    throw new EngineDiagnosticError(
      "invalid_idempotency_key",
      "Idempotency-Key header must be valid UTF-8 and at most 255 bytes",
      null,
      422,
    );
  }
  return raw;
}

export function checkBearerAuth(req) {
  const expected = process.env.LIQUID_REGRESSION_API_TOKEN;
  if (!expected) return;
  const auth = String(req.headers?.authorization || "");
  const m = auth.match(/^Bearer\s+(.+)$/i);
  const provided = m ? m[1] : "";
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new EngineDiagnosticError("unauthorized", "Missing or invalid bearer token", null, 401);
  }
}

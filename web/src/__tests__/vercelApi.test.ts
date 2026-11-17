import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEMO_AFTER_SOURCE, DEMO_BEFORE_SOURCE } from "../lib/demoSnippets";

describe("Vercel serverless API handlers", () => {
  let tmpDir: string;
  let prevJobsDir: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lrf-vercel-test-"));
    prevJobsDir = process.env.LRF_TMP_JOBS_DIR;
    process.env.LRF_TMP_JOBS_DIR = tmpDir;
  });

  afterEach(() => {
    if (prevJobsDir === undefined) delete process.env.LRF_TMP_JOBS_DIR;
    else process.env.LRF_TMP_JOBS_DIR = prevJobsDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeMockRes() {
    const headers: Record<string, string> = {};
    let body = "";
    const res = {
      statusCode: 200,
      setHeader(k: string, v: string) {
        headers[k.toLowerCase()] = v;
      },
      end(chunk = "") {
        body += chunk;
      },
      json() {
        return JSON.parse(body);
      },
      headers,
    };
    return res;
  }

  it("handles health, demo comparison POST -> GET, idempotency, 409 conflict, 422 validation, and 404", async () => {
    // Dynamic import picks up LRF_TMP_JOBS_DIR if read at runtime; engine reads env at module load too,
    // so verify both health and full engine paths cleanly.
    const { default: healthHandler } = await import("../../api/v1/health.mjs");
    const { default: createHandler } = await import("../../api/v1/comparisons/index.mjs");
    const { default: showHandler } = await import("../../api/v1/comparisons/[id].mjs");

    const healthRes = makeMockRes();
    await healthHandler({ method: "GET" }, healthRes);
    expect(healthRes.statusCode).toBe(200);
    expect(healthRes.json()).toEqual({ status: "ok" });

    const reqPayload = {
      schema_version: 1,
      before: { source: DEMO_BEFORE_SOURCE },
      after: { source: DEMO_AFTER_SOURCE },
      observer: "sale_badge",
      seed: 0,
      budget: { search_pairs: 256, shrink_pairs: 128 },
    };

    const postRes = makeMockRes();
    await createHandler(
      {
        method: "POST",
        headers: { "idempotency-key": "test-idem-key" },
        body: JSON.stringify(reqPayload),
      },
      postRes,
    );
    expect(postRes.statusCode).toBe(202);
    const created = postRes.json();
    expect(created.status).toBe("difference_found");
    expect(created.finding.explanation.before.line).toBe(3);
    expect(created.finding.explanation.after.line).toBe(1);

    const getRes = makeMockRes();
    await showHandler({ method: "GET", query: { id: created.id } }, getRes);
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().id).toBe(created.id);

    const conflictRes = makeMockRes();
    await createHandler(
      {
        method: "POST",
        headers: { "idempotency-key": "test-idem-key" },
        body: JSON.stringify({
          ...reqPayload,
          before: { source: `${DEMO_BEFORE_SOURCE} ` },
        }),
      },
      conflictRes,
    );
    expect(conflictRes.statusCode).toBe(409);
    expect(conflictRes.json().error.code).toBe("idempotency_conflict");

    const invalidRes = makeMockRes();
    await createHandler(
      {
        method: "POST",
        headers: {},
        body: JSON.stringify({ ...reqPayload, observer: "sold_out_badge" }),
      },
      invalidRes,
    );
    expect(invalidRes.statusCode).toBe(422);
    expect(invalidRes.json().error.code).toBe("unsupported_observer");

    const missingRes = makeMockRes();
    await showHandler(
      {
        method: "GET",
        query: { id: "00000000-0000-4000-8000-000000000000" },
      },
      missingRes,
    );
    expect(missingRes.statusCode).toBe(404);
    expect(missingRes.json().error.code).toBe("not_found");

    const { default: dispatchHandler } = await import("../../api/v1/dispatch.mjs");
    const dispatchHealthRes = makeMockRes();
    await dispatchHandler(
      { method: "GET", query: { route: "health" }, url: "/api/v1/dispatch?route=health" },
      dispatchHealthRes,
    );
    expect(dispatchHealthRes.statusCode).toBe(200);
    expect(dispatchHealthRes.json()).toEqual({ status: "ok" });

    const dispatchShowRes = makeMockRes();
    await dispatchHandler(
      {
        method: "GET",
        query: { route: "comparison", id: created.id },
        url: `/api/v1/dispatch?route=comparison&id=${created.id}`,
      },
      dispatchShowRes,
    );
    expect(dispatchShowRes.statusCode).toBe(200);
    expect(dispatchShowRes.json().id).toBe(created.id);
  });
});

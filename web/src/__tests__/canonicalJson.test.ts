import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../lib/canonicalJson";
import { makeDifferenceFoundJob } from "./fixtures";

describe("canonicalJson", () => {
  it("serializes keys sorted recursively with compact separators and preserved array order", () => {
    const input = {
      z: 1,
      a: [{ d: 4, b: 2 }, { c: null, a: true }],
      m: "café — $10",
    };

    expect(canonicalJson(input)).toBe(
      '{"a":[{"b":2,"d":4},{"a":true,"c":null}],"m":"café — $10","z":1}',
    );
  });

  it("rejects NaN and Infinity", () => {
    expect(() => canonicalJson({ val: Number.NaN })).toThrow(RangeError);
    expect(() => canonicalJson({ val: Number.POSITIVE_INFINITY })).toThrow(RangeError);
  });

  it("matches Stage 5 demo-replay.json byte-for-byte", () => {
    const artifactPath = path.resolve(
      __dirname,
      "../../../artifacts/stage-5/demo-replay.json",
    );
    const expectedReplayBytes = fs.readFileSync(artifactPath, "utf8");
    const job = makeDifferenceFoundJob();
    expect(canonicalJson(job.finding!.replay)).toBe(expectedReplayBytes);
  });
});

import { DEMO_AFTER_SOURCE, DEMO_BEFORE_SOURCE } from "../lib/demoSnippets";
import type { ComparisonJob } from "../types";

export const DEMO_JOB_ID = "11111111-2222-4333-8444-555555555555";

export const DEMO_REQUEST = {
  schema_version: 1 as const,
  before: { source: DEMO_BEFORE_SOURCE },
  after: { source: DEMO_AFTER_SOURCE },
  observer: "sale_badge" as const,
  seed: 0,
  budget: {
    search_pairs: 256,
    shrink_pairs: 128,
  },
};

export function makeQueuedJob(id = DEMO_JOB_ID): ComparisonJob {
  return {
    schema_version: 1,
    id,
    status: "queued",
    request: DEMO_REQUEST,
    finding: null,
    stats: null,
    error: null,
    result_url: `/comparisons/${id}`,
    created_at: "2026-11-17T10:00:00.000Z",
    completed_at: null,
  };
}

export function makeRunningJob(id = DEMO_JOB_ID): ComparisonJob {
  return {
    ...makeQueuedJob(id),
    status: "running",
  };
}

export function makeDifferenceFoundJob(id = DEMO_JOB_ID): ComparisonJob {
  return {
    schema_version: 1,
    id,
    status: "difference_found",
    request: DEMO_REQUEST,
    finding: {
      product: {
        price: 0,
        price_min: 0,
        price_max: 0,
        price_varies: false,
        compare_at_price: 0,
        compare_at_price_min: 0,
        compare_at_price_max: 1,
        compare_at_price_varies: true,
        available: false,
      },
      replay: {
        request: DEMO_REQUEST,
        fixture: {
          schema_version: 1,
          currency: "USD",
          variants: [
            { id: "v1", price: 0, compare_at_price: 0, available: false },
            { id: "v2", price: 0, compare_at_price: 1, available: false },
          ],
        },
        before_sha256:
          "5bc25597cb21e90168f2b3c671b442acd2d689904e6818a0c60750c1a407af61",
        after_sha256:
          "3287973b7a61caf05bb9866b36ddff7d991447cbccbf0439263bbe0c1343bf99",
        interpreter_version: "0.1.0",
        liquid_version: "5.14.0",
        projection_version: "1.0.0",
      },
      before: {
        status: "ok",
        html: '<span class="badge" data-regression-badge="sale">Sale</span>',
        observed: true,
        events: [
          {
            seq: 0,
            node_id: "n0:assign",
            scope: [],
            span: { start_byte: 0, end_byte: 30, line: 1, column: 1 },
            data: { kind: "assignment", name: "on_sale", value: false },
          },
          {
            seq: 1,
            node_id: "n1:for.coll:lookup",
            scope: [],
            span: { start_byte: 50, end_byte: 66, line: 2, column: 20 },
            data: {
              kind: "lookup",
              path: "product.variants",
              found: true,
              value: [
                { id: "v1", price: 0, compare_at_price: 0, available: false },
                { id: "v2", price: 0, compare_at_price: 1, available: false },
              ],
            },
          },
          {
            seq: 8,
            node_id: "n1:for.b0:conditional.a0.cond.l.l:lookup",
            scope: [{ loop_id: "n1:for", iteration: 1, variant_id: "v2" }],
            span: { start_byte: 80, end_byte: 104, line: 3, column: 10 },
            data: {
              kind: "lookup",
              path: "variant.compare_at_price",
              found: true,
              value: 1,
            },
          },
          {
            seq: 12,
            node_id: "n1:for.b0:conditional.a0.cond.r:comparison",
            scope: [{ loop_id: "n1:for", iteration: 1, variant_id: "v2" }],
            span: { start_byte: 116, end_byte: 156, line: 3, column: 46 },
            data: {
              kind: "comparison",
              op: ">",
              left: 1,
              right: 0,
              result: true,
            },
          },
          {
            seq: 13,
            node_id: "n1:for.b0:conditional.a0:branch",
            scope: [{ loop_id: "n1:for", iteration: 1, variant_id: "v2" }],
            span: { start_byte: 73, end_byte: 160, line: 3, column: 3 },
            data: {
              kind: "branch",
              expression:
                "variant.compare_at_price != nil and variant.compare_at_price > variant.price",
              condition: true,
              taken: true,
            },
          },
          {
            seq: 14,
            node_id: "n1:for.b0:conditional.a0.b0:assign",
            scope: [{ loop_id: "n1:for", iteration: 1, variant_id: "v2" }],
            span: { start_byte: 165, end_byte: 194, line: 4, column: 5 },
            data: { kind: "assignment", name: "on_sale", value: true },
          },
          {
            seq: 17,
            node_id: "n2:conditional.a0.b0:text",
            scope: [],
            span: { start_byte: 244, end_byte: 306, line: 7, column: 19 },
            data: {
              kind: "emit",
              output_start_byte: 0,
              output_end_byte: 60,
              active_branch_seqs: [16],
            },
          },
        ],
        error: null,
      },
      after: {
        status: "ok",
        html: "",
        observed: false,
        events: [
          {
            seq: 0,
            node_id: "n0:conditional.a0.cond.l.l:lookup",
            scope: [],
            span: { start_byte: 7, end_byte: 31, line: 1, column: 8 },
            data: {
              kind: "lookup",
              path: "product.compare_at_price",
              found: true,
              value: 0,
            },
          },
          {
            seq: 4,
            node_id: "n0:conditional.a0.cond.r:comparison",
            scope: [],
            span: { start_byte: 43, end_byte: 83, line: 1, column: 44 },
            data: {
              kind: "comparison",
              op: ">",
              left: 0,
              right: 0,
              result: false,
            },
          },
          {
            seq: 5,
            node_id: "n0:conditional.a0:branch",
            scope: [],
            span: { start_byte: 0, end_byte: 87, line: 1, column: 1 },
            data: {
              kind: "branch",
              expression:
                "product.compare_at_price != nil and product.compare_at_price > product.price",
              condition: false,
              taken: false,
            },
          },
        ],
        error: null,
      },
      reference: {
        before: {
          status: "ok",
          html: '<span class="badge" data-regression-badge="sale">Sale</span>',
          observed: true,
          events: [],
          error: null,
        },
        after: {
          status: "ok",
          html: "",
          observed: false,
          events: [],
          error: null,
        },
      },
      explanation: {
        kind: "structural_change",
        before: { line: 3, event_seq: 13 },
        after: { line: 1, event_seq: 5 },
        summary:
          'Structural change: before at line 3 in variant_id="v2" via line 7 (if on_sale=true, assigned at line 4) [variant.compare_at_price != nil and variant.compare_at_price > variant.price] -> true (variant.compare_at_price=1, variant.price=0); after at line 1 in product/context [product.compare_at_price != nil and product.compare_at_price > product.price] -> false (product.compare_at_price=0, product.price=0).',
      },
    },
    stats: {
      search_pairs: 56,
      shrink_pairs: 28,
      parity_rejections: 0,
      exhausted_by: null,
      first_difference_ms: 291,
      elapsed_ms: 300,
    },
    error: null,
    result_url: `/comparisons/${id}`,
    created_at: "2026-11-17T10:00:00.000Z",
    completed_at: "2026-11-17T10:00:01.000Z",
  };
}

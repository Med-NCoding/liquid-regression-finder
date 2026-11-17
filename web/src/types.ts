export type JobStatus =
  | "queued"
  | "running"
  | "difference_found"
  | "no_difference_found"
  | "failed";

export interface Snippet {
  source: string;
}

export interface Budget {
  search_pairs: number;
  shrink_pairs: number;
}

export interface CompareRequest {
  schema_version: 1;
  before: Snippet;
  after: Snippet;
  observer: "sale_badge";
  seed: number;
  budget: Budget;
}

export interface Variant {
  id: string;
  price: number;
  compare_at_price: number | null;
  available: boolean;
}

export interface Fixture {
  schema_version: 1;
  currency: "USD";
  variants: Variant[];
}

export interface Span {
  start_byte: number;
  end_byte: number;
  line: number;
  column: number;
}

export interface Frame {
  loop_id: string;
  iteration: number;
  variant_id: string | null;
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface LookupEventData {
  kind: "lookup";
  path: string;
  found: boolean;
  value: JsonValue;
}

export interface ComparisonEventData {
  kind: "comparison";
  op: "==" | "!=" | "<" | "<=" | ">" | ">=";
  left: JsonValue;
  right: JsonValue;
  result: boolean;
}

export interface BranchEventData {
  kind: "branch";
  expression: string;
  condition: boolean;
  taken: boolean;
}

export interface AssignmentEventData {
  kind: "assignment";
  name: string;
  value: JsonValue;
}

export interface EmitEventData {
  kind: "emit";
  output_start_byte: number;
  output_end_byte: number;
  active_branch_seqs: number[];
}

export type TraceEventData =
  | LookupEventData
  | ComparisonEventData
  | BranchEventData
  | AssignmentEventData
  | EmitEventData;

export interface TraceEvent {
  seq: number;
  node_id: string;
  scope: Frame[];
  span: Span;
  data: TraceEventData;
}

export interface Diagnostic {
  code: string;
  message: string;
  span: Span | null;
}

export interface RenderResult {
  status: "ok" | "error";
  html: string | null;
  observed: boolean | null;
  events: TraceEvent[];
  error: Diagnostic | null;
}

export interface Projection {
  price: number;
  price_min: number;
  price_max: number;
  price_varies: boolean;
  compare_at_price: number | null;
  compare_at_price_min: number | null;
  compare_at_price_max: number | null;
  compare_at_price_varies: boolean;
  available: boolean;
}

export interface Anchor {
  line: number;
  event_seq: number;
}

export type ExplanationKind = "aligned_change" | "structural_change" | "undetermined";

export interface Explanation {
  kind: ExplanationKind;
  before: Anchor | null;
  after: Anchor | null;
  summary: string;
}

export interface ReplayBundle {
  request: CompareRequest;
  fixture: Fixture;
  before_sha256: string;
  after_sha256: string;
  interpreter_version: string;
  liquid_version: string;
  projection_version: string;
}

export interface Finding {
  product: Projection;
  replay: ReplayBundle;
  before: RenderResult;
  after: RenderResult;
  reference: {
    before: RenderResult;
    after: RenderResult;
  };
  explanation: Explanation;
}

export interface Stats {
  search_pairs: number;
  shrink_pairs: number;
  parity_rejections: number;
  exhausted_by: "pair_limit" | "candidate_space" | null;
  first_difference_ms: number | null;
  elapsed_ms: number;
}

export interface ComparisonJob {
  schema_version: 1;
  id: string;
  status: JobStatus;
  request: CompareRequest;
  finding: Finding | null;
  stats: Stats | null;
  error: Diagnostic | null;
  result_url: string;
  created_at: string;
  completed_at: string | null;
}

export interface ApiErrorResponse {
  error: Diagnostic;
}

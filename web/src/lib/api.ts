import type { CompareRequest, ComparisonJob, Diagnostic } from "../types";

export const POLL_BACKOFF_MS = [300, 500, 800, 1200, 2000] as const;
export const DEFAULT_POLL_TIMEOUT_MS = 95_000;

export class ApiClientError extends Error {
  readonly statusCode: number;
  readonly diagnostic: Diagnostic;

  constructor(statusCode: number, diagnostic: Diagnostic) {
    super(diagnostic.message);
    this.name = "ApiClientError";
    this.statusCode = statusCode;
    this.diagnostic = diagnostic;
  }
}

async function parseErrorResponse(response: Response): Promise<Diagnostic> {
  try {
    const body = (await response.json()) as { error?: Partial<Diagnostic> };
    if (body && body.error && typeof body.error.message === "string") {
      return {
        code: typeof body.error.code === "string" ? body.error.code : `http_${response.status}`,
        message: body.error.message,
        span: body.error.span ?? null,
      };
    }
  } catch {
    // Non-JSON error body fallback
  }

  return {
    code: `http_${response.status}`,
    message: `API request failed with status ${response.status}`,
    span: null,
  };
}

export interface SubmitComparisonResult {
  statusCode: number;
  job: ComparisonJob;
}

export async function submitComparison(
  request: CompareRequest,
  options?: { idempotencyKey?: string; signal?: AbortSignal },
): Promise<SubmitComparisonResult> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  if (options?.idempotencyKey !== undefined && options.idempotencyKey.length > 0) {
    headers["Idempotency-Key"] = options.idempotencyKey;
  }

  const response = await fetch("/api/v1/comparisons", {
    method: "POST",
    headers,
    body: JSON.stringify(request),
    signal: options?.signal,
  });

  if (!response.ok) {
    const diagnostic = await parseErrorResponse(response);
    throw new ApiClientError(response.status, diagnostic);
  }

  const job = (await response.json()) as ComparisonJob;
  return { statusCode: response.status, job };
}

export async function fetchComparison(
  id: string,
  signal?: AbortSignal,
): Promise<ComparisonJob> {
  const response = await fetch(`/api/v1/comparisons/${encodeURIComponent(id)}`, {
    method: "GET",
    headers: {
      Accept: "application/json",
    },
    signal,
  });

  if (!response.ok) {
    const diagnostic = await parseErrorResponse(response);
    throw new ApiClientError(response.status, diagnostic);
  }

  return (await response.json()) as ComparisonJob;
}

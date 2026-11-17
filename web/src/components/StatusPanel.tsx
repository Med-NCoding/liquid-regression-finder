import { Link } from "react-router-dom";
import { splitSourceLines } from "../lib/formatters";
import type { ComparisonJob, Diagnostic } from "../types";

interface StatusPanelProps {
  jobId: string;
  job: ComparisonJob | null;
  loading: boolean;
  notFoundError: Diagnostic | null;
  requestError: { statusCode: number; diagnostic: Diagnostic } | null;
  timedOut: boolean;
  pollAttempt: number;
  onRetry: () => void;
}

export function StatusPanel({
  jobId,
  job,
  loading,
  notFoundError,
  requestError,
  timedOut,
  pollAttempt,
  onRetry,
}: StatusPanelProps) {
  if (notFoundError) {
    return (
      <section className="card" aria-labelledby="missing-job-heading">
        <div className="badge-row" style={{ marginBottom: "0.75rem" }}>
          <span className="badge badge-danger" data-status="not_found">
            Not Found (404)
          </span>
        </div>
        <h2 id="missing-job-heading">Comparison Not Found</h2>
        <p>{notFoundError.message}</p>
        <div className="kv-grid">
          <div className="kv-item">
            <span className="kv-label">Diagnostic Code</span>
            <span className="kv-value mono">{notFoundError.code}</span>
          </div>
          <div className="kv-item">
            <span className="kv-label">Requested Job ID</span>
            <span className="kv-value mono">{jobId}</span>
          </div>
        </div>
        <div className="button-row">
          <Link to="/" className="btn btn-primary">
            Submit New Comparison
          </Link>
        </div>
      </section>
    );
  }

  if (timedOut) {
    return (
      <section className="card" aria-labelledby="timeout-heading">
        <div className="badge-row" style={{ marginBottom: "0.75rem" }}>
          <span className="badge badge-warn" data-status="timeout">
            Polling Timed Out
          </span>
          {job && (
            <span className="badge badge-neutral">
              Last Status: {job.status === "queued" ? "Queued" : "Running"}
            </span>
          )}
        </div>
        <h2 id="timeout-heading">Polling Window Exceeded</h2>
        <p>
          Comparison <code className="mono">{jobId}</code> did not reach a terminal
          state before the client polling timeout elapsed. The job may still be
          executing on the worker.
        </p>
        <div className="button-row">
          <button type="button" className="btn btn-primary" onClick={onRetry}>
            Retry Polling
          </button>
          <Link to="/" className="btn">
            New Comparison
          </Link>
        </div>
      </section>
    );
  }

  if (requestError) {
    return (
      <section className="card" aria-labelledby="request-error-heading">
        <div className="badge-row" style={{ marginBottom: "0.75rem" }}>
          <span className="badge badge-danger" data-status="request_error">
            Request Error
          </span>
        </div>
        <h2 id="request-error-heading">Unable to Load Comparison</h2>
        <div className="alert alert-error" role="alert">
          <strong className="mono">{requestError.diagnostic.code}</strong>:{" "}
          {requestError.diagnostic.message}
        </div>
        <div className="button-row">
          <button type="button" className="btn btn-primary" onClick={onRetry}>
            Retry
          </button>
          <Link to="/" className="btn">
            New Comparison
          </Link>
        </div>
      </section>
    );
  }

  if (loading && !job) {
    return (
      <section className="card" role="status" aria-live="polite">
        <div className="badge-row">
          <span className="badge badge-info">
            <span className="spinner" aria-hidden="true" /> Loading
          </span>
        </div>
        <p style={{ marginTop: "0.75rem", marginBottom: 0 }}>
          Fetching comparison <code className="mono">{jobId}</code>…
        </p>
      </section>
    );
  }

  if (!job) {
    return null;
  }

  if (job.status === "queued" || job.status === "running") {
    const isRunning = job.status === "running";
    return (
      <section className="card" role="status" aria-live="polite">
        <div className="badge-row" style={{ marginBottom: "0.75rem" }}>
          <span
            className={`badge ${isRunning ? "badge-info" : "badge-neutral"}`}
            data-status={job.status}
          >
            <span className="spinner" aria-hidden="true" />{" "}
            {isRunning ? "Running" : "Queued"}
          </span>
          <span className="muted-note">
            Polling for worker completion (checks: {pollAttempt})…
          </span>
        </div>
        <p style={{ margin: "0 0 0.75rem" }}>
          Evaluating generated product fixtures and verifying parity against Official
          Liquid.
        </p>
        <div className="kv-grid">
          <div className="kv-item">
            <span className="kv-label">Job UUID</span>
            <span className="kv-value mono">{job.id}</span>
          </div>
          <div className="kv-item">
            <span className="kv-label">Observer</span>
            <span className="kv-value mono">{job.request.observer}</span>
          </div>
          <div className="kv-item">
            <span className="kv-label">Seed</span>
            <span className="kv-value mono">{job.request.seed}</span>
          </div>
          <div className="kv-item">
            <span className="kv-label">Budget</span>
            <span className="kv-value mono">
              {job.request.budget.search_pairs} search / {job.request.budget.shrink_pairs} shrink
            </span>
          </div>
        </div>
      </section>
    );
  }

  if (job.status === "failed") {
    const err = job.error;
    const span = err?.span ?? null;
    const beforeLines = splitSourceLines(job.request.before.source);
    const afterLines = splitSourceLines(job.request.after.source);

    return (
      <>
        <section className="card" aria-labelledby="failed-heading">
          <div className="badge-row" style={{ marginBottom: "0.75rem" }}>
            <span className="badge badge-danger" data-status="failed">
              Failed
            </span>
            {err && <span className="badge badge-neutral mono">{err.code}</span>}
          </div>
          <h2 id="failed-heading">Comparison Failed</h2>
          {err && (
            <div className="alert alert-error" role="alert">
              <div>
                <strong className="mono">{err.code}</strong>: {err.message}
              </div>
              {span && (
                <div className="muted-note" style={{ marginTop: "0.35rem", color: "inherit" }}>
                  Source Span: Line {span.line}, Column {span.column} (bytes{" "}
                  {span.start_byte}..{span.end_byte})
                </div>
              )}
            </div>
          )}

          {job.stats && (
            <div className="kv-grid" aria-label="Partial comparison statistics">
              <div className="kv-item">
                <span className="kv-label">Search Pairs</span>
                <span className="kv-value mono">{job.stats.search_pairs}</span>
              </div>
              <div className="kv-item">
                <span className="kv-label">Shrink Pairs</span>
                <span className="kv-value mono">{job.stats.shrink_pairs}</span>
              </div>
              <div className="kv-item">
                <span className="kv-label">Parity Rejections</span>
                <span className="kv-value mono">{job.stats.parity_rejections}</span>
              </div>
              <div className="kv-item">
                <span className="kv-label">Exhausted By</span>
                <span className="kv-value mono">{job.stats.exhausted_by ?? "none"}</span>
              </div>
              <div className="kv-item">
                <span className="kv-label">Elapsed</span>
                <span className="kv-value mono">{job.stats.elapsed_ms} ms</span>
              </div>
            </div>
          )}

          <div className="button-row">
            <Link to="/" className="btn btn-primary">
              Edit &amp; Submit New Comparison
            </Link>
          </div>
        </section>

        <section className="card" aria-labelledby="failed-sources-heading">
          <h2 id="failed-sources-heading">
            Submitted Sources {span ? `(Span Line ${span.line}, Col ${span.column})` : ""}
          </h2>
          <div className="two-col">
            <div>
              <h3>Before Snippet</h3>
              <div className="source-viewer">
                {beforeLines.map((lineText, idx) => {
                  const lineNum = idx + 1;
                  const isSpanLine = span !== null && span.line === lineNum;
                  return (
                    <div
                      key={lineNum}
                      className="source-line"
                      data-error-line={isSpanLine ? "true" : undefined}
                    >
                      <span className="source-line-num">{lineNum}</span>
                      {isSpanLine && <span className="anchor-badge">Span L{lineNum}</span>}
                      <code className="source-line-code">{lineText}</code>
                    </div>
                  );
                })}
              </div>
            </div>
            <div>
              <h3>After Snippet</h3>
              <div className="source-viewer">
                {afterLines.map((lineText, idx) => {
                  const lineNum = idx + 1;
                  const isSpanLine = span !== null && span.line === lineNum;
                  return (
                    <div
                      key={lineNum}
                      className="source-line"
                      data-error-line={isSpanLine ? "true" : undefined}
                    >
                      <span className="source-line-num">{lineNum}</span>
                      {isSpanLine && <span className="anchor-badge">Span L{lineNum}</span>}
                      <code className="source-line-code">{lineText}</code>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </section>
      </>
    );
  }

  if (job.status === "no_difference_found") {
    const stats = job.stats;
    const beforeLines = splitSourceLines(job.request.before.source);
    const afterLines = splitSourceLines(job.request.after.source);

    return (
      <>
        <section className="card" aria-labelledby="no-diff-heading">
          <div className="badge-row" style={{ marginBottom: "0.75rem" }}>
            <span className="badge badge-neutral" data-status="no_difference_found">
              No Difference Found
            </span>
          </div>
          <h2 id="no-diff-heading">no difference found within this search</h2>
          <p className="subtitle">
            Both snippets agreed on the <code className="mono">{job.request.observer}</code>{" "}
            observer across all examined candidate pairs within the configured search
            budget.
          </p>

          {stats && (
            <div className="kv-grid" aria-label="Search statistics">
              <div className="kv-item">
                <span className="kv-label">Search Pairs Examined</span>
                <span className="kv-value mono">{stats.search_pairs}</span>
              </div>
              <div className="kv-item">
                <span className="kv-label">Shrink Pairs</span>
                <span className="kv-value mono">{stats.shrink_pairs}</span>
              </div>
              <div className="kv-item">
                <span className="kv-label">Parity Rejections</span>
                <span className="kv-value mono">{stats.parity_rejections}</span>
              </div>
              <div className="kv-item">
                <span className="kv-label">Exhausted By</span>
                <span className="kv-value mono">{stats.exhausted_by ?? "none"}</span>
              </div>
              <div className="kv-item">
                <span className="kv-label">Elapsed</span>
                <span className="kv-value mono">{stats.elapsed_ms} ms</span>
              </div>
              <div className="kv-item">
                <span className="kv-label">Seed / Budget</span>
                <span className="kv-value mono">
                  seed {job.request.seed} · {job.request.budget.search_pairs} pairs
                </span>
              </div>
            </div>
          )}

          <div className="button-row">
            <Link to="/" className="btn btn-primary">
              New Comparison
            </Link>
          </div>
        </section>

        <section className="card" aria-labelledby="no-diff-sources-heading">
          <h2 id="no-diff-sources-heading">Compared Liquid Snippets</h2>
          <div className="two-col">
            <div>
              <h3>Before Snippet</h3>
              <div className="source-viewer">
                {beforeLines.map((lineText, idx) => (
                  <div key={idx + 1} className="source-line">
                    <span className="source-line-num">{idx + 1}</span>
                    <code className="source-line-code">{lineText}</code>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <h3>After Snippet</h3>
              <div className="source-viewer">
                {afterLines.map((lineText, idx) => (
                  <div key={idx + 1} className="source-line">
                    <span className="source-line-num">{idx + 1}</span>
                    <code className="source-line-code">{lineText}</code>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>
      </>
    );
  }

  return null;
}

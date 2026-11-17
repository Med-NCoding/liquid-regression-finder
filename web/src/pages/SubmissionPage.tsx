import { useState } from "react";
import type { FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { ApiClientError, submitComparison } from "../lib/api";
import { utf8ByteLength } from "../lib/canonicalJson";
import { DEMO_AFTER_SOURCE, DEMO_BEFORE_SOURCE } from "../lib/demoSnippets";
import type { Diagnostic } from "../types";

function parseIntegerField(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    return null;
  }
  const num = Number(trimmed);
  if (!Number.isSafeInteger(num)) {
    return null;
  }
  return num;
}

export function SubmissionPage() {
  const navigate = useNavigate();

  const [beforeSource, setBeforeSource] = useState("");
  const [afterSource, setAfterSource] = useState("");
  const [seedInput, setSeedInput] = useState("0");
  const [searchPairsInput, setSearchPairsInput] = useState("256");
  const [shrinkPairsInput, setShrinkPairsInput] = useState("128");
  const [idempotencyKey, setIdempotencyKey] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [errorState, setErrorState] = useState<{
    statusCode: number | null;
    diagnostic: Diagnostic;
  } | null>(null);

  const handleLoadDemo = () => {
    setBeforeSource(DEMO_BEFORE_SOURCE);
    setAfterSource(DEMO_AFTER_SOURCE);
    setErrorState(null);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setErrorState(null);

    const seed = parseIntegerField(seedInput);
    if (seed === null) {
      setErrorState({
        statusCode: null,
        diagnostic: {
          code: "invalid_request",
          message: "Seed must be an integer between 0 and 4294967295.",
          span: null,
        },
      });
      return;
    }

    const searchPairs = parseIntegerField(searchPairsInput);
    if (searchPairs === null) {
      setErrorState({
        statusCode: null,
        diagnostic: {
          code: "invalid_request",
          message: "Search pairs must be an integer between 1 and 5000.",
          span: null,
        },
      });
      return;
    }

    const shrinkPairs = parseIntegerField(shrinkPairsInput);
    if (shrinkPairs === null) {
      setErrorState({
        statusCode: null,
        diagnostic: {
          code: "invalid_request",
          message: "Shrink pairs must be an integer between 0 and 1000.",
          span: null,
        },
      });
      return;
    }

    setSubmitting(true);
    try {
      const result = await submitComparison(
        {
          schema_version: 1,
          before: { source: beforeSource },
          after: { source: afterSource },
          observer: "sale_badge",
          seed,
          budget: {
            search_pairs: searchPairs,
            shrink_pairs: shrinkPairs,
          },
        },
        {
          idempotencyKey: idempotencyKey.length > 0 ? idempotencyKey : undefined,
        },
      );
      const isTerminal =
        result.job.status === "difference_found" ||
        result.job.status === "no_difference_found" ||
        result.job.status === "failed";
      if (isTerminal) {
        try {
          window.sessionStorage.setItem(
            `lrf_terminal_job:${result.job.id}`,
            JSON.stringify(result.job),
          );
        } catch {
          // Ignore storage unavailability in restricted browser contexts.
        }
      }
      navigate(`/comparisons/${result.job.id}`, {
        state: isTerminal ? { terminalJob: result.job } : undefined,
      });
    } catch (err) {
      if (err instanceof ApiClientError) {
        setErrorState({
          statusCode: err.statusCode,
          diagnostic: err.diagnostic,
        });
      } else {
        setErrorState({
          statusCode: null,
          diagnostic: {
            code: "network_error",
            message:
              err instanceof Error
                ? err.message
                : "Failed to submit comparison request",
            span: null,
          },
        });
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Compare Liquid Snippets</h1>
          <p className="subtitle">
            Generate deterministic product fixtures, detect{" "}
            <code className="mono">sale_badge</code> (<code className="mono">[data-regression-badge="sale"]</code>) differences, shrink counterexamples, and confirm parity against Official Liquid.
          </p>
        </div>
        <button type="button" className="btn" onClick={handleLoadDemo}>
          Load Demo Snippets
        </button>
      </div>

      {errorState && (
        <div className="alert alert-error" role="alert">
          <div>
            <strong>
              {errorState.statusCode !== null ? `HTTP ${errorState.statusCode} · ` : ""}
              <span className="mono">{errorState.diagnostic.code}</span>
            </strong>
            : {errorState.diagnostic.message}
          </div>
          {errorState.diagnostic.span && (
            <div className="muted-note" style={{ marginTop: "0.3rem", color: "inherit" }}>
              Line {errorState.diagnostic.span.line}, Column{" "}
              {errorState.diagnostic.span.column}
            </div>
          )}
        </div>
      )}

      <form onSubmit={handleSubmit} noValidate>
        <section className="card">
          <div className="two-col">
            <div className="field">
              <div className="field-header">
                <label htmlFor="before-source">Before Liquid Snippet</label>
                <span className="field-hint mono">
                  {utf8ByteLength(beforeSource)} / 16,384 bytes
                </span>
              </div>
              <textarea
                id="before-source"
                name="before"
                className="code-input"
                value={beforeSource}
                onChange={(e) => setBeforeSource(e.target.value)}
                placeholder="Paste baseline Liquid snippet..."
                spellCheck={false}
              />
            </div>

            <div className="field">
              <div className="field-header">
                <label htmlFor="after-source">After Liquid Snippet</label>
                <span className="field-hint mono">
                  {utf8ByteLength(afterSource)} / 16,384 bytes
                </span>
              </div>
              <textarea
                id="after-source"
                name="after"
                className="code-input"
                value={afterSource}
                onChange={(e) => setAfterSource(e.target.value)}
                placeholder="Paste edited Liquid snippet..."
                spellCheck={false}
              />
            </div>
          </div>
        </section>

        <section className="card">
          <h2>Search Budget &amp; Options</h2>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="seed">Seed</label>
              <input
                id="seed"
                name="seed"
                type="number"
                className="text-input mono"
                min={0}
                max={4294967295}
                step={1}
                value={seedInput}
                onChange={(e) => setSeedInput(e.target.value)}
              />
              <span className="field-hint">0 – 4,294,967,295</span>
            </div>

            <div className="field">
              <label htmlFor="search-pairs">Search Pairs</label>
              <input
                id="search-pairs"
                name="search_pairs"
                type="number"
                className="text-input mono"
                min={1}
                max={5000}
                step={1}
                value={searchPairsInput}
                onChange={(e) => setSearchPairsInput(e.target.value)}
              />
              <span className="field-hint">1 – 5,000 candidate pairs</span>
            </div>

            <div className="field">
              <label htmlFor="shrink-pairs">Shrink Pairs</label>
              <input
                id="shrink-pairs"
                name="shrink_pairs"
                type="number"
                className="text-input mono"
                min={0}
                max={1000}
                step={1}
                value={shrinkPairsInput}
                onChange={(e) => setShrinkPairsInput(e.target.value)}
              />
              <span className="field-hint">0 – 1,000 shrink steps</span>
            </div>

            <div className="field">
              <label htmlFor="idempotency-key">Idempotency Key (Optional)</label>
              <input
                id="idempotency-key"
                name="idempotency_key"
                type="text"
                className="text-input mono"
                value={idempotencyKey}
                onChange={(e) => setIdempotencyKey(e.target.value)}
                placeholder="e.g. pr-42-card-check"
              />
              <span className="field-hint">Optional UTF-8 deduplication key</span>
            </div>
          </div>

          <div className="button-row">
            <button
              type="submit"
              className="btn btn-primary"
              disabled={submitting}
            >
              {submitting ? "Submitting..." : "Run Comparison"}
            </button>
          </div>
        </section>
      </form>
    </div>
  );
}

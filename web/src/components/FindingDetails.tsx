import { useState } from "react";
import { canonicalJson } from "../lib/canonicalJson";
import {
  extractKeyTraceEvents,
  formatExplanationKind,
  formatMoneyDisplay,
  formatScopeFrames,
  formatTypedValue,
  getLoopVariantIds,
  splitSourceLines,
} from "../lib/formatters";
import type { ComparisonJob, TraceEvent } from "../types";

interface FindingDetailsProps {
  job: ComparisonJob;
}

function renderEventSummaryText(event: TraceEvent): {
  title: string;
  operands: Array<{ label: string; value: unknown }>;
} {
  const { data } = event;
  switch (data.kind) {
    case "assignment":
      return {
        title: `${data.name} =`,
        operands: [{ label: "value", value: data.value }],
      };
    case "comparison":
      return {
        title: `${data.op}`,
        operands: [
          { label: "left", value: data.left },
          { label: "right", value: data.right },
          { label: "result", value: data.result },
        ],
      };
    case "lookup":
      return {
        title: `${data.path}${data.found ? "" : " (missing)"}`,
        operands: [{ label: "value", value: data.value }],
      };
    case "branch":
      return {
        title: `if (${data.expression})`,
        operands: [
          { label: "condition", value: data.condition },
          { label: "taken", value: data.taken },
        ],
      };
    case "emit":
      return {
        title: `bytes [${data.output_start_byte}..${data.output_end_byte})`,
        operands: [{ label: "branches", value: data.active_branch_seqs }],
      };
  }
}

export function buildReplayDownloadJson(job: ComparisonJob): string {
  if (!job.finding) {
    throw new Error("Cannot serialize replay JSON without a finding");
  }
  return canonicalJson(job.finding.replay);
}

export function FindingDetails({ job }: FindingDetailsProps) {
  const [copiedCmd, setCopiedCmd] = useState(false);

  const finding = job.finding;
  const stats = job.stats;
  if (!finding || !stats) {
    return null;
  }

  const { product, replay, before, after, reference, explanation } = finding;

  const beforeObserved = Boolean(before.observed);
  const afterObserved = Boolean(after.observed);
  const directionLabel =
    beforeObserved && !afterObserved
      ? "Sale Badge Present in Before only"
      : !beforeObserved && afterObserved
        ? "Sale Badge Present in After only"
        : "Sale Badge Difference Detected";

  const referenceConfirmed =
    reference.before.observed === before.observed &&
    reference.after.observed === after.observed;

  const beforeLines = splitSourceLines(job.request.before.source);
  const afterLines = splitSourceLines(job.request.after.source);

  const keyEvents: Array<{ side: "Before" | "After"; event: TraceEvent; isAnchor: boolean }> = [
    ...extractKeyTraceEvents(before.events).map((event) => ({
      side: "Before" as const,
      event,
      isAnchor: explanation.before?.event_seq === event.seq,
    })),
    ...extractKeyTraceEvents(after.events).map((event) => ({
      side: "After" as const,
      event,
      isAnchor: explanation.after?.event_seq === event.seq,
    })),
  ];

  const replayCliCommand = "python3.11 -m search replay --bundle replay.json";

  const scrollToAnchorLine = (side: "before" | "after", line: number) => {
    const el = document.getElementById(`${side}-line-${line}`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.focus({ preventScroll: true });
    }
  };

  const handleDownloadReplay = () => {
    const payload = buildReplayDownloadJson(job);
    const blob = new Blob([payload], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "replay.json";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const handleCopyCli = async () => {
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
        await navigator.clipboard.writeText(replayCliCommand);
      }
      setCopiedCmd(true);
      setTimeout(() => setCopiedCmd(false), 2000);
    } catch {
      setCopiedCmd(false);
    }
  };

  const projectionFields: Array<{
    key: string;
    kind: "money" | "boolean";
    value: number | null | boolean;
  }> = [
    { key: "price", kind: "money", value: product.price },
    { key: "price_min", kind: "money", value: product.price_min },
    { key: "price_max", kind: "money", value: product.price_max },
    { key: "price_varies", kind: "boolean", value: product.price_varies },
    { key: "compare_at_price", kind: "money", value: product.compare_at_price },
    { key: "compare_at_price_min", kind: "money", value: product.compare_at_price_min },
    { key: "compare_at_price_max", kind: "money", value: product.compare_at_price_max },
    {
      key: "compare_at_price_varies",
      kind: "boolean",
      value: product.compare_at_price_varies,
    },
    { key: "available", kind: "boolean", value: product.available },
  ];

  return (
    <>
      {/* 1. Summary & Parity Banner */}
      <section className="card" aria-labelledby="summary-banner-heading">
        <div className="badge-row" style={{ marginBottom: "0.75rem" }}>
          <span className="badge badge-danger" data-status="difference_found">
            Difference Found
          </span>
          <span className="badge badge-info">{directionLabel}</span>
          <span
            className={`badge ${referenceConfirmed ? "badge-success" : "badge-warn"}`}
          >
            {referenceConfirmed
              ? `Confirmed by Official Liquid v${replay.liquid_version}`
              : `Reference Parity Unconfirmed (Official Liquid v${replay.liquid_version})`}
          </span>
        </div>

        <h2 id="summary-banner-heading">Regression Summary &amp; Parity</h2>

        <div className="kv-grid">
          <div className="kv-item">
            <span className="kv-label">Search Pairs Examined</span>
            <span className="kv-value mono">{stats.search_pairs}</span>
          </div>
          <div className="kv-item">
            <span className="kv-label">Shrink Pairs Examined</span>
            <span className="kv-value mono">{stats.shrink_pairs}</span>
          </div>
          <div className="kv-item">
            <span className="kv-label">Parity Rejections</span>
            <span className="kv-value mono">{stats.parity_rejections}</span>
          </div>
          <div className="kv-item">
            <span className="kv-label">Seed</span>
            <span className="kv-value mono">{job.request.seed}</span>
          </div>
          <div className="kv-item">
            <span className="kv-label">First Difference</span>
            <span className="kv-value mono">
              {stats.first_difference_ms !== null ? `${stats.first_difference_ms} ms` : "—"}
            </span>
          </div>
          <div className="kv-item">
            <span className="kv-label">Total Elapsed</span>
            <span className="kv-value mono">{stats.elapsed_ms} ms</span>
          </div>
        </div>
      </section>

      {/* 2. Explanation Card */}
      <section className="card" aria-labelledby="explanation-heading">
        <div className="badge-row" style={{ marginBottom: "0.65rem" }}>
          <span className="badge badge-warn">
            {formatExplanationKind(explanation.kind)}
          </span>
          {explanation.before && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => scrollToAnchorLine("before", explanation.before!.line)}
            >
              Before Line L{explanation.before.line} (seq #{explanation.before.event_seq})
            </button>
          )}
          {explanation.after && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => scrollToAnchorLine("after", explanation.after!.line)}
            >
              After Line L{explanation.after.line} (seq #{explanation.after.event_seq})
            </button>
          )}
        </div>
        <h2 id="explanation-heading">Condition Explanation</h2>
        <p style={{ margin: 0 }}>{explanation.summary}</p>
      </section>

      {/* 3. Minimized Fixture Variant Table & Derived Product Projection */}
      <section className="card" aria-labelledby="fixture-projection-heading">
        <div className="badge-row" style={{ marginBottom: "0.65rem" }}>
          <span className="badge badge-neutral">
            Minimized Fixture · {replay.fixture.variants.length} variant(s) ·{" "}
            {replay.fixture.currency}
          </span>
        </div>
        <h2 id="fixture-projection-heading">
          Minimized Fixture Variants &amp; Derived <code className="mono">product</code>{" "}
          Projection
        </h2>

        <div className="two-col">
          <div>
            <h3>Variants</h3>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">ID</th>
                    <th scope="col">Price</th>
                    <th scope="col">Compare At Price</th>
                    <th scope="col">Available</th>
                  </tr>
                </thead>
                <tbody>
                  {replay.fixture.variants.map((variant) => {
                    const priceDisp = formatMoneyDisplay(variant.price);
                    const capDisp = formatMoneyDisplay(variant.compare_at_price);
                    return (
                      <tr key={variant.id}>
                        <td className="mono">{variant.id}</td>
                        <td className="mono">
                          {priceDisp.usd} ({priceDisp.centsLabel})
                        </td>
                        <td className="mono">
                          {capDisp.isNil ? (
                            <span className="badge badge-neutral">nil</span>
                          ) : (
                            `${capDisp.usd} (${capDisp.centsLabel})`
                          )}
                        </td>
                        <td>
                          <span
                            className={`badge ${
                              variant.available ? "badge-success" : "badge-neutral"
                            }`}
                          >
                            {String(variant.available)}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div>
            <h3>
              Derived <code className="mono">product</code> Fields
            </h3>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">Field</th>
                    <th scope="col">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {projectionFields.map((field) => {
                    if (field.kind === "boolean") {
                      const boolVal = Boolean(field.value);
                      return (
                        <tr key={field.key}>
                          <td className="mono">product.{field.key}</td>
                          <td>
                            <span
                              className={`badge ${
                                boolVal ? "badge-info" : "badge-neutral"
                              }`}
                            >
                              {String(boolVal)}
                            </span>
                          </td>
                        </tr>
                      );
                    }
                    const moneyDisp = formatMoneyDisplay(
                      field.value as number | null,
                    );
                    return (
                      <tr key={field.key}>
                        <td className="mono">product.{field.key}</td>
                        <td className="mono">
                          {moneyDisp.isNil ? (
                            <span className="badge badge-neutral">nil</span>
                          ) : (
                            `${moneyDisp.usd} (${moneyDisp.centsLabel})`
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </section>

      {/* 4. Safely Escaped Rendered HTML Outputs */}
      <section className="card" aria-labelledby="rendered-html-heading">
        <h2 id="rendered-html-heading">Rendered HTML Outputs (Escaped Text)</h2>
        <p className="muted-note" style={{ marginTop: 0 }}>
          Rendered markup is displayed strictly as escaped text so submitted HTML or
          scripts cannot execute.
        </p>

        <div className="two-col">
          <div>
            <div className="badge-row" style={{ marginBottom: "0.45rem" }}>
              <h3 style={{ margin: 0 }}>Before Output</h3>
              <span
                className={`badge ${
                  beforeObserved ? "badge-success" : "badge-neutral"
                }`}
              >
                {beforeObserved ? "Sale Badge Present" : "Sale Badge Absent"}
              </span>
              <span className="badge badge-neutral">
                Official Liquid v{replay.liquid_version}:{" "}
                {reference.before.observed ? "Present" : "Absent"} (
                {reference.before.observed === before.observed ? "Match" : "Mismatch"})
              </span>
            </div>
            <pre className="code-output" data-testid="before-rendered-html">
              <code>{before.html ?? ""}</code>
            </pre>
            {(before.html ?? "") === "" && (
              <p className="muted-note" style={{ marginBottom: 0 }}>
                (empty output — 0 bytes)
              </p>
            )}
          </div>

          <div>
            <div className="badge-row" style={{ marginBottom: "0.45rem" }}>
              <h3 style={{ margin: 0 }}>After Output</h3>
              <span
                className={`badge ${
                  afterObserved ? "badge-success" : "badge-neutral"
                }`}
              >
                {afterObserved ? "Sale Badge Present" : "Sale Badge Absent"}
              </span>
              <span className="badge badge-neutral">
                Official Liquid v{replay.liquid_version}:{" "}
                {reference.after.observed ? "Present" : "Absent"} (
                {reference.after.observed === after.observed ? "Match" : "Mismatch"})
              </span>
            </div>
            <pre className="code-output" data-testid="after-rendered-html">
              <code>{after.html ?? ""}</code>
            </pre>
            {(after.html ?? "") === "" && (
              <p className="muted-note" style={{ marginBottom: 0 }}>
                (empty output — 0 bytes)
              </p>
            )}
          </div>
        </div>
      </section>

      {/* 5. Highlighted Original Source Lines */}
      <section className="card" aria-labelledby="source-anchors-heading">
        <h2 id="source-anchors-heading">
          Original Liquid Sources &amp; Highlighted Anchor Lines
        </h2>
        <div className="two-col">
          <div>
            <h3>
              Before Source{" "}
              {explanation.before ? `(Anchor: Line ${explanation.before.line})` : ""}
            </h3>
            <div className="source-viewer" data-testid="before-source-lines">
              {beforeLines.map((lineText, idx) => {
                const lineNum = idx + 1;
                const isAnchor = explanation.before?.line === lineNum;
                return (
                  <div
                    key={lineNum}
                    id={`before-line-${lineNum}`}
                    tabIndex={isAnchor ? 0 : undefined}
                    className="source-line"
                    data-anchor-line={isAnchor ? "true" : undefined}
                  >
                    <span className="source-line-num">{lineNum}</span>
                    {isAnchor && <span className="anchor-badge">Anchor</span>}
                    <code className="source-line-code">{lineText}</code>
                  </div>
                );
              })}
            </div>
          </div>

          <div>
            <h3>
              After Source{" "}
              {explanation.after ? `(Anchor: Line ${explanation.after.line})` : ""}
            </h3>
            <div className="source-viewer" data-testid="after-source-lines">
              {afterLines.map((lineText, idx) => {
                const lineNum = idx + 1;
                const isAnchor = explanation.after?.line === lineNum;
                return (
                  <div
                    key={lineNum}
                    id={`after-line-${lineNum}`}
                    tabIndex={isAnchor ? 0 : undefined}
                    className="source-line"
                    data-anchor-line={isAnchor ? "true" : undefined}
                  >
                    <span className="source-line-num">{lineNum}</span>
                    {isAnchor && <span className="anchor-badge">Anchor</span>}
                    <code className="source-line-code">{lineText}</code>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </section>

      {/* 6. Trace Events, Loop variant_ids & Typed Operands */}
      <section className="card" aria-labelledby="trace-events-heading">
        <h2 id="trace-events-heading">
          Trace Events, Loop <code className="mono">variant_id</code>s &amp; Typed Operands
        </h2>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Side</th>
                <th scope="col">Seq</th>
                <th scope="col">Line</th>
                <th scope="col">Kind</th>
                <th scope="col">Loop / Scope</th>
                <th scope="col">Operands &amp; Values</th>
              </tr>
            </thead>
            <tbody>
              {keyEvents.map(({ side, event, isAnchor }) => {
                const summary = renderEventSummaryText(event);
                const variantIds = getLoopVariantIds(event.scope);
                return (
                  <tr
                    key={`${side}-${event.seq}`}
                    data-anchor-event={isAnchor ? "true" : undefined}
                  >
                    <td>
                      <span className="badge badge-neutral">{side}</span>
                      {isAnchor && (
                        <span className="anchor-badge" style={{ marginLeft: "0.3rem" }}>
                          Anchor
                        </span>
                      )}
                    </td>
                    <td className="mono">#{event.seq}</td>
                    <td className="mono">L{event.span.line}</td>
                    <td>
                      <span className="badge badge-info">{event.data.kind}</span>
                    </td>
                    <td className="mono">
                      {variantIds.length > 0 ? (
                        <span>
                          variant_id={JSON.stringify(variantIds[variantIds.length - 1])}{" "}
                          <span className="muted-note">
                            ({formatScopeFrames(event.scope)})
                          </span>
                        </span>
                      ) : (
                        <span className="muted-note">
                          {formatScopeFrames(event.scope)}
                        </span>
                      )}
                    </td>
                    <td className="mono">
                      <div>{summary.title}</div>
                      <div style={{ marginTop: "0.2rem" }}>
                        {summary.operands.map((op, i) => {
                          const typed = formatTypedValue(op.value);
                          return (
                            <span key={op.label} style={{ marginRight: "0.6rem" }}>
                              {i > 0 ? "· " : ""}
                              {op.label}: <strong>{typed.valueText}</strong>
                              <span className="type-pill">{typed.typeLabel}</span>
                            </span>
                          );
                        })}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <details className="trace-details">
          <summary>
            Before Full Trace Events ({before.events.length} events)
          </summary>
          <TraceEventTable events={before.events} anchorSeq={explanation.before?.event_seq ?? null} />
        </details>

        <details className="trace-details">
          <summary>
            After Full Trace Events ({after.events.length} events)
          </summary>
          <TraceEventTable events={after.events} anchorSeq={explanation.after?.event_seq ?? null} />
        </details>
      </section>

      {/* 7. Replay Download & CLI Command */}
      <section className="card" aria-labelledby="replay-heading">
        <h2 id="replay-heading">Replay Bundle &amp; CLI Verification</h2>
        <div className="badge-row" style={{ marginBottom: "0.75rem" }}>
          <span className="badge badge-neutral mono">
            interpreter v{replay.interpreter_version}
          </span>
          <span className="badge badge-neutral mono">
            liquid v{replay.liquid_version}
          </span>
          <span className="badge badge-neutral mono">
            projection v{replay.projection_version}
          </span>
        </div>

        <div className="cli-box">
          <code>{replayCliCommand}</code>
          <button type="button" className="btn btn-sm" onClick={handleCopyCli}>
            {copiedCmd ? "Copied" : "Copy Command"}
          </button>
        </div>

        <div className="button-row">
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleDownloadReplay}
          >
            Download Replay JSON
          </button>
        </div>
      </section>
    </>
  );
}

function TraceEventTable({
  events,
  anchorSeq,
}: {
  events: TraceEvent[];
  anchorSeq: number | null;
}) {
  return (
    <div className="table-scroll">
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">Seq</th>
            <th scope="col">Line:Col</th>
            <th scope="col">Node ID</th>
            <th scope="col">Scope</th>
            <th scope="col">Data</th>
          </tr>
        </thead>
        <tbody>
          {events.map((ev) => {
            const summary = renderEventSummaryText(ev);
            const isAnchor = anchorSeq === ev.seq;
            return (
              <tr key={ev.seq} data-anchor-event={isAnchor ? "true" : undefined}>
                <td className="mono">
                  #{ev.seq} {isAnchor && <span className="anchor-badge">Anchor</span>}
                </td>
                <td className="mono">
                  L{ev.span.line}:{ev.span.column}
                </td>
                <td className="mono">{ev.node_id}</td>
                <td className="mono">{formatScopeFrames(ev.scope)}</td>
                <td className="mono">
                  <strong>{ev.data.kind}</strong>: {summary.title}{" "}
                  {summary.operands.map((op) => {
                    const typed = formatTypedValue(op.value);
                    return (
                      <span key={op.label} style={{ marginLeft: "0.4rem" }}>
                        {op.label}={typed.valueText}
                        <span className="type-pill">{typed.typeLabel}</span>
                      </span>
                    );
                  })}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

import type { ExplanationKind, Frame, TraceEvent } from "../types";

export function formatUsd(cents: number): string {
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const dollars = (abs / 100).toFixed(2);
  return `${negative ? "-" : ""}$${dollars}`;
}

export function formatMoneyDisplay(cents: number | null): {
  usd: string;
  centsLabel: string;
  isNil: boolean;
} {
  if (cents === null) {
    return { usd: "nil", centsLabel: "null", isNil: true };
  }
  return {
    usd: formatUsd(cents),
    centsLabel: `${cents}¢`,
    isNil: false,
  };
}

export interface TypedValueDisplay {
  valueText: string;
  typeLabel: string;
}

export function formatTypedValue(value: unknown): TypedValueDisplay {
  if (value === null) {
    return { valueText: "nil", typeLabel: "nil" };
  }
  if (typeof value === "boolean") {
    return { valueText: value ? "true" : "false", typeLabel: "boolean" };
  }
  if (typeof value === "number") {
    return { valueText: String(value), typeLabel: "number" };
  }
  if (typeof value === "string") {
    return { valueText: JSON.stringify(value), typeLabel: "string" };
  }
  if (Array.isArray(value)) {
    return {
      valueText: JSON.stringify(value),
      typeLabel: `array[${value.length}]`,
    };
  }
  if (typeof value === "object") {
    return { valueText: JSON.stringify(value), typeLabel: "object" };
  }
  return { valueText: String(value), typeLabel: typeof value };
}

export function splitSourceLines(source: string): string[] {
  if (source.length === 0) {
    return [""];
  }
  const parts = source.split("\n");
  if (parts.length > 1 && parts[parts.length - 1] === "") {
    parts.pop();
  }
  return parts;
}

export function formatExplanationKind(kind: ExplanationKind): string {
  switch (kind) {
    case "structural_change":
      return "Structural Change";
    case "aligned_change":
      return "Aligned Change";
    case "undetermined":
      return "Undetermined";
  }
}

export function formatScopeFrames(scope: Frame[]): string {
  if (scope.length === 0) {
    return "product / top-level";
  }
  return scope
    .map((frame) =>
      frame.variant_id !== null
        ? `variant_id="${frame.variant_id}" (iter ${frame.iteration})`
        : `${frame.loop_id} (iter ${frame.iteration})`,
    )
    .join(" > ");
}

export function getLoopVariantIds(scope: Frame[]): string[] {
  return scope
    .map((f) => f.variant_id)
    .filter((id): id is string => id !== null);
}

export function extractKeyTraceEvents(events: TraceEvent[]): TraceEvent[] {
  return events.filter(
    (ev) =>
      ev.data.kind === "assignment" ||
      ev.data.kind === "comparison" ||
      ev.data.kind === "lookup" ||
      ev.data.kind === "branch",
  );
}

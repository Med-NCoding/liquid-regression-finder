/**
 * Deterministic sorted-key UTF-8 compact JSON serializer matching Python's
 * `json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)`.
 * Preserves array order and rejects non-finite numbers (NaN, Infinity).
 */
export function canonicalJson(value: unknown): string {
  if (value === null) {
    return "null";
  }

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number": {
      if (!Number.isFinite(value)) {
        throw new RangeError("canonicalJson does not allow NaN or Infinity");
      }
      return Object.is(value, -0) ? "0" : JSON.stringify(value);
    }
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        const items = value.map((item) =>
          item === undefined ? "null" : canonicalJson(item),
        );
        return `[${items.join(",")}]`;
      }

      const record = value as Record<string, unknown>;
      const keys = Object.keys(record)
        .filter((k) => record[k] !== undefined)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

      const entries = keys.map(
        (k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`,
      );
      return `{${entries.join(",")}}`;
    }
    default:
      throw new TypeError(`Unsupported value type in canonicalJson: ${typeof value}`);
  }
}

const utf8Encoder = new TextEncoder();

export function utf8ByteLength(text: string): number {
  return utf8Encoder.encode(text).length;
}

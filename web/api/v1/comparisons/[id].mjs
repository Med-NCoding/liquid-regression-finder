import { getComparisonJob, sendJson } from "../../_lib/engine.mjs";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    sendJson(res, 405, {
      error: { code: "method_not_allowed", message: "Method not allowed", span: null },
    });
    return;
  }

  let id = req.query?.id;
  if (Array.isArray(id)) id = id[0];
  if (!id && typeof req.url === "string") {
    const pathname = req.url.split("?")[0];
    const parts = pathname.split("/").filter(Boolean);
    id = parts[parts.length - 1];
  }

  const comparison = typeof id === "string" ? await getComparisonJob(id) : null;
  if (!comparison) {
    sendJson(res, 404, {
      error: {
        code: "not_found",
        message: `Comparison '${id ?? ""}' was not found`,
        span: null,
      },
    });
    return;
  }

  sendJson(res, 200, comparison);
}

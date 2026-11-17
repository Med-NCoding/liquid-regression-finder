import { sendJson } from "../_lib/engine.mjs";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    sendJson(res, 405, {
      error: { code: "method_not_allowed", message: "Method not allowed", span: null },
    });
    return;
  }
  sendJson(res, 200, { status: "ok" });
}

import {
  checkBearerAuth,
  createOrGetComparisonJob,
  extractIdempotencyHeader,
  handleError,
  readRawRequestBody,
  sendJson,
} from "../../_lib/engine.mjs";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, {
      error: { code: "method_not_allowed", message: "Method not allowed", span: null },
    });
    return;
  }

  try {
    checkBearerAuth(req);
    const idempotencyKey = extractIdempotencyHeader(req);
    const rawBody = await readRawRequestBody(req);
    const { statusCode, job } = await createOrGetComparisonJob(rawBody, idempotencyKey);
    sendJson(res, statusCode, job, { Location: `/api/v1/comparisons/${job.id}` });
  } catch (err) {
    handleError(res, err);
  }
}

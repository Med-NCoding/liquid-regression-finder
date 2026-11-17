import comparisonsHandler from "./comparisons/index.mjs";
import comparisonShowHandler from "./comparisons/[id].mjs";
import healthHandler from "./health.mjs";

export default async function handler(req, res) {
  let route = req.query?.route;
  if (Array.isArray(route)) route = route[0];

  const pathname = typeof req.url === "string" ? req.url.split("?")[0] : "";

  if (route === "health" || pathname === "/api/v1/health") {
    return healthHandler(req, res);
  }

  if (route === "comparisons" || pathname === "/api/v1/comparisons") {
    return comparisonsHandler(req, res);
  }

  if (route === "comparison" || pathname.startsWith("/api/v1/comparisons/")) {
    return comparisonShowHandler(req, res);
  }

  res.statusCode = 404;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(
    JSON.stringify({
      error: { code: "not_found", message: "API route not found", span: null },
    }),
  );
}

import { httpRequestsTotal, httpRequestDuration, httpRequestErrorsTotal } from "../lib/metrics.js";

/**
 * Phase 13 (§11.2): record one HTTP metrics sample per finished response —
 * duration histogram + total/error counters, labeled {method, route, status}.
 *
 * `route` is normalized to the Express route pattern (:tripId etc.) so label
 * cardinality stays bounded at fleet scale; requests that never matched a
 * route (404s, pre-route failures) fall back to "<unmatched>". Registered in
 * createApp before all routers; req.route is populated by routing time, so
 * reading it on `finish` is safe.
 */
function routeOf(req) {
  if (req.route?.path) {
    const base = req.baseUrl || "";
    return req.route.path === "/" ? base || "/" : `${base}${req.route.path}`;
  }
  return "<unmatched>";
}

export function metricsMiddleware(req, res, next) {
  const start = process.hrtime.bigint();
  res.on("finish", () => {
    const duration = Number(process.hrtime.bigint() - start) / 1e9;
    const route = routeOf(req);
    const { method } = req;
    const status = String(res.statusCode);
    httpRequestsTotal.inc({ method, route, status });
    httpRequestDuration.observe({ method, route }, duration);
    if (res.statusCode >= 400) httpRequestErrorsTotal.inc({ method, route });
  });
  next();
}

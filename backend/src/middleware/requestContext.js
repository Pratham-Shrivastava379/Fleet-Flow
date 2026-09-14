import crypto from "node:crypto";
import { als, logger } from "../lib/logger.js";

/**
 * Phase 13: per-request context + structured request log.
 *
 * - Generates (or honors an inbound) x-request-id, echoes it as a response
 *   header, and runs the rest of the request inside the logger ALS store so
 *   every downstream log line (middleware, services, libs) carries the
 *   requestId. Auth middleware stamps userId into the same store
 *   (lib/logger.js setRequestUserId) once the bearer token is verified.
 * - On response finish, emits ONE structured line per request:
 *   { method, path, status, durationMs }. Bodies, tokens and query strings are
 *   deliberately NOT logged.
 *
 * Registered before all routes (createApp) so 404s/unmatched paths are logged
 * too. Errors are logged by the errorHandler (which runs at the end of the
 * chain), not here — this middleware only reports the terminal status.
 */
export function requestContext(req, res, next) {
  const requestId = req.headers["x-request-id"] || crypto.randomUUID();
  res.setHeader("x-request-id", requestId);
  const store = { requestId };
  als.run(store, () => {
    const start = process.hrtime.bigint();
    res.on("finish", () => {
      const durationMs = Math.round((Number(process.hrtime.bigint() - start) / 1e6) * 100) / 100;
      const fields = {
        requestId,
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        durationMs,
        module: "http",
      };
      if (res.statusCode >= 500) logger.error(fields, "request errored");
      else if (res.statusCode >= 400) logger.warn(fields, "request failed");
      else logger.info(fields, "request complete");
    });
    next();
  });
}

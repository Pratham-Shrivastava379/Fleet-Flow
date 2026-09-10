import { AsyncLocalStorage } from "node:async_hooks";
import pino from "pino";
import config from "../config.js";

/**
 * Phase 13 structured logging (blueprint §11.1). Replaces ad-hoc
 * console.log/console.error across the backend. Every line is JSON with
 * { time, level, service, msg, ...context }; in-request lines additionally
 * carry { requestId, userId } (userId once auth has run).
 *
 * Request context propagation: `als` (AsyncLocalStorage) is populated by the
 * requestContext middleware (middleware/requestContext.js) with the per-request
 * requestId, and auth middleware stamps userId into the same store. Services
 * and libs call getContextLogger({ module }) instead of logging on the bare
 * logger, so a service-layer log line is traceable back to the HTTP request
 * that caused it — without threading a `log` object through every function
 * signature. Job workers log outside a request (no ALS context → no
 * requestId/userId fields).
 *
 * Level is controlled by LOG_LEVEL (info default; tests set silent).
 */
export const als = new AsyncLocalStorage();

export const logger = pino({
  level: config.logLevel,
  timestamp: pino.stdTimeFunctions.isoTime,
  base: { service: process.env.OTEL_SERVICE_NAME || "fleetflow-backend" },
  // Human-readable level label ("info") instead of pino's numeric default.
  formatters: { level: (label) => ({ level: label }) },
});

/** Current request context { requestId, userId? } or {} when not in a request. */
export function getRequestContext() {
  return als.getStore() || {};
}

export function getRequestId() {
  return getRequestContext().requestId;
}

/** Stamp the authenticated user id into the current request's context. */
export function setRequestUserId(userId) {
  const store = als.getStore();
  if (store && userId != null) store.userId = userId;
}

/**
 * Logger bound to the current request context (requestId/userId) plus caller
 * bindings (typically { module }). Use this everywhere instead of the bare
 * logger or console.
 */
export function getContextLogger(bindings = {}) {
  const ctx = getRequestContext();
  return logger.child({
    ...bindings,
    ...(ctx.requestId ? { requestId: ctx.requestId } : {}),
    ...(ctx.userId ? { userId: ctx.userId } : {}),
  });
}

import * as Sentry from "@sentry/node";

/**
 * Phase 13 error tracking.
 *
 * Stub-until-configured like FCM/SMS (Phase 7 convention): Sentry is fully
 * inert until SENTRY_DSN is set — no DSN, no network, no behavior change.
 * errorHandler calls captureError() for every 5xx it handles; without a DSN
 * it no-ops. With a DSN, errors are tagged with the requestId + userId from
 * the ALS context so a captured exception links to its structured log line
 * and trace. Traces are sampled only when SENTRY_TRACES_SAMPLE_RATE is set
 * (default 0.0 — errors-only, keeping quota predictable on a trial org).
 */
let inited = false;

export function sentryEnabled() {
  return Boolean(process.env.SENTRY_DSN);
}

export function initSentry() {
  if (inited || !sentryEnabled()) return;
  inited = true;
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || "development",
    tracesSampleRate: process.env.SENTRY_TRACES_SAMPLE_RATE ? Number(process.env.SENTRY_TRACES_SAMPLE_RATE) : 0.0,
  });
}

/** Report an unexpected error to Sentry (no-op without a DSN). Never throws. */
export function captureError(err, { requestId = null, userId = null } = {}) {
  if (!sentryEnabled()) return;
  Sentry.withScope((scope) => {
    if (requestId) scope.setTag("requestId", requestId);
    if (userId != null) scope.setUser({ id: String(userId) });
    Sentry.captureException(err);
  });
}

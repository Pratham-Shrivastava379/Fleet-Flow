import "dotenv/config";

const config = {
  port: Number(process.env.PORT || 3000),
  redisUrl: process.env.REDIS_URL || "redis://localhost:6379",
  jwtAccessSecret: process.env.JWT_ACCESS_SECRET || "dev-access-secret-change-me",
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET || "dev-refresh-secret-change-me",
  accessTtl: "15m",
  refreshTtlDays: 7,
  nodeEnv: process.env.NODE_ENV || "development",
  isProd: process.env.NODE_ENV === "production",
  // Web dashboard (Phase 11, blueprint §5.4): refresh token delivered as an
  // HttpOnly SameSite=Strict cookie for browser clients (X-Client: web) rather
  // than in the JSON body (which mobile keeps). Never JS-accessible.
  webRefreshCookieName: process.env.WEB_REFRESH_COOKIE || "fleetflow_refresh",
  webRefreshCookieSecure: process.env.WEB_REFRESH_COOKIE_SECURE === "true" || process.env.NODE_ENV === "production",
  // Phase 11 / §5.6: a browser client now exists, so CORS is tightened to an
  // explicit allow-list (credentials enabled for the cookie flow) instead of
  // the previous wide-open `cors()`. Comma-separated origins.
  corsOrigins: (process.env.CORS_ORIGINS || "http://localhost:5173")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  // Phase 4 (blueprint §4.2): global per-IP rate limit. 300 req/min is the
  // MVP default — fine for interactive use and generous per single device, but
  // Phase 15 (production/load) exposes the ceiling via RATE_LIMIT_GLOBAL_MAX so
  // a capacity run (or a fleet behind one egress NAT) can raise it. Auth routes
  // keep their own stricter limiter regardless.
  rateLimitGlobalMax: Number(process.env.RATE_LIMIT_GLOBAL_MAX || 300),
  // Phase 7: SOS SMS fallback — strictly opt-in (blueprint §714/§512: the
  // system must function fully without SMS configured).
  smsSosEnabled: process.env.SMS_SOS_ENABLED === "true",
  twilioAccountSid: process.env.TWILIO_ACCOUNT_SID || "",
  twilioAuthToken: process.env.TWILIO_AUTH_TOKEN || "",
  twilioFrom: process.env.TWILIO_FROM_NUMBER || "",
  smsSosTo: process.env.SMS_SOS_TO || "",
  appBaseUrl: process.env.APP_BASE_URL || "",
  // Phase 10 (§8.1): stale-trip reaper — auto-cancel ACTIVE trips with no ping
  // for this many hours. 0 disables the reaper entirely.
  staleTripHours: Number(process.env.STALE_TRIP_HOURS || 12),
  // Phase 10 (§3.6): on-device queue cap/downsampling contract (client-side;
  // documented in .env.example for parity with the Android config).
  pingQueueHardCap: Number(process.env.PING_QUEUE_HARD_CAP || 5000),
  // Phase 13 observability (§11). Structured logging level (pino).
  logLevel: process.env.LOG_LEVEL || "info",
  // §4.2/§11.2: /api/metrics is "internal network / auth token, not public" —
  // when set, scrapes must present METRICS_TOKEN as a Bearer token.
  metricsToken: process.env.METRICS_TOKEN || "",
  // §11.2: the worker process (no HTTP server of its own) exposes its own
  // small Prometheus exporter on this port.
  workerMetricsPort: Number(process.env.WORKER_METRICS_PORT || 9091),
  // Phase 12/13: export artifact storage. Default: OS temp dir (single-process
  // dev). In the containerized stack, API + worker are separate processes/filesystems,
  // so compose mounts a SHARED volume here — the download route (API) must read
  // what the exports worker wrote. Production replaces deliver() with S3 (§13.2).
  exportArtifactDir: process.env.EXPORT_ARTIFACT_DIR || "",
  // §5 (auth hardening): dev-only reset/invite token delivery (log line + test
  // sink). Tokens are account-recovery secrets, so delivery is opt-in per
  // environment: set DEV_TOKEN_DELIVERY=true in development/test ONLY. In
  // production the policy in authService.tokenDeliveryPolicy() refuses the log
  // channel entirely (and config refuses to boot with it enabled) — delivery
  // then requires a real provider (Phase 7+) and fails safe with a warning.
  devTokenDelivery: process.env.DEV_TOKEN_DELIVERY === "true",
};

if (config.isProd && config.jwtAccessSecret.includes("dev-")) {
  throw new Error("Refusing to run in production with dev JWT secrets");
}
// Fail fast (§1: useful configuration errors): production must never fall back
// to console-delivered one-time tokens. .env.example documents the contract.
if (config.isProd && config.devTokenDelivery) {
  throw new Error("DEV_TOKEN_DELIVERY=true is not allowed in production (NODE_ENV=production)");
}

export default config;

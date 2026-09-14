import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import config from "./config.js";
import authRoutes from "./routes/authRoutes.js";
import vehicleRoutes from "./routes/vehicleRoutes.js";
import tripRoutes from "./routes/tripRoutes.js";
import alertRoutes from "./routes/alertRoutes.js";
import geofenceRoutes from "./routes/geofenceRoutes.js";
import userRoutes from "./routes/userRoutes.js";
import auditRoutes from "./routes/auditRoutes.js";
// Phase 12 (§7.2): fleet user administration + async CSV export jobs.
import userAdminRoutes from "./routes/userAdminRoutes.js";
import exportRoutes from "./routes/exportRoutes.js";
import { rateLimit } from "./middleware/rateLimit.js";
import { notFound, errorHandler } from "./middleware/errorHandler.js";
// Phase 13 observability: request-context/logging + metrics.
import { requestContext } from "./middleware/requestContext.js";
import { metricsMiddleware } from "./middleware/metrics.js";
import { getContextLogger } from "./lib/logger.js";
import { serveMetrics } from "./lib/metrics.js";
import { prisma } from "./prisma.js";
import { redis } from "./lib/redis.js";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.use(helmet());
  // Phase 13 (§11.1/§11.2): structured request logging (requestId header +
  // ALS context) and per-route HTTP metrics. Registered before every router
  // so all traffic (incl. 404s) is logged + measured.
  app.use(requestContext);
  app.use(metricsMiddleware);
  // Phase 11 / §5.6: a browser client (the web dashboard) now exists, so CORS
  // is an explicit allow-list with credentials (cookie flow), not the previous
  // unrestricted `cors()`. Requests without an Origin (native tooling, tests,
  // curl) are unaffected — no ACAO header is emitted. Vite dev proxies /api and
  // /ws same-origin, so the cookie is same-site in local dev regardless.
  app.use(
    cors({
      origin(origin, cb) {
        if (!origin || config.corsOrigins.includes(origin)) return cb(null, true);
        return cb(null, false);
      },
      credentials: true,
    }),
  );
  app.use(cookieParser());
  app.use(express.json({ limit: "256kb" }));

  // global limiter; auth routes get a stricter one (brute-force protection)
  app.use("/api", rateLimit({ windowMs: 60_000, max: config.rateLimitGlobalMax }));
  app.use("/api/auth/login", rateLimit({ windowMs: 60_000, max: 10 }));

  // §4.2 health contract: { ok, db, redis, ts } — checks the two hard
  // dependencies. Both checks are fail-open (a transient hiccup reports the
  // failing piece instead of 500-ing the whole probe), and the load balancer
  // routes around an unhealthy instance via `ok`.
  app.get("/api/health", async (_req, res) => {
    let db = false;
    let redisUp = false;
    try {
      await prisma.$queryRaw`SELECT 1`;
      db = true;
    } catch (err) {
      getContextLogger({ module: "health" }).error({ err: err?.message }, "db check failed");
    }
    try {
      redisUp = (await redis.ping()) === "PONG";
    } catch (err) {
      getContextLogger({ module: "health" }).error({ err: err?.message }, "redis check failed");
    }
    res.json({ ok: db && redisUp, db, redis: redisUp, ts: new Date().toISOString() });
  });

  // Prometheus text format. The endpoint supports bearer-token protection: when
  // METRICS_TOKEN is set, scrapes must present it as a Bearer token.
  app.get("/api/metrics", async (req, res) => {
    const expected = config.metricsToken;
    if (expected) {
      const header = req.headers.authorization || "";
      if (header !== `Bearer ${expected}`) {
        return res.status(401).json({ error: "Missing or invalid metrics token" });
      }
    }
    try {
      await serveMetrics(res);
    } catch (err) {
      getContextLogger({ module: "metrics" }).error({ err: err?.message }, "metrics scrape failed");
      res.status(500).json({ error: "Metrics unavailable" });
    }
  });

  // Phase 13 (§11.1): requestId middleware needs the shared logger helpers
  // (used above for health/metrics failure lines).
  app.use("/api/auth", authRoutes);
  app.use("/api/vehicles", vehicleRoutes);
  app.use("/api/trips", tripRoutes);
  app.use("/api/alerts", alertRoutes);
  app.use("/api/geofences", geofenceRoutes);
  app.use("/api/users", userRoutes);
  app.use("/api/audit-logs", auditRoutes);
  // Phase 12 (§4.2/§7.2): user administration, async CSV exports. The exports
  // router is mounted at BOTH /api/reports (§4.2's client contract) and
  // /api/exports (§6.2's table spelling) — same router, same contract.
  app.use("/api/users-admin", userAdminRoutes);
  app.use("/api/reports", exportRoutes);
  app.use("/api/exports", exportRoutes);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}

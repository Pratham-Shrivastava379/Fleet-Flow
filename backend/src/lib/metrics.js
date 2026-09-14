import http from "node:http";
import { Counter, Gauge, Histogram, Registry } from "prom-client";
import { prisma } from "../prisma.js";
import { partitionQueue, retentionQueue, geofenceEvalQueue, notificationsQueue, exportsQueue } from "../jobs/queues.js";

/**
 * Phase 13 metrics. All process metrics are registered on
 * ONE explicit registry and served in Prometheus exposition format from:
 *  - the API process at GET /api/metrics (token-gated, §4.2), and
 *  - the worker process at GET :9091/metrics via startWorkerMetricsServer()
 *    (the worker is a separate deployable with no HTTP server of its own —
 *    it gets a tiny exporter port instead of an express app).
 *
 * The API exporter covers: HTTP request rate/duration/errors per route, live
 * WS connection count, DB health (up + ping latency — Prisma does not expose
 * pool internals, so this is the documented proxy for pool health), and
 * BullMQ queue depth/counts per queue (read from Redis, so both exporters
 * report the same values regardless of which process serves the scrape).
 * The worker exporter additionally covers geofence-eval and notification
 * dispatch latency (the two background-job hot paths).
 */
export const registry = new Registry();

// ---- HTTP request metrics (API process) ------------------------------------
export const httpRequestsTotal = new Counter({
  name: "http_requests_total",
  help: "Total HTTP requests, labeled by method/route/status code.",
  labelNames: ["method", "route", "status"],
  registers: [registry],
});

export const httpRequestDuration = new Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds, labeled by method/route.",
  labelNames: ["method", "route"],
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const httpRequestErrorsTotal = new Counter({
  name: "http_request_errors_total",
  help: "HTTP requests that ended with status >= 400, labeled by method/route.",
  labelNames: ["method", "route"],
  registers: [registry],
});

// ---- Realtime gateway (API process) ----------------------------------------
export const wsConnections = new Gauge({
  name: "ws_connections",
  help: "WebSocket connections currently open on this process (all WS instances).",
  registers: [registry],
});

// ---- Database health (API process; refreshed on scrape) --------------------
export const dbUp = new Gauge({
  name: "db_up",
  help: "1 if the last SELECT 1 against Postgres succeeded, else 0.",
  registers: [registry],
});

export const dbPingSeconds = new Histogram({
  name: "db_ping_seconds",
  help: "Latency of the scrape-time SELECT 1 health probe (pool-health proxy).",
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [registry],
});

// ---- BullMQ job queues -----------------------------------------------------
// `fleetflow_queue_depth` is an absolute gauge refreshed from Redis (BullMQ
// getJobCounts) by BOTH exporters, so either scrape target reports the same
// live queue state. Completed/failed are event-driven counters incremented by
// the WORKER process on each job completion/failure (see worker.js makeWorker)
// — getJobCounts().completed/failed is not a reliable monotonic series because
// most queues remove completed jobs, so it is not used as a counter source.
export const queueDepth = new Gauge({
  name: "fleetflow_queue_depth",
  help: "Jobs currently in the queue (waiting + delayed + active + paused), per queue.",
  labelNames: ["queue"],
  registers: [registry],
});

export const queueCompletedTotal = new Counter({
  name: "fleetflow_queue_completed_total",
  help: "Jobs completed since worker start (incremented on worker 'completed' events), per queue.",
  labelNames: ["queue"],
  registers: [registry],
});

export const queueFailedTotal = new Counter({
  name: "fleetflow_queue_failed_total",
  help: "Jobs failed since worker start (incremented on worker 'failed' events), per queue.",
  labelNames: ["queue"],
  registers: [registry],
});

export function incQueueCompleted(queue) {
  queueCompletedTotal.inc({ queue });
}

export function incQueueFailed(queue) {
  queueFailedTotal.inc({ queue });
}

// ---- Background-job hot paths (worker process) -----------------------------
export const geofenceEvalDuration = new Histogram({
  name: "geofence_eval_duration_seconds",
  help: "Time to evaluate one location ping against active geofences (worker).",
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [registry],
});

export const notificationDispatchDuration = new Histogram({
  name: "notification_dispatch_duration_seconds",
  help: "Time to dispatch one notifications job (FCM push / SMS fallback) (worker).",
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [registry],
});

export const geofenceEvalProcessedTotal = new Counter({
  name: "geofence_eval_processed_total",
  help: "Location pings evaluated against geofences since worker start (worker).",
  registers: [registry],
});

const ALL_QUEUES = [
  { name: "partition-maintenance", queue: partitionQueue },
  { name: "retention", queue: retentionQueue },
  { name: "geofence-eval", queue: geofenceEvalQueue },
  { name: "notifications", queue: notificationsQueue },
  { name: "exports", queue: exportsQueue },
];

/**
 * Refresh BullMQ queue gauges from Redis. Called on every /api/metrics scrape
 * (API process) and on a periodic interval (worker process) — both exporters
 * observe the same shared queue state, so the values agree regardless of which
 * process Prometheus scrapes. Best-effort: a Redis blip leaves stale gauges
 * rather than failing the scrape.
 */
export async function refreshQueueMetrics() {
  for (const { name, queue } of ALL_QUEUES) {
    try {
      const counts = await queue.getJobCounts("waiting", "active", "completed", "failed", "delayed", "paused");
      const depth = (counts.waiting || 0) + (counts.delayed || 0) + (counts.active || 0) + (counts.paused || 0);
      queueDepth.set({ queue: name }, depth);
    } catch {
      // leave stale; scrape must not fail because a queue is unreachable
    }
  }
}

/** Refresh DB health gauges from the API process on each scrape. */
export async function refreshDbMetrics() {
  const start = process.hrtime.bigint();
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbUp.set(1);
  } catch {
    dbUp.set(0);
  }
  const seconds = Number(process.hrtime.bigint() - start) / 1e9;
  dbPingSeconds.observe(seconds);
}

/** Serve the registry in Prometheus text format on an HTTP response. */
export async function serveMetrics(res) {
  await refreshQueueMetrics();
  await refreshDbMetrics();
  res.set("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
  res.send(await registry.metrics());
}

/**
 * Minimal HTTP exporter for the worker process (node:http, no express).
 * Serves GET /metrics in Prometheus text format on config.workerMetricsPort.
 * Token-gated with the same METRICS_TOKEN as the API's /api/metrics when set.
 */
export function startWorkerMetricsServer(port, token) {
  const server = http.createServer(async (req, res) => {
    if (req.method !== "GET" || (req.url || "").split("?")[0] !== "/metrics") {
      res.writeHead(404).end("not found");
      return;
    }
    if (token) {
      const header = req.headers.authorization || "";
      if (header !== `Bearer ${token}`) {
        res.writeHead(401).end("unauthorized");
        return;
      }
    }
    try {
      await refreshQueueMetrics();
      res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
      res.end(await registry.metrics());
    } catch (err) {
      res.writeHead(500).end(String(err?.message || err));
    }
  });
  return new Promise((resolve) => {
    server.listen(port, () => resolve(server));
  });
}

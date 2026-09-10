// Phase 13 (§11.3): tracing MUST initialize before http is loaded so the
// instrumentation patches it — this import is the entrypoint's first one.
import "../lib/tracing.js";
import { Worker } from "bullmq";
import { redis } from "../lib/redis.js";
import config from "../config.js";
import retentionJob from "./retention.js";
import partitionMaintenanceJob from "./partitionMaintenance.js";
import geofenceEvalJob from "./geofenceEval.js";
import notificationsJob from "./notifications.js";
import exportJob from "./export.js";
import { getContextLogger } from "../lib/logger.js";
import { startWorkerMetricsServer, refreshQueueMetrics, incQueueCompleted, incQueueFailed } from "../lib/metrics.js";
import { shutdownTracing } from "../lib/tracing.js";

/**
 * BullMQ worker process (separate deployable from the API — blueprint ADR-1,
 * §4.4). Started with `node src/jobs/worker.js`; consumes the retention and
 * partition-maintenance queues, sharing the same Prisma client / service-layer
 * code as the API. Runs until SIGTERM/SIGINT.
 *
 * Phase 13 (§11.2): the worker exposes its own tiny Prometheus exporter on
 * config.workerMetricsPort (default 9091) — it has no HTTP server of its own,
 * and geofence-eval/notification latency live in THIS process, not the API's.
 */
const connection = redis;

const log = getContextLogger({ module: "worker" });

function makeWorker(name, handler, concurrency) {
  const w = new Worker(name, async (job) => handler(job.data), { connection, concurrency });
  w.on("completed", (job) => {
    incQueueCompleted(name); // §11.2: per-queue processed counters
    log.info({ jobId: job.id, queue: name }, "job completed");
  });
  w.on("failed", (job, err) => {
    incQueueFailed(name);
    log.error({ jobId: job?.id, queue: name, err: err?.message }, "job failed");
  });
  w.on("error", (err) => log.error({ queue: name, err: err?.message }, "worker error"));
  return w;
}

const workers = [
  makeWorker("partition-maintenance", partitionMaintenanceJob, 1),
  makeWorker("retention", retentionJob, 1),
  // DB-bound; concurrency kept modest per blueprint §14.2 (tuned against the
  // Postgres connection pool; per-vehicle advisory locks keep evals correct
  // even with several worker replicas).
  makeWorker("geofence-eval", geofenceEvalJob, 2),
  makeWorker("notifications", notificationsJob, 2),
  // I/O-bound (CSV generation + file/object write); modest concurrency like
  // the other report-adjacent queues (§14.2).
  makeWorker("exports", exportJob, 2),
];

log.info("FleetFlow worker listening: partition-maintenance, retention, geofence-eval, notifications, exports");

// Worker metrics exporter (Prometheus scrape target, §11.2). Queue gauges are
// refreshed here on an interval so the worker's exporter reports queue state
// even between scrapes; the API's /api/metrics refreshes the same gauges from
// the same Redis on each of its scrapes — both targets agree.
let metricsServer = null;
startWorkerMetricsServer(config.workerMetricsPort, config.metricsToken)
  .then((server) => {
    metricsServer = server;
    log.info({ port: config.workerMetricsPort }, "worker metrics exporter listening");
  })
  .catch((err) => log.error({ err: err?.message }, "failed to start worker metrics exporter"));

const queueMetricsInterval = setInterval(() => {
  refreshQueueMetrics().catch(() => {});
}, 15_000);
queueMetricsInterval.unref();

async function shutdown(signal) {
  log.info({ signal }, "closing workers");
  clearInterval(queueMetricsInterval);
  await Promise.all(workers.map((w) => w.close()));
  if (metricsServer) await new Promise((resolve) => metricsServer.close(resolve));
  await shutdownTracing();
  await redis.quit().catch(() => {});
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

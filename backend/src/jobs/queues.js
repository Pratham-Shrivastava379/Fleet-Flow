import { Queue } from "bullmq";
import { redis } from "../lib/redis.js";

/* BullMQ queue definitions (Phase 4). Queues are named so multiple worker
 * processes / API instances can share them via the same Redis backing store.
 * The shared ioredis client has maxRetriesPerRequest:null (required by BullMQ). */
export const partitionQueue = new Queue("partition-maintenance", { connection: redis });
export const retentionQueue = new Queue("retention", { connection: redis });

// Phase 5: server-authoritative geofence evaluation. One job per ping write,
// consumed by the worker process so the ping request path never evaluates
// inline.
export const geofenceEvalQueue = new Queue("geofence-eval", { connection: redis });

// Phase 7: push/SMS dispatch. Consumed by the worker process so provider calls
// (slow/flaky) never block the request that created the alert (§307).
export const notificationsQueue = new Queue("notifications", { connection: redis });

// Phase 12 (§4.4/§6.2): CSV export generation (trips/alerts/geofence history).
// Consumed by the worker process so large report generation never blocks the
// dashboard request that requested it (§7.2 item 3 async flow).
export const exportsQueue = new Queue("exports", { connection: redis });

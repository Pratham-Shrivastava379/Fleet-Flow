import { evaluatePing } from "../services/geofenceService.js";
import { getContextLogger } from "../lib/logger.js";
import { geofenceEvalDuration, geofenceEvalProcessedTotal } from "../lib/metrics.js";

/**
 * geofence-eval job handler (Phase 5, blueprint §8.3; batch mode Phase 10).
 * Runs the server-authoritative enter/exit evaluation: transition-only
 * GeofenceEvent writes, flag-conditional Alerts, fleet:events fan-out.
 * Idempotent via per-vehicle advisory lock + transition detection, so BullMQ
 * retries are safe.
 *
 * Two job shapes:
 *  - single ping (Phase 5): `{ tripId, vehicleId, ..., lat, lng, ..., pingId }`
 *  - batch (Phase 10): `{ tripId, vehicleId, driverId, batch: [ping, ...] }` —
 *    pings are evaluated SEQUENTIALLY in the order carried by the job (the
 *    service pre-sorts by recordedAt). One job per batch keeps crossing
 *    detection correct without relying on BullMQ inter-job ordering, which is
 *    not guaranteed when single-ping jobs and batch jobs interleave.
 *
 * Phase 13: each ping evaluation is timed (geofence_eval_duration_seconds,
 * §11.2) and counted; the requestId carried onto the job by tripService
 * (§11.1) is attached to log lines so an eval is traceable to the ping POST
 * that enqueued it.
 */
export default async function geofenceEvalJob(data) {
  const log = getContextLogger({
    module: "geofence-eval",
    ...(data.requestId ? { requestId: data.requestId } : {}),
  });
  const evaluate = async (ping) => {
    const start = process.hrtime.bigint();
    try {
      const result = await evaluatePing({ ...data, ...ping });
      geofenceEvalProcessedTotal.inc();
      if (result.transitions.length > 0) {
        log.info(
          {
            tripId: data.tripId,
            transitions: result.transitions.map((t) => ({
              eventType: t.eventType,
              geofenceId: t.geofenceId,
              alertId: t.alertId ?? null,
            })),
          },
          "geofence transition detected",
        );
      }
      return result;
    } finally {
      geofenceEvalDuration.observe(Number(process.hrtime.bigint() - start) / 1e9);
    }
  };

  if (Array.isArray(data.batch) && data.batch.length > 0) {
    const transitions = [];
    for (const ping of data.batch) {
      const result = await evaluate(ping);
      transitions.push(...result.transitions);
    }
    return { evaluated: transitions.length, transitions };
  }

  const { tripId, lat, lng, speedKmh, headingDeg, recordedAt, pingId } = data;
  return evaluate({ tripId, lat, lng, speedKmh, headingDeg, recordedAt, pingId });
}

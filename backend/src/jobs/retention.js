import { prisma } from "../prisma.js";
import config from "../config.js";
import { record } from "../services/auditService.js";
import { publishFleetEvent, fleetEventTopics } from "../lib/events.js";
import { getContextLogger } from "../lib/logger.js";

const log = getContextLogger({ module: "stale-trip-reaper" });

/**
 * Nightly retention/hygiene job. No user-facing behavior —
 * removes expired credentials/sessions and expired unused invites. Raw-ping
 * downsampling/archival is deliberately deferred (needs retention policy + S3,
 * Phase 10); this phase just cleans up stale tables.
 */
export default async function retentionJob() {
  const now = new Date();
  const [refresh, invites, reset] = await prisma.$transaction([
    prisma.refreshToken.deleteMany({ where: { expiresAt: { lt: now } } }),
    prisma.invite.deleteMany({
      where: { OR: [{ expiresAt: { lt: now } }, { acceptedAt: { not: null } }] },
    }),
    prisma.passwordResetToken.deleteMany({ where: { expiresAt: { lt: now } } }),
  ]);

  // Phase 10: stale-trip reaper. A driver app killed without a
  // clean "finish" (crash, dead battery, battery-optimization kill) must not
  // leave a phantom ACTIVE trip forever. Auto-finish with status CANCELLED.
  const reaped = await reapStaleTrips();

  return {
    expiredRefreshTokens: refresh.count,
    expiredOrUsedInvitesRemoved: invites.count,
    expiredResetTokens: reset.count,
    staleTripsReaped: reaped.length,
  };
}

/**
 * Cancel ACTIVE trips whose most recent ping is older than
 * config.staleTripHours (default 12h, §8.1). Trips with no pings at all are
 * judged by startedAt. Raw SQL (NOT executed via prisma.trip.updateMany)
 * because the "latest ping per trip" anti-join is a grouped subquery, and the
 * per-trip updates must run sequentially to keep published event payloads
 * exact. Each cancellation is audited (TRIP_REAPED) and fanned out as
 * trip_finished over fleet:events so dashboards converge.
 */
export async function reapStaleTrips() {
  // STALE_TRIP_HOURS=0 disables the reaper entirely — the documented contract
  // (.env.example / config.js). Guard it explicitly: without this, a 0-hour
  // cutoff would make EVERY ACTIVE trip look stale and reap the whole fleet.
  if (config.staleTripHours <= 0) return [];

  const cutoff = new Date(Date.now() - config.staleTripHours * 60 * 60 * 1000);
  const stale = await prisma.$queryRaw`
    SELECT t.id, t."driverId", t."vehicleId"
    FROM "Trip" t
    LEFT JOIN (
      SELECT "tripId", MAX("recordedAt") AS last_ping
      FROM "LocationPing"
      GROUP BY "tripId"
    ) p ON p."tripId" = t.id
    WHERE t.status = 'ACTIVE'
      AND COALESCE(p.last_ping, t."startedAt") < ${cutoff}`;

  const reaped = [];
  for (const row of stale) {
    try {
      const updated = await prisma.trip.update({
        where: { id: Number(row.id) },
        data: { status: "CANCELLED", finishedAt: new Date() },
        include: { vehicle: true },
      });
      await prisma.fleetLastPosition.deleteMany({
        where: { vehicleId: Number(row.vehicleId), tripId: Number(row.id) },
      });
      await record({
        actorId: null,
        action: "TRIP_REAPED",
        target: `trip:${row.id}`,
        detail: `No pings for over ${config.staleTripHours}h; auto-cancelled by stale-trip reaper`,
      });
      publishFleetEvent({
        type: "trip_finished",
        trip: updated,
        topics: fleetEventTopics({ driverId: Number(row.driverId), vehicleId: Number(row.vehicleId) }),
      });
      reaped.push(updated);
    } catch (e) {
      log.error({ tripId: Number(row.id), err: e?.message }, "trip reaping failed");
    }
  }
  if (reaped.length > 0) {
    log.info({ count: reaped.length, tripIds: reaped.map((t) => t.id) }, `cancelled stale trip(s)`);
  }
  return reaped;
}

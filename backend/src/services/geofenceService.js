import { prisma } from "../prisma.js";
import { HttpError } from "../middleware/errorHandler.js";
import { publishFleetEvent, fleetEventTopics } from "../lib/events.js";

export function createGeofence(data) {
  return prisma.geofence.create({ data });
}

export function listGeofences() {
  return prisma.geofence.findMany({ where: { active: true }, orderBy: { id: "asc" } });
}

/**
 * Phase 12 (§7.2 item 5): authoring also means editing/toggling existing
 * fences. Whitelist mirrors geofenceUpdateSchema (defense in depth — never
 * spread client input into Prisma). Includes the circle fields on the returned
 * row so the dashboard can redraw the fence immediately after an edit.
 */
export async function updateGeofence(id, data) {
  const existing = await prisma.geofence.findUnique({ where: { id } });
  if (!existing) throw new HttpError(404, "Geofence not found");
  const patch = {};
  if (data.name !== undefined) patch.name = data.name;
  if (data.centerLat !== undefined) patch.centerLat = data.centerLat;
  if (data.centerLng !== undefined) patch.centerLng = data.centerLng;
  if (data.radiusM !== undefined) patch.radiusM = data.radiusM;
  if (data.active !== undefined) patch.active = data.active;
  if (data.alertOnEnter !== undefined) patch.alertOnEnter = data.alertOnEnter;
  if (data.alertOnExit !== undefined) patch.alertOnExit = data.alertOnExit;
  return prisma.geofence.update({
    where: { id },
    data: patch,
    select: {
      id: true,
      name: true,
      centerLat: true,
      centerLng: true,
      radiusM: true,
      active: true,
      alertOnEnter: true,
      alertOnExit: true,
      createdAt: true,
    },
  });
}

/**
 * Soft OFF, not a hard delete (§7.2 item 5: fence history must survive): the
 * row stays so GeofenceEvents keep resolving; `active=false` removes it from
 * listings and from future ping evaluation. Historical events for a removed
 * fence are data, not a live trigger.
 */
export async function deleteGeofence(id) {
  const existing = await prisma.geofence.findUnique({ where: { id } });
  if (!existing) throw new HttpError(404, "Geofence not found");
  await prisma.geofence.update({ where: { id }, data: { active: false } });
  return { id, active: false };
}

/**
 * GET /api/geofences/:id/history (blueprint §4.2): paginated enter/exit audit
 * trail for one fence — "which vehicles entered/exited, for compliance
 * reporting". Fence + vehicle/driver context are included so the dashboard
 * can render the history without a second lookup. A fence that was soft-OFF'd
 * (deleted) still answers history queries: its events are historical data and
 * the §6.3 soft-delete contract exists precisely so this trail survives.
 */
export async function listGeofenceHistory(id, query = {}) {
  const fence = await prisma.geofence.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      centerLat: true,
      centerLng: true,
      radiusM: true,
      active: true,
      alertOnEnter: true,
      alertOnExit: true,
      createdAt: true,
    },
  });
  if (!fence) throw new HttpError(404, "Geofence not found");

  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 20));
  const where = { geofenceId: id };
  if (query.vehicleId) where.vehicleId = Number(query.vehicleId);
  if (query.eventType) where.eventType = query.eventType;
  if (query.from || query.to) {
    where.occurredAt = {
      ...(query.from ? { gte: new Date(query.from) } : {}),
      ...(query.to ? { lte: new Date(query.to) } : {}),
    };
  }

  const [items, total] = await prisma.$transaction([
    prisma.geofenceEvent.findMany({
      where,
      include: {
        vehicle: { select: { id: true, plate: true, model: true } },
        trip: { select: { id: true, driver: { select: { id: true, name: true } } } },
      },
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.geofenceEvent.count({ where }),
  ]);
  return { fence, items, page, pageSize, total, pages: Math.ceil(total / pageSize) };
}

/**
 * Evaluate a point against all active geofences (Phase 1: PostGIS).
 * Uses ST_DWithin/ST_Distance against the stored generated `center`
 * geography(Point,4326) column (backed by a GIST index) instead of the
 * previous in-process haversine loop. Point expressed as lon/lat.
 * Returns per-fence { inside } so the client can detect enter/exit transitions.
 */
export async function checkGeofences(lat, lng) {
  const rows = await prisma.$queryRaw`
    SELECT
      id, name, "radiusM",
      ST_Distance(ST_MakePoint(${lng}, ${lat})::geography, center) AS "distanceM",
      ST_DWithin(ST_MakePoint(${lng}, ${lat})::geography, center, "radiusM") AS inside
    FROM "Geofence"
    WHERE active = true
    ORDER BY id`;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    radiusM: Number(r.radiusM),
    distanceM: Math.round(Number(r.distanceM)),
    inside: Boolean(r.inside),
  }));
}

/**
 * Server-authoritative geofence evaluation for one ping (Phase 5, blueprint
 * §8.3). Runs in the geofence-eval WORKER process — never inline in the ping
 * write path — and is deliberately idempotent:
 *
 *  1. Find the active fences containing the point (PostGIS ST_DWithin on the
 *     stored generated `center` geography column, GIST-indexed).
 *  2. Reconstruct the vehicle's last-known inside/outside state from its
 *     latest GeofenceEvent per fence (DB-authoritative: survives restarts and
 *     Redis loss; the blueprint's Redis/FleetLastPosition cache options are
 *     renderable on top of this but not needed for correctness).
 *  3. On a TRANSITION only (inside→outside, outside→inside) write a
 *     GeofenceEvent — never one per ping while inside a fence — and, when the
 *     fence's alertOnEnter/alertOnExit flag says so, also create an Alert.
 *
 * A per-vehicle Postgres advisory lock (xact-scoped) serializes concurrent
 * evaluations so multiple worker replicas cannot double-fire a crossing, and
 * makes retries after a partial failure produce no duplicate events.
 *
 * After commit, transitions are published to the `fleet:events` Redis channel
 * for WS fan-out by API processes (ADR-3 bridge; best-effort, fail-open).
 *
 * @param {object} ping { tripId, vehicleId, driverId, lat, lng, speedKmh,
 *   headingDeg, recordedAt, pingId }
 * @returns {{evaluated: number, transitions: Array<object>}}
 */
export async function evaluatePing(ping) {
  const occurredAt = ping.recordedAt instanceof Date ? ping.recordedAt : new Date(ping.recordedAt);

  // Phase 10: a long-offline batch can sync minutes/hours late. If its pings
  // are OLDER than the vehicle's most recent evaluated ping, evaluating them
  // after a newer crossing would resurrect stale ENTER/EXIT state (the "latest
  // event wins" reconstruction orders by occurredAt, so late-old evals would
  // no-op anyway — but only after wasted work; and two racing evals could
  // still interleave). Skip stale evals outright instead.
  const latest = await prisma.geofenceEvent.findFirst({
    where: { vehicleId: ping.vehicleId },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    select: { occurredAt: true },
  });
  if (latest && occurredAt < new Date(latest.occurredAt.getTime() - 60 * 1000)) {
    return { evaluated: 0, transitions: [], skippedStale: true };
  }

  const created = await prisma.$transaction(async (tx) => {
    // Serialize evaluations per vehicle across worker processes/replicas.
    // Namespace 2501 is an arbitrary fixed domain so other locks never clash.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(2501::int, ${ping.vehicleId}::int)`;

    // 1) All active fences (we need flags for exit transitions too) + the set
    //    containing the point, evaluated by PostGIS (geography, GIST-indexed).
    const fences = await tx.$queryRaw`
      SELECT id, name, "alertOnEnter", "alertOnExit"
      FROM "Geofence"
      WHERE active = true
      ORDER BY id`;
    const insideRows = await tx.$queryRaw`
      SELECT id
      FROM "Geofence"
      WHERE active = true
        AND ST_DWithin(ST_MakePoint(${ping.lng}, ${ping.lat})::geography, center, "radiusM")`;
    const insideIds = new Set(insideRows.map((r) => Number(r.id)));

    // 2) Last known crossing state per fence for this vehicle (latest event
    //    wins; a fence never seen before counts as "outside").
    const stateRows = await tx.$queryRaw`
      SELECT "geofenceId", "eventType" FROM (
        SELECT e."geofenceId", e."eventType",
               ROW_NUMBER() OVER (
                 PARTITION BY e."geofenceId"
                 ORDER BY e."occurredAt" DESC, e."id" DESC
               ) AS rn
        FROM "GeofenceEvent" e
        JOIN "Geofence" g ON g.id = e."geofenceId"
        WHERE e."vehicleId" = ${ping.vehicleId} AND g.active = true
      ) latest
      WHERE rn = 1`;
    const priorState = new Map(stateRows.map((r) => [Number(r.geofenceId), r.eventType]));

    // 3) Transitions only.
    const transitions = [];
    for (const fence of fences) {
      const isInside = insideIds.has(Number(fence.id));
      const prior = priorState.get(Number(fence.id)) ?? null;
      if (isInside && prior !== "ENTER") transitions.push({ fence, eventType: "ENTER" });
      else if (!isInside && prior === "ENTER") transitions.push({ fence, eventType: "EXIT" });
    }

    const results = [];
    for (const { fence, eventType } of transitions) {
      const event = await tx.geofenceEvent.create({
        data: {
          geofenceId: Number(fence.id),
          vehicleId: ping.vehicleId,
          tripId: ping.tripId,
          eventType,
          occurredAt,
        },
      });
      const flagged = eventType === "ENTER" ? fence.alertOnEnter : fence.alertOnExit;
      let alert = null;
      if (flagged) {
        alert = await tx.alert.create({
          data: {
            tripId: ping.tripId,
            type: eventType === "ENTER" ? "GEOFENCE_ENTER" : "GEOFENCE_EXIT",
            lat: ping.lat,
            lng: ping.lng,
            detail: `Geofence "${fence.name}" ${eventType === "ENTER" ? "entered" : "exited"} (server-side eval)`,
          },
        });
      }
      results.push({ event, alert, fence });
    }
    return results;
  });

  // 4) Fan out after commit (WS is best-effort; REST/DB is the source of truth).
  //    Topics: fleet:all + this vehicle/driver (Phase 6 subscription model).
  const topics = fleetEventTopics({ driverId: ping.driverId, vehicleId: ping.vehicleId });
  for (const { event, alert, fence } of created) {
    await publishFleetEvent({
      type: "geofence_event",
      payload: {
        eventId: event.id,
        geofenceId: Number(fence.id),
        geofenceName: fence.name,
        vehicleId: ping.vehicleId,
        driverId: ping.driverId,
        tripId: ping.tripId,
        eventType: event.eventType,
        lat: ping.lat,
        lng: ping.lng,
        occurredAt: occurredAt.toISOString(),
      },
      topics,
    });
    if (alert) await publishFleetEvent({ type: "alert", payload: alert, topics });
  }

  return {
    evaluated: created.length,
    transitions: created.map((c) => ({
      eventId: c.event.id,
      geofenceId: Number(c.fence.id),
      eventType: c.event.eventType,
      alertId: c.alert ? c.alert.id : null,
    })),
  };
}

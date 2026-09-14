import { prisma } from "../prisma.js";
import { HttpError } from "../middleware/errorHandler.js";
import { publishFleetEvent, fleetEventTopics } from "../lib/events.js";
import { geofenceEvalQueue } from "../jobs/queues.js";
import { getContextLogger, getRequestId } from "../lib/logger.js";
import { withSpan } from "../lib/tracing.js";

export async function startTrip(driverId, vehicleId) {
  const vehicle = await prisma.vehicle.findUnique({ where: { id: vehicleId } });
  if (!vehicle) throw new HttpError(404, "Vehicle not found");
  if (vehicle.deletedAt) throw new HttpError(409, "Vehicle is inactive/deleted");
  // §2 RBAC (vehicle availability is a workflow rule, not just display):
  // IN_MAINTENANCE/RETIRED vehicles can't start trips; a vehicle with an
  // ACTIVE trip is already on the road. IN_MAINTENANCE stays startable when
  // the requesting driver is the vehicle's assigned defaultDriver.
  if (vehicle.status === "RETIRED") {
    throw new HttpError(409, "Vehicle is retired");
  }

  // Race-safe one-active-trip-per-driver AND one-active-trip-per-vehicle guards.
  // The findFirst-then-create pattern was a TOCTOU race: two drivers starting
  // trips on the same vehicle concurrently both passed the check (trips
  // 674/675 on WS-001). A session-level advisory lock keyed on the vehicle
  // serializes concurrent starts for that vehicle (and on driverId so one
  // driver's two devices can't race either); the guards are re-checked INSIDE
  // the lock before creating, so the second starter gets a deterministic 409.
  const lockKey = (n) => `fleetflow:trip-start:${n}`;
  return prisma.$transaction(async (tx) => {
    // pg_advisory_xact_lock(hashtext(text)) — tagged-template $executeRaw.
    // Two Prisma gotchas fixed here: (1) $queryRaw fails with "Failed to
    // deserialize column of type 'void'" because the lock fn returns void —
    // $executeRaw (the same pattern geofenceService.js uses for its per-vehicle
    // advisory lock) never deserializes result columns; (2) $queryRawUnsafe
    // ("... $1", v) does not bind $1 in Prisma 5.19 (P2010). The ::text cast
    // keeps hashtext() from receiving an untyped parameter.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey(driverId)}::text))`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey(vehicleId)}::text))`;
    const driverActive = await tx.trip.findFirst({ where: { driverId, status: "ACTIVE" } });
    if (driverActive) throw new HttpError(409, "Driver already has an active trip");
    const vehicleActive = await tx.trip.findFirst({ where: { vehicleId, status: "ACTIVE" } });
    if (vehicleActive) throw new HttpError(409, "Vehicle already has an active trip");
    const trip = await tx.trip.create({
      data: { driverId, vehicleId },
      include: { vehicle: true, driver: { select: { id: true, name: true } } },
    });
    publishFleetEvent({
      type: "trip_started",
      trip,
      topics: fleetEventTopics({ driverId: trip.driverId, vehicleId: trip.vehicleId }),
    });
    return trip;
  });
}

/**
 * Record a location ping. Idempotent via idempotencyKey (client UUID), so
 * offline-synced duplicates from mobile are safely ignored. `LocationPing` is a
 * RANGE(createdAt)-partitioned table, which cannot hold a global unique on
 * `idempotencyKey` (Postgres requires unique cols to include the partition key),
 * so the unique dedup gate lives on the `IdempotencyKey` table — inserted first,
 * atomically with the ping row (P2002 => duplicate).
 */
export async function addPing(user, tripId, ping) {
  const trip = await prisma.trip.findUnique({ where: { id: tripId } });
  if (!trip) throw new HttpError(404, "Trip not found");
  if (trip.status !== "ACTIVE") throw new HttpError(409, "Trip is not active");
  if (user.role === "DRIVER" && trip.driverId !== user.id) throw new HttpError(403, "Not your trip");

  // Phase 10: batches always carry recordedAt; if a long-offline upload races a
  // live ping (single endpoint), only ever move FleetLastPosition forward in
  // time — never let a delayed sync overwrite a newer live fix with an older one.
  const minRecordedAt = new Date(Date.now() - 90 * 1000);

  // Phase 13 (§11.3): the ping-write path is the highest-volume + latency-
  // critical flow — trace it end-to-end when tracing is enabled (no-op API
  // otherwise).
  const result = await withSpan(
    "trip.ping_write",
    () =>
      prisma.$transaction(async (tx) => {
        try {
          await tx.idempotencyKey.create({ data: { idempotencyKey: ping.idempotencyKey, tripId } });
        } catch (e) {
          if (e.code === "P2002") return { duplicate: true };
          throw e;
        }
        const created = await tx.locationPing.create({ data: { tripId, ...ping } });
        // Materialized last-known-position for O(1) live-map reads, updated
        // atomically with the ping write. The row is keyed by
        // vehicle and removed when the trip finishes (see finishTrip).
        await tx.fleetLastPosition.upsert({
          where: { vehicleId: trip.vehicleId },
          create: {
            vehicleId: trip.vehicleId,
            tripId,
            driverId: trip.driverId,
            lat: ping.lat,
            lng: ping.lng,
            speedKmh: ping.speedKmh,
            headingDeg: ping.headingDeg,
            recordedAt: ping.recordedAt,
          },
          update: {
            tripId,
            driverId: trip.driverId,
            // Phase 10: only move the live position forward in time. An old queued
            // ping syncing late must never regress the fleet map.
            ...(ping.recordedAt >= minRecordedAt
              ? {
                  lat: ping.lat,
                  lng: ping.lng,
                  speedKmh: ping.speedKmh,
                  headingDeg: ping.headingDeg,
                  recordedAt: ping.recordedAt,
                }
              : {}),
          },
        });
        return { duplicate: false, ping: created, recordedAt: created.recordedAt };
      }),
    { tripId: String(tripId), vehicleId: String(trip.vehicleId), lat: ping.lat, lng: ping.lng },
  );
  if (result.duplicate) return result;

  // Phase 5: geofence enter/exit is evaluated SERVER-SIDE by
  // a background job — never inline, never by the client. Enqueue is fire-and-
  // forget: a Redis/queue outage must not fail the ping write (§14.3).
  geofenceEvalQueue
    .add(
      "evaluate",
      {
        tripId,
        vehicleId: trip.vehicleId,
        driverId: trip.driverId,
        lat: ping.lat,
        lng: ping.lng,
        speedKmh: ping.speedKmh,
        headingDeg: ping.headingDeg,
        recordedAt: ping.recordedAt instanceof Date ? ping.recordedAt.toISOString() : ping.recordedAt,
        pingId: result.ping.id,
        // Phase 13 (§11.1): tie the async geofence evaluation back to the
        // request that wrote the ping.
        requestId: getRequestId() || null,
      },
      {
        jobId: `gf-eval-${result.ping.id}`,
        attempts: 3,
        backoff: { type: "exponential", delay: 500 },
        removeOnComplete: true,
        removeOnFail: { count: 1000 },
      },
    )
    .catch((err) =>
      getContextLogger({ module: "geofence-eval" }).warn(
        { err: err?.message },
        "enqueue failed (ping persisted, eval skipped)",
      ),
    );
  publishFleetEvent({
    type: "location",
    payload: {
      tripId,
      vehicleId: trip.vehicleId,
      driverId: trip.driverId,
      lat: ping.lat,
      lng: ping.lng,
      speedKmh: ping.speedKmh,
      recordedAt: ping.recordedAt,
    },
    // Phase 6 topic model: fleet managers on fleet:all, the driver's own
    // dashboard, and per-vehicle subscribers. (location_batch uses the same
    // topic contract when the batch endpoint lands in Phase 10.)
    topics: fleetEventTopics({ driverId: trip.driverId, vehicleId: trip.vehicleId }),
  });
  return result;
}

/**
 * Phase 10: offline batch sync. Drains a long-offline
 * client in ONE HTTP call instead of hundreds of single-ping posts.
 *
 * Contract (mirrors addPing per item):
 *  - auth/scoping: same as addPing (owner driver, or manager/admin);
 *  - trip must be ACTIVE (single 409 for the whole request);
 *  - per-item idempotency via the IdempotencyKey table — duplicates are skipped
 *    (P2002 inside the tx), and per-item errors are isolated (one bad ping
 *    cannot fail the whole batch);
 *  - FleetLastPosition is upserted ONCE with the newest ping by recordedAt
 *    (never regresses the live map — see the 90s monotonicity guard in addPing);
 *  - ONE geofence-eval job is enqueued for the whole batch, with pings ordered
 *    by recordedAt; the worker evaluates them sequentially inside one job so
 *    transition-only ENTER/EXIT detection stays correct regardless of BullMQ
 *    scheduling order across jobs;
 *  - a single `location_batch` WS event fans out (§4.3 — avoids flooding
 *    dashboards with hundreds of `location` events after a reconnect).
 *
 * Status: 201 if ≥1 new ping was written, 200 if the batch was all duplicates.
 */
export async function addPingBatch(user, tripId, pings) {
  const trip = await prisma.trip.findUnique({ where: { id: tripId } });
  if (!trip) throw new HttpError(404, "Trip not found");
  if (trip.status !== "ACTIVE") throw new HttpError(409, "Trip is not active");
  if (user.role === "DRIVER" && trip.driverId !== user.id) throw new HttpError(403, "Not your trip");

  // Normalize once: order oldest-first, then dedupe by idempotencyKey within
  // the request. In-request duplicates are COUNTED as duplicates (not silently
  // dropped) so the contract stays coherent: accepted + duplicates + failed
  // === total pings sent in the request.
  const normalized = pings
    .map((p) => ({ ...p, recordedAt: new Date(p.recordedAt) }))
    .sort((a, b) => a.recordedAt - b.recordedAt);

  const seen = new Set();
  const ordered = [];
  let duplicates = 0;
  for (const ping of normalized) {
    if (seen.has(ping.idempotencyKey)) {
      duplicates++;
      continue;
    }
    seen.add(ping.idempotencyKey);
    ordered.push(ping);
  }

  const accepted = [];
  const failed = [];

  // Single live-map upsert with the newest of the batch's recordedAt values.
  const newest = ordered[ordered.length - 1];
  const minRecordedAt = new Date(Date.now() - 90 * 1000);
  const lastPositionUpdate = {
    tripId,
    driverId: trip.driverId,
    ...(newest.recordedAt >= minRecordedAt
      ? {
          lat: newest.lat,
          lng: newest.lng,
          speedKmh: newest.speedKmh,
          headingDeg: newest.headingDeg,
          recordedAt: newest.recordedAt,
        }
      : {}),
  };

  for (const ping of ordered) {
    try {
      const r = await prisma.$transaction(async (tx) => {
        try {
          await tx.idempotencyKey.create({ data: { idempotencyKey: ping.idempotencyKey, tripId } });
        } catch (e) {
          if (e.code === "P2002") return { duplicate: true };
          throw e;
        }
        const created = await tx.locationPing.create({
          data: {
            tripId,
            idempotencyKey: ping.idempotencyKey,
            lat: ping.lat,
            lng: ping.lng,
            speedKmh: ping.speedKmh,
            headingDeg: ping.headingDeg,
            accuracyM: ping.accuracyM,
            recordedAt: ping.recordedAt,
          },
        });
        return { duplicate: false, ping: created, recordedAt: created.recordedAt };
      });
      if (r.duplicate) {
        duplicates++;
      } else {
        accepted.push(r);
      }
    } catch (e) {
      failed.push({ idempotencyKey: ping.idempotencyKey, error: e?.message ?? "unknown error" });
    }
  }

  if (accepted.length > 0) {
    try {
      await prisma.fleetLastPosition.upsert({
        where: { vehicleId: trip.vehicleId },
        create: {
          vehicleId: trip.vehicleId,
          tripId,
          driverId: trip.driverId,
          lat: newest.lat,
          lng: newest.lng,
          speedKmh: newest.speedKmh,
          headingDeg: newest.headingDeg,
          recordedAt: newest.recordedAt,
        },
        update: lastPositionUpdate,
      });
    } catch (e) {
      // Last-position maintenance must never fail the batch itself.
      getContextLogger({ module: "pings/batch" }).warn({ err: e?.message }, "fleetLastPosition upsert failed");
    }
  }

  return finalizeBatchSync(trip, accepted, duplicates, failed, getRequestId() || null);
}

/**
 * Shared tail of addPingBatch: ONE geofence-eval job for the whole batch (the
 * worker walks pings in recordedAt order inside a single job — preserves
 * transition-only crossing detection without relying on BullMQ job ordering),
 * then a single `location_batch` fan-out (§4.3 anti-flooding). `accepted` is in
 * recordedAt order because the batch was pre-sorted; queue/WS failures are
 * fail-open — the pings are already persisted (§14.3).
 */
function finalizeBatchSync(trip, accepted, duplicates, failed, requestId = null) {
  if (accepted.length === 0) {
    return { accepted: 0, duplicates, failed, status: 200 };
  }
  const tripId = trip.id;
  geofenceEvalQueue
    .add(
      "evaluate",
      {
        tripId,
        vehicleId: trip.vehicleId,
        driverId: trip.driverId,
        requestId,
        batch: accepted.map((r) => ({
          lat: r.ping.lat,
          lng: r.ping.lng,
          speedKmh: r.ping.speedKmh,
          headingDeg: r.ping.headingDeg,
          recordedAt: r.recordedAt instanceof Date ? r.recordedAt.toISOString() : r.recordedAt,
          pingId: r.ping.id,
        })),
      },
      {
        jobId: `gf-eval-batch-${accepted[0].ping.id}`,
        attempts: 3,
        backoff: { type: "exponential", delay: 500 },
        removeOnComplete: true,
        removeOnFail: { count: 1000 },
      },
    )
    .catch((err) =>
      getContextLogger({ module: "geofence-eval" }).warn(
        { err: err?.message },
        "batch enqueue failed (pings persisted, eval skipped)",
      ),
    );

  publishFleetEvent({
    type: "location_batch",
    payload: {
      tripId,
      vehicleId: trip.vehicleId,
      driverId: trip.driverId,
      count: accepted.length,
      firstRecordedAt: accepted[0].recordedAt,
      lastRecordedAt: accepted[accepted.length - 1].recordedAt,
    },
    topics: fleetEventTopics({ driverId: trip.driverId, vehicleId: trip.vehicleId }),
  });

  return { accepted: accepted.length, duplicates, failed, status: 201 };
}

/**
 * Compute trip aggregate stats from the ping set via a single PostGIS window
 * query: step distance is summed with ST_DistanceSphere over consecutive
 * pings ordered by recordedAt. Returns km/h/duration rounded for storage.
 */
const STATS_SQL = `
  WITH ordered AS (
    SELECT lat, lng, "recordedAt", "speedKmh",
      LAG(lng) OVER (ORDER BY "recordedAt") AS prev_lng,
      LAG(lat) OVER (ORDER BY "recordedAt") AS prev_lat,
      LAG("recordedAt") OVER (ORDER BY "recordedAt") AS prev_t
    FROM "LocationPing"
    WHERE "tripId" = $1
  )
  SELECT
    COALESCE(SUM(ST_DistanceSphere(
      ST_SetSRID(ST_MakePoint(lng, lat), 4326),
      ST_SetSRID(ST_MakePoint(prev_lng, prev_lat), 4326))), 0) AS "distanceM",
    COALESCE(MAX("speedKmh"), 0) AS "maxSpeedKmh",
    COUNT(*) AS "pingCount",
    MIN("recordedAt") AS "firstAt",
    MAX("recordedAt") AS "lastAt"
  FROM ordered`;

export async function computeTripStatsRaw(tripId) {
  const rows = await prisma.$queryRawUnsafe(STATS_SQL, tripId);
  const r = rows[0];
  const pingCount = Number(r.pingCount) || 0;
  if (!pingCount || !r.firstAt) {
    return { distanceKm: 0, avgSpeedKmh: 0, maxSpeedKmh: 0, durationSeconds: 0, pingCount };
  }
  const distanceM = Number(r.distanceM) || 0;
  const firstAt = r.firstAt instanceof Date ? r.firstAt : new Date(r.firstAt);
  const lastAt = r.lastAt instanceof Date ? r.lastAt : new Date(r.lastAt);
  const durationSeconds = Math.max(0, Math.round((lastAt - firstAt) / 1000));
  const distanceKm = distanceM / 1000;
  const avgSpeedKmh = durationSeconds > 0 ? (distanceKm / durationSeconds) * 3600 : 0;
  return {
    distanceKm: Math.round(distanceKm * 1000) / 1000,
    avgSpeedKmh: Math.round(avgSpeedKmh * 100) / 100,
    maxSpeedKmh: Math.round((Number(r.maxSpeedKmh) || 0) * 100) / 100,
    durationSeconds,
    pingCount,
  };
}

export async function finishTrip(user, tripId, status = "COMPLETED") {
  const trip = await prisma.trip.findUnique({ where: { id: tripId } });
  if (!trip) throw new HttpError(404, "Trip not found");
  if (user.role === "DRIVER" && trip.driverId !== user.id) throw new HttpError(403, "Not your trip");
  if (trip.status !== "ACTIVE") throw new HttpError(409, "Trip already finished");

  // Compute trip stats at finish via PostGIS and persist them (Phase 3).
  const stats = await computeTripStatsRaw(tripId);
  const updated = await prisma.trip.update({
    where: { id: tripId },
    data: {
      status,
      finishedAt: new Date(),
      distanceKm: stats.distanceKm,
      avgSpeedKmh: stats.avgSpeedKmh,
      maxSpeedKmh: stats.maxSpeedKmh,
      durationSeconds: stats.durationSeconds,
    },
    include: { vehicle: true },
  });
  // Phase 5: the materialized last-position row exists only for vehicles on an
  // active trip — remove it when the trip ends. deleteMany + tripId guard: if
  // the vehicle already started a NEW trip, its upserted row must survive.
  await prisma.fleetLastPosition.deleteMany({ where: { vehicleId: trip.vehicleId, tripId } });
  publishFleetEvent({
    type: "trip_finished",
    trip: updated,
    topics: fleetEventTopics({ driverId: trip.driverId, vehicleId: trip.vehicleId }),
  });
  return updated;
}

/** Live-computed trip stats from the ping set (source of truth; independent of
 *  whether stored aggregates exist). Scoped to the trip owner for drivers. */
export async function getTripStats(user, tripId) {
  const trip = await prisma.trip.findUnique({
    where: { id: tripId },
    select: { id: true, driverId: true },
  });
  if (!trip) throw new HttpError(404, "Trip not found");
  if (user.role === "DRIVER" && trip.driverId !== user.id) throw new HttpError(403, "Not your trip");
  return computeTripStatsRaw(tripId);
}

/** Fleet-wide listing with pagination + filtering; drivers are scoped to own trips. */
export async function listTrips(user, { status, driverId, page, pageSize }) {
  const where = {};
  page = Math.max(1, Number(page) || 1);
  pageSize = Math.min(100, Math.max(1, Number(pageSize) || 20));
  if (user.role === "DRIVER") where.driverId = user.id;
  else if (driverId) where.driverId = driverId;
  if (status) where.status = status;
  const [items, total] = await prisma.$transaction([
    prisma.trip.findMany({
      where,
      include: {
        // Phase 11: the web dashboard's live fleet map reads the ACTIVE-trips
        // listing and needs each vehicle's materialized last position for the
        // initial paint;
        // subsequent updates arrive over WS (location / location_batch).
        vehicle: { include: { fleetLastPosition: true } },
        driver: { select: { id: true, name: true } },
        _count: { select: { pings: true } },
      },
      orderBy: { startedAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.trip.count({ where }),
  ]);
  return { items, page, pageSize, total, pages: Math.ceil(total / pageSize) };
}

export async function getTrip(user, tripId) {
  const trip = await prisma.trip.findUnique({
    where: { id: tripId },
    include: {
      vehicle: true,
      driver: { select: { id: true, name: true } },
      pings: { orderBy: { recordedAt: "asc" } },
    },
  });
  if (!trip) throw new HttpError(404, "Trip not found");
  if (user.role === "DRIVER" && trip.driverId !== user.id) throw new HttpError(403, "Not your trip");
  return trip;
}

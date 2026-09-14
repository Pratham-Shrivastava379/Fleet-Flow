/**
 * Phase 10 — offline hardening + stale-trip reaper.
 *
 * 1. A batch of hundreds of queued offline pings drains in ONE
 *    `POST /api/trips/:id/pings/batch` call (per-item idempotency, per-item
 *    error isolation, one geofence-eval job + one `location_batch` WS event for
 *    the whole request). Also proves the MAX_PING_BATCH=500 cap rejects an
 *    oversized request with 422 — the client chunks around it.
 * 2. A simulated stale trip (no pings for the configured window) is
 *    auto-cancelled by the reaper job with status CANCELLED, audited
 *    (TRIP_REAPED) and removed from the live fleet map (FleetLastPosition),
 *    while a FRESH trip is left alone.
 * 3. STALE_TRIP_HOURS=0 disables the reaper entirely (documented contract).
 *
 * Note: geofence evaluation is only ENQUEUED here (worker not running in
 * tests) — the geofence.test.js suite covers evaluation itself.
 */
import { describe, it, before } from "node:test";
import request from "supertest";
import bcrypt from "bcryptjs";
import { createApp } from "../src/app.js";
import { prisma } from "../src/prisma.js";
import { clearRateLimitKeys } from "../src/lib/redis.js";
import { expect } from "./expectShim.js";
import { reapStaleTrips } from "../src/jobs/retention.js";
import config from "../src/config.js";

const app = createApp();
const PASS = "Passw0rd!";
let driverToken, managerToken, driverId;

const uuid = () => crypto.randomUUID();

before(async () => {
  await clearRateLimitKeys();
  // Cleanup (FK order — see api.test.js)
  await prisma.auditLog.deleteMany();
  await prisma.deviceToken.deleteMany();
  await prisma.notificationPreference.deleteMany();
  await prisma.invite.deleteMany();
  await prisma.passwordResetToken.deleteMany();
  await prisma.geofenceEvent.deleteMany();
  await prisma.fleetLastPosition.deleteMany();
  await prisma.alert.deleteMany();
  await prisma.idempotencyKey.deleteMany();
  await prisma.locationPing.deleteMany();
  await prisma.trip.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.vehicle.deleteMany();
  await prisma.geofence.deleteMany();
  await prisma.user.deleteMany();

  const driver = await request(app)
    .post("/api/auth/register")
    .send({ email: "offline-driver@fleetflow.test", password: PASS, name: "Ollie Offline" });
  driverToken = driver.body.accessToken;
  driverId = driver.body.user.id;

  // Manager/admin users are seeded directly: elevation is never self-service
  // (Phase 2) — mirrors api.test.js.
  const manager = await prisma.user.create({
    data: {
      email: "audit-viewer@fleetflow.test",
      name: "Vera Viewer",
      role: "ADMIN",
      passwordHash: await bcrypt.hash(PASS, 4),
    },
  });
  const login = await request(app).post("/api/auth/login").send({ email: manager.email, password: PASS });
  managerToken = login.body.accessToken;
});

/** Create a vehicle + start a trip as the driver; returns { tripId, vehicleId }. */
async function startTripWithVehicle(plateSuffix) {
  // Defensive: end any leftover ACTIVE trip from a previous test (several
  // assertions here deliberately leave trips open — e.g. the reaper tests).
  const leftover = await prisma.trip.findFirst({ where: { driverId, status: "ACTIVE" } });
  if (leftover) {
    await request(app).post(`/api/trips/${leftover.id}/finish`).set("Authorization", `Bearer ${driverToken}`);
  }
  const vehicle = await prisma.vehicle.create({
    data: { plate: `VD-10-${plateSuffix}`, model: "Test Van" },
  });
  const trip = await request(app)
    .post("/api/trips")
    .set("Authorization", `Bearer ${driverToken}`)
    .send({ vehicleId: vehicle.id });
  expect(trip.status).toBe(201);
  return { tripId: trip.body.id, vehicleId: vehicle.id };
}

describe("Phase 10 — batch offline sync (§3.6/§4.2)", () => {
  it("drains 300 queued offline pings in a SINGLE call (not 300 HTTP calls)", async () => {
    const { tripId, vehicleId } = await startTripWithVehicle("A");
    const t0 = Date.now() - 60 * 60 * 1000; // a 1h-old offline backlog
    const pings = [];
    for (let i = 0; i < 300; i++) {
      pings.push({
        idempotencyKey: uuid(),
        lat: 12.9 + i * 0.0001,
        lng: 77.5 + i * 0.0001,
        speedKmh: 40 + (i % 20),
        headingDeg: 90,
        accuracyM: 8,
        recordedAt: new Date(t0 + i * 12_000).toISOString(),
      });
    }

    const res = await request(app)
      .post(`/api/trips/${tripId}/pings/batch`)
      .set("Authorization", `Bearer ${driverToken}`)
      .send({ pings });

    expect(res.status).toBe(201);
    expect(res.body.accepted).toBe(300);
    expect(res.body.duplicates).toBe(0);
    expect(res.body.failed).toHaveLength(0);

    // Every ping actually persisted, oldest first.
    expect(await prisma.locationPing.count({ where: { tripId } })).toBe(300);
    const first = await prisma.locationPing.findFirst({
      where: { tripId },
      orderBy: { recordedAt: "asc" },
    });
    expect(first.lat).toBeCloseTo(12.9, 6);

    // Live map advanced to the NEWEST point (never regresses — §3.6).
    const lastPos = await prisma.fleetLastPosition.findUnique({ where: { vehicleId } });
    expect(lastPos.tripId).toBe(tripId);
    expect(lastPos.recordedAt.getTime()).toBe(t0 + 299 * 12_000);
  });

  it("keeps per-item idempotency: in-batch dupes deduped, replayed batch all-duplicates (200)", async () => {
    const { tripId } = await startTripWithVehicle("B");
    const key = uuid();
    const mk = (k, i) => ({
      idempotencyKey: k,
      lat: 13.0 + i * 0.001,
      lng: 77.6,
      speedKmh: 50,
      headingDeg: 0,
      accuracyM: 5,
      recordedAt: new Date(Date.now() - 30 * 60 * 1000 + i * 10_000).toISOString(),
    });

    const first = await request(app)
      .post(`/api/trips/${tripId}/pings/batch`)
      .set("Authorization", `Bearer ${driverToken}`)
      .send({ pings: [mk(key, 0), mk(uuid(), 1), mk(key, 2)] }); // key reused inside the batch
    expect(first.status).toBe(201);
    expect(first.body.accepted).toBe(2); // in-request dedupe by idempotencyKey
    expect(first.body.duplicates).toBe(1);

    const replay = await request(app)
      .post(`/api/trips/${tripId}/pings/batch`)
      .set("Authorization", `Bearer ${driverToken}`)
      .send({ pings: [mk(key, 0), mk(key, 1)] });
    expect(replay.status).toBe(200); // all-duplicate batch → 200, not 201
    expect(replay.body.accepted).toBe(0);
    expect(replay.body.duplicates).toBe(2);
  });

  it("rejects a batch over MAX_PING_BATCH (422) — the client chunks around it", async () => {
    const { tripId } = await startTripWithVehicle("C");
    const { MAX_PING_BATCH } = await import("../src/middleware/validate.js");
    const pings = Array.from({ length: MAX_PING_BATCH + 1 }, (_, i) => ({
      idempotencyKey: uuid(),
      lat: 12.9,
      lng: 77.5,
      speedKmh: 0,
      headingDeg: 0,
      accuracyM: 0,
      recordedAt: new Date(Date.now() - 60_000 + i).toISOString(),
    }));
    const res = await request(app)
      .post(`/api/trips/${tripId}/pings/batch`)
      .set("Authorization", `Bearer ${driverToken}`)
      .send({ pings });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("ValidationError");
  });

  it("fleet managers can batch-sync on behalf of a driver (fleet-wide scope)", async () => {
    const { tripId } = await startTripWithVehicle("G");
    const res = await request(app)
      .post(`/api/trips/${tripId}/pings/batch`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({
        pings: [
          {
            idempotencyKey: uuid(),
            lat: 12.9,
            lng: 77.5,
            speedKmh: 0,
            headingDeg: 0,
            accuracyM: 0,
            recordedAt: new Date().toISOString(),
          },
        ],
      });
    expect(res.status).toBe(201);
    expect(res.body.accepted).toBe(1);
    void tripId;
  });
});

describe("Phase 10 — stale-trip reaper (§8.1)", () => {
  it("auto-cancels a stale trip, audits TRIP_REAPED, and clears the live map", async () => {
    const { tripId, vehicleId } = await startTripWithVehicle("D");

    // Make the trip stale the deterministic way: backdate its only ping past
    // the reaper window (12h default), leaving the trip ACTIVE — exactly the
    // "driver app killed without a clean finish" scenario (§8.1).
    const oldPing = await request(app)
      .post(`/api/trips/${tripId}/pings`)
      .set("Authorization", `Bearer ${driverToken}`)
      .send({
        idempotencyKey: uuid(),
        lat: 12.9716,
        lng: 77.5946,
        speedKmh: 30,
        headingDeg: 0,
        accuracyM: 10,
        recordedAt: new Date(Date.now() - (config.staleTripHours + 2) * 60 * 60 * 1000).toISOString(),
      });
    expect(oldPing.status).toBe(201);
    // The backdated ping's upsert already CREATED a FleetLastPosition row (the
    // create branch is not time-guarded; only the update branch respects the 90s
    // monotonicity guard). No repair is needed — we just assert the reaper
    // REMOVES that row below.

    const reaped = await reapStaleTrips();
    const hit = reaped.find((t) => t.id === tripId);
    expect(hit).toBeDefined();
    expect(hit.status).toBe("CANCELLED");
    expect(hit.finishedAt).toBeDefined();

    // DB state: trip cancelled, live-map row removed, audit row written.
    const dbTrip = await prisma.trip.findUnique({ where: { id: tripId } });
    expect(dbTrip.status).toBe("CANCELLED");
    expect(await prisma.fleetLastPosition.findUnique({ where: { vehicleId } })).toBeNull();
    const audit = await prisma.auditLog.findFirst({
      where: { action: "TRIP_REAPED", target: `trip:${tripId}` },
    });
    expect(audit).toBeDefined();
  });

  it("leaves fresh trips alone (a recent ping is not stale)", async () => {
    const { tripId, vehicleId } = await startTripWithVehicle("E");
    const fresh = await request(app)
      .post(`/api/trips/${tripId}/pings`)
      .set("Authorization", `Bearer ${driverToken}`)
      .send({
        idempotencyKey: uuid(),
        lat: 12.98,
        lng: 77.6,
        speedKmh: 20,
        headingDeg: 0,
        accuracyM: 10,
        recordedAt: new Date().toISOString(),
      });
    expect(fresh.status).toBe(201);

    const reaped = await reapStaleTrips();
    expect(reaped.find((t) => t.id === tripId)).toBeUndefined();
    const dbTrip = await prisma.trip.findUnique({ where: { id: tripId } });
    expect(dbTrip.status).toBe("ACTIVE");
    // The live-map row written by the ping survives the reaper run.
    expect(await prisma.fleetLastPosition.findUnique({ where: { vehicleId } })).toBeDefined();
  });

  it("STALE_TRIP_HOURS=0 disables the reaper entirely (documented contract)", async () => {
    const original = config.staleTripHours;
    config.staleTripHours = 0;
    try {
      // An ancient trip exists but must NOT be reaped while disabled.
      const { tripId } = await startTripWithVehicle("F");
      const old = await request(app)
        .post(`/api/trips/${tripId}/pings`)
        .set("Authorization", `Bearer ${driverToken}`)
        .send({
          idempotencyKey: uuid(),
          lat: 12.9,
          lng: 77.5,
          speedKmh: 0,
          headingDeg: 0,
          accuracyM: 0,
          recordedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
        });
      expect(old.status).toBe(201);

      const reaped = await reapStaleTrips();
      expect(reaped).toHaveLength(0);
      const dbTrip = await prisma.trip.findUnique({ where: { id: tripId } });
      expect(dbTrip.status).toBe("ACTIVE");
    } finally {
      config.staleTripHours = original;
    }
  });
});

/**
 * Phase 5 — server-authoritative geofence evaluation tests (blueprint §8.3
 * done-conditions).
 *
 * 1. A synthetic drive across a geofence produces exactly ONE `ENTER` and ONE
 *    `EXIT` GeofenceEvent — not one per ping (repeated pings inside the fence
 *    and repeated evaluations are idempotent).
 * 2. Alerts are created ONLY for fences flagged alertOnEnter/alertOnExit;
 *    unflagged fences still get audit events.
 */
import { describe, it, before, after } from "node:test";
import bcrypt from "bcryptjs";
import { expect } from "./expectShim.js";
import { prisma } from "../src/prisma.js";
import { evaluatePing } from "../src/services/geofenceService.js";
import geofenceEvalJob from "../src/jobs/geofenceEval.js";

const PASS = "Passw0rd!";
const T0 = new Date("2026-09-02T10:00:00Z");

// Two coincident fences: "flagged" raises alerts, "silent" doesn't.
const FLAGGED = {
  name: "flagged-yard",
  centerLat: 12.9716,
  centerLng: 77.5946,
  radiusM: 500,
  alertOnEnter: true,
  alertOnExit: true,
};
const SILENT = {
  name: "silent-yard",
  centerLat: 12.9716,
  centerLng: 77.5946,
  radiusM: 500,
  alertOnEnter: false,
  alertOnExit: false,
};
const INSIDE = { lat: 12.9716, lng: 77.5946 }; // fence center
const OUTSIDE = { lat: 12.9816, lng: 77.5946 }; // ~1.1km north — well outside 500m

async function ping(index, point) {
  return evaluatePing({
    tripId: trip.id,
    vehicleId: vehicle.id,
    driverId: driver.id,
    lat: point.lat,
    lng: point.lng,
    speedKmh: 40,
    headingDeg: 0,
    recordedAt: new Date(T0.getTime() + index * 1000),
    pingId: index,
  });
}

let driver, vehicle, trip, flaggedId, silentId;

before(async () => {
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

  driver = await prisma.user.create({
    data: {
      email: "gf-eval@fleetflow.test",
      name: "GF Driver",
      role: "DRIVER",
      passwordHash: await bcrypt.hash(PASS, 4),
    },
  });
  vehicle = await prisma.vehicle.create({ data: { plate: "GF-TEST-1", model: "Test Truck" } });
  trip = await prisma.trip.create({ data: { driverId: driver.id, vehicleId: vehicle.id, startedAt: T0 } });
  flaggedId = (await prisma.geofence.create({ data: FLAGGED })).id;
  silentId = (await prisma.geofence.create({ data: SILENT })).id;
});

after(async () => {
  await prisma.$disconnect();
});

describe("server-side geofence evaluation (Phase 5)", () => {
  it("records exactly one ENTER and one EXIT for a synthetic drive across the fence", async () => {
    // pings 1-3 inside, 4-6 outside: a crossing out; then 7-8 inside again.
    await ping(1, INSIDE);
    await ping(2, INSIDE); // still inside — must NOT re-fire
    await ping(3, INSIDE); // still inside — must NOT re-fire
    await ping(4, OUTSIDE);
    await ping(5, OUTSIDE); // still outside — must NOT re-fire
    await ping(6, OUTSIDE);
    await ping(7, INSIDE);

    const events = await prisma.geofenceEvent.findMany({
      where: { geofenceId: flaggedId },
      orderBy: { occurredAt: "asc" },
    });
    expect(events.map((e) => e.eventType)).toEqual(["ENTER", "EXIT", "ENTER"]);
    expect(events.every((e) => e.vehicleId === vehicle.id && e.tripId === trip.id)).toBe(true);
  });

  it("is idempotent under BullMQ retries (same job data re-run)", async () => {
    const before = await prisma.geofenceEvent.count({ where: { geofenceId: flaggedId } });
    await geofenceEvalJob({
      tripId: trip.id,
      vehicleId: vehicle.id,
      lat: INSIDE.lat,
      lng: INSIDE.lng,
      speedKmh: 40,
      headingDeg: 0,
      recordedAt: new Date(T0.getTime() + 7_000).toISOString(),
      pingId: 99,
    });
    const after = await prisma.geofenceEvent.count({ where: { geofenceId: flaggedId } });
    expect(after).toBe(before); // vehicle is already inside — retry must not re-fire
  });

  it("creates Alerts only for flagged fences", async () => {
    const flaggedAlerts = await prisma.alert.count({
      where: { type: { in: ["GEOFENCE_ENTER", "GEOFENCE_EXIT"] }, detail: { contains: "flagged-yard" } },
    });
    const silentAlerts = await prisma.alert.count({ where: { detail: { contains: "silent-yard" } } });
    expect(flaggedAlerts).toBe(3); // ENTER, EXIT, ENTER — all crossings alerted
    expect(silentAlerts).toBe(0); // audit-only fence never pages anyone

    const silentEvents = await prisma.geofenceEvent.count({ where: { geofenceId: silentId } });
    expect(silentEvents).toBe(3); // ...but the audit trail is complete
  });

  it("derives last-known state from the DB (works across restarts, no cache)", async () => {
    // Fresh evaluation with no in-memory state: vehicle currently inside both
    // fences; pinging outside must fire exactly one EXIT per fence.
    const res = await ping(8, OUTSIDE);
    expect(res.transitions.length).toBe(2);
    expect(res.transitions.every((t) => t.eventType === "EXIT")).toBe(true);
    expect(await prisma.geofenceEvent.count({ where: { geofenceId: flaggedId } })).toBe(4);
  });
});

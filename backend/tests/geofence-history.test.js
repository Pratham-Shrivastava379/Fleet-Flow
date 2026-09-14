/**
 * GET /api/geofences/:id/history — per-fence
 * compliance trail: which vehicles entered/exited a fence, when, on which
 * trip. Fleet-operations only (ADMIN/FLEET_MANAGER); the soft-OFF'd fence
 * keeps answering so a "deleted" fence's history survives (§6.3).
 */
import { describe, it, before } from "node:test";
import request from "supertest";
import { prisma } from "../src/prisma.js";
import { expect } from "./expectShim.js";
import { evaluatePing } from "../src/services/geofenceService.js";
import { app, ADMIN_EMAIL, MANAGER_EMAIL, DRIVER_EMAIL, login, resetAndSeed, getDriverId } from "./phase12-helper.js";

let adminToken;
let managerToken;
let driverToken;
let fenceId;
let vehicleA;
let vehicleB;

const T0 = new Date("2026-09-05T09:00:00Z");

async function seedEvent(vehicle, { eventType, minutes }) {
  return prisma.geofenceEvent.create({
    data: {
      geofenceId: fenceId,
      vehicleId: vehicle.id,
      eventType,
      occurredAt: new Date(T0.getTime() + minutes * 60_000),
    },
  });
}

before(async () => {
  await resetAndSeed();
  adminToken = await login(ADMIN_EMAIL);
  managerToken = await login(MANAGER_EMAIL);
  driverToken = await login(DRIVER_EMAIL);

  const fence = await prisma.geofence.create({
    data: {
      name: "History Yard",
      centerLat: 12.9716,
      centerLng: 77.5946,
      radiusM: 500,
      alertOnEnter: true,
      alertOnExit: true,
    },
  });
  fenceId = fence.id;
  vehicleA = await prisma.vehicle.create({ data: { plate: "HIST-A", model: "Van A" } });
  vehicleB = await prisma.vehicle.create({ data: { plate: "HIST-B", model: "Truck B" } });

  // 3 events: A ENTER (t0), A EXIT (t0+10), B ENTER (t0+20).
  await seedEvent(vehicleA, { eventType: "ENTER", minutes: 0 });
  await seedEvent(vehicleA, { eventType: "EXIT", minutes: 10 });
  await seedEvent(vehicleB, { eventType: "ENTER", minutes: 20 });
});

describe("GET /api/geofences/:id/history", () => {
  it("404s for an unknown fence", async () => {
    const res = await request(app).get("/api/geofences/999999/history").set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  it("is ADMIN/FLEET_MANAGER only — drivers get 403", async () => {
    const ok = await request(app)
      .get(`/api/geofences/${fenceId}/history`)
      .set("Authorization", `Bearer ${managerToken}`);
    expect(ok.status).toBe(200);
    const driverRes = await request(app)
      .get(`/api/geofences/${fenceId}/history`)
      .set("Authorization", `Bearer ${driverToken}`);
    expect(driverRes.status).toBe(403);
  });

  it("returns the fence summary + newest-first events with vehicle/trip context", async () => {
    const res = await request(app)
      .get(`/api/geofences/${fenceId}/history`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.fence.name).toBe("History Yard");
    expect(res.body.total).toBe(3);
    expect(res.body.items.length).toBe(3);
    // Newest first: B ENTER (t+20) → A EXIT (t+10) → A ENTER (t0)
    expect(res.body.items.map((e) => [e.vehicle.plate, e.eventType])).toEqual([
      ["HIST-B", "ENTER"],
      ["HIST-A", "EXIT"],
      ["HIST-A", "ENTER"],
    ]);
    expect(res.body.items[0].trip).toBeNull(); // direct-seeded events have no trip
  });

  it("paginates", async () => {
    const res = await request(app)
      .get(`/api/geofences/${fenceId}/history?page=1&pageSize=2`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBe(2);
    expect(res.body.total).toBe(3);
    expect(res.body.pages).toBe(2);
    expect(res.body.page).toBe(1);
  });

  it("filters by vehicleId and eventType", async () => {
    const byVehicle = await request(app)
      .get(`/api/geofences/${fenceId}/history?vehicleId=${vehicleA.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(byVehicle.status).toBe(200);
    expect(byVehicle.body.total).toBe(2);
    expect(byVehicle.body.items.every((e) => e.vehicle.plate === "HIST-A")).toBe(true);

    const byType = await request(app)
      .get(`/api/geofences/${fenceId}/history?eventType=ENTER`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(byType.status).toBe(200);
    expect(byType.body.total).toBe(2);
    expect(byType.body.items.every((e) => e.eventType === "ENTER")).toBe(true);
  });

  it("filters by occurredAt window", async () => {
    // Window (t0+5m → t0+15m): only the A EXIT at t+10 falls inside.
    const res = await request(app)
      .get(
        `/api/geofences/${fenceId}/history?from=${encodeURIComponent(new Date(T0.getTime() + 5 * 60_000).toISOString())}&to=${encodeURIComponent(new Date(T0.getTime() + 15 * 60_000).toISOString())}`,
      )
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].eventType).toBe("EXIT");
    expect(res.body.items[0].vehicle.plate).toBe("HIST-A");
  });

  it("keeps answering after the fence is soft-OFF'd (delete keeps the trail)", async () => {
    await request(app).delete(`/api/geofences/${fenceId}`).set("Authorization", `Bearer ${adminToken}`);
    const res = await request(app)
      .get(`/api/geofences/${fenceId}/history`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.fence.active).toBe(false);
    expect(res.body.total).toBe(3);
  });

  it("surfaces real server-side crossings (evaluatePing → GeofenceEvent → API)", async () => {
    // A fresh active fence + a synthetic drive across it: the worker-evaluated
    // ENTER/EXIT rows must appear in the history endpoint with trip/driver ctx.
    const fence = await prisma.geofence.create({
      data: { name: "Live Crossing", centerLat: 12.9716, centerLng: 77.5946, radiusM: 500 },
    });
    const vehicle = await prisma.vehicle.create({ data: { plate: "HIST-C", model: "Courier" } });
    const trip = await prisma.trip.create({
      data: { driverId: getDriverId(), vehicleId: vehicle.id, startedAt: T0 },
    });
    const INSIDE = { lat: 12.9716, lng: 77.5946 };
    const OUTSIDE = { lat: 12.9816, lng: 77.5946 };
    await evaluatePing({
      tripId: trip.id,
      vehicleId: vehicle.id,
      driverId: getDriverId(),
      lat: INSIDE.lat,
      lng: INSIDE.lng,
      speedKmh: 40,
      headingDeg: 0,
      recordedAt: new Date(T0.getTime() + 30 * 60_000),
      pingId: 1,
    });
    await evaluatePing({
      tripId: trip.id,
      vehicleId: vehicle.id,
      driverId: getDriverId(),
      lat: OUTSIDE.lat,
      lng: OUTSIDE.lng,
      speedKmh: 40,
      headingDeg: 0,
      recordedAt: new Date(T0.getTime() + 31 * 60_000),
      pingId: 2,
    });

    const res = await request(app)
      .get(`/api/geofences/${fence.id}/history`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.items.map((e) => e.eventType)).toEqual(["EXIT", "ENTER"]);
    const entry = res.body.items.find((e) => e.eventType === "ENTER");
    expect(entry.trip.id).toBe(trip.id);
    expect(entry.trip.driver.id).toBe(getDriverId());
    expect(entry.vehicle.plate).toBe("HIST-C");
  });
});

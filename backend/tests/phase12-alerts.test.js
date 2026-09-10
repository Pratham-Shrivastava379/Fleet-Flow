import { describe, it, before } from "node:test";
import request from "supertest";
import { prisma } from "../src/prisma.js";
import { expect } from "./expectShim.js";
import {
  app,
  ADMIN_EMAIL,
  MANAGER_EMAIL,
  DRIVER_EMAIL,
  login,
  resetAndSeed,
  seedTripAndAlert,
  getAdminId,
  getDriverId,
} from "./phase12-helper.js";

let managerToken;

before(async () => {
  await resetAndSeed();
  await login(ADMIN_EMAIL);
  managerToken = await login(MANAGER_EMAIL);
});

describe("Phase 12 - alert triage metadata (SS6.2)", () => {
  it("stamps raisedBy/acknowledgedBy/resolvedBy + timestamps through triage", async () => {
    const { alert } = await seedTripAndAlert();
    expect(alert.raisedById).toBe(getDriverId());

    // A driver cannot triage.
    const driverTri = await request(app)
      .patch(`/api/alerts/${alert.id}`)
      .set("Authorization", `Bearer ${await login(DRIVER_EMAIL)}`)
      .send({ status: "ACKNOWLEDGED" });
    expect(driverTri.status).toBe(403);

    const ack = await request(app)
      .patch(`/api/alerts/${alert.id}`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ status: "ACKNOWLEDGED" });
    expect(ack.status).toBe(200);
    expect(ack.body.status).toBe("ACKNOWLEDGED");
    expect(ack.body.acknowledgedById).toBeTruthy();
    expect(ack.body.acknowledgedAt).toBeTruthy();

    const resolve = await request(app)
      .patch(`/api/alerts/${alert.id}`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ status: "RESOLVED" });
    expect(resolve.status).toBe(200);
    expect(resolve.body.resolvedById).toBeTruthy();
    expect(resolve.body.resolvedAt).toBeTruthy();

    // The inbox listing includes the triage actors.
    const inbox = await request(app).get("/api/alerts").set("Authorization", `Bearer ${managerToken}`);
    expect(inbox.status).toBe(200);
    const row = inbox.body.items.find((a) => a.id === alert.id);
    expect(row.raisedBy.id).toBe(getDriverId());
    expect(row.acknowledgedBy).toBeTruthy();
    expect(row.resolvedBy).toBeTruthy();
  });

  it("keeps 'Not your trip' a 403 for a driver on someone else's trip", async () => {
    const vehicle = await prisma.vehicle.create({
      data: { plate: `P12X-${Math.random().toString(36).slice(2, 7)}`, model: "Other" },
    });
    const stranger = await prisma.trip.create({
      data: { driverId: getAdminId(), vehicleId: vehicle.id, status: "ACTIVE", startedAt: new Date() },
    });
    const res = await request(app)
      .post("/api/alerts")
      .set("Authorization", `Bearer ${await login(DRIVER_EMAIL)}`)
      .send({ tripId: stranger.id, type: "SOS", lat: 12.97, lng: 77.59 });
    expect(res.status).toBe(403);
  });
});

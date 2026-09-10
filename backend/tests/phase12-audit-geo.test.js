import { describe, it, before } from "node:test";
import request from "supertest";
import { prisma } from "../src/prisma.js";
import { expect } from "./expectShim.js";
import {
  app,
  ADMIN_EMAIL,
  MANAGER_EMAIL,
  login,
  resetAndSeed,
  seedTripAndAlert,
  getAdminId,
} from "./phase12-helper.js";

let adminToken;
let managerToken;

before(async () => {
  await resetAndSeed();
  adminToken = await login(ADMIN_EMAIL);
  managerToken = await login(MANAGER_EMAIL);
});

describe("Phase 12 - audit query API (SS7.3)", () => {
  it("filters by action, actor and free text; ADMIN-only", async () => {
    const seeded = await seedTripAndAlert();
    await request(app)
      .patch(`/api/alerts/${seeded.alert.id}`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ status: "ACKNOWLEDGED" });

    const all = await request(app).get("/api/audit-logs").set("Authorization", `Bearer ${adminToken}`);
    expect(all.status).toBe(200);
    expect(all.body.items.length).toBeGreaterThan(0);
    // Audit targets embed the alert id (integer serial).
    expect(all.body.items.some((e) => e.target === `alert:${seeded.alert.id}`)).toBe(true);

    const byAction = await request(app)
      .get("/api/audit-logs?action=ALERT_ACKNOWLEDGED")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(byAction.status).toBe(200);
    expect(byAction.body.items.length).toBeGreaterThan(0);
    expect(byAction.body.items.every((e) => e.action === "ALERT_ACKNOWLEDGED")).toBe(true);

    const byActor = await request(app)
      .get(`/api/audit-logs?actorId=${getAdminId()}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(byActor.status).toBe(200);
    expect(byActor.body.items.every((e) => e.actorId === getAdminId())).toBe(true);

    // Free-text search over target/detail: this file's fixtures only produce
    // alert-triage rows, so search the alert:<id> targets they actually have.
    const byQ = await request(app).get("/api/audit-logs?q=alert:").set("Authorization", `Bearer ${adminToken}`);
    expect(byQ.status).toBe(200);
    expect(byQ.body.items.length).toBeGreaterThan(0);
    expect(byQ.body.items.every((e) => e.target.includes("alert:"))).toBe(true);

    // Managers are excluded from the audit view (ADMIN-only).
    const forbidden = await request(app).get("/api/audit-logs").set("Authorization", `Bearer ${managerToken}`);
    expect(forbidden.status).toBe(403);
  });
});

describe("Phase 12 - geofence authoring (SS7.2 item 5)", () => {
  it("creates, updates (disable) and soft-deletes a geofence, keeping events", async () => {
    const created = await request(app)
      .post("/api/geofences")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "P12 Yard", centerLat: 12.9716, centerLng: 77.5946, radiusM: 120, alertOnEnter: true });
    expect(created.status).toBe(201);
    const fenceId = created.body.id;

    // Seed one event so we can prove soft-delete keeps history.
    await prisma.geofenceEvent.create({
      data: {
        geofenceId: fenceId,
        vehicleId: (await seedTripAndAlert()).vehicle.id,
        eventType: "ENTER",
        occurredAt: new Date(),
      },
    });

    const updated = await request(app)
      .patch(`/api/geofences/${fenceId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ active: false });
    expect(updated.status).toBe(200);
    expect(updated.body.active).toBe(false);

    const del = await request(app).delete(`/api/geofences/${fenceId}`).set("Authorization", `Bearer ${adminToken}`);
    expect([200, 204]).toContain(del.status);

    // History preserved — soft-OFF (§6.3: fences are historical trigger
    // surfaces; the row stays so GeofenceEvents keep resolving) flips
    // active=false and drops it from the active listing + future evaluation.
    const events = await prisma.geofenceEvent.findMany({ where: { geofenceId: fenceId } });
    expect(events.length).toBe(1);
    const row = await prisma.geofence.findUnique({ where: { id: fenceId } });
    expect(row).toBeTruthy();
    expect(row.active).toBe(false);
    const listing = await request(app).get("/api/geofences").set("Authorization", `Bearer ${adminToken}`);
    expect(listing.status).toBe(200);
    expect(listing.body.items.some((g) => g.id === fenceId)).toBe(false);
  });
});

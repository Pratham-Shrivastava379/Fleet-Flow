import request from "supertest";
import bcrypt from "bcryptjs";
import { rm } from "node:fs/promises";
import { createApp } from "../src/app.js";
import { prisma } from "../src/prisma.js";
import { clearRateLimitKeys } from "../src/lib/redis.js";
import { exportArtifactPath } from "../src/services/exportService.js";
import { expect } from "./expectShim.js";

/**
 * Phase 12 shared test fixtures (blueprint §15.12): users + login tokens,
 * DB reset, and a COMPLETED-trip-with-alert seeder for export/triage tests.
 */
export const app = createApp();
export const PASS = "Passw0rd!";
export const ADMIN_EMAIL = "p12-admin@fleetflow.test";
export const MANAGER_EMAIL = "p12-manager@fleetflow.test";
export const DRIVER_EMAIL = "p12-driver@fleetflow.test";

let adminId;
let driverId;

export async function login(email, password = PASS) {
  const res = await request(app).post("/api/auth/login").set("X-Client", "web").send({ email, password });
  expect(res.status).toBe(200);
  return res.body.accessToken;
}

/** Wipe every table a Phase 12 test touches, then seed the three fleet roles. */
export async function resetAndSeed() {
  await clearRateLimitKeys();
  await prisma.auditLog.deleteMany();
  await prisma.deviceToken.deleteMany();
  await prisma.notificationPreference.deleteMany();
  await prisma.invite.deleteMany();
  await prisma.passwordResetToken.deleteMany();
  await prisma.exportJob.deleteMany();
  await prisma.userStatus.deleteMany();
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

  const hash = await bcrypt.hash(PASS, 4);
  const admin = await prisma.user.create({
    data: { email: ADMIN_EMAIL, name: "Phase12 Admin", role: "ADMIN", passwordHash: hash },
  });
  adminId = admin.id;
  const driver = await prisma.user.create({
    data: { email: DRIVER_EMAIL, name: "Phase12 Driver", role: "DRIVER", passwordHash: hash },
  });
  driverId = driver.id;
  await prisma.user.create({
    data: { email: MANAGER_EMAIL, name: "Phase12 Manager", role: "FLEET_MANAGER", passwordHash: hash },
  });
}

export function getAdminId() {
  return adminId;
}

export function getDriverId() {
  return driverId;
}

/**
 * COMPLETED trip with 3 pings + an OPEN SOS alert raised by the driver
 * (detail is formula-like on purpose: proves the CSV-injection guard).
 */
export async function seedTripAndAlert() {
  const vehicle = await prisma.vehicle.create({
    data: { plate: `P12-${Math.random().toString(36).slice(2, 7)}`, model: "Test Van" },
  });
  const trip = await prisma.trip.create({
    data: { driverId, vehicleId: vehicle.id, status: "COMPLETED", startedAt: new Date(), finishedAt: new Date() },
  });
  await prisma.locationPing.createMany({
    data: [0, 1, 2].map((i) => ({
      tripId: trip.id,
      idempotencyKey: `p12-${trip.id}-${i}`,
      lat: 12.97 + i * 0.001,
      lng: 77.59 + i * 0.001,
      speedKmh: 40 + i,
      recordedAt: new Date(Date.now() + i * 1000),
    })),
  });
  const token = await login(DRIVER_EMAIL);
  const alert = await request(app)
    .post("/api/alerts")
    .set("Authorization", `Bearer ${token}`)
    .send({ tripId: trip.id, type: "SOS", lat: 12.97, lng: 77.59, detail: "=cmd|'/c calc'!A0" });
  expect(alert.status).toBe(201);
  return { vehicle, trip, alert: alert.body };
}

/** Remove a generated export artifact (tests clean their temp CSVs). */
export async function removeArtifact(jobId) {
  await rm(exportArtifactPath(jobId), { force: true });
}

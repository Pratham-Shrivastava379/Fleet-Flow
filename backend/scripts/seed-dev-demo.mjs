#!/usr/bin/env node
/**
 * Idempotent development seed: one ADMIN, one FLEET_MANAGER,
 * one DRIVER, demo vehicles, geofences and a demo trip history. Safe to run
 * any number of times — every record is keyed by a stable natural key (email /
 * plate / fence name) and upserted, so re-runs refresh demo data instead of
 * duplicating it. Existing unrelated rows are never touched or deleted.
 *
 * Credentials come from development env vars with DOCUMENTED DEV DEFAULTS:
 *   SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD
 *   SEED_MANAGER_EMAIL / SEED_MANAGER_PASSWORD
 *   SEED_DRIVER_EMAIL / SEED_DRIVER_PASSWORD
 * ...
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

const env = (name, fallback) => process.env[name]?.trim() || fallback;

const ADMIN_EMAIL = env("SEED_ADMIN_EMAIL", "admin@fleetflow.dev");
const ADMIN_PASSWORD = env("SEED_ADMIN_PASSWORD", "Adminpass1");
const MANAGER_EMAIL = env("SEED_MANAGER_EMAIL", "manager@fleetflow.dev");
const MANAGER_PASSWORD = env("SEED_MANAGER_PASSWORD", "Managerpass1");
const DRIVER_EMAIL = env("SEED_DRIVER_EMAIL", "driver@fleetflow.dev");
const DRIVER_PASSWORD = env("SEED_DRIVER_PASSWORD", "Driverpass1");

const DEV_PLATES = ["KA-01-DEMO", "KA-05-DEMO"];
const DEV_FENCES = [
  { name: "DEMO-HQ", centerLat: 12.9716, centerLng: 77.5946, radiusM: 800, alertOnEnter: true },
  { name: "DEMO-HUB-2", centerLat: 12.8452, centerLng: 77.6602, radiusM: 1200, alertOnEnter: false },
];

const hash = (pw) => bcrypt.hash(pw, 10);

async function upsertUser(email, name, role, password) {
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    if (existing.role !== role) {
      throw new Error(
        `seed-dev-demo: ${email} already exists with role ${existing.role} (expected ${role}). ` +
          "Change SEED_*_EMAIL or fix the account manually — the seed never clobbers.",
      );
    }
    const user = existing.name === name ? existing : await prisma.user.update({ where: { email }, data: { name } });
    console.log(`  = user ${email} ready as ${name} (role ${role})`);
    return user;
  }
  const user = await prisma.user.create({
    data: { email, name, role, passwordHash: await hash(password) },
  });
  console.log(`  + user ${email} (${role}) created`);
  return user;
}

async function upsertVehicle(plate, model) {
  const existing = await prisma.vehicle.findUnique({ where: { plate } });
  if (existing) {
    const vehicle =
      existing.model === model ? existing : await prisma.vehicle.update({ where: { plate }, data: { model } });
    console.log(`  = vehicle ${plate} ready as ${model}`);
    return vehicle;
  }
  const vehicle = await prisma.vehicle.create({ data: { plate, model } });
  console.log(`  + vehicle ${plate} (${model}) created`);
  return vehicle;
}

async function upsertGeofence(fence) {
  const existing = await prisma.geofence.findFirst({ where: { name: fence.name } });
  if (existing) {
    console.log(`  = geofence ${fence.name} already exists — left untouched`);
    return existing;
  }
  const gf = await prisma.geofence.create({ data: fence });
  console.log(`  + geofence ${fence.name} created`);
  return gf;
}

/**
 * One small demo history trip: completed on the first demo vehicle with a few
 * pings and one resolved OVERSPEED alert, so dashboards have something to
 * render immediately. Guarded by a marker audit row — re-runs never duplicate.
 */
async function seedDemoHistory(driver, vehicle) {
  // Idempotency guard: the AuditAction enum has no generic "seed" value, so we
  // mark the demo trip with a real enum action + a distinctive free-text detail,
  // and guard on BOTH fields. The pair ("USER_CREATED" + this exact detail) is
  // only ever written here, so re-runs are safe and no normal flow collides.
  const MARKER_ACTION = "USER_CREATED";
  const MARKER = "SEED:demo-history-trip";
  const already = await prisma.auditLog.findFirst({
    where: { action: MARKER_ACTION, detail: MARKER },
  });
  if (already) {
    console.log("  = demo trip history already seeded — skipping");
    return;
  }
  const start = new Date(Date.now() - 26 * 60 * 60 * 1000); // yesterday
  const trip = await prisma.trip.create({
    data: {
      driverId: driver.id,
      vehicleId: vehicle.id,
      status: "COMPLETED",
      startedAt: start,
      finishedAt: new Date(start.getTime() + 42 * 60 * 1000),
    },
  });
  const base = { lat: 12.9716, lng: 77.5946 };
  for (let i = 0; i < 6; i++) {
    await prisma.locationPing.create({
      data: {
        tripId: trip.id,
        idempotencyKey: `seed-demo-${trip.id}-${i}`,
        lat: base.lat + i * 0.001,
        lng: base.lng + i * 0.0015,
        speedKmh: 20 + i * 3,
        recordedAt: new Date(start.getTime() + i * 5 * 60 * 1000),
      },
    });
  }
  await prisma.trip.update({
    where: { id: trip.id },
    data: { distanceKm: 1.1, avgSpeedKmh: 27, maxSpeedKmh: 35, durationSeconds: 2520 },
  });
  await prisma.alert.create({
    data: {
      tripId: trip.id,
      type: "OVERSPEED",
      status: "RESOLVED",
      lat: base.lat,
      lng: base.lng,
      detail: "seeded demo alert",
      createdAt: new Date(start.getTime() + 20 * 60 * 1000),
    },
  });
  await prisma.auditLog.create({
    data: {
      actorId: driver.id,
      action: MARKER_ACTION,
      target: `trip:${trip.id}`,
      detail: MARKER,
    },
  });
  console.log(`  + demo completed trip #${trip.id} with 6 pings + 1 resolved alert`);
}

async function main() {
  // Production guard: this seed creates well-known demo accounts with
  // documented dev passwords (or SEED_* overrides). It must never run against a
  // production database — refuse unless we're in an explicit dev/test env.
  const nodeEnv = (process.env.NODE_ENV || "development").toLowerCase();
  if (!["development", "dev", "test"].includes(nodeEnv)) {
    console.error(
      `seed-dev-demo: refusing to run with NODE_ENV=${nodeEnv}. ` +
        "The development seed creates demo accounts with known credentials and must only target a development database.",
    );
    process.exitCode = 1;
    return;
  }
  console.log("FleetFlow dev seed (idempotent) — starting");
  const admin = await upsertUser(ADMIN_EMAIL, "Aditi Sharma", "ADMIN", ADMIN_PASSWORD);
  const manager = await upsertUser(MANAGER_EMAIL, "Priya Nair", "FLEET_MANAGER", MANAGER_PASSWORD);
  const driver = await upsertUser(DRIVER_EMAIL, "Ravi Kumar", "DRIVER", DRIVER_PASSWORD);

  const vehicles = [];
  for (const [i, plate] of DEV_PLATES.entries()) {
    vehicles.push(await upsertVehicle(plate, i === 0 ? "Tata Ace Gold" : "Mahindra Bolero Pik-Up"));
  }
  for (const fence of DEV_FENCES) await upsertGeofence(fence);

  await seedDemoHistory(driver, vehicles[0]);

  console.log("");
  console.log("Dev accounts ready:");
  console.log(`  ADMIN         ${admin.email} / ${ADMIN_PASSWORD}`);
  console.log(`  FLEET_MANAGER ${manager.email} / ${MANAGER_PASSWORD}`);
  console.log(`  DRIVER        ${driver.email} / ${DRIVER_PASSWORD}`);
  console.log("Vehicles: " + DEV_PLATES.join(", ") + " · Geofences: " + DEV_FENCES.map((f) => f.name).join(", "));
  console.log("Done.");
}

main()
  .catch((e) => {
    // Print the full error (not just .message) — Prisma errors sometimes carry
    // the real detail in meta/code with an empty top-level message.
    console.error("Seed failed:", e?.message || "(empty message)");
    if (e?.meta) console.error("  meta:", e.meta);
    if (e?.code) console.error("  code:", e.code);
    if (e?.stack) console.error("  stack:", e.stack.split("\n").slice(0, 4).join("\n"));
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

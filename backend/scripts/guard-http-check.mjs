/**
 * Live-HTTP check of the duplicate-vehicle trip guard against a RUNNING api
 * (docker container). Complements tests/api.test.js (supertest, mock DB):
 * this exercises the real network path the Android app uses.
 *
 * Fresh rows only (unique emails/plates) — never touches existing trips.
 * Usage: node scripts/guard-http-check.mjs [baseUrl]   (default localhost:3000/api)
 */
import { randomUUID as _uuid } from "node:crypto";
import { PrismaClient } from "@prisma/client";
const crypto = { randomUUID: _uuid };

const BASE = process.argv[2] ?? "http://localhost:3000/api";
const prisma = new PrismaClient();
const j = async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) });
const post = (path, token, data) =>
  fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(data),
  }).then(j);

const uniq = Date.now().toString(36);
const results = [];
const check = (name, cond, detail) => {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
};

const ping = (tripId, key, token) =>
  post(`/trips/${tripId}/pings`, token, {
    idempotencyKey: key,
    lat: 12.9716,
    lng: 77.5946,
    speedKmh: 42,
    headingDeg: 90,
    accuracyM: 5,
    recordedAt: new Date().toISOString(),
  });

const uuid = () => crypto.randomUUID();

const batch = (tripId, token, n) =>
  post(`/trips/${tripId}/pings/batch`, token, {
    pings: Array.from({ length: n }, (_, i) => ({
      idempotencyKey: uuid(),
      lat: 12.9716 + i * 0.001,
      lng: 77.5946,
      speedKmh: 30,
      headingDeg: 90,
      accuracyM: 5,
      recordedAt: new Date().toISOString(),
    })),
  });

try {
  // Two drivers via the real register endpoint (bcrypt + validation path).
  const reg = (email) => post("/auth/register", null, { email, password: "Passw0rd!", name: email.slice(0, 12) });
  const [a, b] = await Promise.all([reg(`guard-a-${uniq}@guard.test`), reg(`guard-b-${uniq}@guard.test`)]);
  check("register both drivers (201)", a.status === 201 && b.status === 201, `${a.status}/${b.status}`);
  const tokA = a.body.accessToken;
  const tokB = b.body.accessToken;

  // Fresh vehicle directly in the shared DB (host 5432 == container DB).
  const vehicle = await prisma.vehicle.create({
    data: { plate: `GUARD-${uniq.slice(-6).toUpperCase()}`, model: "HTTP Check Van" },
  });

  // 1) Guard: second driver on a vehicle with an ACTIVE trip gets 409.
  const start1 = await post("/trips", tokA, { vehicleId: vehicle.id });
  check("driver A starts trip (201)", start1.status === 201, `trip=${start1.body.id}`);
  const trip1 = start1.body.id;

  const second = await post("/trips", tokB, { vehicleId: vehicle.id });
  check(
    "driver B on same vehicle -> 409",
    second.status === 409,
    `${second.status} ${second.body.message ?? second.body.error ?? ""}`,
  );

  // 2) Pings while active: single + offline-style batch.
  const p1 = await ping(trip1, uuid(), tokA);
  check("single ping accepted (201)", p1.status === 201, String(p1.status));
  const pb = await batch(trip1, tokA, 3);
  check("batch ping sync accepted", pb.status === 201 || pb.status === 200, String(pb.status));

  // 3) Finish releases the guard.
  const fin1 = await post(`/trips/${trip1}/finish`, tokA, {});
  check(
    "driver A finishes (200, COMPLETED)",
    fin1.status === 200 && fin1.body.status === "COMPLETED",
    `${fin1.status} ${fin1.body.status ?? ""}`,
  );

  const retry = await post("/trips", tokB, { vehicleId: vehicle.id });
  check("driver B can start after finish (201)", retry.status === 201, String(retry.status));
  const fin2 = await post(`/trips/${retry.body.id}/finish`, tokB, {});
  check("driver B trip completes", fin2.status === 200 && fin2.body.status === "COMPLETED", String(fin2.status));

  // 4) Concurrent double-start race over real HTTP: exactly one 201 + one 409.
  const vehicle2 = await prisma.vehicle.create({
    data: { plate: `RACE-${uniq.slice(-6).toUpperCase()}`, model: "HTTP Check Van" },
  });
  const race = await Promise.all([
    post("/trips", tokA, { vehicleId: vehicle2.id }),
    post("/trips", tokB, { vehicleId: vehicle2.id }),
  ]);
  const statuses = race.map((r) => r.status).sort();
  const created = race.filter((r) => r.status === 201);
  check(
    "concurrent double-start: exactly one 201 + one 409",
    statuses[0] === 201 && statuses[1] === 409 && created.length === 1 && created[0].body.id > 0,
    statuses.join("/"),
  );
  const fin3 = await post(`/trips/${created[0].body.id}/finish`, tokA, {});
  check("race winner completes cleanly", fin3.status === 200, String(fin3.status));

  const failed = results.filter((r) => !r.ok);
  console.log(
    failed.length === 0
      ? `\nALL ${results.length} CHECKS PASSED`
      : `\n${failed.length}/${results.length} CHECKS FAILED`,
  );
  process.exitCode = failed.length === 0 ? 0 : 1;
} catch (e) {
  console.error("SCRIPT ERROR:", e?.message ?? e);
  process.exitCode = 2;
} finally {
  await prisma.$disconnect();
}

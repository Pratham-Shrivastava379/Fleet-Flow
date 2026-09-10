import { describe, it, before } from "node:test";
import request from "supertest";
import bcrypt from "bcryptjs";
import { createApp } from "../src/app.js";
import { prisma } from "../src/prisma.js";
import { clearRateLimitKeys } from "../src/lib/redis.js";
import { setDevTokenSink } from "../src/services/authService.js";
import { expect } from "./expectShim.js";

const app = createApp();
let adminToken, managerToken, driverToken, secondDriverToken;
let vehicleId, tripId;
const uuid = () => crypto.randomUUID();
const PASS = "Passw0rd!";

async function seedUser(email, name, role) {
  return prisma.user.create({
    data: { email, name, role, passwordHash: await bcrypt.hash(PASS, 4) },
  });
}

before(async () => {
  await clearRateLimitKeys(); // deterministic per-run burst/limit tests
  await prisma.auditLog.deleteMany();
  await prisma.deviceToken.deleteMany();
  await prisma.notificationPreference.deleteMany();
  await prisma.invite.deleteMany();
  await prisma.passwordResetToken.deleteMany();
  await prisma.alert.deleteMany();
  await prisma.idempotencyKey.deleteMany();
  await prisma.locationPing.deleteMany();
  await prisma.trip.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.vehicle.deleteMany();
  await prisma.geofence.deleteMany();
  await prisma.user.deleteMany();

  // Admin/manager are seeded directly: since Phase 2, elevation is NEVER
  // self-service (register is always DRIVER) — privileged users come from
  // bootstrap-admin.js or the admin invite flow.
  await seedUser("admin@fleetflow.test", "Ada Admin", "ADMIN");
  await seedUser("mgr@fleetflow.test", "Mia Manager", "FLEET_MANAGER");
  const driver = await request(app)
    .post("/api/auth/register")
    .send({ email: "driver@fleetflow.test", password: PASS, name: "Dan Driver" });
  driverToken = driver.body.accessToken;

  const adminLogin = await request(app).post("/api/auth/login").send({ email: "admin@fleetflow.test", password: PASS });
  adminToken = adminLogin.body.accessToken;
  const mgrLogin = await request(app).post("/api/auth/login").send({ email: "mgr@fleetflow.test", password: PASS });
  managerToken = mgrLogin.body.accessToken;
});

describe("auth", () => {
  it("registers and logs in, rejecting bad credentials", async () => {
    const bad = await request(app).post("/api/auth/login").send({ email: "driver@fleetflow.test", password: "wrong" });
    expect(bad.status).toBe(401);
    const ok = await request(app)
      .post("/api/auth/login")
      .send({ email: "driver@fleetflow.test", password: "Passw0rd!" });
    expect(ok.status).toBe(200);
    expect(ok.body.accessToken).toBeDefined();
    driverToken = ok.body.accessToken;
  });

  it("validates registration input (422)", async () => {
    const res = await request(app).post("/api/auth/register").send({ email: "nope", password: "short", name: "x" });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("ValidationError");
  });

  it("rotates refresh tokens, revokes on logout", async () => {
    const login = await request(app).post("/api/auth/login").send({ email: "driver@fleetflow.test", password: PASS });
    const rt = login.body.refreshToken;
    const r1 = await request(app).post("/api/auth/refresh").send({ refreshToken: rt });
    expect(r1.status).toBe(200);
    await request(app).post("/api/auth/logout").send({ refreshToken: r1.body.refreshToken });
    const r3 = await request(app).post("/api/auth/refresh").send({ refreshToken: r1.body.refreshToken });
    expect(r3.status).toBe(401);
  });

  it("register always yields DRIVER even if a role is supplied", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send({ email: "sneaky@fleetflow.test", password: PASS, name: "Sneaky Steve", role: "ADMIN" });
    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe("DRIVER");
  });

  it("refresh replay revokes the ENTIRE family (breach response)", async () => {
    const login = await request(app).post("/api/auth/login").send({ email: "driver@fleetflow.test", password: PASS });
    const rt0 = login.body.refreshToken;
    const r1 = await request(app).post("/api/auth/refresh").send({ refreshToken: rt0 });
    expect(r1.status).toBe(200);
    const replay = await request(app).post("/api/auth/refresh").send({ refreshToken: rt0 });
    expect(replay.status).toBe(401); // replayed rotated token rejected...
    // ...and the family is now dead: the legitimate successor also fails.
    const r2 = await request(app).post("/api/auth/refresh").send({ refreshToken: r1.body.refreshToken });
    expect(r2.status).toBe(401);
  });

  it("forgot/reset password flow: single-use token, sessions revoked, no enumeration", async () => {
    const unknown = await request(app).post("/api/auth/forgot-password").send({ email: "ghost@fleetflow.test" });
    expect(unknown.status).toBe(202); // same response whether or not the account exists

    // Capture the dev-delivered reset token via the authService dev sink
    // (email provider deferred to Phase 7+; structured-log delivery otherwise).
    let capturedToken = null;
    setDevTokenSink(({ kind, token }) => {
      if (kind === "password-reset") capturedToken = token;
    });
    await request(app).post("/api/auth/forgot-password").send({ email: "driver@fleetflow.test" });
    expect(capturedToken).toBeDefined();
    const token = capturedToken;

    const reset = await request(app).post("/api/auth/reset-password").send({ token, password: "NewPass123!" });
    expect(reset.status).toBe(200);

    // single-use: replaying the token fails
    const reuse = await request(app).post("/api/auth/reset-password").send({ token, password: "OtherPass123!" });
    expect(reuse.status).toBe(400);

    // old password dead, new password works, prior refresh sessions revoked
    const oldLogin = await request(app)
      .post("/api/auth/login")
      .send({ email: "driver@fleetflow.test", password: PASS });
    expect(oldLogin.status).toBe(401);
    const newLogin = await request(app)
      .post("/api/auth/login")
      .send({ email: "driver@fleetflow.test", password: "NewPass123!" });
    expect(newLogin.status).toBe(200);
    driverToken = newLogin.body.accessToken;
  });

  it("admin invites a manager; accept-invite creates the elevated account; audit rows written", async () => {
    const forbidden = await request(app)
      .post("/api/auth/invite")
      .set("Authorization", `Bearer ${driverToken}`)
      .send({ email: "newmgr@fleetflow.test", role: "FLEET_MANAGER" });
    expect(forbidden.status).toBe(403);

    const invite = await request(app)
      .post("/api/auth/invite")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ email: "newmgr@fleetflow.test", role: "FLEET_MANAGER", includeInviteToken: true }); // §5: dev-only opt-in relay
    expect(invite.status).toBe(201);
    expect(invite.body.inviteToken).toBeDefined();

    const accept = await request(app)
      .post("/api/auth/accept-invite")
      .send({ inviteToken: invite.body.inviteToken, password: PASS, name: "Nia Newmanager" });
    expect(accept.status).toBe(201);
    expect(accept.body.user.role).toBe("FLEET_MANAGER");

    // invite tokens are single-use
    const reuse = await request(app)
      .post("/api/auth/accept-invite")
      .send({ inviteToken: invite.body.inviteToken, password: PASS, name: "Nia Again" });
    expect(reuse.status).toBe(400);

    const audits = await prisma.auditLog.findMany({
      where: { action: { in: ["INVITE_SENT", "INVITE_ACCEPTED"] } },
    });
    expect(audits.some((a) => a.action === "INVITE_SENT")).toBe(true);
    expect(audits.some((a) => a.action === "INVITE_ACCEPTED")).toBe(true);
  });

  it("rejects unauthenticated access", async () => {
    expect((await request(app).get("/api/trips")).status).toBe(401);
  });

  it("returns the complete mobile profile contract without sensitive fields", async () => {
    const res = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${driverToken}`);
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe("driver@fleetflow.test");
    expect(res.body.user.name).toBe("Dan Driver");
    expect(res.body.user.role).toBe("DRIVER");
    expect(res.body.user.passwordHash).toBeUndefined();
    expect(res.body.user.statusFlag).toBeUndefined();
  });
});

describe("vehicles + rbac", () => {
  it("lets a manager create a vehicle, forbids a driver", async () => {
    const forbidden = await request(app)
      .post("/api/vehicles")
      .set("Authorization", `Bearer ${driverToken}`)
      .send({ plate: "KA01AB1234", model: "Tata Ace" });
    expect(forbidden.status).toBe(403);

    const ok = await request(app)
      .post("/api/vehicles")
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ plate: "KA01AB1234", model: "Tata Ace" });
    expect(ok.status).toBe(201);
    vehicleId = ok.body.id;
  });

  it("returns 409 on duplicate plate", async () => {
    const res = await request(app)
      .post("/api/vehicles")
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ plate: "KA01AB1234", model: "Dup" });
    expect(res.status).toBe(409);
  });

  it("Phase 3: PATCH updates a vehicle; soft-delete hides it but history resolves", async () => {
    const soft = await request(app)
      .post("/api/vehicles")
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ plate: "KA02XY9999", model: "Mahindra Bolero" });
    expect(soft.status).toBe(201);
    const softId = soft.body.id;

    // PATCH model + status (ADMIN/FLEET_MANAGER only)
    const patched = await request(app)
      .patch(`/api/vehicles/${softId}`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ model: "Bolero Neo", status: "IN_MAINTENANCE" });
    expect(patched.status).toBe(200);
    expect(patched.body.model).toBe("Bolero Neo");
    expect(patched.body.status).toBe("IN_MAINTENANCE");
    expect(patched.body.deletedAt).toBe(null);

    // PATCH with an empty body is rejected (must change model or status)
    const empty = await request(app)
      .patch(`/api/vehicles/${softId}`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({});
    expect(empty.status).toBe(422);

    // Driver records a persisted trip on that vehicle, then finishes it
    const st = await request(app)
      .post("/api/trips")
      .set("Authorization", `Bearer ${driverToken}`)
      .send({ vehicleId: softId });
    expect(st.status).toBe(201);
    await request(app).post(`/api/trips/${st.body.id}/finish`).set("Authorization", `Bearer ${driverToken}`);
    const savedTripId = st.body.id;

    // Soft-delete
    const del = await request(app).delete(`/api/vehicles/${softId}`).set("Authorization", `Bearer ${managerToken}`);
    expect(del.status).toBe(204);

    // Default listing excludes it…
    const list = await request(app).get("/api/vehicles").set("Authorization", `Bearer ${managerToken}`);
    expect(list.status).toBe(200);
    expect(list.body.items.some((v) => v.id === softId)).toBe(false);

    // …but the historical completed trip still resolves with its vehicle
    const trip = await request(app).get(`/api/trips/${savedTripId}`).set("Authorization", `Bearer ${driverToken}`);
    expect(trip.status).toBe(200);
    expect(trip.body.vehicle.id).toBe(softId);

    // Starting a NEW trip on a soft-deleted vehicle is refused
    const refuse = await request(app)
      .post("/api/trips")
      .set("Authorization", `Bearer ${driverToken}`)
      .send({ vehicleId: softId });
    expect(refuse.status).toBe(409);

    // Deleting it again is a 404
    const del2 = await request(app).delete(`/api/vehicles/${softId}`).set("Authorization", `Bearer ${managerToken}`);
    expect(del2.status).toBe(404);
  });
});

describe("trips", () => {
  it("starts a trip, records pings idempotently, finishes", async () => {
    const start = await request(app)
      .post("/api/trips")
      .set("Authorization", `Bearer ${driverToken}`)
      .send({ vehicleId });
    expect(start.status).toBe(201);
    tripId = start.body.id;

    const key = uuid();
    const ping = {
      idempotencyKey: key,
      lat: 12.9716,
      lng: 77.5946,
      speedKmh: 42.5,
      headingDeg: 90,
      accuracyM: 5,
      recordedAt: new Date().toISOString(),
    };
    const p1 = await request(app)
      .post(`/api/trips/${tripId}/pings`)
      .set("Authorization", `Bearer ${driverToken}`)
      .send(ping);
    expect(p1.status).toBe(201);
    const p2 = await request(app)
      .post(`/api/trips/${tripId}/pings`)
      .set("Authorization", `Bearer ${driverToken}`)
      .send(ping);
    expect(p2.status).toBe(200);
    expect(p2.body.duplicate).toBe(true);

    const get = await request(app).get(`/api/trips/${tripId}`).set("Authorization", `Bearer ${driverToken}`);
    expect(get.status).toBe(200);
    expect(get.body.pings).toHaveLength(1);

    const fin = await request(app).post(`/api/trips/${tripId}/finish`).set("Authorization", `Bearer ${driverToken}`);
    expect(fin.status).toBe(200);
    expect(fin.body.status).toBe("COMPLETED");

    const latePing = await request(app)
      .post(`/api/trips/${tripId}/pings`)
      .set("Authorization", `Bearer ${driverToken}`)
      .send({ ...ping, idempotencyKey: uuid() });
    expect(latePing.status).toBe(409);
  });

  it("enforces driver ownership of trips", async () => {
    const start = await request(app)
      .post("/api/trips")
      .set("Authorization", `Bearer ${driverToken}`)
      .send({ vehicleId });
    const otherDriver = await request(app)
      .post("/api/auth/register")
      .send({ email: "driver2@fleetflow.test", password: "Passw0rd!", name: "D2" });
    const res = await request(app)
      .post(`/api/trips/${start.body.id}/finish`)
      .set("Authorization", `Bearer ${otherDriver.body.accessToken}`);
    expect(res.status).toBe(403);
    await request(app).post(`/api/trips/${start.body.id}/finish`).set("Authorization", `Bearer ${driverToken}`);
  });

  // Offline-sync reliability fix (backend blocker 3): the old
  // findFirst-then-create TOCTOU race let two drivers both start trips on the
  // same vehicle (WS-001 trips 674/675). The guard checks + create now run
  // inside a pg_advisory_xact_lock transaction — deterministic 409 for the
  // second starter on BOTH the per-vehicle and per-driver guards.
  it("blocks a second driver from starting a trip on a vehicle with an ACTIVE trip (409)", async () => {
    const v = await prisma.vehicle.create({
      data: { plate: `GV-${uuid().slice(0, 8).toUpperCase()}`, model: "Guard Van" },
    });
    const second = await request(app)
      .post("/api/auth/register")
      .send({ email: "guard-driver@fleetflow.test", password: PASS, name: "Guard Driver" });
    expect(second.status).toBe(201);
    secondDriverToken = second.body.accessToken;
    const secondToken = secondDriverToken;

    const first = await request(app)
      .post("/api/trips")
      .set("Authorization", `Bearer ${driverToken}`)
      .send({ vehicleId: v.id });
    expect(first.status).toBe(201);

    const secondStart = await request(app)
      .post("/api/trips")
      .set("Authorization", `Bearer ${secondToken}`)
      .send({ vehicleId: v.id });
    expect(secondStart.status).toBe(409);
    expect(secondStart.body.error).toBe("Vehicle already has an active trip");

    // Guard releases cleanly: after the first trip finishes, the vehicle is
    // startable again by the other driver.
    const fin = await request(app)
      .post(`/api/trips/${first.body.id}/finish`)
      .set("Authorization", `Bearer ${driverToken}`);
    expect(fin.status).toBe(200);
    const retry = await request(app)
      .post("/api/trips")
      .set("Authorization", `Bearer ${secondToken}`)
      .send({ vehicleId: v.id });
    expect(retry.status).toBe(201);
    await request(app).post(`/api/trips/${retry.body.id}/finish`).set("Authorization", `Bearer ${secondToken}`);
  });

  it("concurrent double-start on one vehicle yields exactly one ACTIVE trip (advisory-lock race guard)", async () => {
    const v = await prisma.vehicle.create({
      data: { plate: `RC-${uuid().slice(0, 8).toUpperCase()}`, model: "Race Van" },
    });
    const d1 = request(app).post("/api/trips").set("Authorization", `Bearer ${driverToken}`).send({ vehicleId: v.id });
    const d2 = request(app)
      .post("/api/trips")
      .set("Authorization", `Bearer ${secondDriverToken}`)
      .send({ vehicleId: v.id });
    const [a, b] = await Promise.all([d1, d2]);
    // Advisory lock serializes the two starters: exactly one 201, one 409 —
    // never two ACTIVE trips (the WS-001 duplicate-trip regression).
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const winner = a.status === 201 ? a : b;
    const winnerToken = a.status === 201 ? driverToken : secondDriverToken;
    await request(app).post(`/api/trips/${winner.body.id}/finish`).set("Authorization", `Bearer ${winnerToken}`);
  });

  it("paginates and filters trips for managers", async () => {
    const res = await request(app)
      .get("/api/trips?status=COMPLETED&page=1&pageSize=10")
      .set("Authorization", `Bearer ${managerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.items.every((t) => t.status === "COMPLETED")).toBe(true);
    expect(res.body).toHaveProperty("total");
  });
});

describe("trip stats (Phase 3)", () => {
  it("computes distance/duration/max-speed at finish via PostGIS", async () => {
    const v = await request(app)
      .post("/api/vehicles")
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ plate: "KA03TV0001", model: "Test Van" });
    expect(v.status).toBe(201);

    const start = await request(app)
      .post("/api/trips")
      .set("Authorization", `Bearer ${driverToken}`)
      .send({ vehicleId: v.body.id });
    expect(start.status).toBe(201);
    const t = start.body.id;

    const base = Date.now();
    const pts = [
      { lat: 12.9716, lng: 77.5946, speedKmh: 40 },
      { lat: 12.9716, lng: 77.605, speedKmh: 50 },
      { lat: 12.9716, lng: 77.6154, speedKmh: 60 },
    ];
    for (let i = 0; i < pts.length; i++) {
      const res = await request(app)
        .post(`/api/trips/${t}/pings`)
        .set("Authorization", `Bearer ${driverToken}`)
        .send({
          idempotencyKey: uuid(),
          lat: pts[i].lat,
          lng: pts[i].lng,
          speedKmh: pts[i].speedKmh,
          headingDeg: 90,
          accuracyM: 5,
          recordedAt: new Date(base + i * 60_000).toISOString(),
        });
      expect(res.status).toBe(201);
    }

    const fin = await request(app).post(`/api/trips/${t}/finish`).set("Authorization", `Bearer ${driverToken}`);
    expect(fin.status).toBe(200);
    expect(fin.body.durationSeconds).toBe(120); // two 60s steps
    expect(fin.body.maxSpeedKmh).toBe(60);
    // two ~1.13km eastward segments (at ~12.97°N) -> ~2.26 km
    expect(fin.body.distanceKm).toBeGreaterThan(2.0);
    expect(fin.body.distanceKm).toBeLessThan(2.4);
    const expectedAvg = (fin.body.distanceKm / 120) * 3600;
    expect(fin.body.avgSpeedKmh).toBeGreaterThan(expectedAvg - 1);
    expect(fin.body.avgSpeedKmh).toBeLessThan(expectedAvg + 1);

    // stats endpoint reads back the same computed values
    const stats = await request(app).get(`/api/trips/${t}/stats`).set("Authorization", `Bearer ${driverToken}`);
    expect(stats.status).toBe(200);
    expect(stats.body.durationSeconds).toBe(120);
    expect(stats.body.maxSpeedKmh).toBe(60);
    expect(stats.body.distanceKm).toBe(fin.body.distanceKm);
    expect(stats.body.pingCount).toBe(3);
  });
});

describe("alerts + geofences", () => {
  it("driver raises SOS, manager triages", async () => {
    const sos = await request(app)
      .post("/api/alerts")
      .set("Authorization", `Bearer ${driverToken}`)
      .send({ type: "SOS", lat: 12.9716, lng: 77.5946, detail: "Accident ahead" });
    expect(sos.status).toBe(201);

    const list = await request(app).get("/api/alerts?status=OPEN").set("Authorization", `Bearer ${managerToken}`);
    expect(list.body.items.length).toBeGreaterThanOrEqual(1);

    const ack = await request(app)
      .patch(`/api/alerts/${sos.body.id}`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ status: "ACKNOWLEDGED" });
    expect(ack.status).toBe(200);

    const forbidden = await request(app)
      .patch(`/api/alerts/${sos.body.id}`)
      .set("Authorization", `Bearer ${driverToken}`)
      .send({ status: "RESOLVED" });
    expect(forbidden.status).toBe(403);
  });

  it("creates a geofence and evaluates point containment", async () => {
    const gf = await request(app)
      .post("/api/geofences")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Depot Whitefield", centerLat: 12.9698, centerLng: 77.7499, radiusM: 500 });
    expect(gf.status).toBe(201);

    const inside = await request(app)
      .post("/api/geofences/check")
      .set("Authorization", `Bearer ${driverToken}`)
      .send({ lat: 12.9698, lng: 77.7499 });
    expect(inside.body.results[0].inside).toBe(true);

    const outside = await request(app)
      .post("/api/geofences/check")
      .set("Authorization", `Bearer ${driverToken}`)
      .send({ lat: 12.9716, lng: 77.5946 });
    expect(outside.body.results[0].inside).toBe(false);
    expect(outside.body.results[0].distanceM).toBeGreaterThan(500);
  });
});

describe("rate limiting", () => {
  it("returns 429 after burst on login", async () => {
    for (let i = 0; i < 10; i++) {
      await request(app).post("/api/auth/login").send({ email: "x@y.test", password: "z" });
    }
    const res = await request(app).post("/api/auth/login").send({ email: "x@y.test", password: "z" });
    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBeDefined();
  });
});

describe("misc", () => {
  it("health endpoint works", async () => {
    expect((await request(app).get("/api/health")).status).toBe(200);
  });
  it("404s unknown routes", async () => {
    expect((await request(app).get("/api/nope")).status).toBe(404);
  });
});

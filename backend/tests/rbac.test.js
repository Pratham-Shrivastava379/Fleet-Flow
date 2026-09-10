/**
 * Comprehensive RBAC regression suite.
 *
 * Role matrix over HTTP (supertest, same process), plus WebSocket topic
 * authorization against a REAL listening server (the wss server handles the
 * frames; only the HTTP port is external):
 *  - DRIVER: own profile/trips/alerts only — object-level ID access denied.
 *  - FLEET_MANAGER: fleet read + operational mutations, NO user administration
 *    and no audit log.
 *  - ADMIN: full authorized access + last-admin protection (409).
 *  - Deactivated accounts: live sessions revoked (401), login refused, WS
 *    auth refused — current account state, not just JWT validity.
 *  - Consistent 401 (unauthenticated) vs 403 (authenticated-unauthorized).
 */
import { describe, it, before, after } from "node:test";
import http from "node:http";
import request from "supertest";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { WebSocket } from "ws";
import { createApp } from "../src/app.js";
import { prisma } from "../src/prisma.js";
import { clearRateLimitKeys } from "../src/lib/redis.js";
import { initWebSocket } from "../src/websocket.js";
import { setDevTokenSink } from "../src/services/authService.js";
import config from "../src/config.js";
import { expect } from "./expectShim.js";

const app = createApp();
const PASS = "Passw0rd!";
let admin, manager, driverA, driverB;
let adminToken, managerToken, tokenA;
let vehicleA, vehicleB, tripA, tripB;

async function seedUser(email, name, role) {
  return prisma.user.create({
    data: { email, name, role, passwordHash: await bcrypt.hash(PASS, 4) },
  });
}

async function login(email) {
  const res = await request(app).post("/api/auth/login").send({ email, password: PASS });
  expect(res.status).toBe(200);
  return res.body.accessToken;
}

/** Real WS client: connect to a live server, auth-frame handshake, collect. */
function wsConnect(url, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url.replace(/^http/, "ws") + "/ws");
    const conn = { ws, messages: [], result: null };
    ws.on("message", (raw) => conn.messages.push(JSON.parse(raw.toString())));
    ws.on("error", reject);
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "auth", token }));
      const deadline = Date.now() + 3000;
      const poll = () => {
        const found = conn.messages.find((m) => m.type === "auth_ok" || m.type === "auth_failed");
        if (found) {
          conn.result = found;
          return resolve(conn);
        }
        if (Date.now() > deadline) {
          return reject(new Error(`ws auth timeout; got: ${JSON.stringify(conn.messages.map((m) => m.type))}`));
        }
        setTimeout(poll, 25);
      };
      poll();
    });
  });
}

async function wsSubscribe(conn, topics) {
  conn.messages.length = 0;
  conn.ws.send(JSON.stringify({ type: "subscribe", topics }));
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const found = conn.messages.find((m) => m.type === "subscribed" || m.type === "error" || m.type === "auth_failed");
    await new Promise((r) => setTimeout(r, 25));
    if (found) return found;
  }
  throw new Error(`timeout waiting for subscribe ack; got: ${JSON.stringify(conn.messages.map((m) => m.type))}`);
}

/** Resolve true when the socket reaches a terminal close state (or null). */
function waitClosed(ws) {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve(true);
    const timer = setTimeout(() => resolve(false), 3000);
    ws.on("close", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

before(async function _seed() {
  await clearRateLimitKeys();
  // FK-order cleanup (same pattern as the other suites)
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
  await prisma.userStatus.deleteMany();
  await prisma.user.deleteMany();

  // One admin only — the last-admin-protection test depends on it.
  admin = await seedUser("rbac-admin@fleetflow.test", "Rbac Admin", "ADMIN");
  manager = await seedUser("rbac-mgr@fleetflow.test", "Rbac Manager", "FLEET_MANAGER");
  driverA = await seedUser("rbac-driver-a@fleetflow.test", "Driver A", "DRIVER");
  driverB = await seedUser("rbac-driver-b@fleetflow.test", "Driver B", "DRIVER");

  adminToken = await login("rbac-admin@fleetflow.test");
  managerToken = await login("rbac-mgr@fleetflow.test");
  tokenA = await login("rbac-driver-a@fleetflow.test");

  const vA = await request(app)
    .post("/api/vehicles")
    .set("Authorization", `Bearer ${managerToken}`)
    .send({ plate: "RBAC-A-001", model: "Tata Ace" });
  const vB = await request(app)
    .post("/api/vehicles")
    .set("Authorization", `Bearer ${managerToken}`)
    .send({ plate: "RBAC-B-002", model: "Mahindra Bolero" });
  expect(vA.status).toBe(201);
  expect(vB.status).toBe(201);
  vehicleA = vA.body;
  vehicleB = vB.body;

  // driverA: finished warm-up trip, then an ACTIVE one (also proves the
  // one-active-trip-per-vehicle race guard with the 409 in between).
  const t1 = await request(app)
    .post("/api/trips")
    .set("Authorization", `Bearer ${tokenA}`)
    .send({ vehicleId: vehicleA.id });
  expect(t1.status).toBe(201);
  const t2 = await request(app)
    .post("/api/trips")
    .set("Authorization", `Bearer ${tokenA}`)
    .send({ vehicleId: vehicleA.id });
  expect(t2.status).toBe(409);
  await request(app).post(`/api/trips/${t1.body.id}/finish`).set("Authorization", `Bearer ${tokenA}`);
  const t3 = await request(app)
    .post("/api/trips")
    .set("Authorization", `Bearer ${tokenA}`)
    .send({ vehicleId: vehicleA.id });
  expect(t3.status).toBe(201);
  tripA = t3.body;

  // driverB: ACTIVE trip on the other vehicle (cross-driver target).
  const b = await request(app).post("/api/auth/login").send({ email: "rbac-driver-b@fleetflow.test", password: PASS });
  const t4 = await request(app)
    .post("/api/trips")
    .set("Authorization", `Bearer ${b.body.accessToken}`)
    .send({ vehicleId: vehicleB.id });
  expect(t4.status).toBe(201);
  tripB = t4.body;
});

after(async () => {
  await prisma.$disconnect();
});

describe("401 vs 403 contract", () => {
  it("unauthenticated requests get 401 (never 403) on representative routes", async () => {
    for (const [method, p] of [
      ["get", "/api/trips"],
      ["get", "/api/vehicles"],
      ["get", "/api/alerts"],
      ["get", "/api/audit-logs"],
      ["get", "/api/users-admin"],
      ["post", "/api/trips"],
      ["patch", "/api/alerts/1"],
    ]) {
      expect((await request(app)[method](p)).status).toBe(401);
    }
  });

  it("authenticated-but-unauthorized requests get 403 (never 401)", async () => {
    const h = { Authorization: `Bearer ${tokenA}` };
    expect((await request(app).get("/api/audit-logs").set(h)).status).toBe(403);
    expect((await request(app).get("/api/users-admin").set(h)).status).toBe(403);
    expect((await request(app).post("/api/auth/invite").set(h).send({ email: "x@y.test", role: "ADMIN" })).status).toBe(
      403,
    );
  });
});

describe("RBAC: DRIVER", () => {
  it("reads own profile and nobody else's", async () => {
    const me = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${tokenA}`);
    expect(me.status).toBe(200);
    expect(me.body.user.id).toBe(driverA.id);
    // The user-ADMIN profile endpoint is ADMIN/FLEET_MANAGER-only; a DRIVER
    // asking for another account's detail is denied (object-level + role).
    const other = await request(app).get(`/api/users-admin/${manager.id}`).set("Authorization", `Bearer ${tokenA}`);
    expect(other.status).toBe(403);
  });

  it("sees only its own trips and cannot read another driver's trip by changing the ID", async () => {
    const list = await request(app).get("/api/trips").set("Authorization", `Bearer ${tokenA}`);
    expect(list.status).toBe(200);
    expect(list.body.items.every((t) => t.driver?.id === driverA.id)).toBe(true);
    expect(list.body.items.some((t) => t.id === tripB.id)).toBe(false);

    const foreign = await request(app).get(`/api/trips/${tripB.id}`).set("Authorization", `Bearer ${tokenA}`);
    expect([403, 404]).toContain(foreign.status); // denied either way, never 200
  });

  it("cannot finish or ping another driver's trip by changing the ID", async () => {
    const finish = await request(app).post(`/api/trips/${tripB.id}/finish`).set("Authorization", `Bearer ${tokenA}`);
    expect([403, 404]).toContain(finish.status);
    const ping = await request(app).post(`/api/trips/${tripB.id}/pings`).set("Authorization", `Bearer ${tokenA}`).send({
      idempotencyKey: crypto.randomUUID(),
      lat: 12.97,
      lng: 77.59,
      speedKmh: 10,
      headingDeg: 0,
      accuracyM: 5,
      recordedAt: new Date().toISOString(),
    });
    expect([403, 404]).toContain(ping.status);
  });

  it("raises an SOS for its own active trip; foreign-trip SOS is denied", async () => {
    const ok = await request(app)
      .post("/api/alerts")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ tripId: tripA.id, type: "SOS", lat: 12.97, lng: 77.59, detail: "rbac own-trip sos" });
    expect(ok.status).toBe(201);

    const cross = await request(app)
      .post("/api/alerts")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ tripId: tripB.id, type: "SOS", lat: 12.97, lng: 77.59, detail: "rbac foreign trip" });
    expect([400, 403, 404]).toContain(cross.status);
  });

  it("cannot touch fleet/admin surfaces (vehicles, geofences, audit, users, exports, invites)", async () => {
    const surfaces = [
      ["post", "/api/vehicles", { plate: "RBAC-DRIVER-CREATE", model: "x" }],
      ["patch", `/api/vehicles/${vehicleA.id}`, { model: "hijack" }],
      ["delete", `/api/vehicles/${vehicleA.id}`],
      [
        "post",
        "/api/geofences",
        { name: "g", geometryJson: JSON.stringify({ type: "Point", coordinates: [77.59, 12.97] }), radiusM: 100 },
      ],
      ["get", "/api/audit-logs"],
      ["get", "/api/users-admin"],
      ["get", "/api/geofences/1/history"],
      ["get", "/api/exports"],
      ["get", "/api/reports"],
      ["post", "/api/auth/invite", { email: "rbac-x@fleetflow.test", role: "FLEET_MANAGER" }],
      ["patch", `/api/users-admin/${driverA.id}`, { role: "ADMIN" }],
    ];
    for (const [method, url, body] of surfaces) {
      const client = request(app);
      const res = await client[method](url)
        .set("Authorization", `Bearer ${tokenA}`)
        .send(body ?? {});
      expect([403, 404]).toContain(res.status);
    }
    // A DRIVER explicitly cannot reach the ADMIN-only audit log.
    const audit = await request(app).get("/api/audit-logs").set("Authorization", `Bearer ${tokenA}`);
    expect(audit.status).toBe(403);
  });
});

describe("RBAC: FLEET_MANAGER", () => {
  it("sees the fleet: all vehicles and all drivers' trips", async () => {
    const vehicles = await request(app).get("/api/vehicles").set("Authorization", `Bearer ${managerToken}`);
    expect(vehicles.status).toBe(200);
    expect(vehicles.body.items.some((v) => v.id === vehicleB.id)).toBe(true);

    const trips = await request(app).get("/api/trips").set("Authorization", `Bearer ${managerToken}`);
    expect(trips.status).toBe(200);
    expect(trips.body.items.some((t) => t.id === tripB.id)).toBe(true);
  });

  it("acknowledges an operational alert", async () => {
    const alerts = await request(app).get("/api/alerts").set("Authorization", `Bearer ${managerToken}`);
    expect(alerts.status).toBe(200);
    const target = alerts.body.items.find((a) => a.status === "OPEN");
    expect(target).toBeDefined();
    const ack = await request(app)
      .patch(`/api/alerts/${target.id}`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ status: "ACKNOWLEDGED" });
    expect(ack.status).toBe(200);
  });

  it("reads the user directory but cannot mutate users or roles", async () => {
    const dir = await request(app).get("/api/users-admin").set("Authorization", `Bearer ${managerToken}`);
    expect(dir.status).toBe(200);

    expect(
      (
        await request(app)
          .patch(`/api/users-admin/${driverA.id}`)
          .set("Authorization", `Bearer ${managerToken}`)
          .send({ name: "Hijacked" })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .patch(`/api/users-admin/${driverA.id}`)
          .set("Authorization", `Bearer ${managerToken}`)
          .send({ role: "ADMIN" })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .patch(`/api/users-admin/${driverA.id}`)
          .set("Authorization", `Bearer ${managerToken}`)
          .send({ deactivated: true })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .post("/api/auth/invite")
          .set("Authorization", `Bearer ${managerToken}`)
          .send({ email: "rbac-elevate@fleetflow.test", role: "ADMIN" })
      ).status,
    ).toBe(403);
  });

  it("cannot read or purge the audit log (security administration)", async () => {
    expect((await request(app).get("/api/audit-logs").set("Authorization", `Bearer ${managerToken}`)).status).toBe(403);
    expect([403, 404]).toContain(
      (await request(app).delete("/api/audit-logs").set("Authorization", `Bearer ${managerToken}`)).status,
    );
  });
});

describe("RBAC: ADMIN", () => {
  it("has full authorized access (directory, audit, exports, invites)", async () => {
    expect((await request(app).get("/api/users-admin").set("Authorization", `Bearer ${adminToken}`)).status).toBe(200);
    expect((await request(app).get("/api/audit-logs").set("Authorization", `Bearer ${adminToken}`)).status).toBe(200);
    expect((await request(app).get("/api/exports").set("Authorization", `Bearer ${adminToken}`)).status).toBe(200);
    expect((await request(app).get("/api/reports").set("Authorization", `Bearer ${adminToken}`)).status).toBe(200);
    const invite = await request(app)
      .post("/api/auth/invite")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ email: "rbac-invited-mgr@fleetflow.test", role: "FLEET_MANAGER" });
    expect(invite.status).toBe(201);
  });

  it("protects the last active admin from demotion and deactivation", async () => {
    // The seed guarantees exactly one ADMIN.
    expect(await prisma.user.count({ where: { role: "ADMIN" } })).toBe(1);
    expect(
      (
        await request(app)
          .patch(`/api/users-admin/${admin.id}`)
          .set("Authorization", `Bearer ${adminToken}`)
          .send({ role: "FLEET_MANAGER" })
      ).status,
    ).toBe(409);
    expect(
      (
        await request(app)
          .patch(`/api/users-admin/${admin.id}`)
          .set("Authorization", `Bearer ${adminToken}`)
          .send({ deactivated: true })
      ).status,
    ).toBe(409);
    // Still intact and functional.
    const me = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${adminToken}`);
    expect(me.status).toBe(200);
    expect(me.body.user.role).toBe("ADMIN");
  });
});

describe("RBAC: deactivation enforcement", () => {
  it("revokes a deactivated manager's live session; login refused; reactivation restores", async () => {
    const m2 = await seedUser("rbac-mgr2@fleetflow.test", "Rbac Manager 2", "FLEET_MANAGER");
    const m2Token = await login(m2.email);
    expect((await request(app).get("/api/vehicles").set("Authorization", `Bearer ${m2Token}`)).status).toBe(200);

    expect(
      (
        await request(app)
          .patch(`/api/users-admin/${m2.id}`)
          .set("Authorization", `Bearer ${adminToken}`)
          .send({ deactivated: true })
      ).status,
    ).toBe(200);

    // Live access token no longer works on privileged surfaces.
    expect((await request(app).get("/api/vehicles").set("Authorization", `Bearer ${m2Token}`)).status).toBe(401);
    // Fresh login refused.
    const relogin = await request(app).post("/api/auth/login").send({ email: m2.email, password: PASS });
    expect(relogin.status).toBe(401);

    expect(
      (
        await request(app)
          .patch(`/api/users-admin/${m2.id}`)
          .set("Authorization", `Bearer ${adminToken}`)
          .send({ deactivated: false })
      ).status,
    ).toBe(200);
    expect((await request(app).get("/api/vehicles").set("Authorization", `Bearer ${m2Token}`)).status).toBe(200);
  });
});

describe("RBAC: logout", () => {
  it("revokes the refresh token family; access token keeps its natural short TTL", async () => {
    // This suite logs in many users; the login limiter is per-IP (10/min, app.js)
    // and is not what these tests exercise — clear buckets so unrelated tests
    // can't trip a 429 when the sliding window fills (the limiter itself is
    // covered by redis-limit.test.js).
    await clearRateLimitKeys();
    const temp = await seedUser("rbac-logout@fleetflow.test", "Rbac Logout", "FLEET_MANAGER");
    const token = await login(temp.email);

    // Sanity: the session works.
    expect((await request(app).get("/api/vehicles").set("Authorization", `Bearer ${token}`)).status).toBe(200);

    // Grab the refresh token from a raw login (login() returns only the access token).
    const loginRes = await request(app).post("/api/auth/login").send({ email: temp.email, password: PASS });
    expect(loginRes.status).toBe(200);
    const refreshToken = loginRes.body.refreshToken;
    expect(refreshToken).toBeDefined();

    // DB state: exactly one live token in this user's family before logout.
    const liveBefore = await prisma.refreshToken.count({
      where: { userId: temp.id, revokedAt: null },
    });
    expect(liveBefore).toBeGreaterThanOrEqual(1);

    // Mobile-style logout: the refresh token in the body.
    const out = await request(app).post("/api/auth/logout").send({ refreshToken });
    expect(out.status).toBe(204);

    // The presented token is dead...
    const after = await prisma.refreshToken.findFirst({
      where: { userId: temp.id },
      orderBy: { id: "desc" },
    });
    expect(after.revokedAt).not.toBeNull();
    // ...and the WHOLE family is revoked, not just the presented row (breach-
    // response semantics: a stolen refresh token must not outlive logout).
    const liveAfter = await prisma.refreshToken.count({
      where: { userId: temp.id, revokedAt: null },
    });
    expect(liveAfter).toBe(0);

    // Refresh after logout is refused.
    const refreshed = await request(app).post("/api/auth/refresh").send({ refreshToken });
    expect(refreshed.status).toBe(401);

    // Web-style logout: cookie-only, no body — must still clear + revoke (204).
    // Mirror the browser: carry the HttpOnly refresh cookie from login -> logout.
    const webLogin = await request(app)
      .post("/api/auth/login")
      .set("X-Client", "web")
      .send({ email: temp.email, password: PASS });
    expect(webLogin.status).toBe(200);
    const setCookieHeader = (webLogin.headers["set-cookie"] || []).find((c) => c.includes("="));
    expect(setCookieHeader).toBeDefined();
    const webCookieHeader = setCookieHeader.split(";")[0]; // "name=value"
    const webOut = await request(app)
      .post("/api/auth/logout")
      .set("X-Client", "web")
      .set("Cookie", webCookieHeader)
      .send({});
    expect(webOut.status).toBe(204);
    // No live refresh tokens remain for this user after the cookie logout.
    const liveAfterWeb = await prisma.refreshToken.count({
      where: { userId: temp.id, revokedAt: null },
    });
    expect(liveAfterWeb).toBe(0);
  });
});

describe("RBAC: password reset atomicity", () => {
  it("consumes the reset token exactly once under concurrency (CAS, no double-reset)", async () => {
    await clearRateLimitKeys(); // see note in "RBAC: logout" — limiter is not under test here
    const temp = await seedUser("rbac-reset@fleetflow.test", "Rbac Reset", "DRIVER");
    const loginRes = await request(app).post("/api/auth/login").send({ email: temp.email, password: PASS });
    expect(loginRes.status).toBe(200);
    const token = loginRes.body.accessToken;
    const preResetRefresh = loginRes.body.refreshToken;
    expect((await request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`)).status).toBe(200);

    // Capture the dev-delivered reset token (same sink pattern as api.test.js).
    let captured = null;
    setDevTokenSink(({ kind, token: t }) => {
      if (kind === "password-reset" && !captured) captured = t;
    });
    const forgot = await request(app).post("/api/auth/forgot-password").send({ email: temp.email });
    expect(forgot.status).toBe(202);
    expect(captured).toBeDefined();

    // Fire N concurrent resets with the SAME token: the guarded compare-and-swap
    // must let exactly one through and reject the rest with the same 400.
    const attempts = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(app).post("/api/auth/reset-password").send({ token: captured, password: "NewPass123!" }),
      ),
    );
    const ok = attempts.filter((r) => r.status === 200);
    const rejected = attempts.filter((r) => r.status === 400);
    expect(ok.length).toBe(1);
    expect(rejected.length).toBe(4);

    // Token is burned in the DB.
    const row = await prisma.passwordResetToken.findFirst({ where: { userId: temp.id } });
    expect(row.usedAt).not.toBeNull();

    // Session revocation scope: password reset invalidates the refresh FAMILY
    // (a pre-reset refresh token can no longer rotate), NOT the already-issued
    // short-lived access token, which keeps its natural TTL by design.
    expect((await request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`)).status).toBe(200);
    const staleRefresh = await request(app).post("/api/auth/refresh").send({ refreshToken: preResetRefresh });
    expect(staleRefresh.status).toBe(401);
    // The password genuinely changed: the old one is dead, the new one works.
    const oldLogin = await request(app).post("/api/auth/login").send({ email: temp.email, password: PASS });
    expect(oldLogin.status).toBe(401);
    const relogin = await request(app).post("/api/auth/login").send({ email: temp.email, password: "NewPass123!" });
    expect(relogin.status).toBe(200);
  });
});

describe("RBAC: REST deactivation enforcement is uniform (DB-backed, not route-local)", () => {
  it("rejects a deactivated account with 401 on BOTH privileged and non-privileged endpoints", async () => {
    await clearRateLimitKeys(); // see note in "RBAC: logout" — limiter is not under test here
    const temp = await seedUser("rbac-deact@fleetflow.test", "Rbac Deact", "FLEET_MANAGER");
    const token = await login(temp.email);
    expect((await request(app).get("/api/vehicles").set("Authorization", `Bearer ${token}`)).status).toBe(200);
    expect((await request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`)).status).toBe(200);

    expect(
      (
        await request(app)
          .patch(`/api/users-admin/${temp.id}`)
          .set("Authorization", `Bearer ${adminToken}`)
          .send({ deactivated: true })
      ).status,
    ).toBe(200);

    // Same 401 on both sides of the privilege boundary — account state, not
    // route-local authorization, decides.
    expect((await request(app).get("/api/vehicles").set("Authorization", `Bearer ${token}`)).status).toBe(401);
    expect((await request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`)).status).toBe(401);

    expect(
      (
        await request(app)
          .patch(`/api/users-admin/${temp.id}`)
          .set("Authorization", `Bearer ${adminToken}`)
          .send({ deactivated: false })
      ).status,
    ).toBe(200);
    expect((await request(app).get("/api/vehicles").set("Authorization", `Bearer ${token}`)).status).toBe(200);
    expect((await request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`)).status).toBe(200);
  });
});

describe("RBAC: WebSocket topic authorization", () => {
  let server, baseUrl;

  before(async () => {
    server = http.createServer(() => {});
    initWebSocket(server);
    await new Promise((res) => server.listen(0, res));
    baseUrl = `http://localhost:${server.address().port}`;
  });

  after(() => new Promise((res) => server.close(res)));

  it("defaults a DRIVER to only its own topic; fleet:all is denied", async () => {
    const conn = await wsConnect(baseUrl, tokenA);
    try {
      expect(conn.result.type).toBe("auth_ok");
      expect(conn.result.topics).toEqual([`driver:${driverA.id}`]);
      // fleet:all is out of the DRIVER role's authority. The protocol
      // SILENTLY DENIES out-of-scope topics — the ack still says "subscribed"
      // but the granted list is empty (no error frame, nothing is added).
      const fleet = await wsSubscribe(conn, ["fleet:all"]);
      expect(fleet.type).toBe("subscribed");
      expect(fleet.topics).toEqual([]);
    } finally {
      conn.ws.close();
    }
  });

  it("denies a DRIVER subscribing to ANOTHER driver's topic (object-level WS authorization)", async () => {
    const conn = await wsConnect(baseUrl, tokenA);
    try {
      // Foreign driver topic is silently filtered out (granted list stays
      // empty) — the socket never holds another driver's topic.
      const foreign = await wsSubscribe(conn, [`driver:${driverB.id}`]);
      expect(foreign.type).toBe("subscribed");
      expect(foreign.topics).toEqual([]);
      expect(foreign.subscriptions).not.toContain(`driver:${driverB.id}`);
      // Re-asserting the own topic still works after the denial.
      const own = await wsSubscribe(conn, [`driver:${driverA.id}`]);
      expect(own.type).toBe("subscribed");
    } finally {
      conn.ws.close();
    }
  });

  it("auto-subscribes a FLEET_MANAGER to fleet:all and allows vehicle topics", async () => {
    const conn = await wsConnect(baseUrl, managerToken);
    try {
      expect(conn.result.type).toBe("auth_ok");
      expect(conn.result.topics).toContain("fleet:all");
      expect(conn.result.topics).not.toContain(`driver:${driverA.id}`);
      const vehicle = await wsSubscribe(conn, [`vehicle:${vehicleA.id}`]);
      expect(vehicle.type).toBe("subscribed");
    } finally {
      conn.ws.close();
    }
  });

  it("refuses WS auth for a deactivated account holding a still-valid token", async () => {
    await clearRateLimitKeys(); // see note in "RBAC: logout" — limiter is not under test here
    const temp = await seedUser("rbac-ws-temp@fleetflow.test", "Temp WS", "DRIVER");
    const loginRes = await request(app).post("/api/auth/login").send({ email: temp.email, password: PASS });
    const tempToken = loginRes.body.accessToken;
    await prisma.userStatus.create({ data: { userId: temp.id, deactivatedAt: new Date() } });

    const conn = await wsConnect(baseUrl, tempToken);
    try {
      expect(conn.result.type).toBe("auth_failed");
    } finally {
      conn.ws.close();
    }
  });

  it("refuses WS auth for a garbage token (signature check still applies)", async () => {
    const forged = jwt.sign({ sub: String(driverA.id), role: "ADMIN" }, "wrong-secret");
    const conn = await wsConnect(baseUrl, forged);
    try {
      expect(conn.result.type).toBe("auth_failed");
    } finally {
      conn.ws.close();
    }
  });

  it("revalidates account state on EVERY subscribe; mid-session deactivation closes the socket", async () => {
    await clearRateLimitKeys(); // see note in "RBAC: logout" — limiter is not under test here
    const temp = await seedUser("rbac-ws-mid@fleetflow.test", "Mid WS", "FLEET_MANAGER");
    const loginRes = await request(app).post("/api/auth/login").send({ email: temp.email, password: PASS });
    const tempToken = loginRes.body.accessToken;

    const conn = await wsConnect(baseUrl, tempToken);
    try {
      expect(conn.result.type).toBe("auth_ok");
      // Subscribe works while the account is active.
      const first = await wsSubscribe(conn, ["fleet:all"]);
      expect(first.type).toBe("subscribed");
      expect(first.topics).toEqual(["fleet:all"]);

      // Deactivate the account AFTER the socket is authenticated.
      expect(
        (
          await request(app)
            .patch(`/api/users-admin/${temp.id}`)
            .set("Authorization", `Bearer ${adminToken}`)
            .send({ deactivated: true })
        ).status,
      ).toBe(200);

      // A new subscribe must NOT extend the live session's authority: the
      // server re-checks the DB account state and tears the socket down.
      const refused = await wsSubscribe(conn, ["fleet:all"]);
      expect(refused.type).toBe("error");
      expect(refused.error).toBe("Account deactivated");
      expect(await waitClosed(conn.ws)).toBe(true);
    } finally {
      conn.ws.close();
      // Restore so later suites see an active account (defensive; WS block is last).
      await request(app)
        .patch(`/api/users-admin/${temp.id}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ deactivated: false });
    }
  });

  it("fails CLOSED when the account-state revalidation cannot be answered (DB down)", async () => {
    await clearRateLimitKeys(); // see note in "RBAC: logout" — limiter is not under test here
    const temp = await seedUser("rbac-ws-dbdown@fleetflow.test", "DbDown WS", "DRIVER");
    const loginRes = await request(app).post("/api/auth/login").send({ email: temp.email, password: PASS });
    const tempToken = loginRes.body.accessToken;

    const conn = await wsConnect(baseUrl, tempToken);
    const originalFindUnique = prisma.user.findUnique;
    try {
      expect(conn.result.type).toBe("auth_ok");
      // Simulate an unreachable store: the subscribe revalidation query throws.
      prisma.user.findUnique = async () => {
        throw new Error("simulated DB outage");
      };
      // Even an IN-SCOPE subscription (own driver topic) is refused — fail closed.
      const res = await wsSubscribe(conn, [`driver:${temp.id}`]);
      expect(res.type).toBe("error");
      expect(res.error).toBe("Service unavailable");
      expect(await waitClosed(conn.ws)).toBe(true);
    } finally {
      prisma.user.findUnique = originalFindUnique;
      conn.ws.close();
    }
  });

  it("revalidates ROLE changes on subscribe: a demoted manager loses fleet:all mid-session", async () => {
    await clearRateLimitKeys(); // see note in "RBAC: logout" — limiter is not under test here
    const temp = await seedUser("rbac-ws-demotion@fleetflow.test", "Demoted WS", "FLEET_MANAGER");
    const loginRes = await request(app).post("/api/auth/login").send({ email: temp.email, password: PASS });
    const tempToken = loginRes.body.accessToken;

    const conn = await wsConnect(baseUrl, tempToken);
    try {
      expect(conn.result.type).toBe("auth_ok");
      expect(conn.result.role).toBe("FLEET_MANAGER");
      expect(conn.result.topics).toContain("fleet:all");

      // ADMIN demotes the account to DRIVER while the socket is live.
      expect(
        (
          await request(app)
            .patch(`/api/users-admin/${temp.id}`)
            .set("Authorization", `Bearer ${adminToken}`)
            .send({ role: "DRIVER" })
        ).status,
      ).toBe(200);

      // The next subscribe adopts the FRESH DB role: the request for fleet:all
      // is no longer in authority, and existing topics are reset to the new
      // role's defaults (driver:<own id>) — fleet:all is gone from the socket.
      const after = await wsSubscribe(conn, ["fleet:all"]);
      expect(after.type).toBe("subscribed");
      expect(after.topics).toEqual([]); // fleet:all silently denied for DRIVER
      expect(after.subscriptions).not.toContain("fleet:all");
      expect(after.subscriptions).toEqual([`driver:${temp.id}`]);

      // The own driver topic IS grantable under the new role.
      const own = await wsSubscribe(conn, [`driver:${temp.id}`]);
      expect(own.type).toBe("subscribed");
      expect(own.topics).toEqual([`driver:${temp.id}`]);
    } finally {
      conn.ws.close();
      // Restore the role so later suites see a consistent directory.
      await request(app)
        .patch(`/api/users-admin/${temp.id}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ role: "FLEET_MANAGER" });
    }
  });
});

describe("RBAC: REST demotion takes effect immediately (fresh DB role, not JWT role)", () => {
  it("a demoted manager's still-valid JWT no longer grants manager surfaces", async () => {
    await clearRateLimitKeys(); // see note in "RBAC: logout" — limiter is not under test here
    const temp = await seedUser("rbac-rest-demotion@fleetflow.test", "Demoted REST", "FLEET_MANAGER");
    const token = await login(temp.email);
    // Sanity: manager surface works before demotion.
    expect((await request(app).get("/api/users-admin").set("Authorization", `Bearer ${token}`)).status).toBe(200);

    // ADMIN demotes the account to DRIVER.
    expect(
      (
        await request(app)
          .patch(`/api/users-admin/${temp.id}`)
          .set("Authorization", `Bearer ${adminToken}`)
          .send({ role: "DRIVER" })
      ).status,
    ).toBe(200);

    // The 15-minute access token is unchanged, but the FRESH DB role now
    // decides: fleet read surfaces and user administration are denied (403).
    expect((await request(app).get("/api/users-admin").set("Authorization", `Bearer ${token}`)).status).toBe(403);
    expect((await request(app).get("/api/audit-logs").set("Authorization", `Bearer ${token}`)).status).toBe(403);
    expect(
      (
        await request(app)
          .post("/api/auth/invite")
          .set("Authorization", `Bearer ${token}`)
          .send({ email: "rbac-demotion-invite@fleetflow.test", role: "ADMIN" })
      ).status,
    ).toBe(403);

    // The demoted account is now evaluated as a DRIVER everywhere (fresh DB
    // role): the driver-only trip-start gate PASSES for it — proving the gate
    // reads the DB role, not the JWT's FLEET_MANAGER claim. A bogus vehicleId
    // keeps the assertion deterministic (404 from vehicle lookup, not a 409
    // vehicle-busy from real fleet state).
    expect(
      (await request(app).post("/api/trips").set("Authorization", `Bearer ${token}`).send({ vehicleId: 99999999 }))
        .status,
    ).toBe(404);

    // Restore.
    expect(
      (
        await request(app)
          .patch(`/api/users-admin/${temp.id}`)
          .set("Authorization", `Bearer ${adminToken}`)
          .send({ role: "FLEET_MANAGER" })
      ).status,
    ).toBe(200);
    expect((await request(app).get("/api/users-admin").set("Authorization", `Bearer ${token}`)).status).toBe(200);
  });
});

describe("RBAC: invite delivery seam (§5)", () => {
  it("non-production returns the raw token ONLY on the explicit includeInviteToken opt-in", async () => {
    await clearRateLimitKeys(); // see note in "RBAC: logout" — limiter is not under test here
    const without = await request(app)
      .post("/api/auth/invite")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ email: "rbac-invite-noopt@fleetflow.test", role: "FLEET_MANAGER" });
    expect(without.status).toBe(201);
    expect(without.body.inviteToken).toBeUndefined();

    const withOptIn = await request(app)
      .post("/api/auth/invite")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ email: "rbac-invite-optin@fleetflow.test", role: "FLEET_MANAGER", includeInviteToken: true });
    expect(withOptIn.status).toBe(201);
    expect(withOptIn.body.inviteToken).toBeDefined();
  });

  it("production NEVER returns the raw token and fails SAFE without a delivery provider (503)", async () => {
    // Point the auth service at a simulated production environment.
    const originalIsProd = config.isProd;
    const originalNodeEnv = config.nodeEnv;
    config.isProd = true;
    config.nodeEnv = "production";
    try {
      const res = await request(app)
        .post("/api/auth/invite")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ email: "rbac-invite-prod@fleetflow.test", role: "FLEET_MANAGER", includeInviteToken: true });
      // Fail-safe: invite created but delivery impossible without a provider.
      expect(res.status).toBe(503);
      expect(res.body.error).toMatch(/delivery/i);
      // The raw token must NEVER be in the production response body.
      expect(res.body.inviteToken).toBeUndefined();
      // The invite row exists (retryable once a provider is configured).
      const row = await prisma.invite.findFirst({ where: { email: "rbac-invite-prod@fleetflow.test" } });
      expect(row).toBeDefined();
      expect(row.acceptedAt).toBeNull();
    } finally {
      config.isProd = originalIsProd;
      config.nodeEnv = originalNodeEnv;
    }
  });

  it("production delivers through the provider seam when one is configured", async () => {
    const { setInviteDeliveryProvider } = await import("../src/services/authService.js");
    const sent = [];
    setInviteDeliveryProvider({ sendInvite: async (payload) => sent.push(payload) });
    const originalIsProd = config.isProd;
    const originalNodeEnv = config.nodeEnv;
    config.isProd = true;
    config.nodeEnv = "production";
    try {
      const res = await request(app)
        .post("/api/auth/invite")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ email: "rbac-invite-provider@fleetflow.test", role: "FLEET_MANAGER", includeInviteToken: true });
      expect(res.status).toBe(201);
      // Provider received the secret; the HTTP response did NOT.
      expect(sent).toHaveLength(1);
      expect(sent[0].email).toBe("rbac-invite-provider@fleetflow.test");
      expect(sent[0].inviteToken).toBeDefined();
      expect(res.body.inviteToken).toBeUndefined();
    } finally {
      setInviteDeliveryProvider(null);
      config.isProd = originalIsProd;
      config.nodeEnv = originalNodeEnv;
    }
  });
});

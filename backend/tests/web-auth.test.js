/**
 * Phase 11 — web dashboard auth: the same JWT auth as mobile,
 * but for a browser SPA the refresh token is delivered as an HttpOnly,
 * SameSite=Strict cookie (never the JSON body, never localStorage), while the
 * access token is returned in the body for the SPA to hold in memory.
 *
 * Backend variant: `X-Client: web` on login/refresh/logout toggles cookie
 * delivery; mobile keeps the current body-based contract (regression-checked
 * here so the new web path can't silently break it).
 */
import { describe, it, before } from "node:test";
import request from "supertest";
import crypto from "node:crypto";
import { createApp } from "../src/app.js";
import { prisma } from "../src/prisma.js";
import { clearRateLimitKeys } from "../src/lib/redis.js";
import { expect } from "./expectShim.js";
import config from "../src/config.js";

const app = createApp();
const PASS = "Passw0rd!";
const COOKIE = config.webRefreshCookieName;

function setCookie(res, name) {
  const header = (res.headers["set-cookie"] || []).find((c) => c.startsWith(`${name}=`));
  return header || null;
}

function cookieNameValue(header) {
  // "name=value; Path=/; HttpOnly; SameSite=Strict" -> { name, value }
  const [pair] = header.split(";");
  const idx = pair.indexOf("=");
  return { name: pair.slice(0, idx), value: pair.slice(idx + 1) };
}

describe("Phase 11 — web dashboard auth (brand cookie flow)", () => {
  let driverId;

  before(async () => {
    await clearRateLimitKeys();
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

    const reg = await request(app)
      .post("/api/auth/register")
      .send({ email: "web-driver@fleetflow.test", password: PASS, name: "Webby Driver" });
    driverId = reg.body.user.id;
  });

  it("web login sets an HttpOnly SameSite=Strict cookie and never returns refreshToken in the body", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .set("X-Client", "web")
      .send({ email: "web-driver@fleetflow.test", password: PASS });

    expect(res.status).toBe(200);
    const header = setCookie(res, COOKIE);
    expect(header).not.toBeNull();
    // never JS-readable, same-site strict
    expect(header.includes("HttpOnly")).toBe(true);
    expect(header.toLowerCase().includes("samesite=strict")).toBe(true);
    // access token IS in the body (temporary, in-memory only); refresh is NOT.
    expect(typeof res.body.accessToken).toBe("string");
    expect(res.body.refreshToken).toBeUndefined();
    expect(res.body.user.id).toBe(driverId);
  });

  it("web refresh uses the cookie (same X-Client) and rolls a new access token + cookie", async () => {
    const login = await request(app)
      .post("/api/auth/login")
      .set("X-Client", "web")
      .send({ email: "web-driver@fleetflow.test", password: PASS });
    const cookie = setCookie(login, COOKIE);
    const { value } = cookieNameValue(cookie);

    // Send ONLY the cookie — no token in body — the web refresh path reads it.
    const res = await request(app)
      .post("/api/auth/refresh")
      .set("X-Client", "web")
      .set("Cookie", `${COOKIE}=${value}`)
      .send({ refreshToken: "this-is-ignored-for-web" });

    expect(res.status).toBe(200);
    expect(typeof res.body.accessToken).toBe("string");
    // rotation: a NEW cookie (a new refresh token) was issued.
    const cookie2 = setCookie(res, COOKIE);
    expect(cookie2).not.toBeNull();
    const { value: value2 } = cookieNameValue(cookie2);
    expect(value2).not.toBe(value);
    expect(res.body.refreshToken).toBeUndefined();
  });

  it("web logout (cookie + X-Client) revokes the refresh token and clears the cookie", async () => {
    const login = await request(app)
      .post("/api/auth/login")
      .set("X-Client", "web")
      .send({ email: "web-driver@fleetflow.test", password: PASS });
    const cookie = setCookie(login, COOKIE);
    const { value } = cookieNameValue(cookie);
    const tokenHash = crypto.createHash("sha256").update(value).digest("hex");

    const res = await request(app)
      .post("/api/auth/logout")
      .set("X-Client", "web")
      .set("Cookie", `${COOKIE}=${value}`)
      .send({});
    expect(res.status).toBe(204);
    // cookie cleared (expired)
    const cleared = setCookie(res, COOKIE);
    expect(cleared).not.toBeNull();
    expect(
      cleared.toLowerCase().includes("max-age=0") || cleared.toLowerCase().includes("expires=thu, 01 jan 1970"),
    ).toBe(true);
    // server-side revocation persisted
    const stored = await prisma.refreshToken.findUnique({ where: { tokenHash } });
    expect(stored.revokedAt).not.toBeNull();
  });

  it("mobile/auth-tooling login is unchanged: refreshToken in body, no Set-Cookie", async () => {
    const res = await request(app).post("/api/auth/login").send({ email: "web-driver@fleetflow.test", password: PASS });
    expect(res.status).toBe(200);
    expect(typeof res.body.refreshToken).toBe("string");
    expect(res.body.accessToken).toBeDefined();
    expect(setCookie(res, COOKIE)).toBeNull();
  });

  it("web refresh with a bad/missing cookie is rejected 401", async () => {
    const res = await request(app).post("/api/auth/refresh").set("X-Client", "web").send({}); // web path needs NO body token — only the cookie
    expect(res.status).toBe(401);
  });
});

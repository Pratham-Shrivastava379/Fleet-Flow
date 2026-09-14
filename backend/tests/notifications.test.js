/**
 * Phase 7 — Notifications: FCM push via the `notifications` job + preference
 * enforcement + device-token registration.
 *
 * 1. Device-token registration endpoint works (upsert semantics).
 * 2. Notification-prefs PATCH is enforced in dispatch: a manager who disabled
 *    GEOFENCE_ENTER gets no push for that type.
 * 3. SOS is exempt from suppression AND always pushes regardless of prefs,
 *    with the correct payload, to all currently-registered manager/admin tokens.
 */
import { describe, it, before, afterEach } from "node:test";
import request from "supertest";
import bcrypt from "bcryptjs";
import { createApp } from "../src/app.js";
import { prisma } from "../src/prisma.js";
import { clearRateLimitKeys } from "../src/lib/redis.js";
import { setFcmSender } from "../src/lib/fcm.js";
import notificationsJob from "../src/jobs/notifications.js";
import { expect } from "./expectShim.js";

const app = createApp();
const PASS = "Passw0rd!";
let managerToken, driverToken, manager2, manager1, driver;

let sent = []; // captured (mocked) FCM sends
const mockSender = async (tokens, message) => {
  for (const token of tokens) sent.push({ token, message });
  return tokens.map((token) => ({ token, ok: true }));
};

before(async () => {
  setFcmSender(mockSender);

  await clearRateLimitKeys();
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

  const hash = await bcrypt.hash(PASS, 4);
  manager1 = await prisma.user.create({
    data: { email: "mgr1-n@fleetflow.test", name: "M1", role: "FLEET_MANAGER", passwordHash: hash },
  });
  manager2 = await prisma.user.create({
    data: { email: "mgr2-n@fleetflow.test", name: "M2", role: "ADMIN", passwordHash: hash },
  });
  driver = await prisma.user.create({
    data: { email: "drv-n@fleetflow.test", name: "D", role: "DRIVER", passwordHash: hash },
  });

  const mgrLogin = await request(app).post("/api/auth/login").send({ email: manager1.email, password: PASS });
  managerToken = mgrLogin.body.accessToken;
  const drvLogin = await request(app).post("/api/auth/login").send({ email: driver.email, password: PASS });
  driverToken = drvLogin.body.accessToken;

  // manager1: one device; manager2: two devices (multiple registrations)
  await prisma.deviceToken.create({ data: { userId: manager1.id, token: "fcm-token-mgr1", platform: "ANDROID" } });
  await prisma.deviceToken.create({ data: { userId: manager2.id, token: "fcm-token-mgr2-a", platform: "ANDROID" } });
  await prisma.deviceToken.create({ data: { userId: manager2.id, token: "fcm-token-mgr2-b", platform: "WEB" } });

  // manager1 disables GEOFENCE_ENTER push (SOS must still reach them, §15.7)
  await prisma.notificationPreference.create({
    data: { userId: manager1.id, type: "GEOFENCE_ENTER", enabled: false },
  });
});

afterEach(() => {
  sent = [];
});

describe("Phase 7 — device-token registration API", () => {
  it("registers a device token (upsert, 201) and rejects bad payloads (422)", async () => {
    const ok = await request(app)
      .post("/api/users/me/device-tokens")
      .set("Authorization", `Bearer ${driverToken}`)
      .send({ token: "fcm-token-driver-registered-abcdefghijklmnop", platform: "ANDROID" });
    expect(ok.status).toBe(201);

    const count1 = await prisma.deviceToken.count({ where: { userId: driver.id } });
    // re-register same token → idempotent upsert, not a duplicate
    const again = await request(app)
      .post("/api/users/me/device-tokens")
      .set("Authorization", `Bearer ${driverToken}`)
      .send({ token: "fcm-token-driver-registered-abcdefghijklmnop" });
    expect(again.status).toBe(201);
    expect(await prisma.deviceToken.count({ where: { userId: driver.id } })).toBe(count1);

    const bad = await request(app)
      .post("/api/users/me/device-tokens")
      .set("Authorization", `Bearer ${driverToken}`)
      .send({ token: "short" });
    expect(bad.status).toBe(422);

    const unauth = await request(app)
      .post("/api/users/me/device-tokens")
      .send({ token: "fcm-token-x-abcdefghijklmnop" });
    expect(unauth.status).toBe(401);
  });
});

describe("Phase 7 — notification-prefs API", () => {
  it("PATCH /me/notification-prefs upserts and GET reflects it (round-trip)", async () => {
    const patch = await request(app)
      .patch("/api/users/me/notification-prefs")
      .set("Authorization", `Bearer ${managerToken}`)
      .send({
        prefs: [
          { type: "OVERSPEED", enabled: false },
          { type: "CRASH_DETECTED", enabled: true },
        ],
      });
    expect(patch.status).toBe(200);
    expect(patch.body.prefs).toEqual([
      { type: "OVERSPEED", enabled: false },
      { type: "CRASH_DETECTED", enabled: true },
    ]);

    const get = await request(app)
      .get("/api/users/me/notification-prefs")
      .set("Authorization", `Bearer ${managerToken}`);
    expect(get.status).toBe(200);
    expect(get.body.prefs.some((p) => p.type === "OVERSPEED" && p.enabled === false)).toBe(true);

    const bad = await request(app)
      .patch("/api/users/me/notification-prefs")
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ prefs: [{ type: "NOT_A_TYPE", enabled: true }] });
    expect(bad.status).toBe(422);
  });
});

describe("Phase 7 — notification dispatch", () => {
  it("SOS pushes to ALL registered manager/admin device tokens with correct payload, regardless of prefs", async () => {
    const alert = await prisma.alert.create({
      data: { tripId: null, type: "SOS", lat: 12.97, lng: 77.59, detail: "sos-test" },
    });

    const result = await notificationsJob({ alertId: alert.id });

    expect(result.delivered).toBe(3); // mgr1 (1) + mgr2 (2)
    expect(sent.length).toBe(3);
    const tokenSet = new Set(sent.map((s) => s.token));
    expect(tokenSet.has("fcm-token-mgr1")).toBe(true);
    expect(tokenSet.has("fcm-token-mgr2-a")).toBe(true);
    expect(tokenSet.has("fcm-token-mgr2-b")).toBe(true);

    // payload correctness
    const msg = sent[0].message;
    expect(msg.notification.title).toBe("SOS emergency");
    expect(msg.data.alertId).toBe(String(alert.id));
    expect(msg.data.type).toBe("SOS");
    expect(msg.data.lat).toBe("12.97");
  });

  it("manager who disabled GEOFENCE_ENTER gets no push for it (SOS still reaches them)", async () => {
    const alert = await prisma.alert.create({
      data: { tripId: null, type: "GEOFENCE_ENTER", lat: 0, lng: 0, detail: "geofence-test" },
    });
    await notificationsJob({ alertId: alert.id });

    // manager1 suppressed; only manager2's two tokens receive
    expect(sent.length).toBe(2);
    expect(sent.every((s) => s.token.startsWith("fcm-token-mgr2"))).toBe(true);
  });

  it("SOS is exempt from suppression even when SOS itself is disabled for a manager", async () => {
    await prisma.notificationPreference.upsert({
      where: { userId_type: { userId: manager1.id, type: "SOS" } },
      update: { enabled: false },
      create: { userId: manager1.id, type: "SOS", enabled: false },
    });
    const alert = await prisma.alert.create({
      data: { tripId: null, type: "SOS", lat: 1, lng: 1, detail: "sos-exempt" },
    });
    const result = await notificationsJob({ alertId: alert.id });

    expect(result.delivered).toBe(3);
    expect(sent.some((s) => s.token === "fcm-token-mgr1")).toBe(true);

    await prisma.notificationPreference.delete({
      where: { userId_type: { userId: manager1.id, type: "SOS" } },
    });
  });

  it("missing alert is skipped without throwing", async () => {
    const result = await notificationsJob({ alertId: 999999 });
    expect(result.skipped).toBe("alert-gone");
  });

  it("unconfigured FCM is loud, not silently ok; SMS fallback flag is off by default", async () => {
    setFcmSender(null); // real path, no credentials in this environment
    try {
      const alert = await prisma.alert.create({
        data: { tripId: null, type: "SOS", lat: 0, lng: 0, detail: "unconfigured" },
      });
      const result = await notificationsJob({ alertId: alert.id });
      expect(result.delivered).toBe(0);
      expect(result.tokens).toBe(3);
      expect(result.sms.sent).toBe(false); // SMS flag off by default (§714)
    } finally {
      setFcmSender(mockSender);
    }
  });
});

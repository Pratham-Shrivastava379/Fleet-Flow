/**
 * Phase 6 — WebSocket protocol extensions.
 *
 * 1. TWO WS instances (separate http servers = simulated horizontal scale) share
 *    ONE Redis; an event published through `publishFleetEvent` is delivered to
 *    clients connected to EITHER instance (the pub/sub bridge works).
 * 2. Subscription filtering: a `driver:<id>`-subscribed client does NOT receive
 *    another driver's location events; fleet:all (manager) receives everything.
 * 3. Default subscriptions are role-based; topic requests beyond a role's
 *    authority are silently denied (ack carries only granted topics).
 * 4. `alert_updated` (PATCH alert status) reaches subscribed managers.
 */
import { describe, it, before, after } from "node:test";
import http from "node:http";
import { WebSocket } from "ws";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { expect } from "./expectShim.js";
import { prisma } from "../src/prisma.js";
import config from "../src/config.js";
import { initWebSocket } from "../src/websocket.js";
import { publishFleetEvent, fleetEventTopics } from "../src/lib/events.js";
import { updateAlertStatus } from "../src/services/alertService.js";

let manager, driver1, driver2, vehicle, otherVehicle, trip;
let srvA, srvB, urlA, urlB;

function token(user) {
  return jwt.sign({ sub: String(user.id), role: user.role }, config.jwtAccessSecret, {
    expiresIn: "15m",
  });
}

/** Connect + authenticate; collects every inbound message. */
function client(base, user) {
  const ws = new WebSocket(base.replace("http", "ws") + "/ws");
  const c = { ws, messages: [] };
  ws.on("message", (raw) => c.messages.push(JSON.parse(raw.toString())));
  c.waitFor = async (type, timeoutMs = 3000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = c.messages.find((m) => m.type === type);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`timeout waiting for ${type}; got: ${JSON.stringify(c.messages.map((m) => m.type))}`);
  };
  c.send = (obj) => ws.send(JSON.stringify(obj));
  c.opened = new Promise((res, rej) => {
    ws.on("open", res);
    ws.on("error", rej);
  });
  if (user) ws.on("open", () => ws.send(JSON.stringify({ type: "auth", token: token(user) })));
  return c;
}

const startInstance = () =>
  new Promise((res) => {
    const srv = http.createServer(() => {});
    initWebSocket(srv);
    srv.listen(0, () => res(srv));
  });

before(async () => {
  // Cleanup (FK order — see geofence.test.js)
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
  await prisma.user.deleteMany();

  const hash = await bcrypt.hash("unused", 4);
  manager = await prisma.user.create({
    data: { email: "mgr-ws@test.dev", passwordHash: hash, name: "Mgr", role: "FLEET_MANAGER" },
  });
  driver1 = await prisma.user.create({
    data: { email: "d1-ws@test.dev", passwordHash: hash, name: "D1", role: "DRIVER" },
  });
  driver2 = await prisma.user.create({
    data: { email: "d2-ws@test.dev", passwordHash: hash, name: "D2", role: "DRIVER" },
  });
  vehicle = await prisma.vehicle.create({ data: { plate: "WS-001", model: "T" } });
  otherVehicle = await prisma.vehicle.create({ data: { plate: "WS-002", model: "T" } });
  trip = await prisma.trip.create({ data: { driverId: driver1.id, vehicleId: vehicle.id, status: "ACTIVE" } });

  // Two "API instances" — separate http servers, one shared Redis.
  srvA = await startInstance();
  srvB = await startInstance();
  urlA = `http://127.0.0.1:${srvA.address().port}`;
  urlB = `http://127.0.0.1:${srvB.address().port}`;
  // Give the Redis subscriber connection a beat to be ready before publishing.
  await new Promise((r) => setTimeout(r, 150));
});

after(async () => {
  const stop = (srv) => new Promise((res) => srv?.close(() => res()));
  await stop(srvA);
  await stop(srvB);
  await prisma.$disconnect();
});

const locationEvent = (driverId, vehicleId) => ({
  type: "location",
  payload: {
    tripId: null,
    vehicleId,
    driverId,
    lat: 12.97,
    lng: 77.59,
    speedKmh: 42,
    recordedAt: new Date().toISOString(),
  },
  topics: fleetEventTopics({ driverId, vehicleId }),
});

describe("Phase 6 — WebSocket topic subscriptions & Redis fan-out", () => {
  it("default subscriptions are role-based and out-of-authority topics are denied", async () => {
    const d = client(urlA, driver1);
    const m = client(urlB, manager);
    await d.opened;
    await m.opened;

    const dAuth = await d.waitFor("auth_ok");
    expect(dAuth.topics).toEqual([`driver:${driver1.id}`]); // DRIVER → own driver topic
    const mAuth = await m.waitFor("auth_ok");
    expect(mAuth.topics).toEqual(["fleet:all"]); // manager → fleet-wide

    // DRIVER cannot have fleet:all or vehicle:<id>
    d.send({ type: "subscribe", topics: ["fleet:all", `vehicle:${vehicle.id}`] });
    const denied = await d.waitFor("subscribed");
    expect(denied.topics).toEqual([]);
    expect(denied.subscriptions).toEqual([`driver:${driver1.id}`]);

    // Manager can narrow into any driver/vehicle topic
    m.send({ type: "subscribe", topics: [`driver:${driver2.id}`, `vehicle:${vehicle.id}`] });
    const granted = await m.waitFor("subscribed");
    expect(granted.topics).toEqual([`driver:${driver2.id}`, `vehicle:${vehicle.id}`]);

    // Unsubscribe removes the topic
    m.send({ type: "unsubscribe", topics: [`driver:${driver2.id}`] });
    const off = await m.waitFor("unsubscribed");
    expect(off.topics).toEqual([`driver:${driver2.id}`]); // ack lists what was removed
    expect(off.subscriptions).toEqual(["fleet:all", `vehicle:${vehicle.id}`]);

    d.ws.close();
    m.ws.close();
  });

  it("two instances both deliver a published event; driver:<id> filters other drivers", async () => {
    const managerC = client(urlA, manager); // connected to instance A
    const driver1C = client(urlB, driver1); // connected to instance B
    await managerC.opened;
    await driver1C.opened;
    await managerC.waitFor("auth_ok");
    await driver1C.waitFor("auth_ok");

    // Driver 1's location — manager (fleet:all, instance A) AND the driver
    // (own driver:<id> topic, instance B) must BOTH receive it.
    await publishFleetEvent(locationEvent(driver1.id, vehicle.id));
    const atManager = await managerC.waitFor("location");
    expect(atManager.payload.driverId).toEqual(driver1.id);
    const atDriver = await driver1C.waitFor("location");
    expect(atDriver.payload.driverId).toEqual(driver1.id);

    // Driver 2's location — manager receives it (fleet:all), driver1 must NOT.
    const countBefore = driver1C.messages.length;
    await publishFleetEvent(locationEvent(driver2.id, otherVehicle.id));
    await managerC.waitFor("location");
    await new Promise((r) => setTimeout(r, 300)); // grace for any (wrong) cross-delivery
    expect(driver1C.messages.length).toEqual(countBefore); // no leak to driver1
    expect(driver1C.messages.every((m) => m.payload?.driverId !== driver2.id)).toBe(true);

    // Per-vehicle narrowing: a fresh manager client subscribed ONLY to
    // driver2's vehicle topic gets driver2's pings but not driver1's.
    const narrowed = client(urlA, manager);
    await narrowed.opened;
    await narrowed.waitFor("auth_ok");
    narrowed.send({ type: "subscribe", topics: [`vehicle:${otherVehicle.id}`] });
    await narrowed.waitFor("subscribed");
    // Narrowing means dropping the role-default fleet:all (additive topic model):
    narrowed.send({ type: "unsubscribe", topics: ["fleet:all"] });
    await narrowed.waitFor("unsubscribed");
    await publishFleetEvent(locationEvent(driver1.id, vehicle.id));
    await new Promise((r) => setTimeout(r, 300));
    expect(narrowed.messages.some((m) => m.type === "location")).toBe(false); // wrong vehicle
    await publishFleetEvent(locationEvent(driver2.id, otherVehicle.id));
    const hit = await narrowed.waitFor("location");
    expect(hit.payload.vehicleId).toEqual(otherVehicle.id); // right vehicle

    managerC.ws.close();
    driver1C.ws.close();
    narrowed.ws.close();
  });

  it("alert_updated (triage status change) reaches subscribed managers via Redis", async () => {
    const managerC = client(urlB, manager);
    await managerC.opened;
    await managerC.waitFor("auth_ok");

    const alert = await prisma.alert.create({
      data: { tripId: trip.id, type: "SOS", lat: 12.97, lng: 77.59, detail: "ws-test" },
    });
    await updateAlertStatus(alert.id, "ACKNOWLEDGED");

    const evt = await managerC.waitFor("alert_updated");
    expect(evt.payload.id).toEqual(alert.id);
    expect(evt.payload.status).toEqual("ACKNOWLEDGED");
    managerC.ws.close();
  });
});

import crypto from "node:crypto";
import { config } from "dotenv";
config();
const BASE = "http://localhost:3000/api";
const j = (r) => r.json();

const email = "admin@fleetflow.test";
const login = await fetch(`${BASE}/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email, password: "Passw0rd!" }),
}).then(j);
const token = login.accessToken ?? login.token ?? login.access_token;
if (!token) throw new Error("no token: " + JSON.stringify(login).slice(0, 300));
const h = { authorization: `Bearer ${token}`, "content-type": "application/json" };

const veh = await fetch(`${BASE}/vehicles`, {
  method: "POST",
  headers: h,
  body: JSON.stringify({ plate: `E2E-${Date.now() % 100000}`, model: "Truck" }),
}).then(j);
const gf = await fetch(`${BASE}/geofences`, {
  method: "POST",
  headers: h,
  body: JSON.stringify({
    name: "e2e-yard",
    centerLat: 12.9716,
    centerLng: 77.5946,
    radiusM: 500,
    alertOnEnter: true,
    alertOnExit: true,
  }),
}).then(j);
const trip = await fetch(`${BASE}/trips`, {
  method: "POST",
  headers: h,
  body: JSON.stringify({ vehicleId: veh.id }),
}).then(j);
console.log("RAW veh:", JSON.stringify(veh).slice(0, 300));
console.log("RAW gf:", JSON.stringify(gf).slice(0, 300));
console.log("RAW trip:", JSON.stringify(trip).slice(0, 300));
const tripId = trip.id ?? trip.trip?.id;
console.log(`trip=${tripId}`);

const ping = (lat, lng) =>
  fetch(`${BASE}/trips/${tripId}/pings`, {
    method: "POST",
    headers: h,
    body: JSON.stringify({ idempotencyKey: crypto.randomUUID(), lat, lng, recordedAt: new Date().toISOString() }),
  }).then(j);

// synthetic drive: 2 pings inside the fence, 2 outside → expect 1 ENTER, 1 EXIT
await ping(12.9716, 77.5946);
await ping(12.9716, 77.5946);
await ping(12.9816, 77.5946);
await ping(12.9816, 77.5946);
console.log("pings sent; waiting for worker…");
await new Promise((r) => setTimeout(r, 4000));
console.log("done — inspect DB now");

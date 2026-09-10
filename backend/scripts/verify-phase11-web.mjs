/**
 * Phase 11 live E2E check (run against a REAL stack: API + Postgres + Redis).
 *
 * Verifies the web done-conditions end to end:
 *  1. web login (X-Client: web) → refresh token in HttpOnly cookie, NOT in body
 *  2. cookie-based refresh rolls a new access token (no token in request body)
 *  3. GET /api/trips?status=ACTIVE carries vehicle.fleetLastPosition (map paint)
 *  4. driver ping → WS `location` event near-real-time with coordinates
 *  5. batch ping → WS `location_batch` event (counts-only contract)
 *  6. web logout revokes the cookie token; subsequent refresh fails (401)
 *
 * Usage: node scripts/verify-phase11-web.mjs
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import WebSocket from "ws";

const prisma = new PrismaClient();
const BASE = "http://localhost:3000";
const WS_URL = "ws://localhost:3000/ws";
const PASS = "P11-web-check!";
let failures = 0;

function check(name, cond, detail = "") {
  const tag = cond ? "PASS" : "FAIL";
  if (!cond) failures += 1;
  console.log(`  [${tag}] ${name}${detail ? ` — ${detail}` : ""}`);
}

async function jfetch(path, { method = "GET", headers = {}, body, cookie } = {}) {
  const h = { "Content-Type": "application/json", ...headers };
  if (cookie) h["Cookie"] = cookie;
  const res = await fetch(BASE + path, {
    method,
    headers: h,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const setCookies = res.headers.getSetCookie?.() ?? [];
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* 204 */
  }
  return { status: res.status, json, setCookies };
}

const webHeaders = () => ({ "X-Client": "web" });
function cookieFrom(setCookies, name = "fleetflow_refresh") {
  const c = setCookies.find((c) => c.startsWith(name + "="));
  if (!c) return null;
  return { raw: c.split(";")[0], attrs: c.split(";").map((s) => s.trim().toLowerCase()) };
}

/** WS helper: auth with a token, collect fleet events for `ms`. */
function collectEvents(token, ms) {
  return new Promise((resolve) => {
    const events = [];
    const ws = new WebSocket(WS_URL);
    const done = () => {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      resolve(events);
    };
    const timer = setTimeout(done, ms);
    ws.on("open", () => ws.send(JSON.stringify({ type: "auth", token })));
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "location" || msg.type === "location_batch" || msg.type === "trip_finished") {
        events.push(msg);
      }
    });
    ws.on("error", () => {
      clearTimeout(timer);
      done();
    });
  });
}

async function main() {
  const suffix = crypto.randomBytes(3).toString("hex");
  const mgrEmail = `p11-mgr-${suffix}@fleetflow.test`;
  const drvEmail = `p11-drv-${suffix}@fleetflow.test`;
  const hash = await bcrypt.hash(PASS, 4);

  const manager = await prisma.user.create({
    data: { email: mgrEmail, name: "P11 Manager", role: "FLEET_MANAGER", passwordHash: hash },
  });
  const driver = await prisma.user.create({
    data: { email: drvEmail, name: "P11 Driver", role: "DRIVER", passwordHash: hash },
  });
  const vehicle = await prisma.vehicle.create({ data: { plate: `P11-${suffix.toUpperCase()}`, model: "eProbe" } });

  let tripId = null;
  try {
    // ---- 1. web login: cookie in, token out, NO refresh token in body ----
    console.log("\n[1] web login (X-Client: web)");
    const login = await jfetch("/api/auth/login", {
      method: "POST",
      headers: webHeaders(),
      body: { email: mgrEmail, password: PASS },
    });
    check("login 200", login.status === 200, `status=${login.status}`);
    const cookie = cookieFrom(login.setCookies);
    check(
      "Set-Cookie fleetflow_refresh (HttpOnly, SameSite=Strict)",
      !!cookie &&
        cookie.attrs.some((a) => a.includes("httponly")) &&
        cookie.attrs.some((a) => a.includes("samesite=strict")),
    );
    check("body has accessToken (string)", typeof login.json?.accessToken === "string");
    check("body has NO refreshToken", !("refreshToken" in (login.json ?? {})));
    let mgrToken = login.json.accessToken;

    // ---- 2. cookie refresh rolls a new access token ----
    console.log("\n[2] cookie-based refresh");
    const r1 = await jfetch("/api/auth/refresh", {
      method: "POST",
      headers: webHeaders(),
      cookie: cookie.raw,
      body: {},
    });
    check("refresh 200 with ONLY the cookie", r1.status === 200, `status=${r1.status}`);
    // NOTE: the new JWT can be byte-identical to the old one when both are minted
    // within the same second (iat granularity) — verify it AUTHENTICATES instead.
    const probe = await jfetch("/api/auth/me", {
      headers: { Authorization: `Bearer ${r1.json?.accessToken}`, ...webHeaders() },
    });
    check(
      "refreshed access token authenticates (/me 200)",
      probe.status === 200 && probe.json?.user?.role === "FLEET_MANAGER",
      `status=${probe.status}`,
    );
    check("NO refreshToken in body", !("refreshToken" in (r1.json ?? {})));
    const cookie2 = cookieFrom(r1.setCookies);
    check("refresh token ROTATED (new cookie)", !!cookie2 && cookie2.raw !== cookie.raw);
    mgrToken = r1.json.accessToken;

    // ---- 3. driver starts a trip; manager snapshot has fleetLastPosition ----
    console.log("\n[3] trip + initial map snapshot (GET /api/trips?status=ACTIVE)");
    const drvLogin = await jfetch("/api/auth/login", { method: "POST", body: { email: drvEmail, password: PASS } });
    const drvToken = drvLogin.json.accessToken;
    const trip = await jfetch("/api/trips", {
      method: "POST",
      headers: { Authorization: `Bearer ${drvToken}` },
      body: { vehicleId: vehicle.id },
    });
    tripId = trip.json?.id ?? null;
    check("driver starts trip 201", trip.status === 201, `status=${trip.status}`);

    const ping = async (lat, lng, speed, key) =>
      jfetch(`/api/trips/${tripId}/pings`, {
        method: "POST",
        headers: { Authorization: `Bearer ${drvToken}` },
        body: {
          idempotencyKey: key,
          lat,
          lng,
          speedKmh: speed,
          headingDeg: 90,
          accuracyM: 5,
          recordedAt: new Date().toISOString(),
        },
      });
    await ping(12.9716, 77.5946, 35, crypto.randomUUID());

    const snapshot = await jfetch("/api/trips?status=ACTIVE", { headers: { Authorization: `Bearer ${mgrToken}` } });
    const mine = snapshot.json?.items?.find((t) => t.id === tripId);
    check("active-trip snapshot visible to manager", !!mine);
    check(
      "vehicle.fleetLastPosition present (map initial paint)",
      !!mine?.vehicle?.fleetLastPosition && Math.abs(mine.vehicle.fleetLastPosition.lat - 12.9716) < 1e-6,
      JSON.stringify(mine?.vehicle?.fleetLastPosition ?? null),
    );

    // ---- 4. driver ping → manager WS location event (near-real-time) ----
    console.log("\n[4] WS live location from driver ping");
    const events = collectEvents(mgrToken, 4000);
    await new Promise((r) => setTimeout(r, 300)); // let the socket auth settle
    await ping(12.982, 77.605, 48, crypto.randomUUID());
    const seen = await events;
    const loc = seen.find((e) => e.type === "location" && e.payload?.vehicleId === vehicle.id);
    check("WS location event received", !!loc);
    check(
      "event has coordinates (map moves without refetch)",
      !!loc && Math.abs(loc.payload.lat - 12.982) < 1e-6 && Math.abs(loc.payload.lng - 77.605) < 1e-6,
    );

    // ---- 5. batch ping → location_batch (counts only) ----
    console.log("\n[5] WS location_batch (Phase 10 batch sync fan-out)");
    const batchEvents = collectEvents(mgrToken, 4000);
    await new Promise((r) => setTimeout(r, 300));
    const keys = [1, 2, 3].map((i) => ({
      idempotencyKey: crypto.randomUUID(),
      lat: 12.99 + i * 0.001,
      lng: 77.61 + i * 0.001,
      speedKmh: 40 + i,
      headingDeg: 45,
      accuracyM: 5,
      recordedAt: new Date(Date.now() + i * 1000).toISOString(),
    }));
    const batch = await jfetch(`/api/trips/${tripId}/pings/batch`, {
      method: "POST",
      headers: { Authorization: `Bearer ${drvToken}` },
      body: { pings: keys },
    });
    check("batch pings accepted", batch.status === 201 || batch.status === 200, `status=${batch.status}`);
    const bseen = await batchEvents;
    const bat = bseen.find((e) => e.type === "location_batch" && e.payload?.vehicleId === vehicle.id);
    check("WS location_batch event received", !!bat);
    check("batch payload has counts, not coordinates", !!bat && bat.payload.count === 3 && !("lat" in bat.payload));

    // ---- 6. web logout revokes cookie token ----
    console.log("\n[6] web logout + refresh-after-logout");
    const out = await jfetch("/api/auth/logout", {
      method: "POST",
      headers: webHeaders(),
      cookie: cookie2.raw,
      body: {},
    });
    check("logout 204", out.status === 204, `status=${out.status}`);
    const clearCookie = out.setCookies.find((c) => c.startsWith("fleetflow_refresh="));
    check(
      "cookie cleared (Max-Age=0/Expires in past)",
      !!clearCookie && /max-age=0|expires=thu, 01 jan 1970/i.test(clearCookie),
    );
    const r2 = await jfetch("/api/auth/refresh", {
      method: "POST",
      headers: webHeaders(),
      cookie: cookie2.raw,
      body: {},
    });
    check("refresh after logout rejected 401", r2.status === 401, `status=${r2.status}`);

    console.log(failures === 0 ? "\nALL CHECKS PASSED ✅" : `\n${failures} CHECK(S) FAILED ❌`);
  } finally {
    // best-effort cleanup (FK-safe order), mirroring backend tests
    try {
      if (tripId) {
        await prisma.locationPing.deleteMany({ where: { tripId } });
        await prisma.trip.deleteMany({ where: { id: tripId } });
      }
      await prisma.fleetLastPosition.deleteMany({ where: { vehicleId: vehicle.id } });
      await prisma.vehicle.delete({ where: { id: vehicle.id } });
      await prisma.refreshToken.deleteMany({ where: { userId: { in: [manager.id, driver.id] } } });
      await prisma.user.deleteMany({ where: { id: { in: [manager.id, driver.id] } } });
    } catch (e) {
      console.log("cleanup warning:", e.message);
    }
    await prisma.$disconnect();
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

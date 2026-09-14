/**
 * Phase 15 load test — ping-ingestion write path.
 *
 * The dominant write at fleet scale is location pings (active trips × ping
 * frequency). This script drives the real `POST /api/trips/:id/pings` endpoint
 * against a running stack and reports throughput + latency percentiles.
 * Load-test target: ~100 writes/sec sustained (500 active trips ×
 * 1 ping / 5s), spiking higher — tune PINGS_PER_SECOND to probe above it.
 *
 * Usage (against the docker-compose stack, or any running API):
 *   node scripts/load-test-pings.mjs                # defaults: 20s @ 50 pings/s
 *   PINGS_PER_SECOND=200 DURATION_SECONDS=15 node scripts/load-test-pings.mjs
 *   BASE=http://staging:3000 node scripts/load-test-pings.mjs
 *
 * Notes:
 *  - Users/vehicle are seeded via Prisma directly (register + one login only)
 *    so the /api/auth/login rate limit never distorts the measurement.
 *  - Each ping is idempotency-keyed (the real client contract) and enqueues a
 *    geofence-eval BullMQ job (Phase 5), so the worker queue is exercised too.
 *  - The trip is left ACTIVE; the Phase 10 stale-trip reaper cleans it up.
 *  - Exits non-zero if any ping fails or if the API becomes unhealthy.
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";

const prisma = new PrismaClient();
const BASE = process.env.BASE || "http://localhost:3000";
const DURATION_SECONDS = Number(process.env.DURATION_SECONDS || 20);
const PINGS_PER_SECOND = Number(process.env.PINGS_PER_SECOND || 50);
const PASSWORD = "Load-test-2026!";

const suffix = crypto.randomBytes(3).toString("hex");
let failures = 0;

async function jfetch(path, { method = "GET", headers = {}, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* 204 */
  }
  return { status: res.status, json };
}

function pct(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function main() {
  const seed = await prisma.user.create({
    data: {
      email: `load-${suffix}@fleetflow.test`,
      name: "Load Test Driver",
      role: "DRIVER",
      passwordHash: await bcrypt.hash(PASSWORD, 4),
    },
  });
  const vehicle = await prisma.vehicle.create({
    data: { plate: `LOAD-${suffix.toUpperCase()}`, model: "eProbe" },
  });

  const login = await jfetch("/api/auth/login", {
    method: "POST",
    body: { email: seed.email, password: PASSWORD },
  });
  if (login.status !== 200 || !login.json?.accessToken) {
    console.error(`login failed: status=${login.status}`);
    process.exit(1);
  }
  const auth = { Authorization: `Bearer ${login.json.accessToken}` };

  const trip = await jfetch("/api/trips", {
    method: "POST",
    headers: auth,
    body: { vehicleId: vehicle.id },
  });
  if (trip.status !== 201) {
    console.error(`start trip failed: status=${trip.status} ${JSON.stringify(trip.json)}`);
    process.exit(1);
  }
  const tripId = trip.json.id;

  // Deterministic-ish synthetic drive: gentle lat/lng drift around Bengaluru.
  let t0 = Date.now();
  let lat = 12.9716;
  let lng = 77.5946;
  const postPing = async () => {
    const start = Date.now();
    const res = await jfetch(`/api/trips/${tripId}/pings`, {
      method: "POST",
      headers: auth,
      body: {
        idempotencyKey: crypto.randomUUID(),
        lat,
        lng,
        speedKmh: 30 + ((Date.now() / 1000) % 30),
        headingDeg: 90,
        accuracyM: 5,
        recordedAt: new Date().toISOString(),
      },
    });
    lat += 0.00005;
    lng += 0.00005;
    return { status: res.status, ms: Date.now() - start };
  };

  const total = DURATION_SECONDS * PINGS_PER_SECOND;
  console.log(
    `LOAD TEST: ping ingestion → ${BASE}  (${DURATION_SECONDS}s @ ${PINGS_PER_SECOND} pings/s = ${total} pings, trip #${tripId})`,
  );
  const latencies = [];
  let sent = 0;
  let ok = 0;
  let failed = 0;

  for (let sec = 0; sec < DURATION_SECONDS; sec++) {
    const batchStart = Date.now();
    const batch = Array.from({ length: PINGS_PER_SECOND }, () => postPing());
    const results = await Promise.allSettled(batch);
    for (const r of results) {
      sent += 1;
      if (r.status === "fulfilled" && r.value.status >= 200 && r.value.status < 300) {
        ok += 1;
        latencies.push(r.value.ms);
      } else {
        failed += 1;
        failures += 1;
      }
    }
    // Keep the batch cadence aligned to wall-clock seconds.
    const drift = Date.now() - batchStart;
    if (drift < 1000) await new Promise((r) => setTimeout(r, 1000 - drift));
  }

  const sorted = [...latencies].sort((a, b) => a - b);
  const durSec = (Date.now() - t0) / 1000;
  console.log(`  sent ${sent} | ok ${ok} | failed ${failed} | throughput ${(sent / durSec).toFixed(1)} pings/s`);
  if (sorted.length) {
    console.log(
      `  latency ms: p50=${pct(sorted, 50).toFixed(1)} p95=${pct(sorted, 95).toFixed(1)} p99=${pct(sorted, 99).toFixed(1)} max=${sorted[sorted.length - 1].toFixed(1)}`,
    );
  }

  const health = await jfetch("/api/health");
  console.log(`  server health after: ${JSON.stringify(health.json)}`);
  if (health.json?.ok !== true) failures += 1;

  console.log(failures === 0 ? "LOAD TEST PASSED ✅" : `LOAD TEST FAILED (${failures} problems) ❌`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("load test crashed:", err);
  process.exit(1);
});

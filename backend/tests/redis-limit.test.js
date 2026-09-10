/**
 * Phase 4 — Redis-backed rate-limit SHARING across API instances (blueprint
 * done-condition). Two in-process "instances" (separate Express apps) share one
 * Redis, so a burst on instance A must also register on instance B. If the limit
 * were per-instance (the Phase 0 in-memory map), B would have its own fresh
 * bucket and none of B's requests would 429 after only 8 hits on A.
 */
import { describe, it, before } from "node:test";
import request from "supertest";
import { createApp } from "../src/app.js";
import { clearRateLimitKeys } from "../src/lib/redis.js";
import { expect } from "./expectShim.js";

before(async () => {
  await clearRateLimitKeys();
});

describe("Redis rate limit shared across instances (Phase 4)", () => {
  it("two app instances share one bucket (not per-instance)", async () => {
    const appA = createApp();
    const appB = createApp();
    const hit = (app, i) =>
      request(app)
        .post("/api/auth/login")
        .send({ email: `u${i}@t.test`, password: "wrong" });

    // Burn 8 of the login limit (max=10) against instance A.
    for (let i = 0; i < 8; i++) {
      const r = await hit(appA, i);
      const valid = r.status === 401 || r.status === 429; // 401 = allowed-but-bad-creds, 429 = limited
      expect(valid).toBe(true);
    }

    // Instance B must quickly observe the shared limit (its FIRST hits after the
    // combined 8 already used).
    let bLimited = 0;
    for (let i = 0; i < 8; i++) {
      const r = await hit(appB, 100 + i);
      if (r.status === 429) bLimited++;
    }
    // A alone only used 8 (under the 10 limit), so B reaching 429 proves the
    // bucket is SHARED (per-instance would give B a fresh 10 and zero 429s).
    expect(bLimited).toBeGreaterThan(0);
    expect(bLimited).toBeLessThan(8); // but the loop didn't fully empty B; at least 2 allowed
  });
});

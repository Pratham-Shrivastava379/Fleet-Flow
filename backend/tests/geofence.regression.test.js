/**
 * Phase 1 regression test (blueprint done-condition):
 * PostGIS ST_DWithin/ST_Distance must give the same containment result as the
 * old in-process haversine math for a fixed fixture set, before the old code
 * is deleted. Haversine is intentionally reimplemented here as the reference.
 */
import { describe, it, before, after } from "node:test";
import { expect } from "./expectShim.js";
import { prisma } from "../src/prisma.js";
import { checkGeofences } from "../src/services/geofenceService.js";

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Fixed fixtures: fences in Bengaluru + a global spread, points near/far/at boundary.
const FENCES = [
  { name: "Depot Whitefield", centerLat: 12.9698, centerLng: 77.7499, radiusM: 500 },
  { name: "Hub Delhi", centerLat: 28.6139, centerLng: 77.209, radiusM: 2000 },
  { name: "Tiny Fence", centerLat: 0.0001, centerLng: 0.0001, radiusM: 50 },
  { name: "Huge Fence", centerLat: -33.8688, centerLng: 151.2093, radiusM: 50_000 },
];
const POINTS = [
  [12.9698, 77.7499], // fence center
  [12.9716, 77.5946], // far away
  [12.9706, 77.7507], // near boundary (~120m)
  [28.6145, 77.2105], // inside Delhi hub
  [0.0, 0.0], // just outside tiny fence (~15m from center at 0.0001,0.0001... ~ ~14m inside)
  [-33.8688, 151.2093], // inside huge fence center
  [-34.0, 151.0], // near huge fence edge
  [55.0, 37.0], // nowhere near anything
];

before(async () => {
  await prisma.geofence.deleteMany();
  for (const f of FENCES) await prisma.geofence.create({ data: f });
});

after(async () => {
  await prisma.geofence.deleteMany();
});

describe("geofence PostGIS vs haversine regression", () => {
  it("produces identical inside/outside decisions for all fixture combos", async () => {
    for (const [lat, lng] of POINTS) {
      const results = await checkGeofences(lat, lng);
      expect(results.length).toBe(FENCES.length);
      for (const r of results) {
        const fence = FENCES.find((f) => f.name === r.name);
        const ref = haversineMeters(lat, lng, fence.centerLat, fence.centerLng) <= fence.radiusM;
        expect(r.inside).toBe(ref);
      }
    }
  });

  it("distance agrees with haversine within tolerance (5m absolute OR 0.5% relative)", async () => {
    // PostGIS uses the WGS84 geodesic; haversine used a sphere (R=6371000).
    // Measured deviation on the fixture set: <=0.43% at realistic ranges,
    // up to ~1.7% on a 16m distance (rounding at tiny ranges) — hence the
    // small absolute allowance alongside the relative one.
    for (const [lat, lng] of POINTS) {
      const results = await checkGeofences(lat, lng);
      for (const r of results) {
        const fence = FENCES.find((f) => f.name === r.name);
        const ref = haversineMeters(lat, lng, fence.centerLat, fence.centerLng);
        const diff = Math.abs(r.distanceM - ref);
        const pass = diff <= 5 || diff / Math.max(ref, 1) < 0.005;
        expect(pass).toBe(true);
      }
    }
  });
});

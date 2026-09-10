import { describe, it, expect } from "vitest";
import { reduce } from "../hooks/useLiveFleet";
import type { FleetEvent } from "../ws/fleetSocket";

function seed(): Map<
  number,
  Parameters<typeof reduce>[0] extends Map<number, infer V> ? V : never
> {
  const m = new Map();
  m.set(2, {
    vehicleId: 2,
    tripId: 7,
    plate: "KA-01-AB-1234",
    driverName: "Dan",
    lat: 12.9,
    lng: 77.5,
    speedKmh: 30,
    recordedAt: "2026-09-03T09:59:00.000Z",
    live: false,
  });
  return m;
}

describe("useLiveFleet reducer", () => {
  it("location moves the marker in place and preserves labels", () => {
    const m = seed();
    const ev: FleetEvent = {
      kind: "location",
      tripId: 7,
      vehicleId: 2,
      driverId: 3,
      lat: 12.95,
      lng: 77.6,
      speedKmh: 55,
      recordedAt: "2026-09-03T10:00:30.000Z",
    };
    const out = reduce(m, ev)!;
    const v = out.get(2)!;
    expect(v.lat).toBe(12.95);
    expect(v.speedKmh).toBe(55);
    expect(v.plate).toBe("KA-01-AB-1234"); // label preserved
    expect(v.live).toBe(true);
    expect(out.size).toBe(1);
  });

  it("location creates a marker for a previously unseen vehicle", () => {
    const m = seed();
    const out = reduce(m, {
      kind: "location",
      tripId: 8,
      vehicleId: 5,
      driverId: 9,
      lat: 13.1,
      lng: 77.7,
      speedKmh: 0,
      recordedAt: "2026-09-03T10:01:00.000Z",
    })!;
    expect(out.size).toBe(2);
    expect(out.get(5)!.plate).toBe("#5");
  });

  it("trip_finished removes the vehicle marker", () => {
    const m = seed();
    const out = reduce(m, { kind: "trip_finished", tripId: 7, vehicleId: 2 })!;
    expect(out.size).toBe(0);
  });

  it("returns null for events the call site handles via refetch", () => {
    const m = seed();
    expect(
      reduce(m, {
        kind: "location_batch",
        tripId: 7,
        vehicleId: 2,
        driverId: 3,
        count: 12,
        firstRecordedAt: "a",
        lastRecordedAt: "b",
      }),
    ).toBeNull();
    expect(
      reduce(m, { kind: "trip_started", tripId: 9, vehicleId: 4 }),
    ).toBeNull();
    expect(
      reduce(m, {
        kind: "alert",
        alertId: 1,
        tripId: null,
        type: "SOS",
        status: "OPEN",
      }),
    ).toBeNull();
  });
});

import { describe, it, expect } from "vitest";
import { toFleetEvent } from "../ws/fleetSocket";

describe("toFleetEvent (server message normalization)", () => {
  it("maps a location broadcast (payload-wrapped) with numeric coercion", () => {
    const ev = toFleetEvent({
      type: "location",
      payload: {
        tripId: 7,
        vehicleId: 3,
        driverId: 11,
        lat: 12.9716,
        lng: 77.5946,
        speedKmh: 42.5,
        recordedAt: "2026-09-03T10:00:00.000Z",
      },
      ts: "2026-09-03T10:00:01.000Z",
    });
    expect(ev).toEqual({
      kind: "location",
      tripId: 7,
      vehicleId: 3,
      driverId: 11,
      lat: 12.9716,
      lng: 77.5946,
      speedKmh: 42.5,
      recordedAt: "2026-09-03T10:00:00.000Z",
    });
  });

  it("maps location_batch (counts only — no coordinates by design)", () => {
    const ev = toFleetEvent({
      type: "location_batch",
      payload: {
        tripId: 7,
        vehicleId: 3,
        driverId: 11,
        count: 25,
        firstRecordedAt: "a",
        lastRecordedAt: "b",
      },
    });
    expect(ev?.kind).toBe("location_batch");
    if (ev?.kind === "location_batch") {
      expect(ev.count).toBe(25);
      expect("lat" in ev).toBe(false);
    }
  });

  it("maps trip_started / trip_finished from the embedded trip object", () => {
    const trip = { id: 9, vehicle: { id: 4 } };
    expect(toFleetEvent({ type: "trip_started", trip })).toEqual({
      kind: "trip_started",
      tripId: 9,
      vehicleId: 4,
    });
    expect(toFleetEvent({ type: "trip_finished", trip })).toEqual({
      kind: "trip_finished",
      tripId: 9,
      vehicleId: 4,
    });
  });

  it("maps alert payloads and returns null for control frames", () => {
    expect(
      toFleetEvent({
        type: "alert",
        payload: { id: 5, tripId: 9, type: "SOS", status: "OPEN" },
      }),
    ).toEqual({
      kind: "alert",
      alertId: 5,
      tripId: 9,
      type: "SOS",
      status: "OPEN",
    });
    expect(
      toFleetEvent({
        type: "auth_ok",
        role: "FLEET_MANAGER",
        topics: ["fleet:all"],
      }),
    ).toBeNull();
    expect(toFleetEvent({ type: "hello", requiresAuth: true })).toBeNull();
  });
});

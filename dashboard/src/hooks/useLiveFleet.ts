import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as api from "../api/api";
import {
  createFleetSocket,
  type FleetEvent,
  type SocketStatus,
} from "../ws/fleetSocket";

/** A live vehicle position on the fleet map. */
export interface LiveVehicle {
  vehicleId: number;
  tripId: number;
  plate: string;
  driverName: string;
  lat: number;
  lng: number;
  speedKmh: number;
  /** ISO timestamp of the position (ping time or FleetLastPosition update). */
  recordedAt: string;
  /** True when the position came from the WS (vs the initial REST paint). */
  live: boolean;
}

/** Pure reducer for live updates over the vehicle map (exported for tests).
 *  Returns a NEW map when something changed, or null when the call site should
 *  handle the event (refetch) instead. */
export function reduce(
  map: Map<number, LiveVehicle>,
  event: FleetEvent,
): Map<number, LiveVehicle> | null {
  switch (event.kind) {
    case "location": {
      const prev = map.get(event.vehicleId);
      map.set(event.vehicleId, {
        vehicleId: event.vehicleId,
        tripId: event.tripId,
        plate: prev?.plate ?? `#${event.vehicleId}`,
        driverName: prev?.driverName ?? "",
        lat: event.lat,
        lng: event.lng,
        speedKmh: event.speedKmh,
        recordedAt: event.recordedAt,
        live: true,
      });
      return map;
    }
    case "trip_finished": {
      // All trips of this vehicle are done — drop it from the live view.
      if (map.delete(event.vehicleId)) return map;
      return null;
    }
    case "trip_started":
    case "location_batch":
    case "alert":
      return null; // handled by refetch at the call site
  }
}

export interface LiveFleetState {
  vehicles: LiveVehicle[];
  status: SocketStatus;
  loading: boolean;
  error: Error | null;
  lastEventAt: string | null;
  /** bump counter incremented on batch/trip events that trigger a refetch */
  refreshes: number;
}

/**
 * Live fleet state = initial paint from `GET /api/trips?status=ACTIVE`
 * (vehicles incl. fleetLastPosition, §15.11) merged with WS events:
 *  - `location`        → move the marker in place (near-real-time)
 *  - `location_batch`  → refetch (payload has counts, not coordinates)
 *  - `trip_finished`   → remove the vehicle's marker
 *  - `trip_started`    → refetch (new active trip/vehicle appears)
 */
export function useLiveFleet(): LiveFleetState {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<SocketStatus>("connecting");
  const [lastEventAt, setLastEventAt] = useState<string | null>(null);
  const [refreshes, setRefreshes] = useState(0);
  const vehiclesRef = useRef(new Map<number, LiveVehicle>());
  const [, forceRender] = useState(0);

  const tripsQuery = useQuery({
    queryKey: ["activeTrips"],
    queryFn: () => api.activeTrips(),
    staleTime: 15_000,
    refetchInterval: 60_000, // safety net; WS is the primary update path
  });

  // Seed the live map from the REST snapshot (initial paint).
  const seeded = useRef(false);
  if (tripsQuery.data && !seeded.current) {
    seeded.current = true;
    for (const t of tripsQuery.data) {
      const flp = t.vehicle?.fleetLastPosition;
      if (!t.vehicle || !flp) continue;
      vehiclesRef.current.set(t.vehicle.id, {
        vehicleId: t.vehicle.id,
        tripId: t.id,
        plate: t.vehicle.plate,
        driverName: t.driver?.name ?? "",
        lat: flp.lat,
        lng: flp.lng,
        speedKmh: flp.speedKmh,
        recordedAt: flp.updatedAt ?? flp.recordedAt,
        live: false,
      });
    }
  }

  const refetchTrips = useMemo(
    () => () => {
      void queryClient.invalidateQueries({ queryKey: ["activeTrips"] });
      setRefreshes((n) => n + 1);
    },
    [queryClient],
  );

  useEffect(() => {
    // Same-origin path — Vite proxies /ws (with ws:true) to the backend.
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const url = `${proto}://${window.location.host}/ws`;

    const handle = createFleetSocket({
      url,
      onStatus: setStatus,
      onEvent: (event) => {
        setLastEventAt(new Date().toISOString());
        if (event.kind === "location_batch" || event.kind === "trip_started") {
          refetchTrips();
          return;
        }
        const next = reduce(vehiclesRef.current, event);
        if (next) forceRender((n) => n + 1);
      },
    });
    return () => handle.close();
  }, [refetchTrips]);

  // Keep plate/driver labels fresh if the REST snapshot improved them.
  if (tripsQuery.data) {
    for (const t of tripsQuery.data) {
      const v = vehiclesRef.current.get(t.vehicle?.id ?? -1);
      if (v && t.vehicle) {
        v.plate = t.vehicle.plate;
        v.driverName = t.driver?.name ?? v.driverName;
      }
    }
  }

  return {
    vehicles: [...vehiclesRef.current.values()],
    status,
    loading: tripsQuery.isLoading,
    error: tripsQuery.error as Error | null,
    lastEventAt,
    refreshes,
  };
}

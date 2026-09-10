import { getAccessToken } from "../api/tokenStore";
import { tryRefresh } from "../api/httpClient";

// ---- Server → client events (backend/src/websocket.js + services) ----

export interface LocationEvent {
  kind: "location";
  tripId: number;
  vehicleId: number;
  driverId: number;
  lat: number;
  lng: number;
  speedKmh: number;
  recordedAt: string;
}

/** Phase 10 batch-sync fan-out: counts only (no coordinates) — REST stays the
 *  source of truth, so the UI refetches trips on this event. */
export interface LocationBatchEvent {
  kind: "location_batch";
  tripId: number;
  vehicleId: number;
  driverId: number;
  count: number;
  firstRecordedAt: string;
  lastRecordedAt: string;
}

export interface TripStartedEvent {
  kind: "trip_started";
  tripId: number;
  vehicleId: number;
}

export interface TripFinishedEvent {
  kind: "trip_finished";
  tripId: number;
  vehicleId: number;
}

export interface AlertEvent {
  kind: "alert";
  alertId: number;
  tripId: number | null;
  type: string;
  status: string;
}

export type FleetEvent =
  | LocationEvent
  | LocationBatchEvent
  | TripStartedEvent
  | TripFinishedEvent
  | AlertEvent;

export type SocketStatus = "connecting" | "live" | "reconnecting" | "closed";

export interface FleetSocketHandle {
  close(): void;
}

interface RawServerMessage {
  type: string;
  [k: string]: unknown;
}

/** Normalize a raw broadcast (payload wrapped or flat) into a FleetEvent. */
export function toFleetEvent(raw: RawServerMessage): FleetEvent | null {
  const p = (raw.payload ?? raw) as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === "number" ? v : Number(v));
  switch (raw.type) {
    case "location":
      return {
        kind: "location",
        tripId: num(p.tripId),
        vehicleId: num(p.vehicleId),
        driverId: num(p.driverId),
        lat: num(p.lat),
        lng: num(p.lng),
        speedKmh: num(p.speedKmh),
        recordedAt: String(p.recordedAt ?? ""),
      };
    case "location_batch":
      return {
        kind: "location_batch",
        tripId: num(p.tripId),
        vehicleId: num(p.vehicleId),
        driverId: num(p.driverId),
        count: num(p.count),
        firstRecordedAt: String(p.firstRecordedAt ?? ""),
        lastRecordedAt: String(p.lastRecordedAt ?? ""),
      };
    case "trip_started": {
      const trip = (raw.trip ?? {}) as Record<string, unknown>;
      const vehicle = (trip.vehicle ?? {}) as Record<string, unknown>;
      return {
        kind: "trip_started",
        tripId: num(trip.id ?? p.tripId),
        vehicleId: num(vehicle.id ?? p.vehicleId),
      };
    }
    case "trip_finished": {
      const trip = (raw.trip ?? {}) as Record<string, unknown>;
      const vehicle = (trip.vehicle ?? {}) as Record<string, unknown>;
      return {
        kind: "trip_finished",
        tripId: num(trip.id ?? p.tripId),
        vehicleId: num(vehicle.id ?? p.vehicleId),
      };
    }
    case "alert": {
      const a = (raw.payload ?? {}) as Record<string, unknown>;
      return {
        kind: "alert",
        alertId: num(a.id),
        tripId: a.tripId == null ? 0 : num(a.tripId),
        type: String(a.type ?? "ALERT"),
        status: String(a.status ?? "OPEN"),
      };
    }
    default:
      return null;
  }
}
export interface FleetSocketOptions {
  /** e.g. "wss://host/ws"; the socket path of the backend (§4.3). */
  url: string;
  onEvent: (event: FleetEvent) => void;
  onStatus?: (status: SocketStatus) => void;
  /** Injectable WebSocket constructor (tests / different runtimes). */
  WebSocketImpl?: typeof WebSocket;
  /** Injectable refresh (defaults to the HTTP cookie refresh). */
  refreshToken?: () => Promise<boolean>;
}

/**
 * Live fleet socket for the dashboard.
 *
 * Protocol (backend/src/websocket.js): on open, send {type:"auth", token} with
 * the in-memory access token; on `auth_failed` (e.g. token expired after a
 * reconnect) refresh the access token via the HttpOnly cookie once and
 * re-authenticate. Managers are auto-subscribed to `fleet:all` server-side
 * (role-based defaults), so no extra subscribe frame is needed.
 *
 * Reconnects with capped exponential backoff + jitter (§4.3 reliability).
 */
export function createFleetSocket(
  options: FleetSocketOptions,
): FleetSocketHandle {
  const WS = options.WebSocketImpl ?? WebSocket;
  const refresh = options.refreshToken ?? tryRefresh;
  let closedByUser = false;
  let attempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let socket: WebSocket | null = null;

  const setStatus = (s: SocketStatus) => options.onStatus?.(s);

  function sendAuth(ws: WebSocket, token: string) {
    ws.send(JSON.stringify({ type: "auth", token }));
  }

  async function handleAuthFailed(ws: WebSocket): Promise<void> {
    // One silent refresh attempt (HttpOnly cookie), then re-auth.
    const ok = await refresh();
    if (ok) {
      const token = getAccessToken();
      if (token) sendAuth(ws, token);
    }
  }

  function connect(): void {
    if (closedByUser) return;
    setStatus(attempt === 0 ? "connecting" : "reconnecting");
    const ws = new WS(options.url);
    socket = ws;

    ws.onopen = () => {
      const token = getAccessToken();
      if (token) sendAuth(ws, token);
    };

    ws.onmessage = (ev: MessageEvent) => {
      let raw: RawServerMessage;
      try {
        raw = JSON.parse(String(ev.data)) as RawServerMessage;
      } catch {
        return;
      }
      if (raw.type === "auth_ok") {
        attempt = 0;
        setStatus("live");
        return;
      }
      if (raw.type === "auth_failed") {
        void handleAuthFailed(ws);
        return;
      }
      const event = toFleetEvent(raw);
      if (event) options.onEvent(event);
    };

    ws.onclose = () => {
      socket = null;
      if (closedByUser) {
        setStatus("closed");
        return;
      }
      setStatus("reconnecting");
      // capped exponential backoff: min(10s, 1s * 2^attempt) ± 20% jitter
      const delay = Math.min(10_000, 1000 * 2 ** attempt);
      const jitter = delay * 0.2 * (Math.random() * 2 - 1);
      attempt += 1;
      retryTimer = setTimeout(connect, Math.max(250, delay + jitter));
    };

    ws.onerror = () => {
      /* onclose follows; reconnection handled there */
    };
  }

  connect();

  return {
    close() {
      closedByUser = true;
      if (retryTimer) clearTimeout(retryTimer);
      socket?.close();
      setStatus("closed");
    },
  };
}

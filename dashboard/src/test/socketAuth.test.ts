import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createFleetSocket, type FleetEvent } from "../ws/fleetSocket";
import { setAccessToken, clearAccessToken } from "../api/tokenStore";

/** Minimal WebSocket double that records sent frames and lets tests play
 *  server frames. Mirrors the browser API surface the client uses. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  url: string;
  readyState = 1; // OPEN
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  // test helpers
  open() {
    this.onopen?.();
  }
  serverSend(obj: unknown) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
  lastFrame(): Record<string, unknown> {
    return JSON.parse(this.sent[this.sent.length - 1]);
  }
}

function lastSocket(): FakeWebSocket {
  return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
}

describe("createFleetSocket", () => {
  let events: FleetEvent[];
  let statuses: string[];

  beforeEach(() => {
    FakeWebSocket.instances = [];
    events = [];
    statuses = [];
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeSocket(refreshImpl: () => Promise<boolean>) {
    return createFleetSocket({
      url: "ws://test/ws",
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      refreshToken: refreshImpl,
      onEvent: (e) => events.push(e),
      onStatus: (s) => statuses.push(s),
    });
  }

  it("authenticates with the in-memory token on open and goes live on auth_ok", () => {
    setAccessToken("tok-1");
    const handle = makeSocket(async () => false);
    const ws = lastSocket();
    expect(ws.url).toBe("ws://test/ws");

    ws.open();
    expect(ws.lastFrame()).toEqual({ type: "auth", token: "tok-1" });

    ws.serverSend({
      type: "auth_ok",
      role: "FLEET_MANAGER",
      topics: ["fleet:all"],
    });
    expect(statuses).toContain("live");
    handle.close();
    clearAccessToken();
  });

  it("on auth_failed refreshes via cookie once and re-authenticates with the new token", async () => {
    setAccessToken("expired-tok");
    let refreshCalls = 0;
    const handle = makeSocket(async () => {
      refreshCalls += 1;
      setAccessToken("fresh-tok");
      return true;
    });
    const ws = lastSocket();
    ws.open();
    ws.serverSend({ type: "auth_failed" });
    // refresh is async — flush the microtask queue
    await vi.advanceTimersByTimeAsync(0);

    expect(refreshCalls).toBe(1);
    expect(ws.lastFrame()).toEqual({ type: "auth", token: "fresh-tok" });
    handle.close();
    clearAccessToken();
  });

  it("delivers location events to onEvent", async () => {
    setAccessToken("tok-1");
    const handle = makeSocket(async () => false);
    const ws = lastSocket();
    ws.open();
    ws.serverSend({
      type: "location",
      payload: {
        tripId: 1,
        vehicleId: 2,
        driverId: 3,
        lat: 12.9,
        lng: 77.5,
        speedKmh: 40,
        recordedAt: "2026-09-03T10:00:00.000Z",
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("location");
    if (events[0].kind === "location") {
      expect(events[0].vehicleId).toBe(2);
      expect(events[0].lat).toBe(12.9);
    }
    handle.close();
    clearAccessToken();
  });

  it("reconnects with backoff after an abnormal close and recovers", async () => {
    setAccessToken("tok-1");
    const handle = makeSocket(async () => false);
    const first = lastSocket();
    first.open();
    first.serverSend({ type: "auth_ok" });
    expect(statuses).toContain("live");

    // server drops the connection
    first.readyState = 3;
    first.onclose?.();
    expect(statuses).toContain("reconnecting");

    // backoff (1s first retry) — advance past it
    await vi.advanceTimersByTimeAsync(1500);
    const second = lastSocket();
    expect(second).not.toBe(first);
    expect(second.url).toBe("ws://test/ws");

    second.open();
    expect(second.lastFrame()).toEqual({ type: "auth", token: "tok-1" });
    second.serverSend({ type: "auth_ok" });
    expect(statuses.filter((s) => s === "live")).toHaveLength(2);

    handle.close();
    expect(statuses).toContain("closed");
    clearAccessToken();
  });

  it("does not reconnect after an explicit close", async () => {
    setAccessToken("tok-1");
    const handle = makeSocket(async () => false);
    handle.close();
    const count = FakeWebSocket.instances.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(FakeWebSocket.instances.length).toBe(count);
    clearAccessToken();
  });
});

import { Redis } from "ioredis";
import config from "../config.js";
import { redis } from "./redis.js";
import { getContextLogger } from "./logger.js";

const log = getContextLogger({ module: "fleet:events" });

/**
 * Cross-process fleet-event fan-out (blueprint ADR-3, minimal Phase-5 version).
 *
 * Background workers (e.g. geofence-eval) run in a separate process from the
 * API, so they have no WebSocket clients of their own. Workers publish domain
 * events to the `fleet:events` Redis pub/sub channel; every API process
 * subscribes on WS init and re-broadcasts to its locally-connected clients.
 *
 * Reliability model (unchanged): REST is the source of truth. Redis pub/sub
 * has no delivery guarantee — a missed WS event is a missed *live update*,
 * never lost data. Publishes are therefore fail-open (§14.3).
 *
 * Phase 6: ALL WS fan-out goes through this channel (blueprint §4.3/§15.6).
 * Services publish `{ type, payload, topics }`; every API process subscribes
 * once and delivers each event only to locally-connected sockets whose
 * subscriptions intersect `event.topics`. The publisher itself also receives
 * its own event back over Redis and delivers locally — so delivery behavior is
 * identical whether the event originated in this process, another API
 * instance, or a background worker.
 */
export const FLEET_EVENTS_CHANNEL = "fleet:events";

/**
 * Topic set for events tied to a driver/vehicle (location, location_batch,
 * alert, alert_updated, geofence_event). `fleet:all` is always included; the
 * specific driver/vehicle topics are omitted when not applicable (null ids).
 */
export function fleetEventTopics({ driverId = null, vehicleId = null } = {}) {
  const topics = ["fleet:all"];
  if (driverId != null) topics.push(`driver:${driverId}`);
  if (vehicleId != null) topics.push(`vehicle:${vehicleId}`);
  return topics;
}

/** Publish a fleet event for cross-process fan-out. Never throws. */
export async function publishFleetEvent(event) {
  try {
    await redis.publish(FLEET_EVENTS_CHANNEL, JSON.stringify(event));
  } catch (err) {
    log.error({ err: err?.message }, "publish failed (best-effort)");
  }
}

let subscriber = null;
const handlers = new Set();

/**
 * Subscribe this process to fleet events (called once per WS instance by
 * initWebSocket; multiple in-process instances each register a handler).
 * Uses a DEDICATED connection: a Redis client in subscriber mode cannot serve
 * other commands, and the shared client backs the rate limiter + BullMQ.
 * Returns an unsubscribe function.
 */
export function subscribeFleetEvents(handler) {
  handlers.add(handler);
  if (!subscriber) {
    subscriber = new Redis(config.redisUrl, { maxRetriesPerRequest: null, lazyConnect: false });
    subscriber.on("error", (err) => log.error({ err: err?.message }, "subscriber error"));
    subscriber.on("message", (_channel, raw) => {
      let event;
      try {
        event = JSON.parse(raw);
      } catch (err) {
        log.warn({ err: err?.message }, "bad payload");
        return;
      }
      for (const h of handlers) {
        try {
          h(event);
        } catch (err) {
          log.error({ err: err?.message }, "handler error");
        }
      }
    });
    subscriber.subscribe(FLEET_EVENTS_CHANNEL).catch((err) => {
      log.error({ err: err?.message }, "subscribe failed");
    });
  }
  return () => {
    handlers.delete(handler);
  };
}

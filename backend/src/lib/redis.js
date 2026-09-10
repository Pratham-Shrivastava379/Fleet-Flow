import { Redis } from "ioredis";
import config from "../config.js";
import { getContextLogger } from "./logger.js";

const log = getContextLogger({ module: "redis" });

/**
 * Shared Redis client (Phase 4). Backs the rate limiter (shared across API
 * instances), BullMQ job queues, and future pub/sub for the realtime gateway
 * (Phase 6). `maxRetriesPerRequest: null` is required by BullMQ; the rate
 * limiter handles transient failures itself (fail-open, see §14.3).
 */
export const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null, lazyConnect: false });

redis.on("error", (err) => {
  // Don't crash the process on transient Redis issues; subsystems log/fallback.
  log.error({ err: err.message }, "redis error");
});

/** Run a Lua script with the given keys/args via EVAL. */
export async function evalScript(script, keys, args) {
  return redis.eval(script, keys.length, ...keys, ...args);
}

/** Delete every key matching `prefix*` (used by tests for deterministic starts). */
export async function deleteKeysByPrefix(prefix) {
  let cursor = "0";
  do {
    const [next, keys] = await redis.scan(cursor, "MATCH", `${prefix}*`, "COUNT", 500);
    if (keys.length) await redis.del(...keys);
    cursor = next;
  } while (cursor !== "0");
}

export const RATE_LIMIT_KEY_PREFIX = "rl:";
export async function clearRateLimitKeys() {
  await deleteKeysByPrefix(RATE_LIMIT_KEY_PREFIX);
}

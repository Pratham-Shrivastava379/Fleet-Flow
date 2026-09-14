/**
 * Redis-backed sliding-window rate limiter (per IP + route bucket), replacing
 * the Phase 0 in-memory map so limits are SHARED across horizontally-scaled API
 * instances. Uses a Lua script (atomic) over a Redis
 * sorted set; the oldest timestamp stays warm for an accurate Retry-After.
 * On Redis failure the limiter FAILS OPEN with a logged warning (§14.3), so an
 * outage degrades to "no rate limiting" rather than "nobody can log in".
 */
import { evalScript } from "../lib/redis.js";
import { getContextLogger } from "../lib/logger.js";

// KEYS[1]=bucket key, ARGV[1]=windowMs, ARGV[2]=max, ARGV[3]=now
const SLIDING_WINDOW_LUA = `
local key = KEYS[1]
local windowMs = tonumber(ARGV[1])
local max = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - windowMs)
local count = redis.call('ZCARD', key)
if count >= max then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')[2]
  local retryAfter = math.ceil((tonumber(oldest) + windowMs - now) / 1000)
  return { 1, retryAfter }
end
redis.call('ZADD', key, now, now .. ':' .. tostring(redis.call('INCR', key .. ':seq')))
redis.call('EXPIRE', key, math.ceil(windowMs / 1000))
return { 0, count + 1 }
`;

export function rateLimit({ windowMs = 60_000, max = 100 } = {}) {
  return (req, res, next) => {
    const key = `rl:${req.ip}:${req.baseUrl || req.path}`;
    const now = Date.now();
    evalScript(SLIDING_WINDOW_LUA, [key], [String(windowMs), String(max), String(now)])
      .then(([blocked, retryAfterSec]) => {
        if (blocked === 1) {
          res.set("Retry-After", String(retryAfterSec));
          return res.status(429).json({ error: "Too many requests", retryAfterSec });
        }
        next();
      })
      .catch((err) => {
        getContextLogger({ module: "rate-limit" }).warn({ err: err.message }, "Redis unavailable — failing open");
        next();
      });
  };
}

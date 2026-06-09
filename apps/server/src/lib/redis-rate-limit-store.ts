// Redis-backed atomic token bucket.
//
// The Lua script is the source of truth for atomicity:
//   - read current (tokens, lastRefillMs)
//   - refill based on elapsed time and refill rate
//   - subtract cost iff sufficient
//   - write new (tokens, lastRefillMs) with TTL = full-refill time + slack
// The whole script runs as a single Redis command (EVAL), so concurrent
// callers cannot race.

import type { Redis } from 'ioredis';
import type { ConsumeOpts, ConsumeResult, RateLimitStore } from '../services/rate-limit.js';

const LUA = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_per_sec = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local now_ms = tonumber(ARGV[4])

local data = redis.call('HMGET', key, 'tokens', 'last_ms')
local tokens = tonumber(data[1])
local last_ms = tonumber(data[2])

-- Reset to a full bucket when EITHER field is missing. Normally both are
-- written together by the HMSET below (so a fresh key has both nil), but
-- guarding last_ms too makes the script fail SAFE on a partial/corrupt hash
-- (e.g. an external write or a truncated value): a nil last_ms would otherwise
-- make \`now_ms - last_ms\` an arithmetic error, EVAL-failing every request to
-- that key until its TTL self-heals. A limiter must never error a request open
-- or closed on a malformed key.
if tokens == nil or last_ms == nil then
  tokens = capacity
  last_ms = now_ms
end

local elapsed = math.max(0, (now_ms - last_ms) / 1000)
local refilled = math.min(capacity, tokens + elapsed * refill_per_sec)

if refilled >= cost then
  local remaining = refilled - cost
  redis.call('HMSET', key, 'tokens', remaining, 'last_ms', now_ms)
  -- TTL = (capacity / refill_rate) seconds + 60s slack
  local ttl = math.ceil(capacity / math.max(refill_per_sec, 0.0001)) + 60
  redis.call('EXPIRE', key, ttl)
  return {1, remaining, 0}
end

local deficit = cost - refilled
local retry_after_ms = math.ceil((deficit / math.max(refill_per_sec, 0.0001)) * 1000)
redis.call('HMSET', key, 'tokens', refilled, 'last_ms', now_ms)
local ttl = math.ceil(capacity / math.max(refill_per_sec, 0.0001)) + 60
redis.call('EXPIRE', key, ttl)
return {0, refilled, retry_after_ms}
`;

export class RedisRateLimitStore implements RateLimitStore {
  constructor(private readonly redis: Redis) {}

  async consume(opts: ConsumeOpts): Promise<ConsumeResult> {
    const result = (await this.redis.eval(
      LUA,
      1,
      opts.key,
      opts.capacity.toString(),
      opts.refillPerSecond.toString(),
      opts.cost.toString(),
      opts.now.toString(),
    )) as [number, number, number];

    const [allowedFlag, remaining, retryAfterMs] = result;
    return {
      allowed: allowedFlag === 1,
      remaining,
      retryAfterMs,
    };
  }
}

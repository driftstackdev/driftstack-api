// W393.A — drift guard for apps/server/src/lib/memory-rate-limit-store.ts
// + redis-rate-limit-store.ts.
//
// Two implementations of the RateLimitStore interface (defined in
// services/rate-limit.ts). The token-bucket algorithm is identical;
// what differs is atomicity:
//   • memory: in-process Map, NOT safe across multiple server
//     instances — test-only use.
//   • redis: Lua-script-EVAL atomic — single Redis command, no race.
// Drift between the two would silently change rate-limit accuracy
// when production switches from the test-only memory store to redis.
//
//   • memory store framing: "Used by tests; do NOT use in production".
//   • Token-bucket algorithm parity: elapsedSec → refill → cap at
//     capacity → if refilled >= cost { tokens -= cost; allowed: true }
//     else { ceil(deficit / rate * 1000) retryAfterMs; persist
//     refilled; allowed: false }.
//   • Redis Lua script: 4 args (capacity / refill_per_sec / cost /
//     now_ms), 1 KEY (the bucket key).
//   • Lua: HMGET (tokens, last_ms) — first-time defaults to capacity.
//   • Lua: TTL = ceil(capacity / max(refill_per_sec, 0.0001)) + 60s
//     slack, applied on every consume (allowed AND denied branches).
//   • Lua: math.max guard avoids divide-by-zero when refill_per_sec=0.
//   • Lua return: [allowedFlag (1|0), remaining, retryAfterMs].
//   • reset() method on memory store (clear Map) — tests call this
//     between scenarios.
//   • exact sliding-window parity: memory timestamp arrays + one-key Redis
//     sorted-set Lua; no capacity replenishes before an event leaves the window.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const MEM = resolve(REPO_ROOT, 'apps/server/src/lib/memory-rate-limit-store.ts');
const REDIS = resolve(REPO_ROOT, 'apps/server/src/lib/redis-rate-limit-store.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W393.A apps/server/src/lib/memory-rate-limit-store.ts content parity', () => {
  const body = read(MEM);

  it('"in-process token bucket, do NOT use in production" framing pinned', () => {
    expect(body).toMatch(
      /In-process token bucket store\. Used by tests; do NOT use in production\s*\/\/\s*\(no persistence, doesn't work across multiple server instances\)/,
    );
  });

  it('BucketState shape: tokens + lastRefillMs', () => {
    expect(body).toMatch(/interface BucketState \{\s*tokens: number;\s*lastRefillMs: number;\s*\}/);
  });

  it('MemoryRateLimitStore: implements RateLimitStore + private buckets Map', () => {
    expect(body).toMatch(/export class MemoryRateLimitStore implements RateLimitStore \{/);
    expect(body).toMatch(/private readonly buckets = new Map<string, BucketState>\(\);/);
    expect(body).toMatch(/private readonly slidingWindows = new Map<string, number\[]>\(\);/);
  });

  it('consume: existing-or-default {tokens=capacity, lastRefillMs=now} for first hit', () => {
    expect(body).toMatch(
      /const existing = this\.buckets\.get\(key\) \?\? \{ tokens: capacity, lastRefillMs: now \};/,
    );
  });

  it('refill formula: elapsedSec=max(0,(now-last)/1000) * refillPerSecond, then min(capacity, tokens+refill)', () => {
    expect(body).toMatch(
      /const elapsedSec = Math\.max\(0, \(now - existing\.lastRefillMs\) \/ 1000\);/,
    );
    expect(body).toMatch(/const refill = elapsedSec \* refillPerSecond;/);
    expect(body).toMatch(/const refilled = Math\.min\(capacity, existing\.tokens \+ refill\);/);
  });

  it('allowed branch: tokens -= cost, allowed=true, retryAfterMs=0', () => {
    expect(body).toMatch(
      /if \(refilled >= cost\) \{\s*const remaining = refilled - cost;\s*this\.buckets\.set\(key, \{ tokens: remaining, lastRefillMs: now \}\);\s*return Promise\.resolve\(\{ allowed: true, remaining, retryAfterMs: 0 \}\);\s*\}/,
    );
  });

  it('denied branch: ceil(deficit/refillPerSecond*1000), persist refilled (no consume)', () => {
    expect(body).toMatch(/const deficit = cost - refilled;/);
    expect(body).toMatch(
      /const retryAfterMs = Math\.ceil\(\(deficit \/ refillPerSecond\) \* 1000\);/,
    );
    expect(body).toMatch(
      /\/\/ Persist refilled tokens but don't consume\.\s*this\.buckets\.set\(key, \{ tokens: refilled, lastRefillMs: now \}\);\s*return Promise\.resolve\(\{ allowed: false, remaining: refilled, retryAfterMs \}\);/,
    );
  });

  it('consumeSlidingWindow retains only in-window timestamps, refuses at limit, and reports exact reset', () => {
    expect(body).toMatch(
      /async consumeSlidingWindow\(opts: SlidingWindowConsumeOpts\): Promise<SlidingWindowConsumeResult>/,
    );
    expect(body).toMatch(/\(acceptedAt\) => acceptedAt > cutoff/);
    expect(body).toMatch(/if \(retained\.length >= opts\.limit\) \{/);
    expect(body).toMatch(/retryAfterMs: Math\.max\(1, oldest \+ opts\.windowMs - opts\.now\)/);
    expect(body).toMatch(/remaining: opts\.limit - retained\.length/);
  });

  it('reset(): clears token buckets and exact-window history', () => {
    expect(body).toMatch(
      /reset\(\): void \{\s*this\.buckets\.clear\(\);\s*this\.slidingWindows\.clear\(\);\s*\}/,
    );
  });

  it('imports token-bucket and sliding-window contracts from services/rate-limit.js', () => {
    expect(body).toMatch(/ConsumeOpts,/);
    expect(body).toMatch(/ConsumeResult,/);
    expect(body).toMatch(/RateLimitStore,/);
    expect(body).toMatch(/SlidingWindowConsumeOpts,/);
    expect(body).toMatch(/SlidingWindowConsumeResult,/);
    expect(body).toMatch(/from '\.\.\/services\/rate-limit\.js';/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(MEM)).toBe(true);
  });
});

describe('W393.A apps/server/src/lib/redis-rate-limit-store.ts content parity', () => {
  const body = read(REDIS);

  it('Lua-script atomicity framing pinned (single EVAL command, no race)', () => {
    expect(body).toMatch(
      /The Lua script is the source of truth for atomicity:\s*\/\/\s*- read current \(tokens, lastRefillMs\)\s*\/\/\s*- refill based on elapsed time and refill rate\s*\/\/\s*- subtract cost iff sufficient\s*\/\/\s*- write new \(tokens, lastRefillMs\) with TTL = full-refill time \+ slack/,
    );
    expect(body).toMatch(
      /The whole script runs as a single Redis command \(EVAL\), so concurrent\s*\/\/\s*callers cannot race/,
    );
  });

  it('Lua script: HMGET (tokens, last_ms) — first-time defaults to capacity', () => {
    expect(body).toMatch(
      /local data = redis\.call\('HMGET', key, 'tokens', 'last_ms'\)\s*local tokens = tonumber\(data\[1\]\)\s*local last_ms = tonumber\(data\[2\]\)/,
    );
    expect(body).toMatch(
      /if tokens == nil or last_ms == nil then\s*tokens = capacity\s*last_ms = now_ms\s*end/,
    );
  });

  it('Lua refill formula matches memory store: elapsed=max(0,(now-last)/1000), refilled=min(capacity, tokens+elapsed*rate)', () => {
    expect(body).toMatch(/local elapsed = math\.max\(0, \(now_ms - last_ms\) \/ 1000\)/);
    expect(body).toMatch(
      /local refilled = math\.min\(capacity, tokens \+ elapsed \* refill_per_sec\)/,
    );
  });

  it('Lua TTL: ceil(capacity / max(refill_per_sec, 0.0001)) + 60s slack — applied on BOTH allowed AND denied branches', () => {
    expect(body).toMatch(/-- TTL = \(capacity \/ refill_rate\) seconds \+ 60s slack/);
    // Two TTL applications — one in allowed branch, one in denied — both
    // with the same formula. Use a single regex that matches the
    // expression literal; the source has it twice.
    const ttlMatches = body.match(
      /local ttl = math\.ceil\(capacity \/ math\.max\(refill_per_sec, 0\.0001\)\) \+ 60/g,
    );
    expect(ttlMatches?.length).toBe(2);
    const expireMatches = body.match(/redis\.call\('EXPIRE', key, ttl\)/g);
    expect(expireMatches?.length).toBe(2);
  });

  it('Lua allowed branch: HMSET (tokens=remaining, last_ms=now_ms), return {1, remaining, 0}', () => {
    expect(body).toMatch(
      /if refilled >= cost then\s*local remaining = refilled - cost\s*redis\.call\('HMSET', key, 'tokens', remaining, 'last_ms', now_ms\)/,
    );
    expect(body).toMatch(/return \{1, remaining, 0\}/);
  });

  it('Lua denied branch: ceil(deficit/max(rate,0.0001)*1000), HMSET refilled (not consumed), return {0, refilled, retry_after_ms}', () => {
    expect(body).toMatch(/local deficit = cost - refilled/);
    expect(body).toMatch(
      /local retry_after_ms = math\.ceil\(\(deficit \/ math\.max\(refill_per_sec, 0\.0001\)\) \* 1000\)/,
    );
    expect(body).toMatch(/redis\.call\('HMSET', key, 'tokens', refilled, 'last_ms', now_ms\)/);
    expect(body).toMatch(/return \{0, refilled, retry_after_ms\}/);
  });

  it('RedisRateLimitStore: implements RateLimitStore + constructor stores readonly redis', () => {
    expect(body).toMatch(/export class RedisRateLimitStore implements RateLimitStore \{/);
    expect(body).toMatch(/constructor\(private readonly redis: Redis\) \{\}/);
  });

  it('exact sliding-window Lua atomically prunes/counts/adds one-key ZSET members and preserves same-ms uniqueness', () => {
    expect(body).toMatch(/import \{ randomUUID \} from 'node:crypto';/);
    expect(body).toMatch(/const SLIDING_WINDOW_LUA = `/);
    expect(body).toMatch(/redis\.call\('ZREMRANGEBYSCORE', key, '-inf', cutoff\)/);
    expect(body).toMatch(/local count = redis\.call\('ZCARD', key\)/);
    expect(body).toMatch(/if count >= limit then/);
    expect(body).toMatch(/redis\.call\('ZADD', key, now_ms, member\)/);
    expect(body).toMatch(/redis\.call\('PEXPIRE', key, ttl_ms\)/);
    expect(body).toMatch(/randomUUID\(\),/);
    expect(body).toMatch(/\)\) as \[number, number, number, number\];/);
  });

  it('consume: redis.eval(LUA, 1, key, capacity, refillPerSecond, cost, now) — 1 KEY + 4 ARGV', () => {
    expect(body).toMatch(
      /const result = \(await this\.redis\.eval\(\s*LUA,\s*1,\s*opts\.key,\s*opts\.capacity\.toString\(\),\s*opts\.refillPerSecond\.toString\(\),\s*opts\.cost\.toString\(\),\s*opts\.now\.toString\(\),\s*\)\) as \[number, number, number\];/,
    );
  });

  it('consume return shape: {allowed: flag===1, remaining, retryAfterMs}', () => {
    expect(body).toMatch(
      /const \[allowedFlag, remaining, retryAfterMs\] = result;\s*return \{\s*allowed: allowedFlag === 1,\s*remaining,\s*retryAfterMs,\s*\};/,
    );
  });

  it('imports Redis plus token-bucket and sliding-window contracts', () => {
    expect(body).toMatch(/import type \{ Redis \} from 'ioredis';/);
    expect(body).toMatch(/SlidingWindowConsumeOpts,/);
    expect(body).toMatch(/SlidingWindowConsumeResult,/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(REDIS)).toBe(true);
  });
});

// W440.B — drift guard for apps/server/src/lib/redis-rate-limit-store.ts.
// Production Redis-backed atomic token bucket. Drift here either
// reads tokens outside the Lua atomicity envelope (concurrent
// callers race) or drops the divide-by-zero guard on refill_per_sec
// (one trial-pack-style fractional rate triggers a Lua arithmetic
// error and the bucket stops consuming).
//
//   • Lua atomicity framing pinned: read → refill → subtract iff
//     sufficient → write — whole script runs as single Redis EVAL
//     so concurrent callers cannot race.
//   • TTL = (capacity / refill_rate) seconds + 60s slack to clean
//     up idle keys.
//   • math.max(refill_per_sec, 0.0001) divide-by-zero guard (trial-
//     pack 1/60 fractional refill survives).
//   • Lua return: [allowedFlag, remaining, retryAfterMs] tuple.
//   • HMSET 'tokens' + 'last_ms' fields; EXPIRE on every call.
//   • EVAL with 1 key + 4 ARGV (capacity, refillPerSecond, cost, now).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/lib/redis-rate-limit-store.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W440.B apps/server/src/lib/redis-rate-limit-store.ts content parity', () => {
  const body = read(LIB);

  it('header framing pinned: Lua script is source of truth for atomicity — read current (tokens, lastRefillMs) → refill based on elapsed + refill rate → subtract cost iff sufficient → write new with TTL = full-refill time + slack; whole script runs as single Redis EVAL so concurrent callers cannot race', () => {
    expect(body).toMatch(/\/\/ Redis-backed atomic token bucket\./);
    expect(body).toMatch(
      /\/\/ The Lua script is the source of truth for atomicity:\s*\/\/\s*- read current \(tokens, lastRefillMs\)\s*\/\/\s*- refill based on elapsed time and refill rate\s*\/\/\s*- subtract cost iff sufficient\s*\/\/\s*- write new \(tokens, lastRefillMs\) with TTL = full-refill time \+ slack\s*\/\/ The whole script runs as a single Redis command \(EVAL\), so concurrent\s*\/\/ callers cannot race\./,
    );
  });

  it('imports: UUID members + Redis + token-bucket/exact-window contracts', () => {
    expect(body).toMatch(/import \{ randomUUID \} from 'node:crypto';/);
    expect(body).toMatch(/import type \{ Redis \} from 'ioredis';/);
    expect(body).toMatch(/SlidingWindowConsumeOpts,/);
    expect(body).toMatch(/SlidingWindowConsumeResult,/);
  });

  it('Lua KEYS[1] + ARGV[1..4] decode (capacity / refill_per_sec / cost / now_ms via tonumber)', () => {
    expect(body).toMatch(
      /local key = KEYS\[1\]\s*local capacity = tonumber\(ARGV\[1\]\)\s*local refill_per_sec = tonumber\(ARGV\[2\]\)\s*local cost = tonumber\(ARGV\[3\]\)\s*local now_ms = tonumber\(ARGV\[4\]\)/,
    );
  });

  it('Lua HMGET tokens + last_ms; first-touch initialize to capacity + now_ms when EITHER field nil (fail-safe on a partial/corrupt hash)', () => {
    expect(body).toMatch(
      /local data = redis\.call\('HMGET', key, 'tokens', 'last_ms'\)\s*local tokens = tonumber\(data\[1\]\)\s*local last_ms = tonumber\(data\[2\]\)[\s\S]*?if tokens == nil or last_ms == nil then\s*tokens = capacity\s*last_ms = now_ms\s*end/,
    );
  });

  it('Lua elapsed clamp via math.max(0, ...); refilled clamp via math.min(capacity, ...)', () => {
    expect(body).toMatch(
      /local elapsed = math\.max\(0, \(now_ms - last_ms\) \/ 1000\)\s*local refilled = math\.min\(capacity, tokens \+ elapsed \* refill_per_sec\)/,
    );
  });

  it('Lua sufficient branch: HMSET tokens=remaining + last_ms=now_ms; TTL = ceil(capacity / max(refill, 0.0001)) + 60s slack divide-by-zero guard; return {1, remaining, 0}', () => {
    expect(body).toMatch(
      /if refilled >= cost then\s*local remaining = refilled - cost\s*redis\.call\('HMSET', key, 'tokens', remaining, 'last_ms', now_ms\)\s*-- TTL = \(capacity \/ refill_rate\) seconds \+ 60s slack\s*local ttl = math\.ceil\(capacity \/ math\.max\(refill_per_sec, 0\.0001\)\) \+ 60\s*redis\.call\('EXPIRE', key, ttl\)\s*return \{1, remaining, 0\}\s*end/,
    );
  });

  it('Lua insufficient branch: retry_after_ms = ceil((deficit / max(refill,0.0001))*1000); HMSET partial refill + EXPIRE; return {0, refilled, retry_after_ms}', () => {
    expect(body).toMatch(
      /local deficit = cost - refilled\s*local retry_after_ms = math\.ceil\(\(deficit \/ math\.max\(refill_per_sec, 0\.0001\)\) \* 1000\)\s*redis\.call\('HMSET', key, 'tokens', refilled, 'last_ms', now_ms\)\s*local ttl = math\.ceil\(capacity \/ math\.max\(refill_per_sec, 0\.0001\)\) \+ 60\s*redis\.call\('EXPIRE', key, ttl\)\s*return \{0, refilled, retry_after_ms\}/,
    );
  });

  it('RedisRateLimitStore class: constructor(private readonly redis: Redis); consume() destructures [allowedFlag, remaining, retryAfterMs] = result; allowed: allowedFlag === 1', () => {
    expect(body).toMatch(
      /export class RedisRateLimitStore implements RateLimitStore \{\s*constructor\(private readonly redis: Redis\) \{\}/,
    );
    expect(body).toMatch(
      /const result = \(await this\.redis\.eval\(\s*LUA,\s*1,\s*opts\.key,\s*opts\.capacity\.toString\(\),\s*opts\.refillPerSecond\.toString\(\),\s*opts\.cost\.toString\(\),\s*opts\.now\.toString\(\),\s*\)\) as \[number, number, number\];/,
    );
    expect(body).toMatch(
      /const \[allowedFlag, remaining, retryAfterMs\] = result;\s*return \{\s*allowed: allowedFlag === 1,\s*remaining,\s*retryAfterMs,\s*\};/,
    );
  });

  it('consumeSlidingWindow is one atomic, one-key ZSET EVAL with a unique same-ms member', () => {
    expect(body).toMatch(/const SLIDING_WINDOW_LUA = `/);
    expect(body).toMatch(/redis\.call\('ZREMRANGEBYSCORE', key, '-inf', cutoff\)/);
    expect(body).toMatch(/local count = redis\.call\('ZCARD', key\)/);
    expect(body).toMatch(/if count >= limit then/);
    expect(body).toMatch(/redis\.call\('ZADD', key, now_ms, member\)/);
    expect(body).toMatch(/randomUUID\(\),/);
    expect(body).toMatch(/const \[allowedFlag, remaining, retryAfterMs, resetAtMs\] = result;/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});

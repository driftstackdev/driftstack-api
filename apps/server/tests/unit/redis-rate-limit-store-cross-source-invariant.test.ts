// W975 — redis-rate-limit-store token-bucket cross-source invariant.
// Three-hundred-first in the drift-guard series. Pins the apps/
// server/src/lib/redis-rate-limit-store.ts atomic token-bucket
// primitive:
//
//   Header framing — 'Redis-backed atomic token bucket. The Lua
//   script is the source of truth for atomicity:
//     - read current (tokens, lastRefillMs)
//     - refill based on elapsed time and refill rate
//     - subtract cost iff sufficient
//     - write new (tokens, lastRefillMs) with TTL = full-refill time
//       + slack.
//   The whole script runs as a single Redis command (EVAL), so
//   concurrent callers cannot race'.
//
//   Lua script 4 ARGV inputs — ARGV[1]=capacity + ARGV[2]=
//     refill_per_sec + ARGV[3]=cost + ARGV[4]=now_ms.
//
//   1 KEYS input — KEYS[1] = bucket key.
//
//   HMGET tokens + last_ms 2-field read.
//
//   Bootstrap-on-nil-tokens — tokens == nil → tokens = capacity +
//     last_ms = now_ms (full bucket on first hit).
//
//   Elapsed seconds = max(0, (now_ms - last_ms) / 1000).
//
//   Refill formula — refilled = min(capacity, tokens + elapsed *
//     refill_per_sec). Capacity clamp prevents over-fill from long
//     idle windows.
//
//   Allow-branch — refilled >= cost → remaining = refilled - cost +
//     HMSET tokens=remaining,last_ms=now_ms + EXPIRE + return
//     {1, remaining, 0}.
//
//   Deny-branch — deficit = cost - refilled, retry_after_ms =
//     ceil((deficit / refill_per_sec) * 1000) + HMSET partial-refill
//     state + EXPIRE + return {0, refilled, retry_after_ms}.
//
//   TTL formula — ceil(capacity / max(refill_per_sec, 0.0001)) + 60.
//     The 0.0001 floor prevents divide-by-zero; 60s slack ensures the
//     bucket survives a brief Redis-flush window.
//
//   3-element return tuple — [allowedFlag, remaining,
//     retryAfterMs].
//
//   RedisRateLimitStore implements RateLimitStore — single consume
//     method takes ConsumeOpts {key, capacity, refillPerSecond, cost,
//     now} and returns ConsumeResult {allowed, remaining,
//     retryAfterMs}.
//
//   redis.eval invocation: LUA + numkeys=1 + opts.key + 4 string-
//     coerced ARGVs.
//
// stays in lockstep across apps/server/src/lib/redis-rate-limit-store.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W975 redis-rate-limit-store token-bucket cross-source invariant', () => {
  // ─── Header atomicity framing ────────────────────────────────

  it("CRITICAL apps/server/src/lib/redis-rate-limit-store.ts header pins surface — 'Redis-backed atomic token bucket. The Lua script is the source of truth for atomicity'. The Lua-as-source-of-truth framing is the atomicity contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/redis-rate-limit-store.ts'));
    expect(p).toMatch(/Redis-backed atomic token bucket\./);
    expect(p).toMatch(/The Lua script is the source of truth for atomicity:/);
  });

  it("CRITICAL 4-step atomic flow framing — 'read current (tokens, lastRefillMs) + refill based on elapsed time and refill rate + subtract cost iff sufficient + write new (tokens, lastRefillMs) with TTL = full-refill time + slack'. The 4-step flow is the V-216 rate-limit atomicity model.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/redis-rate-limit-store.ts'));
    expect(p).toMatch(/- read current \(tokens, lastRefillMs\)/);
    expect(p).toMatch(/- refill based on elapsed time and refill rate/);
    expect(p).toMatch(/- subtract cost iff sufficient/);
    expect(p).toMatch(/- write new \(tokens, lastRefillMs\) with TTL = full-refill time \+ slack/);
  });

  it("CRITICAL single-EVAL atomicity framing — 'The whole script runs as a single Redis command (EVAL), so concurrent callers cannot race'. The single-EVAL design is the no-race guarantee.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/redis-rate-limit-store.ts'));
    expect(p).toMatch(/The whole script runs as a single Redis command \(EVAL\), so concurrent/);
    expect(p).toMatch(/callers cannot race\./);
  });

  // ─── 4 ARGV + 1 KEYS Lua inputs ──────────────────────────────

  it('CRITICAL Lua script has 4 ARGV inputs in order — capacity + refill_per_sec + cost + now_ms. The 4-input + ordered design is what makes the JS-to-Lua wire-format stable.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/redis-rate-limit-store.ts'));
    expect(p).toMatch(/local capacity = tonumber\(ARGV\[1\]\)/);
    expect(p).toMatch(/local refill_per_sec = tonumber\(ARGV\[2\]\)/);
    expect(p).toMatch(/local cost = tonumber\(ARGV\[3\]\)/);
    expect(p).toMatch(/local now_ms = tonumber\(ARGV\[4\]\)/);
  });

  it('CRITICAL Lua script has 1 KEYS input — KEYS[1] = bucket key. Single-key access is what makes the script Redis-Cluster-compatible.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/redis-rate-limit-store.ts'));
    expect(p).toMatch(/local key = KEYS\[1\]/);
  });

  // ─── HMGET 2-field read ──────────────────────────────────────

  it("CRITICAL HMGET reads 2 fields — 'tokens' + 'last_ms'. The 2-field hash is the bucket state shape.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/redis-rate-limit-store.ts'));
    expect(p).toMatch(/redis\.call\('HMGET', key, 'tokens', 'last_ms'\)/);
  });

  // ─── Bootstrap-on-nil-tokens ─────────────────────────────────

  it('CRITICAL bootstrap-on-nil-tokens — first-hit branch sets tokens = capacity + last_ms = now_ms (full bucket). The full-bucket-on-first-hit design lets new keys immediately serve traffic.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/redis-rate-limit-store.ts'));
    expect(p).toMatch(/if tokens == nil or last_ms == nil then/); // fail-safe on partial/corrupt hash
    expect(p).toMatch(/tokens = capacity/);
    expect(p).toMatch(/last_ms = now_ms/);
  });

  // ─── Elapsed seconds formula ─────────────────────────────────

  it('CRITICAL elapsed seconds = math.max(0, (now_ms - last_ms) / 1000). The max(0, ...) clamp guards against clock-skew-induced negative elapsed (which would refund tokens).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/redis-rate-limit-store.ts'));
    expect(p).toMatch(/local elapsed = math\.max\(0, \(now_ms - last_ms\) \/ 1000\)/);
  });

  // ─── Refill formula with capacity clamp ──────────────────────

  it('CRITICAL refilled = math.min(capacity, tokens + elapsed * refill_per_sec). The capacity-clamp prevents long-idle buckets from over-filling.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/redis-rate-limit-store.ts'));
    expect(p).toMatch(
      /local refilled = math\.min\(capacity, tokens \+ elapsed \* refill_per_sec\)/,
    );
  });

  // ─── Allow-branch: refilled >= cost ──────────────────────────

  it("CRITICAL allow-branch condition is refilled >= cost (ge-not-gt). The 'sufficient if equal' semantics means cost = remaining-balance is still allowed.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/redis-rate-limit-store.ts'));
    expect(p).toMatch(/if refilled >= cost then/);
  });

  it('CRITICAL allow-branch writes back tokens=remaining + last_ms=now_ms via HMSET. The 2-field write is the bucket state-transition.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/redis-rate-limit-store.ts'));
    expect(p).toMatch(/local remaining = refilled - cost/);
    expect(p).toMatch(/redis\.call\('HMSET', key, 'tokens', remaining, 'last_ms', now_ms\)/);
  });

  it('CRITICAL allow-branch returns {1, remaining, 0} — allowedFlag=1 + remaining + retryAfterMs=0. The 3-element tuple matches the deny-branch shape for uniform downstream parsing.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/redis-rate-limit-store.ts'));
    expect(p).toMatch(/return \{1, remaining, 0\}/);
  });

  // ─── Deny-branch: deficit + retry ────────────────────────────

  it('CRITICAL deny-branch computes deficit = cost - refilled. The deficit is what feeds the retry-after calculation.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/redis-rate-limit-store.ts'));
    expect(p).toMatch(/local deficit = cost - refilled/);
  });

  it('CRITICAL deny-branch retry_after_ms = ceil((deficit / max(refill_per_sec, 0.0001)) * 1000). The 0.0001 floor prevents divide-by-zero when refill_per_sec is 0 (e.g. misconfigured throttle).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/redis-rate-limit-store.ts'));
    expect(p).toMatch(
      /local retry_after_ms = math\.ceil\(\(deficit \/ math\.max\(refill_per_sec, 0\.0001\)\) \* 1000\)/,
    );
  });

  it('CRITICAL deny-branch still HMSETs the partial-refill state (tokens=refilled). The persist-even-on-deny design lets multiple denied calls share refill progress.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/redis-rate-limit-store.ts'));
    expect(p).toMatch(/redis\.call\('HMSET', key, 'tokens', refilled, 'last_ms', now_ms\)/);
  });

  it('CRITICAL deny-branch returns {0, refilled, retry_after_ms}. The 3-element tuple lets callers surface Retry-After header semantics directly.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/redis-rate-limit-store.ts'));
    expect(p).toMatch(/return \{0, refilled, retry_after_ms\}/);
  });

  // ─── TTL formula + 60s slack ─────────────────────────────────

  it('CRITICAL TTL formula = ceil(capacity / max(refill_per_sec, 0.0001)) + 60 (seconds). The 60s slack ensures the bucket survives a brief Redis-flush window without losing client state.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/redis-rate-limit-store.ts'));
    expect(p).toMatch(
      /local ttl = math\.ceil\(capacity \/ math\.max\(refill_per_sec, 0\.0001\)\) \+ 60/,
    );
    expect(p).toMatch(/redis\.call\('EXPIRE', key, ttl\)/);
    expect(p).toMatch(/TTL = \(capacity \/ refill_rate\) seconds \+ 60s slack/);
  });

  // ─── consume signature + parse ───────────────────────────────

  it("CRITICAL RedisRateLimitStore implements RateLimitStore — 'export class RedisRateLimitStore implements RateLimitStore'. The interface-implementation lets the in-memory + redis stores be polymorphic at the consumer.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/redis-rate-limit-store.ts'));
    expect(p).toMatch(/export class RedisRateLimitStore implements RateLimitStore \{/);
  });

  it("CRITICAL constructor takes ioredis.Redis instance — 'constructor(private readonly redis: Redis)'. The DI'd Redis lets tests substitute a mock and prod inject a clustered client.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/redis-rate-limit-store.ts'));
    expect(p).toMatch(/constructor\(private readonly redis: Redis\) \{\}/);
  });

  it("CRITICAL consume eval invocation — '(await this.redis.eval(LUA, 1, opts.key, opts.capacity.toString(), opts.refillPerSecond.toString(), opts.cost.toString(), opts.now.toString()))'. The numkeys=1 + 4 string-coerced ARGVs match the Lua script's expected wire-format.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/redis-rate-limit-store.ts'));
    expect(p).toMatch(/await this\.redis\.eval\(/);
    expect(p).toMatch(/LUA,/);
    expect(p).toMatch(/1,/);
    expect(p).toMatch(/opts\.key,/);
    expect(p).toMatch(/opts\.capacity\.toString\(\),/);
    expect(p).toMatch(/opts\.refillPerSecond\.toString\(\),/);
    expect(p).toMatch(/opts\.cost\.toString\(\),/);
    expect(p).toMatch(/opts\.now\.toString\(\),/);
  });

  it('CRITICAL consume return shape — [allowedFlag, remaining, retryAfterMs] → ConsumeResult { allowed: flag===1, remaining, retryAfterMs }. The flag-to-boolean conversion is the type-safe boundary.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/redis-rate-limit-store.ts'));
    expect(p).toMatch(/\)\) as \[number, number, number\];/);
    expect(p).toMatch(/const \[allowedFlag, remaining, retryAfterMs\] = result;/);
    expect(p).toMatch(/return \{/);
    expect(p).toMatch(/allowed: allowedFlag === 1,/);
    expect(p).toMatch(/remaining,/);
    expect(p).toMatch(/retryAfterMs,/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/redis-rate-limit-store-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});

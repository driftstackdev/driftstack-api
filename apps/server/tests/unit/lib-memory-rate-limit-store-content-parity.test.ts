// W440.A — drift guard for apps/server/src/lib/memory-rate-limit-store.ts.
// In-process token bucket — tests only. Drift here either drops the
// test-only framing (someone wires it into production and silently
// loses rate-limiting across instances) or breaks the refill-on-miss
// semantics that production Redis store mirrors.
//
//   • Test-only framing pinned: in-process; NO persistence; doesn't
//     work across multiple server instances.
//   • RateLimitStore interface contract.
//   • First-touch bucket initialized to capacity (not zero).
//   • Elapsed seconds clamped at zero on clock-skew (Math.max(0, ...)).
//   • Refilled clamped at capacity (no over-refill).
//   • On insufficient: persist refilled tokens but DON'T consume
//     (caller may retry; bucket state stays consistent).
//   • retryAfterMs = ceil((deficit / refill) * 1000).
//   • reset() for tests.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/lib/memory-rate-limit-store.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W440.A apps/server/src/lib/memory-rate-limit-store.ts content parity', () => {
  const body = read(LIB);

  it("test-only framing pinned: in-process token bucket; do NOT use in production (no persistence, doesn't work across multiple server instances)", () => {
    expect(body).toMatch(
      /\/\/ In-process token bucket store\. Used by tests; do NOT use in production\s*\/\/ \(no persistence, doesn't work across multiple server instances\)\./,
    );
  });

  it('imports token-bucket and exact-window contracts from services/rate-limit.js', () => {
    expect(body).toMatch(/ConsumeOpts,/);
    expect(body).toMatch(/ConsumeResult,/);
    expect(body).toMatch(/RateLimitStore,/);
    expect(body).toMatch(/SlidingWindowConsumeOpts,/);
    expect(body).toMatch(/SlidingWindowConsumeResult,/);
  });

  it('BucketState interface: tokens + lastRefillMs', () => {
    expect(body).toMatch(/interface BucketState \{\s*tokens: number;\s*lastRefillMs: number;\s*\}/);
  });

  it('MemoryRateLimitStore implements RateLimitStore; private readonly buckets Map<string, BucketState>', () => {
    expect(body).toMatch(
      /export class MemoryRateLimitStore implements RateLimitStore \{\s*private readonly buckets = new Map<string, BucketState>\(\);/,
    );
    expect(body).toMatch(/private readonly slidingWindows = new Map<string, number\[]>\(\);/);
  });

  it('consume(): first-touch bucket initialized to capacity (not zero) on Map miss; lastRefillMs = now on initialization', () => {
    expect(body).toMatch(
      /const existing = this\.buckets\.get\(key\) \?\? \{ tokens: capacity, lastRefillMs: now \};/,
    );
  });

  it('elapsedSec clamped at zero (Math.max(0, ...)) for clock-skew safety; refilled = min(capacity, tokens + elapsed*rate) (no over-refill past capacity)', () => {
    expect(body).toMatch(
      /const elapsedSec = Math\.max\(0, \(now - existing\.lastRefillMs\) \/ 1000\);\s*const refill = elapsedSec \* refillPerSecond;\s*const refilled = Math\.min\(capacity, existing\.tokens \+ refill\);/,
    );
  });

  it('on sufficient (refilled >= cost): persist remaining + return {allowed:true, remaining, retryAfterMs:0}', () => {
    expect(body).toMatch(
      /if \(refilled >= cost\) \{\s*const remaining = refilled - cost;\s*this\.buckets\.set\(key, \{ tokens: remaining, lastRefillMs: now \}\);\s*return Promise\.resolve\(\{ allowed: true, remaining, retryAfterMs: 0 \}\);\s*\}/,
    );
  });

  it('on insufficient framing pinned: persist refilled tokens but DO NOT consume; retryAfterMs = Math.ceil((deficit/refillPerSecond)*1000); return {allowed:false, remaining:refilled, retryAfterMs}', () => {
    expect(body).toMatch(/const deficit = cost - refilled;/);
    expect(body).toMatch(
      /const retryAfterMs = Math\.ceil\(\(deficit \/ refillPerSecond\) \* 1000\);/,
    );
    expect(body).toMatch(
      /\/\/ Persist refilled tokens but don't consume\.\s*this\.buckets\.set\(key, \{ tokens: refilled, lastRefillMs: now \}\);\s*return Promise\.resolve\(\{ allowed: false, remaining: refilled, retryAfterMs \}\);/,
    );
  });

  it('exact sliding window refuses at the limit until the oldest retained timestamp expires', () => {
    expect(body).toMatch(/async consumeSlidingWindow\(/);
    expect(body).toMatch(/\(acceptedAt\) => acceptedAt > cutoff/);
    expect(body).toMatch(/if \(retained\.length >= opts\.limit\) \{/);
    expect(body).toMatch(/remaining: opts\.limit - retained\.length/);
  });

  it('reset(): clears bucket Map and sliding-window history (for tests)', () => {
    expect(body).toMatch(
      /reset\(\): void \{\s*this\.buckets\.clear\(\);\s*this\.slidingWindows\.clear\(\);\s*\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});

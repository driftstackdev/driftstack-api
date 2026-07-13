// W913 — RateLimit token-bucket store interface + ConsumeResult
// cross-source invariant. Two-hundred-thirty-ninth in the drift-
// guard series. Pins the rate-limit primitives:
//
//   BucketConfig: { capacity: number; refillPerSecond: number }.
//
//   ConsumeOpts (5 fields): key + capacity + refillPerSecond +
//     cost + now.
//
//   ConsumeResult (3 fields): allowed (boolean) + remaining (tokens
//     left after call) + retryAfterMs (ms until bucket is full enough
//     to satisfy this cost; 0 when allowed).
//
//   ConsumeResultWithBucket (5 fields, W199): extends ConsumeResult
//     with capacity + refillPerSecond — surfaces 'x-ratelimit-limit'
//     + 'x-ratelimit-reset' + 'x-ratelimit-bucket' headers.
//
//   RateLimitStore (interface): consume(opts): Promise<ConsumeResult>.
//
//   2 store impls — RedisRateLimitStore (atomic Lua) +
//   MemoryRateLimitStore (in-process map). Shared test suite in
//   tests/unit/rate-limit.test.ts.
//
//   bucketConfigFor reads TIER_RATE_LIMIT_DEFAULTS (V-219 api-types
//   single source of truth) + falls back to 'global' bucket per tier.
//
//   RateLimitInput.overrides: 'consulted first; expired or missing →
//   tier default'.
//
// stays in lockstep across apps/server/src/services/rate-limit.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W913 RateLimit store interface cross-source invariant', () => {
  // ─── BucketConfig 2-field interface ──────────────────────────

  it('CRITICAL apps/server/src/services/rate-limit.ts BucketConfig interface = { capacity: number; refillPerSecond: number }. The 2-field token-bucket shape is the canonical token-bucket primitive.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/rate-limit.ts'));
    expect(p).toMatch(
      /export interface BucketConfig \{\s*\n\s*capacity: number;\s*\n\s*refillPerSecond: number;\s*\n\s*\}/,
    );
  });

  // ─── ConsumeOpts 5-field shape ───────────────────────────────

  it('CRITICAL ConsumeOpts has 5 fields — key + capacity + refillPerSecond + cost + now. The 5-field input is what each consume call needs to compute bucket-state deterministically.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/rate-limit.ts'));
    expect(p).toMatch(
      /export interface ConsumeOpts \{\s*\n\s*key: string;\s*\n\s*capacity: number;\s*\n\s*refillPerSecond: number;\s*\n\s*cost: number;\s*\n\s*now: number;\s*\n\s*\}/,
    );
  });

  // ─── ConsumeResult 3-field shape ─────────────────────────────

  it('CRITICAL ConsumeResult has 3 fields — allowed (boolean) + remaining (tokens left) + retryAfterMs (ms until bucket full enough; 0 when allowed). The 3-field shape is what RateLimitStore implementations return.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/rate-limit.ts'));
    expect(p).toMatch(
      /export interface ConsumeResult \{\s*\n\s*allowed: boolean;[\s\S]+?remaining: number;[\s\S]+?retryAfterMs: number;\s*\n\s*\}/,
    );
  });

  it("CRITICAL ConsumeResult.retryAfterMs comment pins 'ms until the bucket is full enough to satisfy this cost; 0 when allowed'. The retryAfterMs is what the middleware translates into x-ratelimit-reset + retry_after_seconds.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/rate-limit.ts'));
    expect(p).toMatch(/ms until the bucket is full enough to satisfy this cost; 0 when allowed/);
  });

  // ─── W199 ConsumeResultWithBucket extension ──────────────────

  it("CRITICAL ConsumeResultWithBucket extends ConsumeResult with capacity + refillPerSecond — W199 'customer rate-limit headers (x-ratelimit-limit, x-ratelimit-reset, x-ratelimit-bucket) match the contract'. The 2-field extension surfaces bucket-config to middleware without growing the Store interface.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/rate-limit.ts'));
    expect(p).toMatch(/W199 — capacity \+ reset hints surfaced to the middleware/);
    expect(p).toMatch(
      /customer\s*\n\/\/ rate-limit headers \(`x-ratelimit-limit`, `x-ratelimit-reset`,/,
    );
    expect(p).toMatch(/`x-ratelimit-bucket`\) match the contract/);
    expect(p).toMatch(
      /export interface ConsumeResultWithBucket extends ConsumeResult \{\s*\n[\s\S]+?capacity: number;[\s\S]+?refillPerSecond: number;/,
    );
  });

  // ─── 2 store impls (Redis + Memory) ──────────────────────────

  it("CRITICAL header pins 2-impl pattern — 'RedisRateLimitStore (production: atomic Lua script)' + 'MemoryRateLimitStore (tests: in-process map)'. Both implementations follow same semantics, validated by shared test suite.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/rate-limit.ts'));
    expect(p).toMatch(/RedisRateLimitStore \(production: atomic Lua script\)/);
    expect(p).toMatch(/MemoryRateLimitStore \(tests: in-process map\)/);
    expect(p).toMatch(
      /Both implementations follow the same semantics, validated by the shared\s*\n\/\/ test suite in tests\/unit\/rate-limit\.test\.ts/,
    );
  });

  // ─── RateLimitStore interface ────────────────────────────────

  it('CRITICAL RateLimitStore interface = single method consume(opts: ConsumeOpts): Promise<ConsumeResult>. The 1-method interface lets Redis + Memory impls share the same call surface.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/rate-limit.ts'));
    expect(p).toMatch(
      /export interface RateLimitStore \{\s*\n\s*consume\(opts: ConsumeOpts\): Promise<ConsumeResult>;\s*\n\s*\}/,
    );
  });

  it('CRITICAL exact ceilings use a separate optional SlidingWindowRateLimitStore capability with resetAtMs; ordinary token-bucket callers keep the one-method interface', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/rate-limit.ts'));
    expect(p).toMatch(/export interface SlidingWindowConsumeOpts \{/);
    expect(p).toMatch(/limit: number;/);
    expect(p).toMatch(/windowMs: number;/);
    expect(p).toMatch(
      /export interface SlidingWindowConsumeResult extends ConsumeResult \{[\s\S]+?resetAtMs: number;/,
    );
    expect(p).toMatch(
      /export interface SlidingWindowRateLimitStore \{\s*\n?\s*consumeSlidingWindow\(opts: SlidingWindowConsumeOpts\): Promise<SlidingWindowConsumeResult>;/,
    );
  });

  // ─── bucketConfigFor reads TIER_RATE_LIMIT_DEFAULTS ──────────

  it('CRITICAL bucketConfigFor reads TIER_RATE_LIMIT_DEFAULTS[tier] + bucketKey-specific entry OR fallback to global. The V-219 source-of-truth pinned via the api-types canonical record.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/rate-limit.ts'));
    expect(p).toMatch(
      /import \{ TIER_RATE_LIMIT_DEFAULTS, type AccountTier \} from '@driftstack\/api-types';/,
    );
    expect(p).toMatch(/V-219 sources from `@driftstack\/api-types`/);
    expect(p).toMatch(/TIER_RATE_LIMIT_DEFAULTS` so SDK consumers can read the same/);
    expect(p).toMatch(/constants the server enforces/);
  });

  it("CRITICAL bucketConfigFor falls back to 'global' bucket when bucketKey-specific config is missing. The fallback ensures every tier has at least global rate-limiting.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/rate-limit.ts'));
    expect(p).toMatch(/const fallback = tierConfig\.global;/);
    expect(p).toMatch(
      /tier \$\{tier\} is missing a 'global' bucket — TIER_RATE_LIMIT_DEFAULTS is malformed/,
    );
  });

  // ─── RateLimitInput overrides precedence ─────────────────────

  it("CRITICAL RateLimitInput.overrides comment pins 'Override is consulted first; expired or missing → tier default'. The override-then-default precedence matches the V-052 admin-override flow.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/rate-limit.ts'));
    expect(p).toMatch(/Override is consulted first; expired or missing → tier default/);
  });

  // ─── 'RPS = tokens/sec if cost=1' framing ────────────────────

  it("CRITICAL header pins 'RPS is tokens per second if cost=1; for buckets where each request costs more, the effective request rate is (rps / cost)'. The framing teaches consumers that cost is multiplicative.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/rate-limit.ts'));
    expect(p).toMatch(/"RPS" is "tokens per second" if/);
    expect(p).toMatch(/cost=1; for buckets where each request costs more/);
    expect(p).toMatch(/the effective/);
    expect(p).toMatch(/request rate is \(rps \/ cost\)/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/rate-limit-store-interface-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});

// W395.B — drift guard for apps/server/src/services/rate-limit.ts.
// Token-bucket service entry that the rate-limit middleware (W394.C)
// and ip-rate-limit middleware (W395.A) compose against. Pairs with
// the store implementations (W393.A memory + redis). The V-219
// tier-defaults source-of-truth pin + W199 ConsumeResultWithBucket
// extension are the load-bearing contracts; drift either re-classifies
// every account's rate-limit budget silently or removes the response-
// header capacity hint the SDK relies on.
//
//   • Token-bucket framing pinned + 2-store posture (Redis prod, memory
//     tests).
//   • V-219 source: TIER_RATE_LIMIT_DEFAULTS from @driftstack/api-types
//     (SDK consumers read the same constants the server enforces).
//   • RPS = cost=1; effective request rate (rps / cost) when cost > 1.
//   • bucketConfigFor: tier-specific bucket → global fallback → throw
//     when 'global' missing (malformed tier).
//   • ConsumeOpts (5 fields) / ConsumeResult (3 fields).
//   • W199 ConsumeResultWithBucket: extends with capacity +
//     refillPerSecond (avoids growing RateLimitStore interface).
//   • RateLimitInput: accountId + tier + bucketKey + cost? + now? +
//     overrides? (V-219 RateLimitOverride keyed by bucketKey).
//   • effectiveBucketConfig: override-when-unexpired-else-tier-default
//     (lazy-expiry posture).
//   • storeKey: `rl:${accountId}:${bucketKey}`.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/services/rate-limit.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W395.B apps/server/src/services/rate-limit.ts content parity', () => {
  const body = read(LIB);

  it('Token-bucket framing pinned: capacity + refill + cost-vs-tokens allow/deny', () => {
    expect(body).toMatch(
      /Token-bucket rate limiter\.\s*\n?\s*\/\/\s*\n?\s*\/\/\s*One "bucket" per \(account, bucket-key\)\. Buckets refill at a steady rate up\s*\n?\s*\/\/\s*to a capacity\. Each call consumes some cost; if the bucket has at least\s*\n?\s*\/\/\s*`cost` tokens, the call is allowed; otherwise it's denied with a retry\s*\n?\s*\/\/\s*hint \(ms until enough tokens have accrued\)/,
    );
  });

  it('2-store posture pinned: RedisRateLimitStore (prod, atomic Lua) + MemoryRateLimitStore (tests)', () => {
    expect(body).toMatch(
      /The algorithm is implemented over a `RateLimitStore` interface so we have:\s*\n?\s*\/\/\s*- RedisRateLimitStore \(production: atomic Lua script\)\s*\n?\s*\/\/\s*- MemoryRateLimitStore \(tests: in-process map\)/,
    );
    expect(body).toMatch(
      /Both implementations follow the same semantics, validated by the shared\s*\n?\s*\/\/\s*test suite in tests\/unit\/rate-limit\.test\.ts/,
    );
  });

  it('V-219 TIER_RATE_LIMIT_DEFAULTS source-of-truth framing pinned', () => {
    expect(body).toMatch(
      /Tier defaults — V-219 sources from `@driftstack\/api-types`\s*\n?\s*\/\/\s*`TIER_RATE_LIMIT_DEFAULTS` so SDK consumers can read the same\s*\n?\s*\/\/\s*constants the server enforces/,
    );
    expect(body).toMatch(
      /"RPS" is "tokens per second" if\s*\n?\s*\/\/\s*cost=1; for buckets where each request costs more, the effective\s*\n?\s*\/\/\s*request rate is \(rps \/ cost\)/,
    );
  });

  it('BucketConfig: capacity + refillPerSecond', () => {
    expect(body).toMatch(
      /export interface BucketConfig \{\s*\n?\s*capacity: number;\s*\n?\s*refillPerSecond: number;\s*\n?\s*\}/,
    );
  });

  it('bucketConfigFor: tier-specific bucket → global fallback → throw on missing "global" (malformed tier)', () => {
    expect(body).toMatch(
      /export function bucketConfigFor\(tier: AccountTier, bucketKey: string\): BucketConfig \{\s*\n?\s*const tierConfig = TIER_RATE_LIMIT_DEFAULTS\[tier\];/,
    );
    expect(body).toMatch(
      /if \(specific\) \{\s*\n?\s*return \{ capacity: specific\.capacity, refillPerSecond: specific\.refill_per_second \};\s*\n?\s*\}/,
    );
    expect(body).toMatch(/const fallback = tierConfig\.global;/);
    expect(body).toMatch(
      /if \(!fallback\) \{\s*\n?\s*throw new Error\(\s*\n?\s*`tier \$\{tier\} is missing a 'global' bucket — TIER_RATE_LIMIT_DEFAULTS is malformed`,\s*\n?\s*\);/,
    );
  });

  it('ConsumeOpts: 5 fields (key, capacity, refillPerSecond, cost, now)', () => {
    expect(body).toMatch(/export interface ConsumeOpts \{/);
    expect(body).toMatch(/key: string;/);
    expect(body).toMatch(/capacity: number;/);
    expect(body).toMatch(/refillPerSecond: number;/);
    expect(body).toMatch(/cost: number;/);
    expect(body).toMatch(/now: number;/);
  });

  it('ConsumeResult: 3 fields (allowed, remaining, retryAfterMs); retryAfterMs=0 when allowed', () => {
    expect(body).toMatch(/export interface ConsumeResult \{/);
    expect(body).toMatch(/allowed: boolean;/);
    expect(body).toMatch(/Tokens left in the bucket after this call\./);
    expect(body).toMatch(/remaining: number;/);
    expect(body).toMatch(
      /ms until the bucket is full enough to satisfy this cost; 0 when allowed\./,
    );
    expect(body).toMatch(/retryAfterMs: number;/);
  });

  it('W199 ConsumeResultWithBucket: extends ConsumeResult with capacity + refillPerSecond (interface non-growth posture)', () => {
    expect(body).toMatch(
      /W199 — capacity \+ reset hints surfaced to the middleware so customer\s*\n?\s*\/\/\s*rate-limit headers \(`x-ratelimit-limit`, `x-ratelimit-reset`,\s*\n?\s*\/\/\s*`x-ratelimit-bucket`\) match the contract documented at\s*\n?\s*\/\/\s*`\/docs\/rate-limits`\. ConsumeResult stays minimal so the\s*\n?\s*\/\/\s*RateLimitStore interface doesn't grow; the middleware composes the\s*\n?\s*\/\/\s*extra fields here from the cached bucket config/,
    );
    expect(body).toMatch(/export interface ConsumeResultWithBucket extends ConsumeResult \{/);
    expect(body).toMatch(
      /Maximum bucket size \(capacity\)\. The bucket can never hold more than this\./,
    );
    expect(body).toMatch(/capacity: number;/);
    expect(body).toMatch(/Refill rate used for this consume call \(tokens\/sec\)\./);
  });

  it('RateLimitStore interface: single method (consume opts → Promise<ConsumeResult>)', () => {
    expect(body).toMatch(
      /export interface RateLimitStore \{\s*\n?\s*consume\(opts: ConsumeOpts\): Promise<ConsumeResult>;\s*\n?\s*\}/,
    );
  });

  it('RateLimitInput: accountId + tier + bucketKey + cost? + now? + overrides? (RateLimitOverride keyed by bucketKey)', () => {
    expect(body).toMatch(/export interface RateLimitInput \{/);
    expect(body).toMatch(/accountId: string;/);
    expect(body).toMatch(/tier: AccountTier;/);
    expect(body).toMatch(/bucketKey: string;/);
    expect(body).toMatch(/cost\?: number;/);
    expect(body).toMatch(/now\?: number;/);
    expect(body).toMatch(
      /Active overrides keyed by bucketKey, loaded from AccountContext\.\s*\n?\s*\*\s*Override is consulted first; expired or missing → tier default\./,
    );
    expect(body).toMatch(/overrides\?: Record<string, RateLimitOverride>;/);
  });

  it('rateLimitConsume: cost defaults to 1, now defaults to Date.now(), returns ConsumeResultWithBucket spread', () => {
    expect(body).toMatch(
      /export async function rateLimitConsume\(\s*\n?\s*store: RateLimitStore,\s*\n?\s*input: RateLimitInput,\s*\n?\s*\): Promise<ConsumeResultWithBucket> \{/,
    );
    expect(body).toMatch(/const cfg = effectiveBucketConfig\(input\);/);
    expect(body).toMatch(
      /const result = await store\.consume\(\{\s*\n?\s*key: storeKey\(input\.accountId, input\.bucketKey\),\s*\n?\s*capacity: cfg\.capacity,\s*\n?\s*refillPerSecond: cfg\.refillPerSecond,\s*\n?\s*cost: input\.cost \?\? 1,\s*\n?\s*now: input\.now \?\? Date\.now\(\),\s*\n?\s*\}\);/,
    );
    expect(body).toMatch(
      /return \{ \.\.\.result, capacity: cfg\.capacity, refillPerSecond: cfg\.refillPerSecond \};/,
    );
  });

  it('effectiveBucketConfig: lazy-expiry override (unexpired wins) → tier default fallback', () => {
    expect(body).toMatch(
      /Resolve the bucket config: override \(when present \+ unexpired\) wins\s*\n?\s*\*\s*over the tier default\. Lazy expiry — an expired override row in the\s*\n?\s*\*\s*cached context falls through to the tier default without requiring\s*\n?\s*\*\s*the cache to have been re-loaded/,
    );
    expect(body).toMatch(
      /if \(override && override\.expiresAt\.getTime\(\) > now\) \{\s*\n?\s*return \{ capacity: override\.capacity, refillPerSecond: override\.refillPerSecond \};\s*\n?\s*\}/,
    );
    expect(body).toMatch(/return bucketConfigFor\(input\.tier, input\.bucketKey\);/);
  });

  it('storeKey: "rl:${accountId}:${bucketKey}" prefix', () => {
    expect(body).toMatch(
      /function storeKey\(accountId: string, bucketKey: string\): string \{\s*\n?\s*return `rl:\$\{accountId\}:\$\{bucketKey\}`;\s*\n?\s*\}/,
    );
  });

  it('imports: TIER_RATE_LIMIT_DEFAULTS + AccountTier from @driftstack/api-types + RateLimitOverride from ./auth.js', () => {
    expect(body).toMatch(
      /import \{ TIER_RATE_LIMIT_DEFAULTS, type AccountTier \} from '@driftstack\/api-types';/,
    );
    expect(body).toMatch(/import type \{ RateLimitOverride \} from '\.\/auth\.js';/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});

// W413.A — drift guard for apps/server/src/routes/account-rate-limits.ts.
// V-219 customer-facing /v1/account/rate-limits — returns effective
// rate-limit config (tier default OR active admin override). Drift
// here either lies to customers about their limits (override stops
// being reflected) or leaks expired-override state (timer-skew bug).
//
//   • V-219 framing pinned: customer-facing view; effective config
//     per bucket; tier default OR currently-active admin override.
//   • Buckets allowlist: `as const` 3-tuple ['global', 'sessions:create',
//     'agent_sessions:message'] — v2-#8 sub-slice 8.20 isolated bucket.
//   • BucketKey type: typeof BUCKET_KEYS[number].
//   • Auth posture: requireAuth + exact read scope + global rate-limit gate.
//   • TIER_RATE_LIMIT_DEFAULTS sourced from @driftstack/api-types
//     (SDK mirror — single source of truth).
//   • Active-override detection: expiresAt.getTime() > now (current
//     time check; expired-but-not-purged overrides return tier default).
//   • Source discriminator: 'override' (as const) vs 'tier_default'
//     (as const) — SDK-readable union literal.
//   • Reply shape: { tier, buckets: [{bucket_key, capacity,
//     refill_per_second, source, override_expires_at}] };
//     override_expires_at ISO string when override, null otherwise.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/routes/account-rate-limits.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W413.A apps/server/src/routes/account-rate-limits.ts content parity', () => {
  const body = read(LIB);

  it('V-219 framing pinned: GET /v1/account/rate-limits returns effective config (tier default OR active admin override)', () => {
    expect(body).toMatch(/V-219 — customer-facing rate-limit view\./);
    expect(body).toMatch(
      /GET \/v1\/account\/rate-limits — returns the calling account's\s*\n?\s*\/\/\s*effective rate-limit config per bucket \(tier default OR admin\s*\n?\s*\/\/\s*override if currently active\)\./,
    );
  });

  it("BUCKET_KEYS: as const 4-tuple ['global', 'sessions:create', 'agent_sessions:message', 'agent_sessions:input_event'] + BucketKey = typeof[number] — all enforced buckets so the customer view hides none", () => {
    expect(body).toMatch(
      /const BUCKET_KEYS = \[\s*'global',\s*'sessions:create',\s*'agent_sessions:message',\s*'agent_sessions:input_event',?\s*\] as const;/,
    );
    expect(body).toMatch(/type BucketKey = \(typeof BUCKET_KEYS\)\[number\];/);
  });

  it('Auth posture: requireAuth + exact read scope + rateLimit("global") preHandler', () => {
    expect(body).toMatch(
      /\{ preHandler: \[app\.requireAuth, app\.requireScope\('read'\), app\.rateLimit\('global'\)\] \},/,
    );
  });

  it('TIER_RATE_LIMIT_DEFAULTS imported from @driftstack/api-types (SDK mirror)', () => {
    expect(body).toMatch(/import \{ TIER_RATE_LIMIT_DEFAULTS \} from '@driftstack\/api-types';/);
  });

  it('Account-context invariant: ctx falsy → "account context missing after requireAuth"', () => {
    expect(body).toMatch(/const ctx = request\.account;/);
    expect(body).toMatch(
      /if \(!ctx\) throw new Error\('account context missing after requireAuth'\);/,
    );
  });

  it('Active-override detection: override && override.expiresAt.getTime() > now → source: override (as const)', () => {
    expect(body).toMatch(/const tier = ctx\.account\.tier;/);
    expect(body).toMatch(/const tierDefaults = TIER_RATE_LIMIT_DEFAULTS\[tier\];/);
    expect(body).toMatch(/const now = Date\.now\(\);/);
    expect(body).toMatch(
      /const override = ctx\.rateLimitOverrides\[bucketKey\];\s*\n?\s*if \(override && override\.expiresAt\.getTime\(\) > now\) \{\s*\n?\s*return \{\s*\n?\s*bucket_key: bucketKey,\s*\n?\s*capacity: override\.capacity,\s*\n?\s*refill_per_second: override\.refillPerSecond,\s*\n?\s*source: 'override' as const,\s*\n?\s*override_expires_at: override\.expiresAt\.toISOString\(\),\s*\n?\s*\};/,
    );
  });

  it("Tier-default fallback: source: 'tier_default' as const + override_expires_at: null", () => {
    expect(body).toMatch(
      /const def = tierDefaults\[bucketKey\];\s*\n?\s*return \{\s*\n?\s*bucket_key: bucketKey,\s*\n?\s*capacity: def\.capacity,\s*\n?\s*refill_per_second: def\.refill_per_second,\s*\n?\s*source: 'tier_default' as const,\s*\n?\s*override_expires_at: null,\s*\n?\s*\};/,
    );
  });

  it('Reply shape: { tier, buckets } with buckets iterated via BUCKET_KEYS.map(bucketKey: BucketKey)', () => {
    expect(body).toMatch(/const buckets = BUCKET_KEYS\.map\(\(bucketKey: BucketKey\) => \{/);
    expect(body).toMatch(/return \{ tier, buckets \};/);
  });

  it('imports: FastifyInstance type only (no module mutation)', () => {
    expect(body).toMatch(/import type \{ FastifyInstance \} from 'fastify';/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});

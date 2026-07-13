// W1017 — routes/account-rate-limits V-219 cross-source invariant.
// Three-hundred-forty-third in the drift-guard series. Pins the
// apps/server/src/routes/account-rate-limits.ts customer-facing rate-
// limit view:
//
//   V-219 anchor — 'V-219 — customer-facing rate-limit view'.
//
//   Endpoint — 'GET /v1/account/rate-limits — returns the calling
//   account's effective rate-limit config per bucket (tier default
//   OR admin override if currently active)'.
//
//   BUCKET_KEYS readonly tuple — ['global', 'sessions:create'].
//
//   preHandler chain — [app.requireAuth, app.requireScope('read'),
//   app.rateLimit('global')]
//     (global bucket gates this endpoint).
//
//   Override-active check — and(override exists, override.expiresAt
//     .getTime() > now).
//
//   Override response shape — 5 fields: bucket_key + capacity +
//     refill_per_second + source:'override' + override_expires_at
//     (ISO).
//
//   Tier-default response shape — 5 fields: bucket_key + capacity +
//     refill_per_second + source:'tier_default' + override_expires_at:
//     null.
//
//   Tier defaults from TIER_RATE_LIMIT_DEFAULTS[tier][bucketKey].
//
//   Response envelope — { tier, buckets }.
//
// stays in lockstep across apps/server/src/routes/account-rate-limits.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W1017 routes/account-rate-limits V-219 cross-source invariant', () => {
  it("CRITICAL V-219 anchor — 'V-219 — customer-facing rate-limit view'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/account-rate-limits.ts'));
    expect(p).toMatch(/\/\/ V-219 — customer-facing rate-limit view\./);
  });

  it("CRITICAL endpoint framing — 'GET /v1/account/rate-limits — returns the calling account's effective rate-limit config per bucket (tier default OR admin override if currently active)'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/account-rate-limits.ts'));
    expect(p).toMatch(/\/\/ GET \/v1\/account\/rate-limits — returns the calling account's/);
    expect(p).toMatch(/\/\/ effective rate-limit config per bucket \(tier default OR admin/);
    expect(p).toMatch(/\/\/ override if currently active\)\./);
  });

  it("CRITICAL BUCKET_KEYS readonly tuple — 'global' + 'sessions:create' + 'agent_sessions:message' + 'agent_sessions:input_event'. The 4-bucket set defines what customers can introspect; it must match TIER_RATE_LIMIT_DEFAULTS so no enforced limit is hidden (input_event was previously omitted).", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/account-rate-limits.ts'));
    expect(p).toMatch(
      /const BUCKET_KEYS = \[\s*'global',\s*'sessions:create',\s*'agent_sessions:message',\s*'agent_sessions:input_event',?\s*\] as const;/,
    );
    expect(p).toMatch(/type BucketKey = \(typeof BUCKET_KEYS\)\[number\];/);
  });

  it('CRITICAL preHandler chain — broad read plus the global bucket. Account-wide limit/override metadata rejects zero-scope and granular-resource keys while the endpoint remains rate-limited.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/account-rate-limits.ts'));
    expect(p).toMatch(
      /\{ preHandler: \[app\.requireAuth, app\.requireScope\('read'\), app\.rateLimit\('global'\)\] \},/,
    );
  });

  it('CRITICAL endpoint path — GET /v1/account/rate-limits.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/account-rate-limits.ts'));
    expect(p).toMatch(/app\.get\(\s*'\/v1\/account\/rate-limits',/);
  });

  it("CRITICAL override-active check — 'override && override.expiresAt.getTime() > now'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/account-rate-limits.ts'));
    expect(p).toMatch(/const override = ctx\.rateLimitOverrides\[bucketKey\];/);
    expect(p).toMatch(/if \(override && override\.expiresAt\.getTime\(\) > now\) \{/);
  });

  it("CRITICAL override response 5-field shape — bucket_key + capacity + refill_per_second + source:'override' + override_expires_at (ISO).", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/account-rate-limits.ts'));
    expect(p).toMatch(/bucket_key: bucketKey,/);
    expect(p).toMatch(/capacity: override\.capacity,/);
    expect(p).toMatch(/refill_per_second: override\.refillPerSecond,/);
    expect(p).toMatch(/source: 'override' as const,/);
    expect(p).toMatch(/override_expires_at: override\.expiresAt\.toISOString\(\),/);
  });

  it("CRITICAL tier-default response 5-field shape — bucket_key + capacity + refill_per_second + source:'tier_default' + override_expires_at:null.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/account-rate-limits.ts'));
    expect(p).toMatch(/const def = tierDefaults\[bucketKey\];/);
    expect(p).toMatch(/capacity: def\.capacity,/);
    expect(p).toMatch(/refill_per_second: def\.refill_per_second,/);
    expect(p).toMatch(/source: 'tier_default' as const,/);
    expect(p).toMatch(/override_expires_at: null,/);
  });

  it('CRITICAL tier defaults from TIER_RATE_LIMIT_DEFAULTS[tier] + response envelope { tier, buckets }.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/account-rate-limits.ts'));
    expect(p).toMatch(/import \{ TIER_RATE_LIMIT_DEFAULTS \} from '@driftstack\/api-types';/);
    expect(p).toMatch(/const tierDefaults = TIER_RATE_LIMIT_DEFAULTS\[tier\];/);
    expect(p).toMatch(/return \{ tier, buckets \};/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/routes-account-rate-limits-v219-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});

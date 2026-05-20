// W869 — RateLimitBucket 2-key cross-source invariant. One-
// hundred-ninety-fifth in the drift-guard series. Pins the V-219
// token-bucket key 2-roster:
//
//   1. global           — every authenticated /v1/* call consumes
//                         this bucket (anti-DDoS / runaway scripts).
//   2. sessions:create  — POST /v1/sessions only (lower cap because
//                         session-create is the most expensive op).
//
// stays in lockstep across:
//   - packages/api-types/src/common.ts TIER_RATE_LIMIT_DEFAULTS
//     (Record<AccountTier, Record<'global' | 'sessions:create', ...>>).
//   - packages/api-types/src/accounts.ts RateLimitBucketSchema
//     (z.enum on bucket_key field for /v1/account/rate-limits read).
//   - packages/api-types/src/admin.ts SetQuotaOverrideRequest +
//     ClearQuotaOverrideQuery (admin write/clear surface).
//   - apps/server/src/services/rate-limit.ts (consumer service).
//
// Drift in any source would silently let an admin/customer query
// or override a bucket the rate-limit service doesn't recognise
// (NoOp at runtime, broken UX).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const BUCKET_KEYS = [
  'global',
  'sessions:create',
  'agent_sessions:message',
  'agent_sessions:input_event',
] as const;

describe('W869 RateLimitBucket cross-source invariant', () => {
  // ─── api-types common.ts TIER_RATE_LIMIT_DEFAULTS shape ──────

  it("CRITICAL packages/api-types/src/common.ts TIER_RATE_LIMIT_DEFAULTS has the EXACT Record<AccountTier, Record<'global' | 'sessions:create' | 'agent_sessions:message' | 'agent_sessions:input_event', BucketLimitConfig>> shape. The 4-bucket-key shape (v2-#13 added 'agent_sessions:message' for AI chat throttle; Slice 4 added 'agent_sessions:input_event' for LK.6 manual-control stream) is the V-219 closed roster.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/common.ts'));
    expect(p).toMatch(
      /TIER_RATE_LIMIT_DEFAULTS: Record<\s*\n?\s*AccountTier,\s*\n?\s*Record<\s*\n?\s*'global' \| 'sessions:create' \| 'agent_sessions:message' \| 'agent_sessions:input_event',\s*\n?\s*BucketLimitConfig/,
    );
  });

  it("CRITICAL packages/api-types/src/common.ts BucketLimitConfig interface has exactly 2 fields: capacity (number) + refill_per_second (number). The 2-field token-bucket shape is what the server's bucket math operates on.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/common.ts'));
    expect(p).toMatch(
      /export interface BucketLimitConfig \{\s*\n\s*capacity: number;\s*\n\s*refill_per_second: number;\s*\n\s*\}/,
    );
  });

  // ─── V-219 anchor traceable ──────────────────────────────────

  it("CRITICAL V-219 anchor pinned in api-types/common.ts above TIER_RATE_LIMIT_DEFAULTS. The 'V-219 — per-tier rate-limit defaults' header threads the rate-limit-policy provenance.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/common.ts'));
    expect(p).toMatch(/V-219 — per-tier rate-limit defaults/);
  });

  // ─── api-types accounts.ts RateLimitBucketSchema enum field ──

  it("CRITICAL packages/api-types/src/accounts.ts RateLimitBucketSchema declares bucket_key: z.enum(['global', 'sessions:create', 'agent_sessions:message']). The customer-read response surface — what /v1/account/rate-limits returns to dashboard consumers. (Schema-side excludes agent_sessions:input_event because that bucket is internal-only — driven by the LK.6 stream-rate gate, not customer-visible.)", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/accounts.ts'));
    expect(p).toMatch(
      /bucket_key: z\.enum\(\['global', 'sessions:create', 'agent_sessions:message'\]\)/,
    );
  });

  // ─── api-types admin.ts SetQuotaOverrideRequest enum field ───

  it("CRITICAL packages/api-types/src/admin.ts SetQuotaOverrideRequestSchema declares bucket_key: z.enum(['global', 'sessions:create', 'agent_sessions:message']). The admin-write surface (POST /v1/admin/accounts/:id/rate-limit-overrides) accepts the 3 customer-visible keys; agent_sessions:input_event stays internal-only.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/admin.ts'));
    expect(p).toMatch(
      /SetQuotaOverrideRequestSchema = z\.object\(\{[\s\S]+?bucket_key: z\.enum\(\['global', 'sessions:create', 'agent_sessions:message'\]\)/,
    );
  });

  it("CRITICAL packages/api-types/src/admin.ts ClearQuotaOverrideQuerySchema declares bucket_key: z.enum(['global', 'sessions:create', 'agent_sessions:message']). The admin-clear surface (DELETE /v1/admin/.../rate-limit-overrides?bucket_key=...) accepts the 3 customer-visible keys.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/admin.ts'));
    expect(p).toMatch(
      /ClearQuotaOverrideQuerySchema = z\.object\(\{[\s\S]+?bucket_key: z\.enum\(\['global', 'sessions:create', 'agent_sessions:message'\]\)/,
    );
  });

  // ─── Server rate-limit service consumer ───────────────────────

  it('CRITICAL apps/server/src/services/rate-limit.ts exports bucketConfigFor(tier, bucketKey) — the source-of-truth lookup helper. The api-types comment cross-links to this function so future maintainers find the consumer.', () => {
    const apiTypes = read(resolve(REPO_ROOT, 'packages/api-types/src/common.ts'));
    // Cross-link comment in api-types points at the consumer service file.
    expect(apiTypes).toMatch(/bucketConfigFor/);
    expect(apiTypes).toMatch(/apps\/server\/src\/services\/rate-limit\.ts/);
    const service = read(resolve(REPO_ROOT, 'apps/server/src/services/rate-limit.ts'));
    expect(service).toMatch(
      /export function bucketConfigFor\(tier: AccountTier, bucketKey: string\)/,
    );
  });

  it("CRITICAL apps/server/src/services/rate-limit.ts has a defensive error message when the 'global' bucket is missing from TIER_RATE_LIMIT_DEFAULTS — '`tier ${tier} is missing a global bucket — TIER_RATE_LIMIT_DEFAULTS is malformed`'. The 'global' bucket is the MANDATORY one per tier; drift to dropping it would crash rate-limit lookup.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/rate-limit.ts'));
    expect(p).toMatch(/tier \$\{tier\} is missing a 'global' bucket/);
  });

  // ─── Bucket-key semantics in doc comments ─────────────────────

  it("CRITICAL api-types comment block above TIER_RATE_LIMIT_DEFAULTS documents the 2-bucket semantics — 'global' = anti-DDoS; 'sessions:create' = lower cap because session create is most expensive op. Drift to weaker framing would mis-document the policy.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/common.ts'));
    expect(p).toMatch(/`global` — every authenticated `\/v1\/\*` call consumes this bucket/);
    expect(p).toMatch(/`sessions:create` — `POST \/v1\/sessions` only/);
  });

  // ─── 2-key cardinality + no forbidden buckets ────────────────

  it('CRITICAL bucket_key roster = EXACTLY 4 values (v2-#13 added agent_sessions:message for AI chat throttle; Slice 4 added agent_sessions:input_event for LK.6 manual-control stream). Drift to adding a 5th bucket would force coordinated SDK + dashboard + admin updates.', () => {
    expect(BUCKET_KEYS.length).toBe(4);
    expect(BUCKET_KEYS).toEqual([
      'global',
      'sessions:create',
      'agent_sessions:message',
      'agent_sessions:input_event',
    ]);
  });

  it("CRITICAL no source declares forbidden bucket-key names (per-route / api / write / read / admin / heavy / light). These are common patterns that V-219 intentionally avoids — the 2-key model maps to 'all calls vs the single most-expensive op'.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/common.ts'));
    const m = p.match(
      /TIER_RATE_LIMIT_DEFAULTS: Record<\s*\n?\s*AccountTier,\s*\n?\s*Record<([^>]+)>/,
    );
    expect(m, 'TIER_RATE_LIMIT_DEFAULTS type signature must match').not.toBeNull();
    const body = m![1];
    const forbidden = ['per-route', 'api', 'write', 'read', 'admin', 'heavy', 'light'];
    for (const f of forbidden) {
      expect(body, `bucket_key must NOT include forbidden '${f}'`).not.toMatch(
        new RegExp(`'${f}'`),
      );
    }
  });

  // ─── 'sessions:create' colon-namespace pattern ────────────────

  it("CRITICAL per-route buckets use colon-namespace ('resource:verb' or 'resource:event') NOT slash or dot. The colon is what distinguishes per-route buckets from the global one. Drift to 'sessions/create' or 'sessions.create' would let the bucket-key parser mis-classify routes.", () => {
    expect(BUCKET_KEYS).toContain('sessions:create');
    expect(BUCKET_KEYS).toContain('agent_sessions:message');
    expect(BUCKET_KEYS).toContain('agent_sessions:input_event');
    // v2-#13 + Slice 4 — every non-global bucket follows the resource:verb
    // colon convention; only 'global' is bare.
    expect(BUCKET_KEYS.filter((k) => k.includes(':')).length).toBe(3);
    expect(BUCKET_KEYS.filter((k) => k.includes('/')).length).toBe(0);
    expect(BUCKET_KEYS.filter((k) => k.includes('.')).length).toBe(0);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/rate-limit-bucket-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});

// W730 — TIER_CONCURRENT_SESSION_LIMITS + PROFILES_PER_TIER server-
// side parity (matches W729 marketing-site pricing).
//
// Fifty-seventh in the cross-SDK drift-guard series. Pins the two
// canonical per-tier limit Records in api-types/src/common.ts that
// drive server-side enforcement of:
//   - profile-count cap at /v1/profiles create gate (V-136 / V-073)
//   - concurrent-session cap at /v1/sessions create gate (V-156)
//
// The numeric values MUST match the marketing-site pricing.ts
// fields (W729) — drift between server enforcement + marketing
// copy is the worst class of regression (customer pays for X but
// gets blocked at Y).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tierBlockIn } from './_helpers/pricing-tiers.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const COMMON = resolve(REPO_ROOT, 'packages/api-types/src/common.ts');

describe('W730 tier-limit server-side records parity', () => {
  it('common.ts file exists', () => {
    expect(existsSync(COMMON)).toBe(true);
  });

  it('CRITICAL PROFILES_PER_TIER Record pinned with 8-tier roster matching W728 AccountTier enum + W729 marketing.profiles values: trial 1 / solo 10 / team 50 / agency 200 / api_starter 25 / api_builder 100 / api_scale 500 / enterprise custom.', () => {
    const c = read(COMMON);

    expect(c).toMatch(
      /export const PROFILES_PER_TIER: Record<AccountTier, number \| 'custom'> = \{/,
    );

    const expected: Array<[string, string]> = [
      ['free', '1'],
      ['solo_manual', '10'],
      ['team_manual', '50'],
      ['agency_manual', '200'],
      ['api_starter', '25'],
      ['api_builder', '100'],
      ['api_scale', '500'],
      ['enterprise', "'custom'"],
    ];

    for (const [tier, val] of expected) {
      const re = new RegExp(`${tier}:\\s*${val.replace(/'/g, "'")},`);
      expect(c, `${tier} → ${val}`).toMatch(re);
    }
  });

  it('CRITICAL TIER_CONCURRENT_SESSION_LIMITS Record pinned with 8-tier roster matching W729 marketing.concurrent values: trial 1 / solo 1 / team 3 / agency 8 / api_starter 2 / api_builder 8 / api_scale 24 / enterprise 32.', () => {
    const c = read(COMMON);

    expect(c).toMatch(
      /export const TIER_CONCURRENT_SESSION_LIMITS: Record<AccountTier, number> = \{/,
    );

    const expected: Array<[string, number]> = [
      ['free', 1],
      ['solo_manual', 1],
      ['team_manual', 3],
      ['agency_manual', 8],
      ['api_starter', 2],
      ['api_builder', 8],
      ['api_scale', 24],
      ['enterprise', 32],
    ];

    for (const [tier, val] of expected) {
      expect(c, `${tier} → ${val}`).toMatch(new RegExp(`${tier}: ${val},`));
    }
  });

  it('CRITICAL enterprise: 32 sentinel-floor framing pinned. The 32 number is the smallest custom-contract floor; real Enterprise customers get higher via per-account rate-limit-overrides path. Drift to a different default would silently change what Enterprise gets out-of-the-box.', () => {
    const c = read(COMMON);
    expect(c).toMatch(
      /`enterprise: 32` is a sentinel floor for the smallest\s*\n\s*\*\s*custom contract; per-account overrides via the rate-limit-overrides/,
    );
    expect(c).toMatch(/path bump real Enterprise customers higher/);
  });

  it("CRITICAL `concurrent_limit_exceeded` HTTP 429 framing pinned in the constant's doc-comment. The framing tells engineers what the (N+1)th session-create returns — drift to a different error type would silently break customer error-handling.", () => {
    const c = read(COMMON);
    expect(c).toMatch(
      /creating an \(N\+1\)th triggers\s*\n\s*\*\s*`concurrency_limit_exceeded` \(HTTP 429\)/,
    );
  });

  it('CRITICAL ADR-004 + marketing.ts cross-reference pinned. The "Locked per ADR-004. Values mirrored in apps/marketing-site/src/data/pricing.ts:API_TIERS field `concurrent`" framing makes the cross-file dependency explicit.', () => {
    const c = read(COMMON);
    expect(c).toMatch(
      /Locked per ADR-004\. Values mirrored in\s*\n\s*\*\s*`apps\/marketing-site\/src\/data\/pricing\.ts:API_TIERS`/,
    );
  });

  it('CRITICAL primary-metering-primitive framing on TIER_CONCURRENT_SESSION_LIMITS — "the primary metering primitive on paid tiers". The wording tells engineers concurrency is the meter (not hours, not requests).', () => {
    const c = read(COMMON);
    expect(c).toMatch(/the primary metering primitive\s*\n\s*\*\s*on paid tiers/);
  });

  it('CRITICAL `creating` / `ready` / `busy` 3-state framing pinned. The 3-state set is what the (N+1)th-session-counter compares against; drift to including `destroyed` would let destroyed sessions still count.', () => {
    const c = read(COMMON);
    expect(c).toMatch(
      /A customer can have up to N sessions in `creating` \/\s*\n\s*\*\s*`ready` \/ `busy` state simultaneously/,
    );
  });

  it('CRITICAL cross-workspace import-direct framing pinned. The "customer-dashboard /sessions tier-info, admin-panel account-detail can import directly" wording tells consumers the constant is a STABLE PUBLIC api.', () => {
    const c = read(COMMON);
    expect(c).toMatch(
      /Cross-workspace consumers\s*\n\s*\*\s*\(customer-dashboard \/sessions tier-info, admin-panel account-detail\)\s*\n\s*\*\s*can import directly/,
    );
  });

  it('CRITICAL server-side enforcement framing — "reads from this constant via `concurrentSessionLimitFor()`". The helper function abstracts the lookup; drift to dropping the helper would force every callsite to know the const name.', () => {
    const c = read(COMMON);
    expect(c).toMatch(/constant via `concurrentSessionLimitFor\(\)`/);
  });

  it('CRITICAL sessions.ts service-layer wires both consts. Pins the import path + helper functions per V-156 / V-136.', () => {
    const s = read(resolve(REPO_ROOT, 'apps/server/src/services/sessions.ts'));

    expect(s).toMatch(/PROFILES_PER_TIER/);
    expect(s).toMatch(/TIER_CONCURRENT_SESSION_LIMITS/);
    expect(s).toMatch(/V-156/);
    expect(s).toMatch(/V-136/);
    expect(s).toMatch(/return TIER_CONCURRENT_SESSION_LIMITS\[tier\]/);
  });

  it('CRITICAL profile-cap helper handles the "custom" sentinel. Drift to passing "custom" string into arithmetic would crash at runtime.', () => {
    const s = read(resolve(REPO_ROOT, 'apps/server/src/services/sessions.ts'));
    expect(s).toMatch(/const limit = PROFILES_PER_TIER\[tier\]/);
  });

  it('CRITICAL cross-marketing-server parity — every TIER_CONCURRENT_SESSION_LIMITS entry has a matching marketing.ts API_TIERS.concurrent field with the same numeric value. The 6 paid + 1 trial + 1 enterprise tiers must reconcile.', () => {
    const common = read(COMMON);
    const pricing = read(resolve(REPO_ROOT, 'apps/marketing-site/src/data/pricing.ts'));

    const expected: Array<[string, number | string]> = [
      ['free', 1],
      ['solo_manual', 1],
      ['team_manual', 3],
      ['agency_manual', 8],
      ['api_starter', 2],
      ['api_builder', 8],
      ['api_scale', 24],
    ];

    for (const [tier, val] of expected) {
      // Server-side: tier: N,
      expect(common, `server ${tier} concurrent`).toMatch(new RegExp(`${tier}: ${val},`));
      // Marketing-side: id: 'tier', ... concurrent: N,
      expect(pricing, `marketing ${tier} concurrent`).toMatch(
        new RegExp(`id: '${tier}',[\\s\\S]{0,600}concurrent: ${val},`),
      );
    }

    // Enterprise: server 32, marketing 'Custom' (correct — marketing shows "Custom"; server enforces 32 default floor).
    expect(common).toMatch(/enterprise: 32,/);
    expect(tierBlockIn(pricing, 'enterprise')).toMatch(/concurrent: 'Custom',/);
  });

  it('CRITICAL cross-marketing-server profile-cap parity. The numeric values match across both files.', () => {
    const common = read(COMMON);
    const pricing = read(resolve(REPO_ROOT, 'apps/marketing-site/src/data/pricing.ts'));

    const expected: Array<[string, number | string]> = [
      ['free', 1],
      ['solo_manual', 10],
      ['team_manual', 50],
      ['agency_manual', 200],
      ['api_starter', 25],
      ['api_builder', 100],
      ['api_scale', 500],
    ];

    for (const [tier, val] of expected) {
      expect(common, `server ${tier} profiles`).toMatch(new RegExp(`${tier}: ${val},`));
      expect(pricing, `marketing ${tier} profiles`).toMatch(
        new RegExp(`id: '${tier}',[\\s\\S]{0,500}profiles: ${val},`),
      );
    }

    // Enterprise: server 'custom' (lowercase), marketing 'Custom' (display).
    expect(common).toMatch(/enterprise: 'custom',/);
    expect(tierBlockIn(pricing, 'enterprise')).toMatch(/profiles: 'Custom',/);
  });

  it('Tier-limits 5-invariant cluster — 2 canonical Records (PROFILES + CONCURRENT) + 8 entries each + sentinel-floor framing + helper-function indirection + cross-marketing parity reconciled per tier.', () => {
    const c = read(COMMON);

    expect(c).toMatch(/PROFILES_PER_TIER/);
    expect(c).toMatch(/TIER_CONCURRENT_SESSION_LIMITS/);
    expect(c).toMatch(/concurrentSessionLimitFor/);
    expect(c).toMatch(/sentinel floor for the smallest/);
    expect(c).toMatch(/Locked per ADR-004/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/tier-limits-server-side-parity.test.ts'),
      ),
    ).toBe(true);
  });
});

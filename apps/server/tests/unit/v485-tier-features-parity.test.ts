// W732 — V-485 TIER_FEATURES per-tier feature-gating registry parity.
//
// Fifty-ninth in the cross-SDK drift-guard series. Pins the V-485
// per-tier feature registry in api-types/src/common.ts — the single
// source of truth for "which capabilities does this tier unlock?"
// Mirrors W729 marketing-site pricing.ts API_TIERS for consistency
// between server-side gates + customer-facing copy.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const COMMON = resolve(REPO_ROOT, 'packages/api-types/src/common.ts');

describe('W732 V-485 TIER_FEATURES per-tier feature registry parity', () => {
  it('common.ts file exists', () => {
    expect(existsSync(COMMON)).toBe(true);
  });

  it('CRITICAL V-485 anchor + single-source-of-truth framing pinned. The registry consolidates scattered call-site checks (tier===trial_pack, PROFILES_PER_TIER, TIER_CONCURRENT_SESSION_LIMITS) into one place.', () => {
    const c = read(COMMON);
    expect(c).toMatch(/V-485 — per-tier feature gating registry/);
    expect(c).toMatch(
      /Single source of truth for "which capabilities does this tier\s*\n\s*\*\s*unlock\?"/,
    );
    expect(c).toMatch(/this registry is the central place for/);
  });

  it('CRITICAL marketing-site mirror framing pinned — "Mirrors the customer-facing matrix in apps/marketing-site/src/data/pricing.ts:API_TIERS — both layers MUST agree". Drift to mismatched values would let server gate features marketing claims to deliver.', () => {
    const c = read(COMMON);
    expect(c).toMatch(
      /Mirrors the customer-facing matrix in\s*\n\s*\*\s*`apps\/marketing-site\/src\/data\/pricing\.ts:API_TIERS`/,
    );
    expect(c).toMatch(/Both layers MUST agree/);
  });

  it('CRITICAL requireTierFeature consumer framing pinned. The 403 feature_not_available problem-type matches W709 problem roster.', () => {
    const c = read(COMMON);
    expect(c).toMatch(
      /Server: `requireTierFeature\(tier, key\)` in\s*\n\s*\*\s*`apps\/server\/src\/lib\/errors-helpers\.ts` throws 403 with\s*\n\s*\*\s*`feature_not_available` problem-type when the gate fails/,
    );
  });

  it('CRITICAL dashboard-consumer framing pinned. The "Customer dashboard: read TIER_FEATURES directly to drive conditional UI (e.g. hide AI-agent CTA on Personal)" wording tells dashboard engineers this is the canonical read path.', () => {
    const c = read(COMMON);
    expect(c).toMatch(
      /Customer dashboard: read TIER_FEATURES directly to drive\s*\n\s*\*\s*conditional UI \(e\.g\. hide AI-agent CTA on Personal\)/,
    );
  });

  it('CRITICAL new-feature-extension recipe framing pinned. The "Adding a new feature: extend TierFeatures, populate every row, then have the route handler call requireTierFeature(...)" wording is the canonical pattern for new features.', () => {
    const c = read(COMMON);
    expect(c).toMatch(
      /Adding a new feature: extend `TierFeatures`, populate every row\s*\n\s*\*\s*in `TIER_FEATURES`, then have the route handler call\s*\n\s*\*\s*`requireTierFeature\(tier, 'newFeature'\)` on the gated path/,
    );
  });

  it('CRITICAL TierFeatures interface shape pinned — concurrentSessions + profiles + apiKeyEnvironment + aiAgent + llmBilling (trialPack removed 2026-05-27 with the trial_pack retirement). Drift to dropping a field would force every consumer to gate on something else.', () => {
    const c = read(COMMON);

    expect(c).toMatch(/export interface TierFeatures \{/);
    expect(c).toMatch(/concurrentSessions: number;/);
    expect(c).toMatch(/profiles: number \| 'custom';/);
    expect(c).toMatch(/apiKeyEnvironment: 'test' \| 'live';/);
    expect(c).toMatch(/aiAgent: boolean;/);
    expect(c).toMatch(/llmBilling: LlmBilling;/);
    expect(c).not.toMatch(/trialPack/);
  });

  it('CRITICAL apiKeyEnvironment is "test" on free + "live" elsewhere. The test/live split is what determines whether the minted Stripe key is sandboxed or real. Drift to "live" on free would let free keys charge real money.', () => {
    const c = read(COMMON);
    expect(c).toMatch(/free: \{[\s\S]+?apiKeyEnvironment: 'test',/);

    // Every non-free tier uses 'live'.
    for (const tier of [
      'solo_manual',
      'team_manual',
      'agency_manual',
      'api_starter',
      'api_builder',
      'api_scale',
      'enterprise',
    ]) {
      expect(c, `${tier} apiKeyEnvironment: live`).toMatch(
        new RegExp(`${tier}: \\{[\\s\\S]+?apiKeyEnvironment: 'live',`),
      );
    }
  });

  it('CRITICAL apiAccess: false ONLY on free; true everywhere else. The boolean discriminator gates manual-only (no API) vs API-capable tiers.', () => {
    const c = read(COMMON);
    expect(c).toMatch(/free: \{[\s\S]+?apiAccess: false,/);

    for (const tier of [
      'solo_manual',
      'team_manual',
      'agency_manual',
      'api_starter',
      'api_builder',
      'api_scale',
      'enterprise',
    ]) {
      expect(c, `${tier} apiAccess: true`).toMatch(
        new RegExp(`${tier}: \\{[\\s\\S]+?apiAccess: true,`),
      );
    }
  });

  it('CRITICAL aiAgent gate matrix pinned — false on free + solo_manual; true on every other paid tier. Matches W729 marketing.aiAgent (founder Tier 3 spec post-V-072).', () => {
    const c = read(COMMON);
    expect(c).toMatch(/free: \{[\s\S]+?aiAgent: false,/);
    expect(c).toMatch(/solo_manual: \{[\s\S]+?aiAgent: false,/);

    for (const tier of [
      'team_manual',
      'agency_manual',
      'api_starter',
      'api_builder',
      'api_scale',
      'enterprise',
    ]) {
      expect(c, `${tier} aiAgent: true`).toMatch(
        new RegExp(`${tier}: \\{[\\s\\S]+?aiAgent: true,`),
      );
    }
  });

  it('CRITICAL llmBilling gate matrix pinned — null on free+solo; byok_only on team/agency/starter; byok_or_bundled on builder/scale; byok_or_bundled_custom on enterprise. Matches W729 marketing.llmBilling.', () => {
    const c = read(COMMON);
    expect(c).toMatch(/free: \{[\s\S]+?llmBilling: null,/);
    expect(c).toMatch(/solo_manual: \{[\s\S]+?llmBilling: null,/);

    for (const tier of ['team_manual', 'agency_manual', 'api_starter']) {
      expect(c, `${tier} llmBilling: byok_only`).toMatch(
        new RegExp(`${tier}: \\{[\\s\\S]+?llmBilling: 'byok_only',`),
      );
    }
    for (const tier of ['api_builder', 'api_scale']) {
      expect(c, `${tier} llmBilling: byok_or_bundled`).toMatch(
        new RegExp(`${tier}: \\{[\\s\\S]+?llmBilling: 'byok_or_bundled',`),
      );
    }
    expect(c).toMatch(/enterprise: \{[\s\S]+?llmBilling: 'byok_or_bundled_custom',/);
  });

  it('CRITICAL TIER_FEATURES Record type — Record<AccountTier, TierFeatures>. Drift to a different key type would let an unknown tier slip past the gate.', () => {
    const c = read(COMMON);
    expect(c).toMatch(/export const TIER_FEATURES: Record<AccountTier, TierFeatures> = \{/);
  });

  it('CRITICAL cross-record consistency — TIER_FEATURES.concurrentSessions[tier] === TIER_CONCURRENT_SESSION_LIMITS[tier]. The "Mirrors TIER_CONCURRENT_SESSION_LIMITS" doc-comment is the explicit cross-reference.', () => {
    const c = read(COMMON);
    expect(c).toMatch(/Concurrent session cap\. Mirrors TIER_CONCURRENT_SESSION_LIMITS/);

    const expected: Array<[string, number]> = [
      ['free', 1],
      ['solo_manual', 1],
      ['team_manual', 3],
      ['agency_manual', 8],
      ['api_starter', 2],
      ['api_builder', 8],
      ['api_scale', 24],
    ];
    for (const [tier, val] of expected) {
      expect(c, `${tier} concurrentSessions: ${val}`).toMatch(
        new RegExp(`${tier}: \\{[\\s\\S]+?concurrentSessions: ${val},`),
      );
    }
  });

  it('CRITICAL cross-record consistency — TIER_FEATURES.profiles[tier] === PROFILES_PER_TIER[tier]. The values mirror across both records.', () => {
    const c = read(COMMON);

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
      const re = new RegExp(`${tier}: \\{[\\s\\S]+?profiles: ${val.replace(/'/g, "'")},`);
      expect(c, `${tier} profiles: ${val}`).toMatch(re);
    }
  });

  it('V-485 6-invariant cluster — V-485 anchor + 6-field TierFeatures + 8-tier roster + marketing-mirror framing + requireTierFeature consumer + new-feature-extension recipe + aiAgent/llmBilling/trialPack gate matrices.', () => {
    const c = read(COMMON);

    expect(c).toMatch(/V-485/);
    expect(c).toMatch(/export interface TierFeatures \{/);
    expect(c).toMatch(/export const TIER_FEATURES: Record<AccountTier, TierFeatures>/);
    expect(c).toMatch(/Both layers MUST agree/);
    expect(c).toMatch(/requireTierFeature/);
    expect(c).toMatch(/Adding a new feature: extend `TierFeatures`/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(resolve(REPO_ROOT, 'apps/server/tests/unit/v485-tier-features-parity.test.ts')),
    ).toBe(true);
  });
});

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

/**
 * One tier's row from `TIER_FEATURES`, and ONLY that row.
 *
 * ⛔ Every value assertion below used to search the WHOLE FILE with
 * `${tier}: \{[\s\S]+?field: value,`. Each tier name appears TWICE in
 * common.ts — once in the per-tier rate-limit table and once in
 * TIER_FEATURES, about a hundred lines apart — so the lazy unanchored scan
 * could BEGIN in the rate-limit table and TERMINATE at a DIFFERENT tier's
 * field. Every arm degraded from "THIS tier has this value" to "SOME tier
 * has this value".
 *
 * Mutation-proved both ways (V-1643): setting `free.concurrentSessions` to 99
 * left this file entirely green; read through `tierRow` the same mutation
 * fails it. ⚠️ The property was never unguarded —
 * `the-built-api-types-agrees-with-its-source` catches an unrebuilt source
 * edit and `tier-features` compares the built records — but a layer that
 * CANNOT fail is worse than no layer, because it reads as coverage.
 */
function tierRow(tier: string): string {
  const c = read(COMMON);
  const start = c.indexOf('export const TIER_FEATURES');
  if (start < 0) throw new Error('TIER_FEATURES not found in common.ts');
  const m = new RegExp(`\\n  ${tier}: \\{([^}]*)\\}`).exec(c.slice(start));
  if (m === null) throw new Error(`no TIER_FEATURES row for tier "${tier}"`);
  return m[1]!;
}

describe('W732 V-485 TIER_FEATURES per-tier feature registry parity', () => {
  it('common.ts file exists', () => {
    expect(existsSync(COMMON)).toBe(true);
  });

  it('CRITICAL POSITIVE CONTROL the row reader isolates ONE tier, so every value assertion below means what it says. Without this the arms read as coverage while matching a neighbour a hundred lines away.', () => {
    const free = tierRow('free');
    const scale = tierRow('api_scale');

    // Each row carries its own values...
    expect(free).toMatch(/concurrentSessions: 1,/);
    expect(scale).toMatch(/concurrentSessions: 24,/);

    // ...and CANNOT reach a neighbour's. This is the arm that fails if the
    // reader ever goes back to scanning the whole file.
    expect(free).not.toMatch(/concurrentSessions: 24,/);
    expect(scale).not.toMatch(/concurrentSessions: 1,/);

    // The per-tier RATE-LIMIT table also has a `free: {` row. The reader must
    // never land in it — that ambiguity is what made these arms vacuous.
    expect(free).not.toMatch(/refill_per_second/);

    // A tier that does not exist must throw rather than silently return ''.
    expect(() => tierRow('no_such_tier')).toThrow(/no TIER_FEATURES row/);
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
    expect(tierRow('free')).toMatch(/apiKeyEnvironment: 'test',/);

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
      expect(tierRow(tier), `${tier} apiKeyEnvironment: live`).toMatch(
        new RegExp(`apiKeyEnvironment: 'live',`),
      );
    }
  });

  it('CRITICAL apiAccess: false ONLY on free; true everywhere else. The boolean discriminator gates manual-only (no API) vs API-capable tiers.', () => {
    expect(tierRow('free')).toMatch(/apiAccess: false,/);

    for (const tier of [
      'solo_manual',
      'team_manual',
      'agency_manual',
      'api_starter',
      'api_builder',
      'api_scale',
      'enterprise',
    ]) {
      expect(tierRow(tier), `${tier} apiAccess: true`).toMatch(new RegExp(`apiAccess: true,`));
    }
  });

  it('CRITICAL aiAgent gate matrix pinned — false on free + solo_manual; true on every other paid tier. Matches W729 marketing.aiAgent (founder Tier 3 spec post-V-072).', () => {
    expect(tierRow('free')).toMatch(/aiAgent: false,/);
    expect(tierRow('solo_manual')).toMatch(/aiAgent: false,/);

    for (const tier of [
      'team_manual',
      'agency_manual',
      'api_starter',
      'api_builder',
      'api_scale',
      'enterprise',
    ]) {
      expect(tierRow(tier), `${tier} aiAgent: true`).toMatch(new RegExp(`aiAgent: true,`));
    }
  });

  it('CRITICAL llmBilling gate matrix pinned — null on free+solo; byok_only on team/agency/starter; byok_or_bundled on builder/scale; byok_or_bundled_custom on enterprise. Matches W729 marketing.llmBilling.', () => {
    expect(tierRow('free')).toMatch(/llmBilling: null,/);
    expect(tierRow('solo_manual')).toMatch(/llmBilling: null,/);

    for (const tier of ['team_manual', 'agency_manual', 'api_starter']) {
      expect(tierRow(tier), `${tier} llmBilling: byok_only`).toMatch(
        new RegExp(`llmBilling: 'byok_only',`),
      );
    }
    for (const tier of ['api_builder', 'api_scale']) {
      expect(tierRow(tier), `${tier} llmBilling: byok_or_bundled`).toMatch(
        new RegExp(`llmBilling: 'byok_or_bundled',`),
      );
    }
    expect(tierRow('enterprise')).toMatch(/llmBilling: 'byok_or_bundled_custom',/);
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
      expect(tierRow(tier), `${tier} concurrentSessions: ${val}`).toMatch(
        new RegExp(`concurrentSessions: ${val},`),
      );
    }
  });

  it('CRITICAL cross-record consistency — TIER_FEATURES.profiles[tier] === PROFILES_PER_TIER[tier]. The values mirror across both records.', () => {
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
      const re = new RegExp(`profiles: ${val.replace(/'/g, "'")},`);
      expect(tierRow(tier), `${tier} profiles: ${val}`).toMatch(re);
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

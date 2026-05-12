// W386.A — drift guard for marketing-site src/data/pricing.ts self-
// hosted SKU + record exports. Existing pricing-trial-pack-binding +
// self-hosted-skus-parity cover binding/coverage; this guard pins
// the canonical SKU figures + 3 differentiator record-of-records:
//
//   • V-131 framing pinned (multi-region + multi-node stripped —
//     customer deployment choices, not license-tier gates).
//   • SELF_HOSTED_SKUS: 3 entries in canonical order (self_hosted_
//     solo / self_hosted_pro / self_hosted_enterprise).
//   • Solo: $1,000/mo + $800 annual-equiv + $9,600/yr + 25 profiles
//     + 1 archetype + custom-archetype-dev=none + email_48h support
//     + 3-month minimum + no source escrow.
//   • Pro: $2,000/mo + $1,600 + $19,200/yr + 100 profiles + 3
//     archetypes + custom-archetype-dev=limited + email_slack_12h
//     + 3-month minimum + no source escrow.
//   • Enterprise: monthlyUsd=null + $4,000 annual-equiv + $48,000/yr
//     + unlimited profiles/archetypes + custom-archetype-dev=
//     unlimited + dedicated_csm_1h + 12-month minimum + source
//     escrow=true.
//   • SELF_HOSTED_SOFTWARE_UPDATES + SELF_HOSTED_ARCHETYPE_UPDATES +
//     SELF_HOSTED_SOURCE_ACCESS 3-tier records pinned.
//   • ANNUAL_DISCOUNT_LABEL = "20% off annual".
//   • TRIAL_PACK 7-field as-const surface.
//   • TierType union: 'trial' | 'manual' | 'api'.
//   • LlmBilling union: byok_only / byok_or_bundled /
//     byok_or_bundled_custom / null.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const DATA = resolve(REPO_ROOT, 'apps/marketing-site/src/data/pricing.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W386.A marketing-site src/data/pricing.ts self-hosted data-source content parity', () => {
  const body = read(DATA);

  it('ADR-004 + ADR-003 framing pinned in module comment', () => {
    expect(body).toMatch(
      /Locked pricing values — single source of truth for the marketing\s*\n?\s*\/\/\s*site\. Per ADR-004/,
    );
    expect(body).toMatch(/Trial pack mechanics survive intact per ADR-003/);
  });

  it('V-073 backend-equivalence framing pinned (TIER_CONCURRENT_SESSION_LIMITS, PROFILES_PER_TIER)', () => {
    expect(body).toMatch(
      /apps\/server\/src\/services\/sessions\.ts\s*\n?\s*\/\/\s*\(TIER_CONCURRENT_SESSION_LIMITS, PROFILES_PER_TIER\) per V-073/,
    );
    expect(body).toMatch(
      /Both layers must agree on tier ids \+ concurrent caps \+ profile\s*\n?\s*\/\/\s*counts/,
    );
  });

  it('TierType union: trial / manual / api', () => {
    expect(body).toMatch(/export type TierType = 'trial' \| 'manual' \| 'api';/);
  });

  it('LlmBilling union: 4 literals (byok_only / byok_or_bundled / byok_or_bundled_custom / null)', () => {
    expect(body).toMatch(
      /export type LlmBilling = 'byok_only' \| 'byok_or_bundled' \| 'byok_or_bundled_custom' \| null;/,
    );
  });

  it('V-131 license-tier-differentiator framing (multi-region + multi-node stripped)', () => {
    expect(body).toMatch(/V-131: license-tier differentiators surfaced in the SKU comparison/);
    expect(body).toMatch(
      /Multi-region \+ multi-node-clustering were stripped here \(V-131\) —\s*\n?\s*\/\/\s*those were customer deployment choices, not license-tier gates/,
    );
  });

  it('SELF_HOSTED_SKUS: 3 entries in canonical order (solo / pro / enterprise)', () => {
    const block = body.match(/export const SELF_HOSTED_SKUS: SelfHostedSku\[\] = \[([\s\S]+?)\];/);
    expect(block).not.toBeNull();
    const ids = Array.from(block![1]!.matchAll(/id: '([^']+)',/g)).map((m) => m[1]);
    expect(ids).toEqual(['self_hosted_solo', 'self_hosted_pro', 'self_hosted_enterprise']);
  });

  it('Solo SKU: $1,000/mo + $800 annual-equiv + $9,600/yr + 25 profiles + 1 archetype + no source escrow', () => {
    expect(body).toMatch(
      /id: 'self_hosted_solo',[\s\S]+?monthlyUsd: 1_000,[\s\S]+?annualMonthlyEquivalentUsd: 800,[\s\S]+?annualUsd: 9_600,[\s\S]+?profilesMax: 25,[\s\S]+?archetypesMax: 1,[\s\S]+?customArchetypeDevelopment: 'none',[\s\S]+?supportTier: 'email_48h',[\s\S]+?minimumTermMonths: 3,[\s\S]+?sourceEscrow: false,/,
    );
  });

  it('Pro SKU: $2,000/mo + $1,600 annual-equiv + $19,200/yr + 100 profiles + 3 archetypes + custom-archetype=limited', () => {
    expect(body).toMatch(
      /id: 'self_hosted_pro',[\s\S]+?monthlyUsd: 2_000,[\s\S]+?annualMonthlyEquivalentUsd: 1_600,[\s\S]+?annualUsd: 19_200,[\s\S]+?profilesMax: 100,[\s\S]+?archetypesMax: 3,[\s\S]+?customArchetypeDevelopment: 'limited',[\s\S]+?supportTier: 'email_slack_12h',[\s\S]+?minimumTermMonths: 3,[\s\S]+?sourceEscrow: false,/,
    );
  });

  it('Enterprise SKU: monthlyUsd=null + $4,000 annual-equiv + $48,000/yr + unlimited + 12-month minimum + sourceEscrow=true', () => {
    expect(body).toMatch(
      /id: 'self_hosted_enterprise',[\s\S]+?monthlyUsd: null,[\s\S]+?annualMonthlyEquivalentUsd: 4_000,[\s\S]+?annualUsd: 48_000,[\s\S]+?profilesMax: null,[\s\S]+?archetypesMax: null,[\s\S]+?customArchetypeDevelopment: 'unlimited',[\s\S]+?supportTier: 'dedicated_csm_1h',[\s\S]+?minimumTermMonths: 12,[\s\S]+?sourceEscrow: true,/,
    );
  });

  it('Enterprise SKU subject lines: Self-Hosted Solo / Pro / Enterprise mailto-prefilled', () => {
    expect(body).toMatch(/ctaHref: 'mailto:sales@driftstack\.dev\?subject=Self-Hosted%20Solo',/);
    expect(body).toMatch(/ctaHref: 'mailto:sales@driftstack\.dev\?subject=Self-Hosted%20Pro',/);
    expect(body).toMatch(
      /ctaHref: 'mailto:sales@driftstack\.dev\?subject=Self-Hosted%20Enterprise',/,
    );
  });

  it('SELF_HOSTED_SOFTWARE_UPDATES: 3-tier record (Solo=Quarterly / Pro=Continuous / Enterprise=Continuous + bespoke patches)', () => {
    expect(body).toMatch(/export const SELF_HOSTED_SOFTWARE_UPDATES: Record<string, string> = \{/);
    expect(body).toMatch(/self_hosted_solo: 'Quarterly',/);
    expect(body).toMatch(/self_hosted_pro: 'Continuous',/);
    expect(body).toMatch(/self_hosted_enterprise: 'Continuous \+ bespoke patches',/);
  });

  it('SELF_HOSTED_ARCHETYPE_UPDATES: 3-tier record (Solo=Major iOS only / Pro=All releases / Enterprise=All + early access)', () => {
    expect(body).toMatch(/export const SELF_HOSTED_ARCHETYPE_UPDATES: Record<string, string> = \{/);
    expect(body).toMatch(/self_hosted_solo: 'Major iOS only',/);
    expect(body).toMatch(/self_hosted_pro: 'All releases',/);
    expect(body).toMatch(/self_hosted_enterprise: 'All \+ early access',/);
  });

  it('SELF_HOSTED_SOURCE_ACCESS: 3-tier record (Solo+Pro=Build artifacts / Enterprise=Full repository read-only audit)', () => {
    expect(body).toMatch(/export const SELF_HOSTED_SOURCE_ACCESS: Record<string, string> = \{/);
    expect(body).toMatch(/self_hosted_solo: 'Build artifacts',/);
    expect(body).toMatch(/self_hosted_pro: 'Build artifacts',/);
    expect(body).toMatch(/self_hosted_enterprise: 'Full repository \(read-only audit\)',/);
  });

  it('ANNUAL_DISCOUNT_LABEL = "20% off annual"', () => {
    expect(body).toMatch(/export const ANNUAL_DISCOUNT_LABEL = '20% off annual';/);
  });

  it('TRIAL_PACK as-const: 7 fields (price=2.99 / credit=299 / meterRate / 16h / 14d / concurrent=1 / oncePerAccount=true)', () => {
    expect(body).toMatch(/export const TRIAL_PACK = \{/);
    expect(body).toMatch(/priceUsd: 2\.99,/);
    expect(body).toMatch(/creditCents: 299,/);
    expect(body).toMatch(
      /meterRate: '\$0\.18 per concurrent-hour \(per ADR-003 trial-pack mechanic\)',/,
    );
    expect(body).toMatch(/hoursApprox: 16,/);
    expect(body).toMatch(/windowDays: 14,/);
    expect(body).toMatch(/concurrent: 1,/);
    expect(body).toMatch(/oncePerAccount: true,/);
    expect(body).toMatch(/\} as const;/);
  });

  it('SelfHostedSku interface: 10 fields incl. customArchetypeDevelopment 3-literal union + supportTier 3-literal union', () => {
    expect(body).toMatch(/customArchetypeDevelopment: 'none' \| 'limited' \| 'unlimited';/);
    expect(body).toMatch(/supportTier: 'email_48h' \| 'email_slack_12h' \| 'dedicated_csm_1h';/);
    expect(body).toMatch(/sourceEscrow: boolean;/);
    expect(body).toMatch(/minimumTermMonths: number;/);
  });

  it('Self-hosted concurrent-ceiling-removed framing pinned (V-075+ founder Tier 3 spec)', () => {
    expect(body).toMatch(
      /no\s*\n?\s*\*\s*`concurrentCeiling` field\. Differentiation is by profile count,/,
    );
    expect(body).toMatch(
      /concurrent capacity is bounded by customer\s*\n?\s*\*\s*hardware, NOT by license/,
    );
  });

  it('data file exists at canonical path', () => {
    expect(existsSync(DATA)).toBe(true);
  });
});

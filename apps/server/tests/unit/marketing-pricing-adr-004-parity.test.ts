// W729 — marketing-site/src/data/pricing.ts ADR-004 ladder parity.
// Fifty-sixth in the cross-SDK drift-guard series (W649 + W675-
// W729).
//
// Pins apps/marketing-site/src/data/pricing.ts as the single source
// of truth for marketing-site pricing copy. ADR-004 (two-ladder
// concurrent-only restructure) locks these numbers — drift here would
// silently mismatch what the customer sees vs what Stripe / server-
// side actually charges + enforces. The one-time trial pack was
// retired 2026-05-27 and replaced by the perpetual free tier.
//
// Tier roster MUST match AccountTier enum from W728 (api-types).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const PRICING = resolve(REPO_ROOT, 'apps/marketing-site/src/data/pricing.ts');

describe('W729 marketing-site pricing.ts ADR-004 ladder parity', () => {
  it('pricing.ts file exists', () => {
    expect(existsSync(PRICING)).toBe(true);
  });

  it('CRITICAL ADR-004 + V-073 anchors pinned in pricing.ts header + free-tier-replaces-trial-pack note. ADR-004 = two-ladder restructure; V-073 = server-side TIER_CONCURRENT_SESSION_LIMITS sync; the perpetual free tier replaced the one-time trial pack 2026-05-27.', () => {
    const p = read(PRICING);
    expect(p).toMatch(/Per ADR-004 \(two-ladder concurrent-only restructure/);
    expect(p).toMatch(/The perpetual free tier replaced the one-time trial pack 2026-05-27\./);
    expect(p).toMatch(
      /Backend equivalent at apps\/server\/src\/services\/sessions\.ts\s*\n\/\/\s*\(TIER_CONCURRENT_SESSION_LIMITS, PROFILES_PER_TIER\) per V-073/,
    );
    expect(p).toMatch(/Both layers must agree on tier ids \+ concurrent caps \+ profile/);
  });

  it("CRITICAL TierType 3-value union pinned — 'free' | 'manual' | 'api' (trial→free 2026-05-27). Drift to a 4th value would silently widen the V-075+ section-grouping discriminator.", () => {
    const p = read(PRICING);
    expect(p).toMatch(/export type TierType = 'free' \| 'manual' \| 'api'/);
  });

  it("CRITICAL LlmBilling 4-value union pinned — 'byok_only' | 'byok_or_bundled' | 'byok_or_bundled_custom' | null. The 4-value set is the per-tier AI-agent billing gate.", () => {
    const p = read(PRICING);
    expect(p).toMatch(
      /export type LlmBilling = 'byok_only' \| 'byok_or_bundled' \| 'byok_or_bundled_custom' \| null/,
    );
  });

  it('CRITICAL API_TIERS roster MUST contain all 8 tier IDs matching W728 AccountTier enum. The id-by-id match is what makes server-side TIER_CONCURRENT_SESSION_LIMITS pinable against marketing-site copy.', () => {
    const p = read(PRICING);

    const tierIds = [
      'free',
      'solo_manual',
      'team_manual',
      'agency_manual',
      'api_starter',
      'api_builder',
      'api_scale',
      'enterprise',
    ];

    for (const id of tierIds) {
      expect(p, `tier id '${id}'`).toMatch(new RegExp(`id: '${id}'`));
    }
  });

  it('CRITICAL free-tier pricing pinned — $0 monthly + 1 profile + 1 concurrent + oneTime: false + 20-minute sessions (perpetual free tier; trial_pack retired 2026-05-27).', () => {
    const p = read(PRICING);

    expect(p).toMatch(/id: 'free',[\s\S]{0,400}monthlyUsd: 0,/);
    expect(p).toMatch(/profiles: 1,[\s\S]{0,200}hoursLabel: '20-minute sessions',/);
    expect(p).toMatch(/concurrent: 1,[\s\S]{0,400}oneTime: false,/);
  });

  it('CRITICAL Personal pricing pinned — $79/mo + $63 annual-equiv + 10 profiles + 1 concurrent.', () => {
    const p = read(PRICING);

    expect(p).toMatch(
      /id: 'solo_manual',[\s\S]{0,400}monthlyUsd: 79,\s*\n\s*annualMonthlyEquivalentUsd: 63,\s*\n\s*annualUsd: 758,/,
    );
    expect(p).toMatch(/id: 'solo_manual',[\s\S]{0,500}profiles: 10,/);
    expect(p).toMatch(/id: 'solo_manual',[\s\S]{0,600}concurrent: 1,/);
  });

  it('CRITICAL Team pricing pinned — $249/mo + $199 annual-equiv + 50 profiles + 3 concurrent + highlight: true.', () => {
    const p = read(PRICING);

    expect(p).toMatch(
      /id: 'team_manual',[\s\S]{0,400}monthlyUsd: 249,\s*\n\s*annualMonthlyEquivalentUsd: 199,\s*\n\s*annualUsd: 2_390,/,
    );
    expect(p).toMatch(/id: 'team_manual',[\s\S]{0,500}profiles: 50,/);
    expect(p).toMatch(/id: 'team_manual',[\s\S]{0,600}concurrent: 3,/);
    expect(p).toMatch(/id: 'team_manual',[\s\S]{0,1000}highlight: true,/);
  });

  it('CRITICAL Agency pricing pinned — $699/mo + $559 annual-equiv + 200 profiles + 8 concurrent + Email/Slack Connect channel with the 48h non-contractual target (S43 2026-07-07: ToS §9.1 disclaims a reply-time SLA on this tier, so the old "12h SLA" figure is retired).', () => {
    const p = read(PRICING);

    expect(p).toMatch(
      /id: 'agency_manual',[\s\S]{0,400}monthlyUsd: 699,\s*\n\s*annualMonthlyEquivalentUsd: 559,\s*\n\s*annualUsd: 6_710,/,
    );
    expect(p).toMatch(/id: 'agency_manual',[\s\S]{0,500}profiles: 200,/);
    expect(p).toMatch(/id: 'agency_manual',[\s\S]{0,600}concurrent: 8,/);
    expect(p).toMatch(
      /id: 'agency_manual',[\s\S]{0,700}support: 'Email \+ Slack Connect · 48h target',/,
    );
  });

  it('CRITICAL API Starter pricing pinned — $149/mo + $119 annual-equiv + 25 profiles + 2 concurrent.', () => {
    const p = read(PRICING);

    expect(p).toMatch(
      /id: 'api_starter',[\s\S]{0,400}monthlyUsd: 149,\s*\n\s*annualMonthlyEquivalentUsd: 119,\s*\n\s*annualUsd: 1_430,/,
    );
    expect(p).toMatch(/id: 'api_starter',[\s\S]{0,500}profiles: 25,/);
    expect(p).toMatch(/id: 'api_starter',[\s\S]{0,600}concurrent: 2,/);
  });

  it('CRITICAL API Builder pricing pinned — $499/mo + $399 annual-equiv + 100 profiles + 8 concurrent + highlight: true + byok_or_bundled LLM.', () => {
    const p = read(PRICING);

    expect(p).toMatch(
      /id: 'api_builder',[\s\S]{0,400}monthlyUsd: 499,\s*\n\s*annualMonthlyEquivalentUsd: 399,\s*\n\s*annualUsd: 4_790,/,
    );
    expect(p).toMatch(/id: 'api_builder',[\s\S]{0,500}profiles: 100,/);
    expect(p).toMatch(/id: 'api_builder',[\s\S]{0,600}concurrent: 8,/);
    expect(p).toMatch(/id: 'api_builder',[\s\S]{0,800}llmBilling: 'byok_or_bundled',/);
    expect(p).toMatch(/id: 'api_builder',[\s\S]{0,1000}highlight: true,/);
  });

  it('CRITICAL API Scale pricing pinned — $1,499/mo + $1,199 annual-equiv + 500 profiles + 24 concurrent + Slack Connect with the ToS §9.2 4h Severity-1 first-response SLA (S43 2026-07-07: the bare "4h SLA" read as an all-ticket reply SLA; the ToS grant is Severity-1 first-response).', () => {
    const p = read(PRICING);

    expect(p).toMatch(
      /id: 'api_scale',[\s\S]{0,400}monthlyUsd: 1_499,\s*\n\s*annualMonthlyEquivalentUsd: 1_199,\s*\n\s*annualUsd: 14_390,/,
    );
    expect(p).toMatch(/id: 'api_scale',[\s\S]{0,500}profiles: 500,/);
    expect(p).toMatch(/id: 'api_scale',[\s\S]{0,600}concurrent: 24,/);
    expect(p).toMatch(
      /id: 'api_scale',[\s\S]{0,700}support: 'Slack Connect · 4h Severity-1 first-response SLA',/,
    );
  });

  it('CRITICAL Enterprise tier — monthlyUsd null + annualMonthlyEquivalentUsd 4_000 (the $4,000/mo entry floor) + annualUsd 48_000 (= 4_000 × 12, a true YEARLY total like every other tier) + Custom profiles + Custom concurrent + dedicated CSM 1h + Contact sales CTA. The $4,000/mo floor is the entry for the negotiated commitment.', () => {
    const p = read(PRICING);

    expect(p).toMatch(/id: 'enterprise',[\s\S]{0,400}monthlyUsd: null,/);
    expect(p).toMatch(/id: 'enterprise',[\s\S]{0,900}annualMonthlyEquivalentUsd: 4_000,/);
    expect(p).toMatch(/id: 'enterprise',[\s\S]{0,950}annualUsd: 48_000,/);
    expect(p).toMatch(/id: 'enterprise',[\s\S]{0,1100}profiles: 'Custom',/);
    expect(p).toMatch(/id: 'enterprise',[\s\S]{0,1200}concurrent: 'Custom',/);
    // S43 2026-07-07 — support string states the ToS §9.2 grant
    // exactly (1h Severity-1 first-response), not a bare "1h SLA".
    expect(p).toMatch(
      /id: 'enterprise',[\s\S]{0,1300}support: 'Dedicated CSM · 1h Severity-1 first-response SLA',/,
    );
    expect(p).toMatch(
      /id: 'enterprise',[\s\S]{0,1500}cta: \{ label: 'Contact sales', href: 'mailto:sales@driftstack\.dev' \}/,
    );
    expect(p).toMatch(/id: 'enterprise',[\s\S]{0,1500}llmBilling: 'byok_or_bundled_custom',/);
  });

  it('CRITICAL aiAgent boolean gates pinned correctly — false on free + solo_manual; true on team_manual + agency_manual + all api_* + enterprise. The free/solo lock-out is per founder Tier 3 spec post-V-072.', () => {
    const p = read(PRICING);

    // aiAgent: false tiers.
    expect(p).toMatch(/id: 'free',[\s\S]{0,800}aiAgent: false,/);
    expect(p).toMatch(/id: 'solo_manual',[\s\S]{0,800}aiAgent: false,/);

    // aiAgent: true tiers.
    for (const tier of [
      'team_manual',
      'agency_manual',
      'api_starter',
      'api_builder',
      'api_scale',
      'enterprise',
    ]) {
      expect(p, `${tier} aiAgent: true`).toMatch(
        new RegExp(`id: '${tier}',[\\s\\S]{0,1000}aiAgent: true,`),
      );
    }
  });

  it('CRITICAL TRIAL_PACK const removed — the one-time trial pack was retired 2026-05-27 (replaced by the perpetual free tier). No TRIAL_PACK export may return.', () => {
    const p = read(PRICING);
    expect(p).not.toMatch(/export const TRIAL_PACK/);
    expect(p).not.toMatch(/oncePerAccount/);
  });

  it("CRITICAL ANNUAL_DISCOUNT_LABEL pinned at '20% off annual'. Drift would mismatch the discount-line copy on /pricing.", () => {
    const p = read(PRICING);
    expect(p).toMatch(/export const ANNUAL_DISCOUNT_LABEL = '20% off annual'/);
  });

  it('CRITICAL SELF_HOSTED_SKUS 3-tier roster pinned — solo $1k/$800 + pro $2k/$1.6k + enterprise null/$4k. The 3-month minimum on solo/pro + 12-month on enterprise pins the term shape.', () => {
    const p = read(PRICING);

    // Solo.
    expect(p).toMatch(
      /id: 'self_hosted_solo',[\s\S]{0,400}monthlyUsd: 1_000,\s*\n\s*annualMonthlyEquivalentUsd: 800,/,
    );
    expect(p).toMatch(/id: 'self_hosted_solo',[\s\S]{0,500}profilesMax: 25,/);
    expect(p).toMatch(/id: 'self_hosted_solo',[\s\S]{0,800}minimumTermMonths: 3,/);
    expect(p).toMatch(/id: 'self_hosted_solo',[\s\S]{0,800}sourceEscrow: false,/);

    // Pro.
    expect(p).toMatch(
      /id: 'self_hosted_pro',[\s\S]{0,400}monthlyUsd: 2_000,\s*\n\s*annualMonthlyEquivalentUsd: 1_600,/,
    );
    expect(p).toMatch(/id: 'self_hosted_pro',[\s\S]{0,500}profilesMax: 100,/);
    expect(p).toMatch(/id: 'self_hosted_pro',[\s\S]{0,800}minimumTermMonths: 3,/);

    // Enterprise.
    expect(p).toMatch(
      /id: 'self_hosted_enterprise',[\s\S]{0,400}monthlyUsd: null,\s*\n\s*annualMonthlyEquivalentUsd: 4_000,/,
    );
    expect(p).toMatch(/id: 'self_hosted_enterprise',[\s\S]{0,500}profilesMax: null,/);
    expect(p).toMatch(/id: 'self_hosted_enterprise',[\s\S]{0,800}minimumTermMonths: 12,/);
    expect(p).toMatch(/id: 'self_hosted_enterprise',[\s\S]{0,800}sourceEscrow: true,/);
  });

  it('CRITICAL SELF_HOSTED differentiator records pinned — SOFTWARE_UPDATES + ARCHETYPE_UPDATES + SOURCE_ACCESS (V-131 license-tier-gate). Drift would mis-document what each self-hosted tier actually delivers.', () => {
    const p = read(PRICING);

    // V-131 anchor.
    expect(p).toMatch(/V-131: license-tier differentiators surfaced/);

    // 3 differentiator records.
    expect(p).toMatch(/SELF_HOSTED_SOFTWARE_UPDATES: Record<string, string> = \{/);
    expect(p).toMatch(/SELF_HOSTED_ARCHETYPE_UPDATES: Record<string, string> = \{/);
    expect(p).toMatch(/SELF_HOSTED_SOURCE_ACCESS: Record<string, string> = \{/);

    // Sample entries (post 2026-05-XX V-131 license-tier-gate parity
    // simplification: software-updates + archetype-updates all-tiers
    // Continuous; source-access still tiered Solo/Pro=compiled software /
    // Enterprise adds read-only source review — S20b 2026-07-06 plain-
    // language labels, same 2-level differentiation).
    expect(p).toMatch(/self_hosted_solo: 'Continuous'/);
    expect(p).toMatch(/self_hosted_pro: 'Continuous'/);
    expect(p).toMatch(/self_hosted_enterprise: 'Continuous'/);
    expect(p).toMatch(
      /self_hosted_enterprise: 'Compiled software \+ read-only source-code review access'/,
    );
  });

  it('CRITICAL paid manual + API tiers use the canonical "Get started" → Dashboard signup CTA (trial-funnel CTA retired with the trial pack 2026-05-27). The 6 non-enterprise paid tiers send signups straight to /signup/; the free tier uses "Get started — free".', () => {
    const p = read(PRICING);

    // 6 paid non-enterprise tiers use the direct signup CTA. W467 — the CTA
    // now points to the canonical ABSOLUTE dashboard signup (app.driftstack.dev/signup/);
    // the prior relative '/signup' 404'd on the marketing origin (driftstack.dev).
    const signupCtaMatches = (
      p.match(
        /cta: \{ label: 'Get started', href: 'https:\/\/app\.driftstack\.dev\/signup\/' \}/g,
      ) ?? []
    ).length;
    expect(signupCtaMatches, 'paid tiers using the signup CTA').toBeGreaterThanOrEqual(6);

    // The free tier uses its own free-framed CTA.
    expect(p).toMatch(
      /cta: \{ label: 'Get started — free', href: 'https:\/\/app\.driftstack\.dev\/signup\/' \}/,
    );
    // The relative '/signup' (404 on the marketing origin) must not return.
    expect(p).not.toMatch(/href: '\/signup'/);
    expect(p).not.toMatch(/href: 'https:\/\/app\.driftstack\.dev\/signup'/);

    // The retired trial-funnel CTA must NOT return.
    expect(p).not.toMatch(/Start with \$2\.99/);
    expect(p).not.toMatch(/\/pricing#trial-pack/);
  });

  it('CRITICAL ApiTier interface 16+ field shape pinned — id + tierType + name + monthly/annual triple + profiles + hoursLabel + overagePerHourUsd + concurrent + archetypeAccess + support + audience + aiAgent + llmBilling + cta + highlight? + oneTime?. Drift to dropping a field would break the marketing pricing table render.', () => {
    const p = read(PRICING);

    expect(p).toMatch(/export interface ApiTier \{[\s\S]+?\}/);

    // 16 fields on the interface.
    const fields = [
      'id: string',
      'tierType: TierType',
      'name: string',
      'monthlyUsd: number \\| null',
      'annualMonthlyEquivalentUsd: number \\| null',
      'annualUsd: number \\| null',
      'profiles: number \\| string',
      'hoursLabel: string',
      'overagePerHourUsd: number \\| null',
      'concurrent: number \\| string',
      'archetypeAccess: string',
      'support: string',
      'audience: string',
      'aiAgent: boolean',
      'llmBilling: LlmBilling',
      'cta: \\{ label: string; href: string \\}',
      'highlight\\?: boolean',
      'oneTime\\?: boolean',
    ];

    for (const f of fields) {
      expect(p, `ApiTier field ${f}`).toMatch(new RegExp(f));
    }
  });

  it('Pricing invariant cluster — ADR-004 + V-073 anchors + 8-tier roster matching W728 + free-tier-replaces-trial-pack note + ANNUAL_DISCOUNT 20% + SELF_HOSTED 3-tier + V-131 differentiators + /signup CTA on every paid tier.', () => {
    const p = read(PRICING);

    expect(p).toMatch(/ADR-004/);
    expect(p).toMatch(/The perpetual free tier replaced the one-time trial pack 2026-05-27\./);
    expect(p).toMatch(/V-073/);
    expect(p).toMatch(/V-131/);

    // 8 tiers + 3 self-hosted.
    const allTiers = [
      'free',
      'solo_manual',
      'team_manual',
      'agency_manual',
      'api_starter',
      'api_builder',
      'api_scale',
      'enterprise',
    ];
    for (const t of allTiers) {
      expect(p, `tier ${t}`).toMatch(new RegExp(`id: '${t}'`));
    }
    for (const sh of ['self_hosted_solo', 'self_hosted_pro', 'self_hosted_enterprise']) {
      expect(p, `self-hosted ${sh}`).toMatch(new RegExp(`id: '${sh}'`));
    }
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/marketing-pricing-adr-004-parity.test.ts'),
      ),
    ).toBe(true);
  });
});

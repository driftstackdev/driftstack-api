// Locked pricing values — single source of truth for the marketing
// site. Per ADR-004 (two-ladder concurrent-only restructure,
// supersedes file-127 single-ladder hours-with-overage design).
// Trial pack mechanics survive intact per ADR-003.
//
// V-072 NOTE: this file lands the new pricing values + tier IDs +
// new fields (`tierType`, `profiles`) but retains old field names
// (`monthlyUsd`, `annualUsd`, etc.) so the existing pricing.astro
// + self-hosted.astro templates keep compiling. The proper visual
// rewrite — two-ladder layout, removed-overage-row, profile-count
// emphasis — lands in V-075+ Marketing site B v3 (Tier 3
// draft-surface cadence).
//
// Backend equivalent at apps/server/src/services/sessions.ts
// (TIER_CONCURRENT_SESSION_LIMITS) + new PROFILES_PER_TIER per V-073.
// Both layers must agree.

export type TierType = 'trial' | 'manual' | 'api';

export interface ApiTier {
  id: string;
  /** Two-ladder discriminator added in V-072 for V-075+ section grouping. */
  tierType: TierType;
  name: string;
  monthlyUsd: number | null;
  annualMonthlyEquivalentUsd: number | null;
  annualUsd: number | null;
  /**
   * Profile count limit (Manual-tier-defining per ADR-004).
   * `'Custom'` for Enterprise; numbers everywhere else.
   * V-072 added field; V-073 enforces at /v1/profiles gate.
   */
  profiles: number | string;
  hoursLabel: string;
  overagePerHourUsd: number | null;
  concurrent: number | string;
  archetypeAccess: string;
  support: string;
  /** Audience description for V-075+ two-ladder positioning. */
  audience: string;
  cta: { label: string; href: string };
  highlight?: boolean;
  oneTime?: boolean;
}

export const API_TIERS: ApiTier[] = [
  // Trial pack — unchanged from ADR-003.
  {
    id: 'trial_pack',
    tierType: 'trial',
    name: 'Trial pack',
    monthlyUsd: 2.99,
    annualMonthlyEquivalentUsd: null,
    annualUsd: null,
    profiles: 1,
    hoursLabel: '~16 hrs at $0.18/hr',
    overagePerHourUsd: null,
    concurrent: 1,
    archetypeAccess: 'All currently-available archetypes',
    support: 'Community',
    audience: 'Evaluation',
    cta: { label: 'Get started — $2.99', href: '/pricing#trial-pack' },
    oneTime: true,
  },

  // Manual ladder — humans clicking GUI client, persistent profiles.
  {
    id: 'solo_manual',
    tierType: 'manual',
    name: 'Solo Manual',
    monthlyUsd: 79,
    annualMonthlyEquivalentUsd: 63,
    annualUsd: 758,
    profiles: 10,
    hoursLabel: 'Unlimited',
    overagePerHourUsd: null,
    concurrent: 1,
    archetypeAccess: 'All currently-available archetypes',
    support: 'Email · 48h SLA',
    audience: 'Solo power users, individual operators',
    cta: { label: 'Start with $2.99', href: '/pricing#trial-pack' },
  },
  {
    id: 'team_manual',
    tierType: 'manual',
    name: 'Team Manual',
    monthlyUsd: 249,
    annualMonthlyEquivalentUsd: 199,
    annualUsd: 2_390,
    profiles: 50,
    hoursLabel: 'Unlimited',
    overagePerHourUsd: null,
    concurrent: 3,
    archetypeAccess: 'All currently-available archetypes',
    support: 'Email · 24h SLA',
    audience: 'Teams of account managers',
    cta: { label: 'Start with $2.99', href: '/pricing#trial-pack' },
    highlight: true,
  },
  {
    id: 'agency_manual',
    tierType: 'manual',
    name: 'Agency Manual',
    monthlyUsd: 699,
    annualMonthlyEquivalentUsd: 559,
    annualUsd: 6_710,
    profiles: 200,
    hoursLabel: 'Unlimited',
    overagePerHourUsd: null,
    concurrent: 8,
    archetypeAccess: 'All currently-available archetypes',
    support: 'Email + Slack Connect · 12h SLA',
    audience: 'Agencies juggling many client profiles',
    cta: { label: 'Start with $2.99', href: '/pricing#trial-pack' },
  },

  // API ladder — programmatic SDK access.
  {
    id: 'api_starter',
    tierType: 'api',
    name: 'API Starter',
    monthlyUsd: 149,
    annualMonthlyEquivalentUsd: 119,
    annualUsd: 1_430,
    profiles: 25,
    hoursLabel: 'Unlimited',
    overagePerHourUsd: null,
    concurrent: 2,
    archetypeAccess: 'All currently-available archetypes',
    support: 'Email · 48h SLA',
    audience: 'Solo developers, evaluation-stage automation',
    cta: { label: 'Start with $2.99', href: '/pricing#trial-pack' },
  },
  {
    id: 'api_builder',
    tierType: 'api',
    name: 'API Builder',
    monthlyUsd: 499,
    annualMonthlyEquivalentUsd: 399,
    annualUsd: 4_790,
    profiles: 100,
    hoursLabel: 'Unlimited',
    overagePerHourUsd: null,
    concurrent: 8,
    archetypeAccess: 'All currently-available archetypes',
    support: 'Email + Slack Connect · 12h SLA',
    audience: 'Production automation at scale',
    cta: { label: 'Start with $2.99', href: '/pricing#trial-pack' },
    highlight: true,
  },
  {
    id: 'api_scale',
    tierType: 'api',
    name: 'API Scale',
    monthlyUsd: 1_499,
    annualMonthlyEquivalentUsd: 1_199,
    annualUsd: 14_390,
    profiles: 500,
    hoursLabel: 'Unlimited',
    overagePerHourUsd: null,
    concurrent: 24,
    archetypeAccess: 'All currently-available archetypes',
    support: 'Slack Connect · 4h SLA',
    audience: 'High-throughput automation fleets',
    cta: { label: 'Start with $2.99', href: '/pricing#trial-pack' },
  },
  {
    id: 'enterprise',
    tierType: 'api',
    name: 'Enterprise',
    monthlyUsd: null,
    annualMonthlyEquivalentUsd: null,
    annualUsd: 4_000,
    profiles: 'Custom',
    hoursLabel: 'Unlimited',
    overagePerHourUsd: null,
    concurrent: 'Custom',
    archetypeAccess: 'All available + custom archetypes',
    support: 'Dedicated CSM · 1h SLA',
    audience: 'Negotiated commitment',
    cta: { label: 'Contact sales', href: 'mailto:sales@driftstack.dev' },
  },
];

export interface SelfHostedSku {
  id: string;
  name: string;
  monthlyUsd: number | null;
  annualMonthlyEquivalentUsd: number | null;
  hardwareRequired: string;
  concurrent: string;
  archetypeAccess: string;
  minimumTerm: string;
  ctaHref: string;
}

export const SELF_HOSTED_SKUS: SelfHostedSku[] = [
  {
    id: 'self_hosted_solo',
    name: 'Self-Hosted Solo',
    monthlyUsd: 1_000,
    annualMonthlyEquivalentUsd: 800,
    hardwareRequired: 'Mac Mini M4 16 GB (customer-purchased)',
    concurrent: '4 concurrent ceiling',
    archetypeAccess: '1 archetype',
    minimumTerm: '3-month minimum',
    ctaHref: 'mailto:sales@driftstack.dev?subject=Self-Hosted%20Solo',
  },
  {
    id: 'self_hosted_pro',
    name: 'Self-Hosted Pro',
    monthlyUsd: 2_000,
    annualMonthlyEquivalentUsd: 1_600,
    hardwareRequired: 'Mac Studio M4 Max',
    concurrent: '12–16 concurrent',
    archetypeAccess: '3 archetypes',
    minimumTerm: '3-month minimum',
    ctaHref: 'mailto:sales@driftstack.dev?subject=Self-Hosted%20Pro',
  },
  {
    id: 'self_hosted_enterprise',
    name: 'Self-Hosted Enterprise',
    monthlyUsd: null,
    annualMonthlyEquivalentUsd: 4_000,
    hardwareRequired: 'Mac Studio Ultra / Mac Pro / multi-node cluster',
    concurrent: '32+ concurrent',
    archetypeAccess: 'Unlimited archetypes',
    minimumTerm: '12-month minimum',
    ctaHref: 'mailto:sales@driftstack.dev?subject=Self-Hosted%20Enterprise',
  },
];

export const ANNUAL_DISCOUNT_LABEL = '20% off annual';

export const TRIAL_PACK = {
  priceUsd: 2.99,
  creditCents: 299,
  meterRate: '$0.18/hr (Starter equivalent rate)',
  hoursApprox: 16,
  windowDays: 14,
  concurrent: 1,
  oncePerAccount: true,
} as const;

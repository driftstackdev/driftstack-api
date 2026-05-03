// Locked pricing values — single source of truth for the marketing
// site. Mirrors parent driftstack repo file 127
// (`docs/planning/127-pricing-self-hosted-strategy.md`, supersedes
// files 8 + 39) for the API tier ladder, and ADR-003 for the trial
// pack ($2.99 paid trial replaces the file-127 §6 free trial).
//
// Backend equivalent at apps/server/src/services/sessions.ts
// (TIER_CONCURRENT_SESSION_LIMITS) and usage.ts (TIER_QUOTAS) per
// V-061. Both layers must agree; this file lifts to the marketing
// site without re-deriving values.

export interface ApiTier {
  id: string;
  name: string;
  monthlyUsd: number | null; // null = "from $X annual only" or one-time
  annualMonthlyEquivalentUsd: number | null;
  annualUsd: number | null;
  hoursLabel: string;
  overagePerHourUsd: number | null;
  concurrent: number | string;
  archetypeAccess: string;
  support: string;
  cta: { label: string; href: string };
  highlight?: boolean;
  oneTime?: boolean;
}

export const API_TIERS: ApiTier[] = [
  {
    id: 'trial-pack',
    name: 'Trial pack',
    monthlyUsd: 2.99,
    annualMonthlyEquivalentUsd: null,
    annualUsd: null,
    hoursLabel: '~16 hrs at $0.18/hr',
    overagePerHourUsd: null,
    concurrent: 1,
    archetypeAccess: 'All currently-available archetypes',
    support: 'Community',
    cta: { label: 'Get started', href: '/pricing#trial-pack' },
    oneTime: true,
  },
  {
    id: 'starter',
    name: 'Starter',
    monthlyUsd: 29,
    annualMonthlyEquivalentUsd: 23,
    annualUsd: 278,
    hoursLabel: '100 hrs/mo',
    overagePerHourUsd: 0.18,
    concurrent: 2,
    archetypeAccess: 'All currently-available archetypes',
    support: 'Email · 48h SLA',
    cta: { label: 'Choose Starter', href: '/pricing#trial-pack' },
  },
  {
    id: 'solo',
    name: 'Solo',
    monthlyUsd: 99,
    annualMonthlyEquivalentUsd: 79,
    annualUsd: 950,
    hoursLabel: '400 hrs/mo',
    overagePerHourUsd: 0.16,
    concurrent: 4,
    archetypeAccess: 'All currently-available archetypes',
    support: 'Email · 24h SLA',
    cta: { label: 'Choose Solo', href: '/pricing#trial-pack' },
  },
  {
    id: 'builder',
    name: 'Builder',
    monthlyUsd: 299,
    annualMonthlyEquivalentUsd: 239,
    annualUsd: 2_870,
    hoursLabel: '1,500 hrs/mo',
    overagePerHourUsd: 0.14,
    concurrent: 8,
    archetypeAccess: 'All available + 2 archetype slots',
    support: 'Email + Slack Connect · 12h SLA',
    cta: { label: 'Choose Builder', href: '/pricing#trial-pack' },
    highlight: true,
  },
  {
    id: 'scale',
    name: 'Scale',
    monthlyUsd: 999,
    annualMonthlyEquivalentUsd: 799,
    annualUsd: 9_590,
    hoursLabel: '6,000 hrs/mo',
    overagePerHourUsd: 0.12,
    concurrent: 24,
    archetypeAccess: 'All available + 3 archetype slots',
    support: 'Slack Connect · 4h SLA',
    cta: { label: 'Choose Scale', href: '/pricing#trial-pack' },
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    monthlyUsd: null,
    annualMonthlyEquivalentUsd: null,
    annualUsd: 2_500, // "from $2,500/mo annual only" — display as monthly equivalent
    hoursLabel: 'Custom',
    overagePerHourUsd: null,
    concurrent: 'Custom',
    archetypeAccess: 'All available + custom archetypes',
    support: 'Dedicated CSM · 1h SLA',
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
    id: 'self-hosted-solo',
    name: 'Self-Hosted Solo',
    monthlyUsd: 1_500,
    annualMonthlyEquivalentUsd: 1_200,
    hardwareRequired: 'Mac Mini M4 16 GB (customer-purchased)',
    concurrent: '4 concurrent',
    archetypeAccess: '1 archetype',
    minimumTerm: '3-month minimum',
    ctaHref: 'mailto:sales@driftstack.dev?subject=Self-Hosted%20Solo',
  },
  {
    id: 'self-hosted-pro',
    name: 'Self-Hosted Pro',
    monthlyUsd: 2_500,
    annualMonthlyEquivalentUsd: 2_000,
    hardwareRequired: 'Mac Studio M4 Max 36 GB',
    concurrent: '12–16 concurrent',
    archetypeAccess: '3 archetypes',
    minimumTerm: '3-month minimum',
    ctaHref: 'mailto:sales@driftstack.dev?subject=Self-Hosted%20Pro',
  },
  {
    id: 'self-hosted-enterprise',
    name: 'Self-Hosted Enterprise',
    monthlyUsd: null,
    annualMonthlyEquivalentUsd: 5_000,
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
  meterRate: '$0.18/hr (Starter rate)',
  hoursApprox: 16,
  windowDays: 14,
  concurrent: 1,
  oncePerAccount: true,
} as const;

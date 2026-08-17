// Locked pricing values — single source of truth for the marketing
// site. Per ADR-004 (two-ladder concurrent-only restructure,
// supersedes file-127 single-ladder hours-with-overage design).
// The perpetual free tier replaced the one-time trial pack 2026-05-27.
//
// Backend equivalent at apps/server/src/services/sessions.ts
// (TIER_CONCURRENT_SESSION_LIMITS, PROFILES_PER_TIER) per V-073.
// Both layers must agree on tier ids + concurrent caps + profile
// counts.
//
// V-075+ NOTE: schema folds the spec corrections from founder Tier 3
// review post-V-072 — `aiAgent` + `llmBilling` per-tier gating fields
// added; `concurrentCeiling` removed from self-hosted entirely
// (customer hardware bounds parallelism, not the license);
// self-hosted profile / archetype / multi-region / multi-node /
// custom-archetype-dev / support-tier / source-escrow fields
// expanded per the locked shape. Old field names retained where
// they still apply so the Tier 3 draft-surface review can focus on
// new fields + render structure.

// S43 2026-07-07 (founder-approved) — SLA alignment to ToS §9. The
// cloud-tier `support` strings previously carried a 48h/24h/12h/4h/1h
// per-tier reply-time "SLA" ladder. ToS §9.1 provides the Free,
// Manual-ladder (Personal, Team, Agency), API Starter, and API
// Builder tiers WITHOUT a contractually-binding SLA, so those tiers
// now state the support channel + the honest operational 48h target
// (same wording as the self-hosted SKUs' fmtSupportTier, per the
// 2026-05-19 founder verdict + the faq.ts "48h business-time across
// every tier" target). ToS §9.2 grants API Scale and Enterprise a
// contractual "first-response SLA on Severity-1 incidents of four (4)
// hours on API Scale and one (1) hour on Enterprise" — those two
// tiers state exactly that grant, no more.

export type TierType = 'free' | 'manual' | 'api';

/**
 * AI agent feature gating per ADR-004 + founder Tier 3 spec
 * (post-V-072). `null` for tiers where the feature is off entirely.
 */
export type LlmBilling = 'byok_only' | 'byok_or_bundled' | 'byok_or_bundled_custom' | null;

export interface ApiTier {
  id: string;
  /** Two-ladder discriminator for V-075+ section grouping. */
  tierType: TierType;
  name: string;
  monthlyUsd: number | null;
  annualMonthlyEquivalentUsd: number | null;
  annualUsd: number | null;
  /** Profile count limit (Manual-tier-defining). `'Custom'` for Enterprise. */
  profiles: number | string;
  hoursLabel: string;
  overagePerHourUsd: number | null;
  concurrent: number | string;
  archetypeAccess: string;
  support: string;
  audience: string;
  /** AI agent feature available on this tier? Per founder Tier 3 spec. */
  aiAgent: boolean;
  /** LLM billing model when aiAgent is true; `null` when aiAgent is false. */
  llmBilling: LlmBilling;
  cta: { label: string; href: string };
  highlight?: boolean;
  oneTime?: boolean;
}

export const API_TIERS: ApiTier[] = [
  // Free — perpetual entry tier (replaced the one-time trial_pack 2026-05-27).
  {
    id: 'free',
    tierType: 'free',
    name: 'Free',
    monthlyUsd: 0,
    annualMonthlyEquivalentUsd: null,
    annualUsd: null,
    profiles: 1,
    hoursLabel: '20-minute sessions',
    overagePerHourUsd: null,
    concurrent: 1,
    archetypeAccess: 'All currently-available archetypes',
    support: 'Community',
    audience: 'Evaluation (1 session, 20-min cap)',
    aiAgent: false,
    llmBilling: null,
    cta: { label: 'Get started — free', href: 'https://app.driftstack.dev/signup/' },
    oneTime: false,
  },

  // Manual ladder — humans clicking GUI client, persistent profiles.
  {
    id: 'solo_manual',
    tierType: 'manual',
    name: 'Personal',
    monthlyUsd: 79,
    annualMonthlyEquivalentUsd: 63,
    annualUsd: 758,
    profiles: 10,
    hoursLabel: 'Unlimited',
    overagePerHourUsd: null,
    concurrent: 1,
    archetypeAccess: 'All currently-available archetypes',
    support: 'Email · 48h target',
    audience: 'Solo power users, individual operators',
    aiAgent: false,
    llmBilling: null,
    cta: { label: 'Get started', href: 'https://app.driftstack.dev/signup/' },
  },
  {
    id: 'team_manual',
    tierType: 'manual',
    name: 'Team',
    monthlyUsd: 249,
    annualMonthlyEquivalentUsd: 199,
    annualUsd: 2_390,
    profiles: 50,
    hoursLabel: 'Unlimited',
    overagePerHourUsd: null,
    concurrent: 3,
    archetypeAccess: 'All currently-available archetypes',
    support: 'Email · 48h target',
    audience: 'Teams of account managers',
    aiAgent: true,
    llmBilling: 'byok_only',
    cta: { label: 'Get started', href: 'https://app.driftstack.dev/signup/' },
    highlight: true,
  },
  {
    id: 'agency_manual',
    tierType: 'manual',
    name: 'Agency',
    monthlyUsd: 699,
    annualMonthlyEquivalentUsd: 559,
    annualUsd: 6_710,
    profiles: 200,
    hoursLabel: 'Unlimited',
    overagePerHourUsd: null,
    concurrent: 8,
    archetypeAccess: 'All currently-available archetypes',
    support: 'Email + Slack Connect · 48h target',
    audience: 'Agencies juggling many client profiles',
    aiAgent: true,
    llmBilling: 'byok_only',
    cta: { label: 'Get started', href: 'https://app.driftstack.dev/signup/' },
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
    support: 'Email · 48h target',
    audience: 'Solo developers, evaluation-stage automation',
    aiAgent: true,
    llmBilling: 'byok_only',
    cta: { label: 'Get started', href: 'https://app.driftstack.dev/signup/' },
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
    support: 'Email + Slack Connect · 48h target',
    audience: 'Production automation at scale',
    aiAgent: true,
    llmBilling: 'byok_or_bundled',
    cta: { label: 'Get started', href: 'https://app.driftstack.dev/signup/' },
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
    support: 'Slack Connect · 4h Severity-1 first-response SLA',
    audience: 'High-volume automation running many sessions at once',
    aiAgent: true,
    llmBilling: 'byok_or_bundled',
    cta: { label: 'Get started', href: 'https://app.driftstack.dev/signup/' },
  },
  {
    id: 'enterprise',
    tierType: 'api',
    name: 'Enterprise',
    monthlyUsd: null,
    // Enterprise is annual-contracts-only with a negotiated floor. The
    // entry floor is "$4,000/mo on annual contracts", so the per-month
    // figure lives in annualMonthlyEquivalentUsd (12 × that = the yearly
    // total in annualUsd), mirroring the self_hosted_enterprise SKU.
    // annualUsd is a true YEARLY total on every tier, but eq × 12 only
    // reproduces it here and on the self-hosted SKUs; on the API ladder it
    // lands $2 low. tests/unit/pricing-annual-figures-are-derived.test.ts
    // carries both real rules.
    annualMonthlyEquivalentUsd: 4_000,
    annualUsd: 48_000,
    profiles: 'Custom',
    hoursLabel: 'Unlimited',
    overagePerHourUsd: null,
    concurrent: 'Custom',
    archetypeAccess: 'All available + custom archetypes',
    support: 'Dedicated CSM · 1h Severity-1 first-response SLA',
    audience: 'Custom negotiated contracts',
    aiAgent: true,
    llmBilling: 'byok_or_bundled_custom',
    cta: { label: 'Contact sales', href: 'mailto:sales@driftstack.dev' },
  },
];

/**
 * Self-hosted SKU — concurrent capacity is bounded by customer
 * hardware, NOT by license. Per founder Tier 3 spec post-V-072: no
 * `concurrentCeiling` field. Differentiation is by profile count,
 * archetype access, multi-region / multi-node deployment,
 * custom-archetype development, support tier, term, source escrow.
 */
export interface SelfHostedSku {
  id: string;
  name: string;
  monthlyUsd: number | null;
  annualMonthlyEquivalentUsd: number | null;
  annualUsd: number | null;
  /** Profile count limit. `null` = unlimited (Enterprise). */
  profilesMax: number | null;
  /** Archetype slot limit. `null` = unlimited (Enterprise). */
  archetypesMax: number | null;
  customArchetypeDevelopment: 'none' | 'limited' | 'unlimited';
  supportTier: 'email_48h' | 'email_slack_12h' | 'dedicated_csm_1h';
  minimumTermMonths: number;
  sourceEscrow: boolean;
  ctaHref: string;
}

// V-131: license-tier differentiators surfaced in the SKU comparison
// matrix on /pricing + /self-hosted. Stored here rather than as fields
// on the SelfHostedSku struct so the type stays narrow + so cosmetic
// label changes don't ripple into anything that consumes the type.
// Multi-region + multi-node-clustering were stripped here (V-131) —
// those were customer deployment choices, not license-tier gates.

// 2026-05-19 founder verdict — software updates, archetype updates,
// and source access are NOT differentiated by SKU. Every self-hosted
// customer receives the same iOS / Safari / archetype refresh cadence
// and the same source-access posture. SKU differentiation is
// concurrent-capacity-driven (number of Macs + Mac model), not
// software-feature-gated.
export const SELF_HOSTED_SOFTWARE_UPDATES: Record<string, string> = {
  self_hosted_solo: 'Continuous',
  self_hosted_pro: 'Continuous',
  self_hosted_enterprise: 'Continuous',
};

export const SELF_HOSTED_ARCHETYPE_UPDATES: Record<string, string> = {
  self_hosted_solo: 'All releases',
  self_hosted_pro: 'All releases',
  self_hosted_enterprise: 'All releases',
};

export const SELF_HOSTED_SOURCE_ACCESS: Record<string, string> = {
  self_hosted_solo: 'Compiled software (build artifacts)',
  self_hosted_pro: 'Compiled software (build artifacts)',
  self_hosted_enterprise: 'Compiled software + read-only source-code review access',
};

export const SELF_HOSTED_SKUS: SelfHostedSku[] = [
  {
    id: 'self_hosted_solo',
    name: 'Self-Hosted Solo',
    monthlyUsd: 1_000,
    annualMonthlyEquivalentUsd: 800,
    annualUsd: 9_600,
    profilesMax: 25,
    archetypesMax: 1,
    customArchetypeDevelopment: 'none',
    supportTier: 'email_48h',
    minimumTermMonths: 3,
    sourceEscrow: false,
    ctaHref: 'mailto:sales@driftstack.dev?subject=Self-Hosted%20Solo',
  },
  {
    id: 'self_hosted_pro',
    name: 'Self-Hosted Pro',
    monthlyUsd: 2_000,
    annualMonthlyEquivalentUsd: 1_600,
    annualUsd: 19_200,
    profilesMax: 100,
    archetypesMax: 3,
    customArchetypeDevelopment: 'limited',
    supportTier: 'email_slack_12h',
    minimumTermMonths: 3,
    sourceEscrow: false,
    ctaHref: 'mailto:sales@driftstack.dev?subject=Self-Hosted%20Pro',
  },
  {
    id: 'self_hosted_enterprise',
    name: 'Self-Hosted Enterprise',
    monthlyUsd: null,
    annualMonthlyEquivalentUsd: 4_000,
    annualUsd: 48_000,
    profilesMax: null,
    archetypesMax: null,
    customArchetypeDevelopment: 'unlimited',
    supportTier: 'dedicated_csm_1h',
    minimumTermMonths: 12,
    sourceEscrow: true,
    ctaHref: 'mailto:sales@driftstack.dev?subject=Self-Hosted%20Enterprise',
  },
];

export const ANNUAL_DISCOUNT_LABEL = '20% off annual';

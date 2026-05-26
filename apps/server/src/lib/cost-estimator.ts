// V-658 — cost estimator (V-541.B foundation).
//
// Pure functions that implement the cost-to-serve formula sketched in
// `docs/internal/v541-cost-monitoring-design.md`. The downstream
// service (V-541.B) wires these against the `sessions` + `usage_records`
// tables and persists the result into `cost_snapshots`; this module
// has zero DB dependencies so it can be tested + tuned independently.
//
// Everything in cents (integer math). Rates are passed in by the
// caller — the admin UI is the source of truth for re-tunable rates
// (per the V-541 design: "operator maintains this multiplier in admin
// config"). Hard-coding rates here would mean shipping a deploy on
// every Hetzner / R2 / Postmark price change.

export interface CostRates {
  /** Cents per Mac mini compute-minute. */
  computeCentsPerMinute: number;
  /** Cents per GB-month of R2 storage. */
  storageCentsPerGbMonth: number;
  /** Cents per GB of TURN egress (post-V-531). */
  egressCentsPerGb: number;
  /** Cents per Postmark transactional email sent. */
  emailCentsPerSend: number;
  /** Cents per 1k LLM input tokens (sub-processor v1 — pass-through). */
  llmCentsPer1kInputTokens: number;
  /** Cents per 1k LLM output tokens. */
  llmCentsPer1kOutputTokens: number;
}

export interface UsageInputs {
  /** Total session-minutes consumed in the billing cycle. */
  sessionMinutes: number;
  /** Average R2 storage in GB-months over the cycle. */
  storageGbMonths: number;
  /** TURN egress GB in the cycle. */
  egressGb: number;
  /** Postmark sends in the cycle. */
  emailSends: number;
  /** LLM input tokens (sub-processor). */
  llmInputTokens: number;
  /** LLM output tokens. */
  llmOutputTokens: number;
}

export interface AlertThresholds {
  /** Cents. Soft warn threshold — informational. */
  softCents: number;
  /** Cents. Hard cap — paging threshold. */
  hardCents: number;
}

export type ThresholdState = 'under-soft' | 'between-soft-and-hard' | 'over-hard';

export interface CostBreakdown {
  computeCents: number;
  storageCents: number;
  egressCents: number;
  emailCents: number;
  llmCents: number;
  /** Sum of all sub-components. */
  totalCents: number;
  /** Where this account sits against its configured thresholds. */
  thresholdState: ThresholdState;
}

/**
 * Compute a per-account cost breakdown for one billing cycle.
 *
 * All arithmetic is rounded to the nearest cent via `Math.round`,
 * which is round-half-up (ties round toward +Infinity), NOT banker's
 * round-half-to-even. Negative inputs are clamped to 0 — usage data
 * should never be negative, but a corrupt input shouldn't produce
 * nonsense negative cost.
 */
export function estimateCost(
  usage: UsageInputs,
  rates: CostRates,
  thresholds: AlertThresholds,
): CostBreakdown {
  const sessionMinutes = clampNonNegative(usage.sessionMinutes);
  const storageGbMonths = clampNonNegative(usage.storageGbMonths);
  const egressGb = clampNonNegative(usage.egressGb);
  const emailSends = clampNonNegative(usage.emailSends);
  const llmInputTokens = clampNonNegative(usage.llmInputTokens);
  const llmOutputTokens = clampNonNegative(usage.llmOutputTokens);

  const computeCents = Math.round(sessionMinutes * rates.computeCentsPerMinute);
  const storageCents = Math.round(storageGbMonths * rates.storageCentsPerGbMonth);
  const egressCents = Math.round(egressGb * rates.egressCentsPerGb);
  const emailCents = Math.round(emailSends * rates.emailCentsPerSend);
  const llmCents = Math.round(
    (llmInputTokens / 1000) * rates.llmCentsPer1kInputTokens +
      (llmOutputTokens / 1000) * rates.llmCentsPer1kOutputTokens,
  );

  const totalCents = computeCents + storageCents + egressCents + emailCents + llmCents;

  return {
    computeCents,
    storageCents,
    egressCents,
    emailCents,
    llmCents,
    totalCents,
    thresholdState: classifyThreshold(totalCents, thresholds),
  };
}

export function classifyThreshold(totalCents: number, thresholds: AlertThresholds): ThresholdState {
  if (totalCents >= thresholds.hardCents) return 'over-hard';
  if (totalCents >= thresholds.softCents) return 'between-soft-and-hard';
  return 'under-soft';
}

/**
 * Default per-tier alert thresholds in cents. V-541 design called for
 * "per-tier alert thresholds hard-coded" in v1 with admin-override
 * landing in V-541.C; these constants are the v1 defaults. Currency:
 * EUR (V-541 open-question recommendation accepted in W44).
 */
export const DEFAULT_TIER_THRESHOLDS: Record<string, AlertThresholds> = {
  solo_manual: { softCents: 1500, hardCents: 3000 }, // €15 / €30
  team_manual: { softCents: 5000, hardCents: 10000 },
  agency_manual: { softCents: 20000, hardCents: 40000 },
  api_starter: { softCents: 3000, hardCents: 6000 },
  api_builder: { softCents: 15000, hardCents: 30000 },
  api_scale: { softCents: 75000, hardCents: 150000 },
};

function clampNonNegative(x: number): number {
  return Number.isFinite(x) && x > 0 ? x : 0;
}

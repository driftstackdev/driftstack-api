// V-541.F — production defaults for cost rates + tier thresholds.
//
// The estimator (V-658) is pure — it accepts rates + thresholds as
// inputs so tests and tooling can sweep alternative configurations.
// Production wiring needs concrete defaults; before this module they
// lived as inline literals in tests / fixtures, which drifts the
// "what we actually deploy" from "what we test." Centralising them
// here means a rate change is one edit + a runbook entry.
//
// Posture: rates are an internal accounting concept (cost-to-serve);
// they do NOT drive customer pricing. Pricing lives in
// `packages/api-types` (tier configs) + the Stripe price-list. These
// numbers anchor the V-541 cost-monitoring alerting only.

import type { AccountTier } from '@driftstack/api-types';
import type { AlertThresholds, CostRates } from './cost-estimator.js';

/**
 * V-541.F — production cost rates. Currency: EUR cents.
 *
 * Source spreadsheet: `docs/internal/v541-cost-monitoring-design.md`,
 * "Default rate card v1 (W44 review)." Rates re-reviewed quarterly
 * against actual invoices from Hetzner / Cloudflare R2 / Postmark /
 * OpenAI; bump this constant + add an entry to the cost-monitoring
 * runbook when a sub-processor price changes meaningfully.
 */
export const DEFAULT_COST_RATES: CostRates = {
  // Hetzner CCX13 averaged across the fleet, divided by minutes-per-month.
  computeCentsPerMinute: 0.05,
  // R2 €0.015/GB-month list price.
  storageCentsPerGbMonth: 1.5,
  // TURN egress €0.05/GB after V-531 free-tier discount.
  egressCentsPerGb: 5,
  // Postmark transactional bulk rate, €0.001/send.
  emailCentsPerSend: 0.1,
  // OpenAI 4o-mini input list price ~€0.15/1M = 0.015c/1k.
  llmCentsPer1kInputTokens: 0.015,
  // OpenAI 4o-mini output list price ~€0.60/1M = 0.06c/1k.
  llmCentsPer1kOutputTokens: 0.06,
};

/**
 * V-541.F — tier monthly prices used to derive default thresholds.
 * Mirrors `packages/api-types` tier-pricing where it exists; tiers
 * not on Stripe (e.g. the future api_pro tier) get a placeholder
 * so the derive helper doesn't break.
 */
export const TIER_MONTHLY_PRICE_CENTS: Partial<Record<AccountTier, number>> = {
  solo_manual: 2500, // €25/mo
  team_manual: 8000, // €80/mo
  agency_manual: 30000, // €300/mo
  api_starter: 5000, // €50/mo
  api_builder: 25000, // €250/mo
  api_scale: 100000, // €1000/mo
};

/**
 * V-541.F — derive (softCents, hardCents) from a tier's monthly
 * subscription price using the runbook formula:
 *
 *   softCents = round(P × 0.6)
 *   hardCents = round(P × 0.9)
 *
 * Soft = "approaching the operator-tolerated cost ceiling."
 * Hard = "10% margin between cost-to-serve and revenue."
 *
 * The runbook (`docs/runbooks/cost-monitoring.md`) documents this
 * rationale; tweaking the multipliers means editing both this file
 * AND the runbook so the operator's interpretation stays in sync.
 */
export function deriveThresholdsFromMonthlyPrice(monthlyPriceCents: number): AlertThresholds {
  return {
    softCents: Math.round(monthlyPriceCents * 0.6),
    hardCents: Math.round(monthlyPriceCents * 0.9),
  };
}

/**
 * V-541.F — derived defaults built from the tier-price table. Use
 * this in production wiring as the `tierThresholds` for
 * CostMonitoringService. Tests + tooling can still pass alternative
 * maps to sweep configurations.
 *
 * Compared with the in-estimator DEFAULT_TIER_THRESHOLDS, this map
 * is derived (price-driven) rather than hand-tuned. Both are
 * intentionally kept around: the estimator's defaults exist so the
 * pure module is self-contained, this map exists so production
 * wiring is anchored to tier pricing.
 */
export const DEFAULT_TIER_THRESHOLDS_DERIVED: Record<string, AlertThresholds> = Object.fromEntries(
  Object.entries(TIER_MONTHLY_PRICE_CENTS).map(([tier, price]) => [
    tier,
    deriveThresholdsFromMonthlyPrice(price),
  ]),
);

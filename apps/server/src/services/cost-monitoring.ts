// V-541.B — cost-monitoring service.
//
// Compute-on-demand per-account cost breakdown for the V-541 admin
// surface. Wraps the V-658 estimator + a pluggable usage aggregator.
//
// V-541.B posture: no persistence (no `cost_snapshots` table yet —
// V-541.C's job). Every call recomputes from the underlying usage
// data. Cost-of-recompute is bounded by the per-account usage row
// count, which is small enough that compute-on-demand is acceptable
// for admin-tool use (one operator, occasional queries).

import {
  DEFAULT_TIER_THRESHOLDS,
  estimateCost,
  type AlertThresholds,
  type CostBreakdown,
  type CostRates,
  type UsageInputs,
} from '../lib/cost-estimator.js';

export interface UsageAggregator {
  /**
   * Aggregate usage for a single account over the requested billing
   * cycle. Returns null when the account doesn't exist or has no
   * usage in the cycle.
   */
  aggregateForAccount(args: {
    accountId: string;
    billingCycle: string; // 'YYYY-MM'
  }): Promise<UsageInputs | null>;
}

export interface CostMonitoringAccountSummary {
  account_id: string;
  billing_cycle: string;
  breakdown: CostBreakdown;
  tier: string;
  thresholds: AlertThresholds;
}

export interface CostMonitoringServiceOpts {
  aggregator: UsageAggregator;
  rates: CostRates;
  /** Per-tier thresholds. Defaults to V-658 DEFAULT_TIER_THRESHOLDS. */
  tierThresholds?: Record<string, AlertThresholds>;
  /**
   * Resolve a tier label for a given account id. Production wires this
   * to AccountAuthRepo / accounts table; tests pass a stub map.
   */
  resolveTier: (accountId: string) => Promise<string | null>;
}

export class CostMonitoringService {
  constructor(private readonly opts: CostMonitoringServiceOpts) {}

  async getAccountSummary(args: {
    accountId: string;
    billingCycle: string;
  }): Promise<CostMonitoringAccountSummary | null> {
    const usage = await this.opts.aggregator.aggregateForAccount(args);
    if (usage === null) return null;
    const tier = await this.opts.resolveTier(args.accountId);
    if (tier === null) return null;
    const thresholds = (this.opts.tierThresholds ?? DEFAULT_TIER_THRESHOLDS)[tier] ??
      DEFAULT_TIER_THRESHOLDS.api_starter ?? { softCents: 0, hardCents: 0 };
    return {
      account_id: args.accountId,
      billing_cycle: args.billingCycle,
      breakdown: estimateCost(usage, this.opts.rates, thresholds),
      tier,
      thresholds,
    };
  }

  /**
   * Compute summaries for many accounts in one call. Caller passes
   * the id list (typically the result of an `accounts` table list).
   * Accounts with no usage in the cycle are omitted from the result.
   */
  async getOverview(args: {
    accountIds: readonly string[];
    billingCycle: string;
  }): Promise<readonly CostMonitoringAccountSummary[]> {
    const results: CostMonitoringAccountSummary[] = [];
    for (const id of args.accountIds) {
      const summary = await this.getAccountSummary({
        accountId: id,
        billingCycle: args.billingCycle,
      });
      if (summary !== null) results.push(summary);
    }
    // Sort by total cost descending so the admin's "who's expensive" eye
    // hits the top of the list first.
    return [...results].sort((a, b) => b.breakdown.totalCents - a.breakdown.totalCents);
  }
}

/**
 * Build a YYYY-MM billing-cycle label from a Date (UTC).
 */
export function billingCycleFromDate(d: Date): string {
  const y = d.getUTCFullYear().toString();
  const m = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  return `${y}-${m}`;
}

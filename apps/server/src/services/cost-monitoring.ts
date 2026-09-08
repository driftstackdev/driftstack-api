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
import { PURCHASABLE_TIERS } from '@driftstack/api-types';

/**
 * The tiers that legitimately have NO cost-alert policy: every AccountTier
 * that is NOT self-serve purchasable — `free` (perpetual, unbilled) and
 * `enterprise` (negotiated, no price-derived threshold). Their thresholds are
 * deliberately absent, so the single-account path fails closed on them. The
 * batch `getOverview` path uses this set to SKIP them instead (see there);
 * a *purchasable* tier missing its thresholds is a genuine misconfiguration
 * and still throws. Derived from the invariant-locked PURCHASABLE_TIERS
 * (see `the-purchasable-product-set-is-one-set`), so a future price-less tier
 * is covered without editing this file.
 */
const PURCHASABLE_TIER_SET: ReadonlySet<string> = new Set<string>(PURCHASABLE_TIERS);

/**
 * Canonical public billing-cycle grammar. Both customer and admin routes use
 * this exact authority so an impossible calendar month can never reach the
 * usage aggregator as a plausible cycle.
 */
export const BILLING_CYCLE_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])$/;

/**
 * Configuration fault, not an absent account or an empty usage cycle.
 *
 * Callers deliberately let this fail closed: borrowing another tier's
 * threshold would misclassify spend and could emit a false operator alert.
 */
export class CostThresholdConfigurationError extends Error {
  readonly tier: string;

  constructor(tier: string) {
    super(`No cost alert thresholds are configured for tier "${tier}".`);
    this.name = 'CostThresholdConfigurationError';
    this.tier = tier;
  }
}

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
    const tier = await this.opts.resolveTier(args.accountId);
    if (tier === null) return null;
    const thresholds = (this.opts.tierThresholds ?? DEFAULT_TIER_THRESHOLDS)[tier];
    if (thresholds === undefined) {
      throw new CostThresholdConfigurationError(tier);
    }
    const usage = await this.opts.aggregator.aggregateForAccount(args);
    if (usage === null) return null;
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
  /**
   * V-683 — return the rates + tier-threshold table currently
   * wired into this service so admin tooling can verify what's in
   * production. Read-only; no usage data is accessed.
   */
  getConfig(): { rates: CostRates; tierThresholds: Record<string, AlertThresholds> } {
    return {
      rates: this.opts.rates,
      tierThresholds: this.opts.tierThresholds ?? DEFAULT_TIER_THRESHOLDS,
    };
  }

  async getOverview(args: {
    accountIds: readonly string[];
    billingCycle: string;
  }): Promise<readonly CostMonitoringAccountSummary[]> {
    const results: CostMonitoringAccountSummary[] = [];
    for (const id of args.accountIds) {
      let summary: CostMonitoringAccountSummary | null;
      try {
        summary = await this.getAccountSummary({
          accountId: id,
          billingCycle: args.billingCycle,
        });
      } catch (err) {
        // A tier that LEGITIMATELY has no cost-alert policy — the
        // non-purchasable tiers `free` (unbilled) and `enterprise` (negotiated,
        // no derived threshold) — throws CostThresholdConfigurationError from
        // the fail-closed getAccountSummary path. In a BATCH overview that is
        // NOT a fault: the account has no threshold to breach, so skip it and
        // keep evaluating the rest. Before this, one such account aborted the
        // whole overview — and, via the nightly CostAlertDispatcher, silently
        // killed cost-alert recompute for the ENTIRE fleet every night (the
        // fleet always contains a free account, so the tick threw before
        // evaluating anyone). A *purchasable* tier missing its thresholds IS a
        // genuine misconfiguration: re-throw so it stays loud (fail-closed)
        // rather than silently never alerting a paying account. Single-account
        // callers (customer + admin `/accounts/:id`) still fail closed — they
        // call getAccountSummary directly and never reach this catch.
        if (err instanceof CostThresholdConfigurationError && !PURCHASABLE_TIER_SET.has(err.tier)) {
          continue;
        }
        throw err;
      }
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

// V-541.H — production UsageAggregator wiring the V-541.B cost
// monitoring service to real usage data from the V-073 UsageRepo.
//
// The cost estimator's UsageInputs has six dimensions:
//   sessionMinutes / storageGbMonths / egressGb / emailSends /
//   llmInputTokens / llmOutputTokens
//
// Today, the only one we have a per-account ledger for is
// session_minute (UsageRecordType). The other dimensions need
// per-account meters we haven't built yet:
//   - storage:  per-account R2 quota (V-541.I follow-up)
//   - egress:   TURN / R2 egress meter (V-531 follow-up)
//   - email:    Postmark fan-out is account-level but not yet
//               aggregated into usage_records (V-541.J follow-up)
//   - llm:      sub-processor tokens are accounted-for in the
//               LLM-billing module (V-487) but not yet rolled
//               into usage_records (V-541.K follow-up)
//
// For now, the aggregator fills sessionMinutes from real data and
// returns zero for the rest. That matches the customer-facing
// /v1/account/cost contract — the customer sees a real compute
// number + zeros for the other lines until the meters land. The
// V-541.G prod bootstrap can swap its stub aggregator for this
// implementation when the founder is ready to expose real numbers
// to customers.

import type { UsageInputs } from '../lib/cost-estimator.js';
import type { UsageAggregator } from './cost-monitoring.js';
import type { UsageRepo } from './usage.js';

export interface UsageAggregatorFromUsageRepoOpts {
  repo: UsageRepo;
}

export class UsageAggregatorFromUsageRepo implements UsageAggregator {
  constructor(private readonly opts: UsageAggregatorFromUsageRepoOpts) {}

  /**
   * Compute the UsageInputs envelope for a single account over a
   * billing-cycle window. The window math:
   *
   *   billing_cycle 'YYYY-MM' → [start of that UTC month, start of next)
   *
   * Returns null when the account has zero usage rows in the window
   * — the caller (CostMonitoringService) interprets null as "no
   * usage in cycle" and returns synthetic-zero to the customer.
   */
  async aggregateForAccount(args: {
    accountId: string;
    billingCycle: string;
  }): Promise<UsageInputs | null> {
    const window = billingCycleWindow(args.billingCycle);
    if (window === null) return null;
    const totals = await this.opts.repo.totalsForPeriod(args.accountId, window.start, window.end);
    const sessionMinutes = totals.totals.session_minute ?? 0;
    if (sessionMinutes === 0) return null;
    return {
      sessionMinutes,
      // V-541.I/J/K follow-ups — zero placeholders until the meters
      // for these dimensions exist at the per-account granularity.
      storageGbMonths: 0,
      egressGb: 0,
      emailSends: 0,
      llmInputTokens: 0,
      llmOutputTokens: 0,
    };
  }
}

/**
 * Parse a billing_cycle string ('YYYY-MM') into a [start, end) UTC
 * Date pair. Returns null for malformed input (callers treat as no
 * usage rather than throwing — admin tools display a friendlier
 * error than a 500).
 */
export function billingCycleWindow(billingCycle: string): { start: Date; end: Date } | null {
  const match = /^(\d{4})-(\d{2})$/.exec(billingCycle);
  if (!match) return null;
  const year = Number.parseInt(match[1] ?? '', 10);
  const month = Number.parseInt(match[2] ?? '', 10);
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
    return null;
  }
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));
  return { start, end };
}

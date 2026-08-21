// In-memory UsageRepo for integration tests.

import type {
  UsageDailyBucket,
  UsageRecordType,
  UsageRepo,
  UsageTotals,
} from '../../../src/services/usage.js';
import {
  INTERNAL_RECORD_TYPES as REPO_INTERNAL_RECORD_TYPES,
  LIFECYCLE_DERIVED_RECORD_TYPE as REPO_LIFECYCLE_DERIVED_RECORD_TYPE,
} from '../../../src/db/usage-repo.js';

export interface UsageEvent {
  accountId: string;
  recordType: UsageRecordType;
  quantity: number;
  recordedAt: Date;
}

/**
 * V-1217 — mirrors DrizzleUsageRepo. `session_minute` is LIFECYCLE-DERIVED: production computes it
 * from real session lifetimes in the `sessions` table and never sums stored `session_minute` usage
 * rows, so summing them here reported minutes production would not. The two `agent_decomposer`
 * types are internal accounting and are excluded outright with nothing added back.
 *
 * LIMITATION, stated rather than hidden: this double has no sessions to derive minutes FROM, so it
 * omits `session_minute` entirely where production would report a derived figure. Excluding the
 * stored rows makes the two agree about what must NOT be counted; it does not make this double a
 * source of lifecycle minutes, and a test needing those has to use the real repo.
 */
// V-1262 — both sets are read from DrizzleUsageRepo rather than restated. They used to be
// local copies of the same two decisions, correct only for as long as nobody moved either.
const LIFECYCLE_DERIVED_RECORD_TYPE: string = REPO_LIFECYCLE_DERIVED_RECORD_TYPE;
const INTERNAL_RECORD_TYPES: readonly string[] = REPO_INTERNAL_RECORD_TYPES;

function isExcludedFromAggregation(recordType: string): boolean {
  return recordType === LIFECYCLE_DERIVED_RECORD_TYPE || INTERNAL_RECORD_TYPES.includes(recordType);
}

export class InMemoryUsageRepo implements UsageRepo {
  private readonly events: UsageEvent[] = [];

  record(event: UsageEvent): void {
    this.events.push(event);
  }

  totalsForPeriod(accountId: string, periodStart: Date, periodEnd: Date): Promise<UsageTotals> {
    const totals: Partial<Record<UsageRecordType, number>> = {};
    for (const e of this.events) {
      if (e.accountId !== accountId) continue;
      if (e.recordedAt < periodStart || e.recordedAt >= periodEnd) continue;
      if (isExcludedFromAggregation(e.recordType)) continue;
      totals[e.recordType] = (totals[e.recordType] ?? 0) + e.quantity;
    }
    return Promise.resolve({ totals });
  }

  dailyBucketsForRange(
    accountId: string,
    fromDate: Date,
    toDate: Date,
  ): Promise<readonly UsageDailyBucket[]> {
    const byDate = new Map<string, Partial<Record<UsageRecordType, number>>>();
    for (const e of this.events) {
      if (e.accountId !== accountId) continue;
      if (e.recordedAt < fromDate || e.recordedAt >= toDate) continue;
      if (isExcludedFromAggregation(e.recordType)) continue;
      const dateStr = e.recordedAt.toISOString().slice(0, 10);
      const bucket = byDate.get(dateStr) ?? {};
      bucket[e.recordType] = (bucket[e.recordType] ?? 0) + e.quantity;
      byDate.set(dateStr, bucket);
    }
    const buckets = Array.from(byDate.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, totals]) => ({ date, totals }));
    return Promise.resolve(buckets);
  }
}

// Drizzle-backed implementation of UsageRepo.

import { and, eq, gte, lt, ne, sql } from 'drizzle-orm';
import type {
  UsageDailyBucket,
  UsageRecordType,
  UsageRepo,
  UsageTotals,
} from '../services/usage.js';
import type { Database } from './client.js';
import { usageRecords } from './schema.js';

// v2-#4 Q.1.e — `agent_decomposer` rows are server-internal cost
// telemetry per founder verdict "cost-tracked, unbilled at v1.0".
// The customer-facing UsageRecordType union excludes this value;
// filter at the repo so customer aggregations + tier-quota math
// don't accidentally surface internal cost data on the dashboard.
const INTERNAL_RECORD_TYPES = ['agent_decomposer'] as const;

export class DrizzleUsageRepo implements UsageRepo {
  constructor(private readonly database: Database) {}

  async totalsForPeriod(
    accountId: string,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<UsageTotals> {
    const rows = await this.database.db
      .select({
        recordType: usageRecords.recordType,
        total: sql<number>`coalesce(sum(${usageRecords.quantity}), 0)::int`,
      })
      .from(usageRecords)
      .where(
        and(
          eq(usageRecords.accountId, accountId),
          gte(usageRecords.recordedAt, periodStart),
          lt(usageRecords.recordedAt, periodEnd),
          ne(usageRecords.recordType, INTERNAL_RECORD_TYPES[0]),
        ),
      )
      .groupBy(usageRecords.recordType);

    const totals: Partial<Record<UsageRecordType, number>> = {};
    for (const row of rows) {
      // Defensive: the SQL ne() filter excludes internal types, but if
      // a future row leaks through, drop it here so the customer-
      // facing type stays narrowed.
      if ((INTERNAL_RECORD_TYPES as readonly string[]).includes(row.recordType)) continue;
      totals[row.recordType as UsageRecordType] = row.total;
    }
    return { totals };
  }

  async dailyBucketsForRange(
    accountId: string,
    fromDate: Date,
    toDate: Date,
  ): Promise<readonly UsageDailyBucket[]> {
    // GROUP BY (date_trunc('day', recorded_at), record_type) with the
    // existing (account_id, recorded_at) index. UTC-day truncation
    // matches the API contract.
    const rows = await this.database.db
      .select({
        day: sql<string>`to_char(date_trunc('day', ${usageRecords.recordedAt} AT TIME ZONE 'UTC'), 'YYYY-MM-DD')`,
        recordType: usageRecords.recordType,
        total: sql<number>`coalesce(sum(${usageRecords.quantity}), 0)::int`,
      })
      .from(usageRecords)
      .where(
        and(
          eq(usageRecords.accountId, accountId),
          gte(usageRecords.recordedAt, fromDate),
          lt(usageRecords.recordedAt, toDate),
          ne(usageRecords.recordType, INTERNAL_RECORD_TYPES[0]),
        ),
      )
      .groupBy(
        sql`date_trunc('day', ${usageRecords.recordedAt} AT TIME ZONE 'UTC')`,
        usageRecords.recordType,
      );

    const byDate = new Map<string, Partial<Record<UsageRecordType, number>>>();
    for (const row of rows) {
      if ((INTERNAL_RECORD_TYPES as readonly string[]).includes(row.recordType)) continue;
      const bucket = byDate.get(row.day) ?? {};
      bucket[row.recordType as UsageRecordType] = row.total;
      byDate.set(row.day, bucket);
    }
    return Array.from(byDate.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, totals]) => ({ date, totals }));
  }
}

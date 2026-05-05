// Drizzle-backed implementation of UsageRepo.

import { and, eq, gte, lt, sql } from 'drizzle-orm';
import type {
  UsageDailyBucket,
  UsageRecordType,
  UsageRepo,
  UsageTotals,
} from '../services/usage.js';
import type { Database } from './client.js';
import { usageRecords } from './schema.js';

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
        ),
      )
      .groupBy(usageRecords.recordType);

    const totals: Partial<Record<UsageRecordType, number>> = {};
    for (const row of rows) {
      totals[row.recordType] = row.total;
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
        ),
      )
      .groupBy(
        sql`date_trunc('day', ${usageRecords.recordedAt} AT TIME ZONE 'UTC')`,
        usageRecords.recordType,
      );

    const byDate = new Map<string, Partial<Record<UsageRecordType, number>>>();
    for (const row of rows) {
      const bucket = byDate.get(row.day) ?? {};
      bucket[row.recordType] = row.total;
      byDate.set(row.day, bucket);
    }
    return Array.from(byDate.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, totals]) => ({ date, totals }));
  }
}

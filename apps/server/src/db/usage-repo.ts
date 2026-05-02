// Drizzle-backed implementation of UsageRepo.

import { and, eq, gte, lt, sql } from 'drizzle-orm';
import type { UsageRecordType, UsageRepo, UsageTotals } from '../services/usage.js';
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
}

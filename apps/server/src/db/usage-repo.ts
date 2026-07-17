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
// Arc 1 sub-slice 6.4 (v2-#6) — `agent_decomposer_bundled` joins the
// same filter set. The bundled-LLM status endpoint (sub-slice 6.7) is
// the customer-visible surface for these rows; the generic /v1/usage
// summary keeps the same shape it has today.
const INTERNAL_RECORD_TYPES = ['agent_decomposer', 'agent_decomposer_bundled'] as const;
// Production never had a complete session-minute writer. Lifecycle rows are
// the durable authority; old/manual ledger rows must not double-count them.
const LIFECYCLE_DERIVED_RECORD_TYPE = 'session_minute' as const;

interface LifecycleMinutesRow {
  total_minutes: number;
}

interface LifecycleDailyMinutesRow extends LifecycleMinutesRow {
  day: string;
}

export class DrizzleUsageRepo implements UsageRepo {
  constructor(
    private readonly database: Database,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async totalsForPeriod(
    accountId: string,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<UsageTotals> {
    const asOf = this.clock();
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
          ne(usageRecords.recordType, LIFECYCLE_DERIVED_RECORD_TYPE),
          ne(usageRecords.recordType, INTERNAL_RECORD_TYPES[0]),
          ne(usageRecords.recordType, INTERNAL_RECORD_TYPES[1]),
        ),
      )
      .groupBy(usageRecords.recordType);

    const periodStartIso = periodStart.toISOString();
    const periodEndIso = periodEnd.toISOString();
    const asOfIso = asOf.toISOString();
    const lifecycleRows = await this.database.client<LifecycleMinutesRow[]>`
      WITH lifecycle_intervals AS (
        SELECT
          created_at AS started_at,
          CASE
            WHEN destroyed_at IS NOT NULL THEN destroyed_at
            WHEN status IN ('destroyed', 'errored') THEN updated_at
            ELSE ${asOfIso}::timestamptz
          END AS ended_at
        FROM sessions
        WHERE account_id = ${accountId}::uuid
          AND driver_session_id NOT LIKE 'reserving:%'

        UNION ALL

        SELECT
          created_at AS started_at,
          CASE
            WHEN closed_at IS NOT NULL THEN closed_at
            WHEN status = 'closed' THEN updated_at
            ELSE ${asOfIso}::timestamptz
          END AS ended_at
        FROM agent_sessions
        WHERE account_id = ${accountId}::uuid
          AND node_id IS NOT NULL
          AND driftstack_session_id IS NULL
      )
      SELECT floor(
        coalesce(
          sum(
            extract(
              epoch FROM (
                least(ended_at, ${periodEndIso}::timestamptz, ${asOfIso}::timestamptz)
                - greatest(started_at, ${periodStartIso}::timestamptz)
              )
            )
          ),
          0
        ) / 60
      )::int AS total_minutes
      FROM lifecycle_intervals
      WHERE greatest(started_at, ${periodStartIso}::timestamptz)
        < least(ended_at, ${periodEndIso}::timestamptz, ${asOfIso}::timestamptz)
    `;

    const totals: Partial<Record<UsageRecordType, number>> = {};
    for (const row of rows) {
      // Defend the source boundary in JS as well as SQL. In particular, a
      // legacy session_minute ledger row must never replace lifecycle truth.
      if (
        row.recordType === LIFECYCLE_DERIVED_RECORD_TYPE ||
        (INTERNAL_RECORD_TYPES as readonly string[]).includes(row.recordType)
      ) {
        continue;
      }
      totals[row.recordType as UsageRecordType] = row.total;
    }
    totals.session_minute = lifecycleRows[0]?.total_minutes ?? 0;
    return { totals };
  }

  async dailyBucketsForRange(
    accountId: string,
    fromDate: Date,
    toDate: Date,
  ): Promise<readonly UsageDailyBucket[]> {
    const asOf = this.clock();
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
          ne(usageRecords.recordType, LIFECYCLE_DERIVED_RECORD_TYPE),
          ne(usageRecords.recordType, INTERNAL_RECORD_TYPES[0]),
          ne(usageRecords.recordType, INTERNAL_RECORD_TYPES[1]),
        ),
      )
      .groupBy(
        sql`date_trunc('day', ${usageRecords.recordedAt} AT TIME ZONE 'UTC')`,
        usageRecords.recordType,
      );

    const fromDateIso = fromDate.toISOString();
    const toDateIso = toDate.toISOString();
    const asOfIso = asOf.toISOString();
    const lifecycleRows = await this.database.client<LifecycleDailyMinutesRow[]>`
      WITH days AS (
        SELECT day_start_utc AT TIME ZONE 'UTC' AS day_start
        FROM generate_series(
          ${fromDateIso}::timestamptz AT TIME ZONE 'UTC',
          (${toDateIso}::timestamptz AT TIME ZONE 'UTC') - interval '24 hours',
          interval '24 hours'
        ) AS day_start_utc
      ),
      lifecycle_intervals AS (
        SELECT
          created_at AS started_at,
          CASE
            WHEN destroyed_at IS NOT NULL THEN destroyed_at
            WHEN status IN ('destroyed', 'errored') THEN updated_at
            ELSE ${asOfIso}::timestamptz
          END AS ended_at
        FROM sessions
        WHERE account_id = ${accountId}::uuid
          AND driver_session_id NOT LIKE 'reserving:%'

        UNION ALL

        SELECT
          created_at AS started_at,
          CASE
            WHEN closed_at IS NOT NULL THEN closed_at
            WHEN status = 'closed' THEN updated_at
            ELSE ${asOfIso}::timestamptz
          END AS ended_at
        FROM agent_sessions
        WHERE account_id = ${accountId}::uuid
          AND node_id IS NOT NULL
          AND driftstack_session_id IS NULL
      )
      SELECT
        to_char(days.day_start AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
        floor(
          sum(
            extract(
              epoch FROM (
                least(
                  lifecycle_intervals.ended_at,
                  days.day_start + interval '24 hours',
                  ${toDateIso}::timestamptz,
                  ${asOfIso}::timestamptz
                )
                - greatest(
                  lifecycle_intervals.started_at,
                  days.day_start,
                  ${fromDateIso}::timestamptz
                )
              )
            )
          ) / 60
        )::int AS total_minutes
      FROM days
      JOIN lifecycle_intervals
        ON greatest(
          lifecycle_intervals.started_at,
          days.day_start,
          ${fromDateIso}::timestamptz
        ) < least(
          lifecycle_intervals.ended_at,
          days.day_start + interval '24 hours',
          ${toDateIso}::timestamptz,
          ${asOfIso}::timestamptz
        )
      GROUP BY days.day_start
      ORDER BY days.day_start ASC
    `;

    const byDate = new Map<string, Partial<Record<UsageRecordType, number>>>();
    for (const row of rows) {
      if (
        row.recordType === LIFECYCLE_DERIVED_RECORD_TYPE ||
        (INTERNAL_RECORD_TYPES as readonly string[]).includes(row.recordType)
      ) {
        continue;
      }
      const bucket = byDate.get(row.day) ?? {};
      bucket[row.recordType as UsageRecordType] = row.total;
      byDate.set(row.day, bucket);
    }
    for (const row of lifecycleRows) {
      if (row.total_minutes <= 0) continue;
      const bucket = byDate.get(row.day) ?? {};
      bucket.session_minute = row.total_minutes;
      byDate.set(row.day, bucket);
    }
    return Array.from(byDate.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, totals]) => ({ date, totals }));
  }
}

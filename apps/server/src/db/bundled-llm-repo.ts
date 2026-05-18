// Arc 1 sub-slice 6.3 (v2-#6) — Drizzle-backed BundledLlmRepo.
//
// Reads bundled_llm_consent + bundled_llm_monthly_cap_usd_cents off
// the accounts row via a single SELECT. Returns null when the account
// row is missing (caller treats as consent=false).
//
// Arc 1 sub-slice 6.5 (v2-#6) — also exposes
// sumMonthlySpendCents(accountId, now) for the soft-cap pre-turn
// check. Sums usage_records.cost_usd_cents over the current calendar
// month for bundled-LLM rows only.

import { and, eq, gte, sql } from 'drizzle-orm';
import type { Database } from './client.js';
import { accounts, usageRecords } from './schema.js';
import {
  startOfCalendarMonthUtc,
  type BundledLlmRepo,
  type BundledLlmSettings,
} from '../services/bundled-llm.js';

export class DrizzleBundledLlmRepo implements BundledLlmRepo {
  constructor(private readonly database: Database) {}

  async findSettings(accountId: string): Promise<BundledLlmSettings | null> {
    const rows = await this.database.db
      .select({
        consent: accounts.bundledLlmConsent,
        cap: accounts.bundledLlmMonthlyCapUsdCents,
      })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      consent: row.consent,
      monthlyCapUsdCents: row.cap,
    };
  }

  async updateSettings(args: {
    accountId: string;
    consent?: boolean;
    monthlyCapUsdCents?: number;
  }): Promise<BundledLlmSettings | null> {
    // PATCH semantics — only touch the columns that were supplied.
    // No-op when neither field is set; returns current state for echo.
    const set: Record<string, unknown> = {};
    if (args.consent !== undefined) set.bundledLlmConsent = args.consent;
    if (args.monthlyCapUsdCents !== undefined) {
      set.bundledLlmMonthlyCapUsdCents = args.monthlyCapUsdCents;
    }
    if (Object.keys(set).length > 0) {
      await this.database.db.update(accounts).set(set).where(eq(accounts.id, args.accountId));
    }
    return this.findSettings(args.accountId);
  }

  async sumMonthlySpendCents(args: { accountId: string; now: Date }): Promise<number> {
    const start = startOfCalendarMonthUtc(args.now);
    // SUM is over JSONB metadata.cost_usd_cents — the recorder writes
    // a numeric value there for every bundled row (sub-slice 6.4).
    // COALESCE so an empty match returns 0 instead of NULL.
    const rows = await this.database.db
      .select({
        total: sql<string>`coalesce(sum(
          (${usageRecords.metadata}->>'cost_usd_cents')::int
        ), 0)`,
      })
      .from(usageRecords)
      .where(
        and(
          eq(usageRecords.accountId, args.accountId),
          eq(usageRecords.recordType, 'agent_decomposer_bundled'),
          gte(usageRecords.recordedAt, start),
        ),
      );
    const total = rows[0]?.total;
    if (total === undefined) return 0;
    const parsed = Number.parseInt(total, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }
}

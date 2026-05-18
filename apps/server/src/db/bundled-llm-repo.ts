// Arc 1 sub-slice 6.3 (v2-#6) — Drizzle-backed BundledLlmRepo.
//
// Reads bundled_llm_consent + bundled_llm_monthly_cap_usd_cents off
// the accounts row via a single SELECT. Returns null when the account
// row is missing (caller treats as consent=false).

import { eq } from 'drizzle-orm';
import type { Database } from './client.js';
import { accounts } from './schema.js';
import type { BundledLlmRepo, BundledLlmSettings } from '../services/bundled-llm.js';

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
}

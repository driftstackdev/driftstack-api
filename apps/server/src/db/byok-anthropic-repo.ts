// AI-CHAT BYOK Anthropic — Drizzle implementation of BYOKAnthropicRepo.
// Backs the three new columns on `accounts` (migration 0041):
//   - byok_anthropic_api_key_ciphertext bytea
//   - byok_anthropic_api_key_set_at timestamptz
//   - byok_anthropic_api_key_last_used_at timestamptz
//
// The repo only reads/writes these three columns; the rest of the
// accounts row stays untouched. NULL ciphertext is the "no BYOK key
// set" sentinel — runtime resolution falls back to the request header,
// then the deployment fallback `BYOK_ANTHROPIC_FALLBACK_KEY` env var.

import { eq } from 'drizzle-orm';
import type { Database } from './client.js';
import { accounts } from './schema.js';
import type { BYOKAnthropicKeyRow, BYOKAnthropicRepo } from '../services/byok-anthropic.js';

export class DrizzleBYOKAnthropicRepo implements BYOKAnthropicRepo {
  constructor(private readonly database: Database) {}

  async findByAccount(accountId: string): Promise<BYOKAnthropicKeyRow | null> {
    const rows = await this.database.db
      .select({
        id: accounts.id,
        ciphertext: accounts.byokAnthropicApiKeyCiphertext,
        setAt: accounts.byokAnthropicApiKeySetAt,
        lastUsedAt: accounts.byokAnthropicApiKeyLastUsedAt,
      })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      accountId: row.id,
      ciphertext: row.ciphertext ?? null,
      setAt: row.setAt ?? null,
      lastUsedAt: row.lastUsedAt ?? null,
    };
  }

  async upsert(args: {
    accountId: string;
    ciphertext: Buffer;
    setAt: Date;
    now: Date;
  }): Promise<void> {
    // ALTER TABLE migration only added columns to the existing accounts
    // row — there's no separate fleet row to insert. UPDATE the three
    // BYOK columns + bump updatedAt.
    await this.database.db
      .update(accounts)
      .set({
        byokAnthropicApiKeyCiphertext: args.ciphertext,
        byokAnthropicApiKeySetAt: args.setAt,
        // v2-#11 — reset rotation reminder dedupe on every key set so
        // the next 90d cycle can fire reminders again.
        byokAnthropicApiKeyLastReminderSentAt: null,
        updatedAt: args.now,
      })
      .where(eq(accounts.id, args.accountId));
  }

  async clear(args: { accountId: string; now: Date }): Promise<void> {
    await this.database.db
      .update(accounts)
      .set({
        byokAnthropicApiKeyCiphertext: null,
        byokAnthropicApiKeySetAt: null,
        byokAnthropicApiKeyLastUsedAt: null,
        byokAnthropicApiKeyLastReminderSentAt: null,
        updatedAt: args.now,
      })
      .where(eq(accounts.id, args.accountId));
  }

  async touchLastUsed(args: { accountId: string; now: Date }): Promise<void> {
    // Bump only — does NOT touch `updated_at` (the touch is an
    // application-side observation, not a customer mutation).
    await this.database.db
      .update(accounts)
      .set({ byokAnthropicApiKeyLastUsedAt: args.now })
      .where(eq(accounts.id, args.accountId));
  }
}

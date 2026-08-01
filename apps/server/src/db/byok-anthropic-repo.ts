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

import { and, asc, count, eq, sql } from 'drizzle-orm';
import type { Database } from './client.js';
import { accounts } from './schema.js';
import type { BYOKAnthropicKeyRow, BYOKAnthropicRepo } from '../services/byok-anthropic.js';
import { verifyBootEncryptionKey } from '../lib/boot-key-verification.js';
import {
  BYOK_ANTHROPIC_KEY_V2_PREFIX,
  decryptByokAnthropicKey,
  decryptLegacyByokAnthropicKey,
  encryptByokAnthropicKey,
} from '../lib/byok-anthropic-encryption.js';

const MAX_BYOK_ANTHROPIC_MIGRATION_BATCH = 500;
const BYOK_ANTHROPIC_KEY_V2_PREFIX_BYTES = Buffer.from(BYOK_ANTHROPIC_KEY_V2_PREFIX, 'utf8');

function byokAnthropicCiphertextIsV2() {
  return sql`${accounts.byokAnthropicApiKeyCiphertext} IS NOT NULL
    AND substring(${accounts.byokAnthropicApiKeyCiphertext} from 1 for ${BYOK_ANTHROPIC_KEY_V2_PREFIX_BYTES.length}) = ${BYOK_ANTHROPIC_KEY_V2_PREFIX_BYTES}`;
}

function byokAnthropicCiphertextIsLegacy() {
  return sql`${accounts.byokAnthropicApiKeyCiphertext} IS NOT NULL
    AND NOT (${byokAnthropicCiphertextIsV2()})`;
}

export class DrizzleBYOKAnthropicRepo implements BYOKAnthropicRepo {
  constructor(private readonly database: Database) {}

  /**
   * Bootstrap-only no-DDL conversion from global context-free byte envelopes to
   * purpose/account-bound v2. Every selected legacy key authenticates before the
   * first UPDATE; each write exact-CASes the owning account and old bytea value.
   */
  async migrateCiphertextEnvelopes(
    encryptionKeyBase64: string,
    limit = MAX_BYOK_ANTHROPIC_MIGRATION_BATCH,
  ): Promise<{ scanned: number; converted: number; remaining: number }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_BYOK_ANTHROPIC_MIGRATION_BATCH) {
      throw new Error(
        `BYOK Anthropic migration limit must be an integer from 1 to ${MAX_BYOK_ANTHROPIC_MIGRATION_BATCH.toString()}.`,
      );
    }

    // Authenticate one already-bound row before considering legacy data. A
    // wrong operator key therefore fails without rewriting anything, including
    // on successor boots after the legacy set has drained to zero.
    const [v2Probe] = await this.database.db
      .select({
        accountId: accounts.id,
        ciphertext: accounts.byokAnthropicApiKeyCiphertext,
      })
      .from(accounts)
      .where(byokAnthropicCiphertextIsV2())
      .orderBy(asc(accounts.id))
      .limit(1);
    if (v2Probe !== undefined) {
      if (v2Probe.ciphertext === null) {
        throw new Error(`Account ${v2Probe.accountId} has an incomplete BYOK ciphertext.`);
      }
      // Only the DECRYPT is wrapped: the incomplete-ciphertext check above is a
      // structural fault, not a key mismatch, and keeps its own message.
      // `ciphertext` is bound locally first: inside the callback TypeScript no
      // longer carries the null-narrowing from the structural check above, and
      // widening the parameter to accept null would erase a real type guarantee
      // to satisfy a diagnostic wrapper.
      const probeCiphertext = v2Probe.ciphertext;
      verifyBootEncryptionKey('BYOK Anthropic keys', 'MFA_ENCRYPTION_KEY', () => {
        decryptByokAnthropicKey(probeCiphertext, encryptionKeyBase64, v2Probe.accountId);
      });
    }

    const rows = await this.database.db
      .select({
        accountId: accounts.id,
        ciphertext: accounts.byokAnthropicApiKeyCiphertext,
      })
      .from(accounts)
      .where(byokAnthropicCiphertextIsLegacy())
      .orderBy(asc(accounts.id))
      .limit(limit);

    // Authenticate and shape-check the complete bounded page before its first
    // write. Wrong key, malformed bytes or invalid plaintext leaves it intact.
    const prepared = rows.map((row) => {
      if (row.ciphertext === null) {
        throw new Error(`Account ${row.accountId} has an incomplete BYOK ciphertext.`);
      }
      const plaintext = decryptLegacyByokAnthropicKey(row.ciphertext, encryptionKeyBase64);
      return {
        ...row,
        ciphertext: row.ciphertext,
        next: encryptByokAnthropicKey(plaintext, encryptionKeyBase64, row.accountId),
      };
    });

    let converted = 0;
    for (const row of prepared) {
      const updated = await this.database.db
        .update(accounts)
        .set({
          // Ciphertext-only maintenance write: preserve set/use/reminder and
          // account updatedAt timestamps exactly.
          byokAnthropicApiKeyCiphertext: row.next,
        })
        .where(
          and(
            eq(accounts.id, row.accountId),
            eq(accounts.byokAnthropicApiKeyCiphertext, row.ciphertext),
          ),
        )
        .returning({ id: accounts.id });
      if (updated.length === 1) converted += 1;
    }

    const [remainingRow] = await this.database.db
      .select({ value: count() })
      .from(accounts)
      .where(byokAnthropicCiphertextIsLegacy());
    return { scanned: rows.length, converted, remaining: remainingRow?.value ?? 0 };
  }

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

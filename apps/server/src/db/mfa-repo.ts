// V-353b — Drizzle implementation of MfaRepo.

import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import type { MfaEnrollmentRow, MfaRepo, RecoveryCodeRow } from '../services/mfa.js';
import type { Database } from './client.js';
import { accountMfa, accountMfaRecoveryCodes } from './schema.js';

function toEnrollmentRow(r: typeof accountMfa.$inferSelect): MfaEnrollmentRow {
  return {
    accountId: r.accountId,
    totpSecretCiphertext: r.totpSecretCiphertext,
    totpSecretIv: r.totpSecretIv,
    totpSecretTag: r.totpSecretTag,
    enrolledAt: r.enrolledAt,
    lastUsedAt: r.lastUsedAt,
    lastUsedTotpCounter: r.lastUsedTotpCounter,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function toRecoveryCodeRow(r: typeof accountMfaRecoveryCodes.$inferSelect): RecoveryCodeRow {
  return {
    id: r.id,
    accountId: r.accountId,
    codeHash: r.codeHash,
    usedAt: r.usedAt,
    createdAt: r.createdAt,
  };
}

export class DrizzleMfaRepo implements MfaRepo {
  constructor(private readonly database: Database) {}

  async findByAccount(accountId: string): Promise<MfaEnrollmentRow | null> {
    const [row] = await this.database.db
      .select()
      .from(accountMfa)
      .where(eq(accountMfa.accountId, accountId))
      .limit(1);
    return row ? toEnrollmentRow(row) : null;
  }

  async upsertSecret(args: {
    accountId: string;
    ciphertext: string;
    iv: string;
    tag: string;
    enrolledAt: Date | null;
    now: Date;
  }): Promise<MfaEnrollmentRow> {
    const setOnConflict: Record<string, unknown> = {
      totpSecretCiphertext: args.ciphertext,
      totpSecretIv: args.iv,
      totpSecretTag: args.tag,
      updatedAt: args.now,
    };
    if (args.enrolledAt !== null) setOnConflict.enrolledAt = args.enrolledAt;

    const [row] = await this.database.db
      .insert(accountMfa)
      .values({
        accountId: args.accountId,
        totpSecretCiphertext: args.ciphertext,
        totpSecretIv: args.iv,
        totpSecretTag: args.tag,
        enrolledAt: args.enrolledAt,
        createdAt: args.now,
        updatedAt: args.now,
      })
      .onConflictDoUpdate({
        target: accountMfa.accountId,
        set: setOnConflict,
      })
      .returning();
    if (!row) throw new Error('upsertSecret: insert returned no row');
    return toEnrollmentRow(row);
  }

  async touchLastUsed(accountId: string, now: Date): Promise<void> {
    await this.database.db
      .update(accountMfa)
      .set({ lastUsedAt: now, updatedAt: now })
      .where(eq(accountMfa.accountId, accountId));
  }

  // TOTP replay defence (migration 0090) — atomic strict-monotonic write. The
  // WHERE clause (last_used_totp_counter IS NULL OR < :counter) makes the
  // accept-and-write a SINGLE conditional UPDATE, so two concurrent verifies of
  // the same code can't both succeed (the DB serialises the row write; the
  // loser matches zero rows). Returns true iff a row was updated.
  async consumeTotpCounter(args: {
    accountId: string;
    counter: number;
    now: Date;
  }): Promise<boolean> {
    const result = await this.database.db
      .update(accountMfa)
      .set({ lastUsedTotpCounter: args.counter, updatedAt: args.now })
      .where(
        and(
          eq(accountMfa.accountId, args.accountId),
          or(
            isNull(accountMfa.lastUsedTotpCounter),
            sql`${accountMfa.lastUsedTotpCounter} < ${args.counter}`,
          ),
        ),
      )
      .returning({ accountId: accountMfa.accountId });
    return result.length > 0;
  }

  async deleteForAccount(accountId: string): Promise<void> {
    await this.database.db.delete(accountMfa).where(eq(accountMfa.accountId, accountId));
    // Recovery codes cascade via FK on accountId, but we rely on the
    // accounts FK cascade — accountMfa cascade is on accounts only.
    // Belt-and-braces: explicit delete on the recovery codes table.
    await this.database.db
      .delete(accountMfaRecoveryCodes)
      .where(eq(accountMfaRecoveryCodes.accountId, accountId));
  }

  async insertRecoveryCodes(args: {
    accountId: string;
    hashes: string[];
    now: Date;
  }): Promise<void> {
    if (args.hashes.length === 0) return;
    await this.database.db.insert(accountMfaRecoveryCodes).values(
      args.hashes.map((h) => ({
        accountId: args.accountId,
        codeHash: h,
        createdAt: args.now,
      })),
    );
  }

  async listUnusedRecoveryCodes(accountId: string): Promise<RecoveryCodeRow[]> {
    const rows = await this.database.db
      .select()
      .from(accountMfaRecoveryCodes)
      .where(
        and(
          eq(accountMfaRecoveryCodes.accountId, accountId),
          isNull(accountMfaRecoveryCodes.usedAt),
        ),
      )
      .orderBy(desc(accountMfaRecoveryCodes.createdAt));
    return rows.map(toRecoveryCodeRow);
  }

  async markRecoveryCodeUsed(id: string, now: Date): Promise<void> {
    await this.database.db
      .update(accountMfaRecoveryCodes)
      .set({ usedAt: now })
      .where(and(eq(accountMfaRecoveryCodes.id, id), isNull(accountMfaRecoveryCodes.usedAt)));
  }

  async markAllRecoveryCodesUsed(accountId: string, now: Date): Promise<void> {
    await this.database.db
      .update(accountMfaRecoveryCodes)
      .set({ usedAt: now })
      .where(
        and(
          eq(accountMfaRecoveryCodes.accountId, accountId),
          isNull(accountMfaRecoveryCodes.usedAt),
        ),
      );
  }
}

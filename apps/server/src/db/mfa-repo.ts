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

function nextRevision(now: Date, previous: Date): Date {
  return new Date(Math.max(now.getTime(), previous.getTime() + 1));
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

  async startEnrollmentIfNotEnrolled(args: {
    accountId: string;
    ciphertext: string;
    iv: string;
    tag: string;
    now: Date;
  }): Promise<MfaEnrollmentRow | null> {
    return this.database.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`mfa-credentials:${args.accountId}`}))`,
      );
      const [existing] = await tx
        .select()
        .from(accountMfa)
        .where(eq(accountMfa.accountId, args.accountId))
        .limit(1);
      if (existing?.enrolledAt != null) return null;

      if (existing) {
        const [updated] = await tx
          .update(accountMfa)
          .set({
            totpSecretCiphertext: args.ciphertext,
            totpSecretIv: args.iv,
            totpSecretTag: args.tag,
            updatedAt: nextRevision(args.now, existing.updatedAt),
          })
          .where(eq(accountMfa.accountId, args.accountId))
          .returning();
        if (!updated) throw new Error('startEnrollmentIfNotEnrolled: update returned no row');
        return toEnrollmentRow(updated);
      }

      const [inserted] = await tx
        .insert(accountMfa)
        .values({
          accountId: args.accountId,
          totpSecretCiphertext: args.ciphertext,
          totpSecretIv: args.iv,
          totpSecretTag: args.tag,
          enrolledAt: null,
          createdAt: args.now,
          updatedAt: args.now,
        })
        .returning();
      if (!inserted) throw new Error('startEnrollmentIfNotEnrolled: insert returned no row');
      return toEnrollmentRow(inserted);
    });
  }

  async completeEnrollmentIfPending(args: {
    accountId: string;
    expectedUpdatedAt: Date;
    hashes: string[];
    now: Date;
  }): Promise<boolean> {
    return this.database.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`mfa-credentials:${args.accountId}`}))`,
      );
      const [updated] = await tx
        .update(accountMfa)
        .set({
          enrolledAt: args.now,
          updatedAt: nextRevision(args.now, args.expectedUpdatedAt),
        })
        .where(
          and(
            eq(accountMfa.accountId, args.accountId),
            isNull(accountMfa.enrolledAt),
            eq(accountMfa.updatedAt, args.expectedUpdatedAt),
          ),
        )
        .returning({ accountId: accountMfa.accountId });
      if (!updated) return false;
      if (args.hashes.length > 0) {
        await tx.insert(accountMfaRecoveryCodes).values(
          args.hashes.map((codeHash) => ({
            accountId: args.accountId,
            codeHash,
            createdAt: args.now,
          })),
        );
      }
      return true;
    });
  }

  async touchLastUsed(accountId: string, now: Date): Promise<void> {
    await this.database.db
      .update(accountMfa)
      .set({
        lastUsedAt: now,
        updatedAt: sql`GREATEST(${accountMfa.updatedAt} + INTERVAL '1 millisecond', ${now})`,
      })
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
      .set({
        lastUsedTotpCounter: args.counter,
        updatedAt: sql`GREATEST(${accountMfa.updatedAt} + INTERVAL '1 millisecond', ${args.now})`,
      })
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
    await this.database.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`mfa-credentials:${accountId}`}))`,
      );
      await tx
        .delete(accountMfaRecoveryCodes)
        .where(eq(accountMfaRecoveryCodes.accountId, accountId));
      await tx.delete(accountMfa).where(eq(accountMfa.accountId, accountId));
    });
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

  async markRecoveryCodeUsed(id: string, now: Date): Promise<boolean> {
    // Atomic consume: only update the row if it is STILL unused. The conditional
    // WHERE (id = … AND used_at IS NULL) means two concurrent requests with the
    // same code race on this UPDATE; exactly one matches a row (→ returns it),
    // the other matches zero rows. The caller gates success on this so a code can
    // never be spent twice (#5). `.returning()` lets us read the affected count
    // (mirrors consumeTotpCounter's atomic-consume pattern).
    const updated = await this.database.db
      .update(accountMfaRecoveryCodes)
      .set({ usedAt: now })
      .where(and(eq(accountMfaRecoveryCodes.id, id), isNull(accountMfaRecoveryCodes.usedAt)))
      .returning({ id: accountMfaRecoveryCodes.id });
    return updated.length === 1;
  }

  async replaceRecoveryCodesIfCurrent(args: {
    accountId: string;
    expectedUpdatedAt: Date;
    hashes: string[];
    now: Date;
  }): Promise<boolean> {
    return this.database.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`mfa-credentials:${args.accountId}`}))`,
      );
      const [updated] = await tx
        .update(accountMfa)
        .set({ updatedAt: nextRevision(args.now, args.expectedUpdatedAt) })
        .where(
          and(
            eq(accountMfa.accountId, args.accountId),
            sql`${accountMfa.enrolledAt} IS NOT NULL`,
            eq(accountMfa.updatedAt, args.expectedUpdatedAt),
          ),
        )
        .returning({ accountId: accountMfa.accountId });
      if (!updated) return false;

      await tx
        .update(accountMfaRecoveryCodes)
        .set({ usedAt: args.now })
        .where(
          and(
            eq(accountMfaRecoveryCodes.accountId, args.accountId),
            isNull(accountMfaRecoveryCodes.usedAt),
          ),
        );
      if (args.hashes.length > 0) {
        await tx.insert(accountMfaRecoveryCodes).values(
          args.hashes.map((codeHash) => ({
            accountId: args.accountId,
            codeHash,
            createdAt: args.now,
          })),
        );
      }
      return true;
    });
  }
}

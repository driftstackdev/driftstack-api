// V-353b — Drizzle implementation of MfaRepo.

import { and, asc, count, desc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import {
  decryptLegacyMfaSecret,
  decryptSecret,
  encryptSecret,
  MFA_TOTP_SECRET_V2_PREFIX,
} from '../lib/mfa-totp.js';
import type { MfaEnrollmentRow, MfaRepo, RecoveryCodeRow } from '../services/mfa.js';
import type { Database } from './client.js';
import { accountMfa, accountMfaRecoveryCodes, accounts, webSessions } from './schema.js';

const MAX_MFA_SECRET_MIGRATION_BATCH = 500;

function mfaSecretIsLegacy() {
  return sql`${accountMfa.totpSecretCiphertext} NOT LIKE ${`${MFA_TOTP_SECRET_V2_PREFIX}%`}`;
}

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

  /**
   * Bootstrap-only no-DDL cutover from the prefixless v1 tuple to the
   * purpose/account-bound v2 tuple. The selected page is fully authenticated
   * before its first write, and every rewrite compares all three old fields.
   */
  async migrateTotpSecretEnvelopes(
    keyBase64: string,
    limit = MAX_MFA_SECRET_MIGRATION_BATCH,
  ): Promise<{ scanned: number; converted: number; remaining: number }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_MFA_SECRET_MIGRATION_BATCH) {
      throw new Error(
        `MFA secret migration limit must be an integer from 1 to ${MAX_MFA_SECRET_MIGRATION_BATCH.toString()}.`,
      );
    }

    // Successor boots authenticate one already-bound tuple before considering
    // legacy rows. This catches a wrong operator key without rewriting data.
    const [v2Probe] = await this.database.db
      .select({
        accountId: accountMfa.accountId,
        ciphertext: accountMfa.totpSecretCiphertext,
        iv: accountMfa.totpSecretIv,
        tag: accountMfa.totpSecretTag,
      })
      .from(accountMfa)
      .where(sql`${accountMfa.totpSecretCiphertext} LIKE ${`${MFA_TOTP_SECRET_V2_PREFIX}%`}`)
      .orderBy(asc(accountMfa.createdAt), asc(accountMfa.accountId))
      .limit(1);
    if (v2Probe !== undefined) {
      decryptSecret(v2Probe, keyBase64, v2Probe.accountId);
    }

    const rows = await this.database.db
      .select({
        accountId: accountMfa.accountId,
        ciphertext: accountMfa.totpSecretCiphertext,
        iv: accountMfa.totpSecretIv,
        tag: accountMfa.totpSecretTag,
      })
      .from(accountMfa)
      .where(mfaSecretIsLegacy())
      .orderBy(asc(accountMfa.createdAt), asc(accountMfa.accountId))
      .limit(limit);

    // Decode/authenticate every legacy row before the first UPDATE. A wrong
    // key, malformed tuple, or non-20-byte seed leaves the whole page intact.
    const prepared = rows.map((row) => {
      const plaintext = decryptLegacyMfaSecret(row, keyBase64);
      return { row, next: encryptSecret(plaintext, keyBase64, row.accountId) };
    });

    let converted = 0;
    for (const { row, next } of prepared) {
      const updated = await this.database.db
        .update(accountMfa)
        .set({
          totpSecretCiphertext: next.ciphertext,
          totpSecretIv: next.iv,
          totpSecretTag: next.tag,
          // Deliberately leave updatedAt unchanged: it is the customer-facing
          // credential revision used by enrollment/recovery-code CAS paths.
        })
        .where(
          and(
            eq(accountMfa.accountId, row.accountId),
            eq(accountMfa.totpSecretCiphertext, row.ciphertext),
            eq(accountMfa.totpSecretIv, row.iv),
            eq(accountMfa.totpSecretTag, row.tag),
          ),
        )
        .returning({ accountId: accountMfa.accountId });
      if (updated.length === 1) converted += 1;
    }

    const [remainingRow] = await this.database.db
      .select({ value: count() })
      .from(accountMfa)
      .where(mfaSecretIsLegacy());
    return { scanned: rows.length, converted, remaining: remainingRow?.value ?? 0 };
  }

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
    currentWebSessionId: string;
    expectedUpdatedAt: Date;
    hashes: string[];
    now: Date;
  }): Promise<boolean> {
    return this.database.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`mfa-credentials:${args.accountId}`}))`,
      );

      // Lock the same account authority row used by web-session minting. This
      // serializes MFA activation with password/magic-link/OAuth/reset login:
      // a mint that wins first is retired by the epoch advance below; a mint
      // that loses observes the new epoch and refuses its stale snapshot.
      const [authority] = await tx
        .select({ authEpoch: accounts.authEpoch })
        .from(accounts)
        .where(and(eq(accounts.id, args.accountId), eq(accounts.status, 'active')))
        .for('update')
        .limit(1);
      if (!authority) return false;

      // Activation is authorized by the exact live web session that proved the
      // first TOTP. A cached/stale, expired, revoked, cross-account, or old-epoch
      // bearer cannot turn a pending secret into an active credential.
      const [currentSession] = await tx
        .select({ id: webSessions.id })
        .from(webSessions)
        .where(
          and(
            eq(webSessions.id, args.currentWebSessionId),
            eq(webSessions.accountId, args.accountId),
            eq(webSessions.authEpoch, authority.authEpoch),
            gt(webSessions.expiresAt, args.now),
            isNull(webSessions.revokedAt),
          ),
        )
        .for('update')
        .limit(1);
      if (!currentSession) return false;

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

      const [nextAuthority] = await tx
        .update(accounts)
        .set({ authEpoch: sql`${accounts.authEpoch} + 1` })
        .where(and(eq(accounts.id, args.accountId), eq(accounts.authEpoch, authority.authEpoch)))
        .returning({ authEpoch: accounts.authEpoch });
      if (!nextAuthority) {
        throw new Error('completeEnrollmentIfPending: account authority update returned no row');
      }

      const [rebasedSession] = await tx
        .update(webSessions)
        .set({ authEpoch: nextAuthority.authEpoch, mfaSatisfiedAt: args.now })
        .where(
          and(
            eq(webSessions.id, args.currentWebSessionId),
            eq(webSessions.accountId, args.accountId),
            eq(webSessions.authEpoch, authority.authEpoch),
            isNull(webSessions.revokedAt),
          ),
        )
        .returning({ id: webSessions.id });
      if (!rebasedSession) {
        throw new Error('completeEnrollmentIfPending: enrolling session rebase returned no row');
      }
      return true;
    });
  }

  async touchLastUsed(accountId: string, now: Date): Promise<void> {
    // Raw drizzle `sql` parameters bypass the timestamp column serializer;
    // binding a Date reaches postgres-js's Buffer.byteLength and throws.
    // Keep lastUsedAt on the typed update path, but serialize the value used
    // inside GREATEST explicitly (see drizzle-date-param-workaround.md).
    const nowIso = now.toISOString();
    await this.database.db
      .update(accountMfa)
      .set({
        lastUsedAt: now,
        updatedAt: sql`GREATEST(${accountMfa.updatedAt} + INTERVAL '1 millisecond', ${nowIso}::timestamptz)`,
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
    // Same raw-SQL boundary as touchLastUsed: never bind a Date directly.
    const nowIso = args.now.toISOString();
    const result = await this.database.db
      .update(accountMfa)
      .set({
        lastUsedTotpCounter: args.counter,
        updatedAt: sql`GREATEST(${accountMfa.updatedAt} + INTERVAL '1 millisecond', ${nowIso}::timestamptz)`,
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

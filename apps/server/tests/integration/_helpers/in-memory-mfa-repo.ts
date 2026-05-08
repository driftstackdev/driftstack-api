// V-353b — in-memory MfaRepo for integration tests. Mirrors the
// Drizzle implementation behavior (upsert, single-use recovery codes,
// list-unused, mark-all-used).

import { randomUUID } from 'node:crypto';
import type { MfaEnrollmentRow, MfaRepo, RecoveryCodeRow } from '../../../src/services/mfa.js';

export class InMemoryMfaRepo implements MfaRepo {
  private readonly enrollments = new Map<string, MfaEnrollmentRow>();
  private readonly recoveryCodes = new Map<string, RecoveryCodeRow>();

  findByAccount(accountId: string): Promise<MfaEnrollmentRow | null> {
    return Promise.resolve(this.enrollments.get(accountId) ?? null);
  }

  upsertSecret(args: {
    accountId: string;
    ciphertext: string;
    iv: string;
    tag: string;
    enrolledAt: Date | null;
    now: Date;
  }): Promise<MfaEnrollmentRow> {
    const existing = this.enrollments.get(args.accountId);
    const row: MfaEnrollmentRow = {
      accountId: args.accountId,
      totpSecretCiphertext: args.ciphertext,
      totpSecretIv: args.iv,
      totpSecretTag: args.tag,
      enrolledAt: args.enrolledAt !== null ? args.enrolledAt : (existing?.enrolledAt ?? null),
      lastUsedAt: existing?.lastUsedAt ?? null,
      createdAt: existing?.createdAt ?? args.now,
      updatedAt: args.now,
    };
    this.enrollments.set(args.accountId, row);
    return Promise.resolve(row);
  }

  touchLastUsed(accountId: string, now: Date): Promise<void> {
    const r = this.enrollments.get(accountId);
    if (r) this.enrollments.set(accountId, { ...r, lastUsedAt: now, updatedAt: now });
    return Promise.resolve();
  }

  deleteForAccount(accountId: string): Promise<void> {
    this.enrollments.delete(accountId);
    for (const [id, row] of this.recoveryCodes.entries()) {
      if (row.accountId === accountId) this.recoveryCodes.delete(id);
    }
    return Promise.resolve();
  }

  insertRecoveryCodes(args: { accountId: string; hashes: string[]; now: Date }): Promise<void> {
    for (const hash of args.hashes) {
      const id = randomUUID();
      this.recoveryCodes.set(id, {
        id,
        accountId: args.accountId,
        codeHash: hash,
        usedAt: null,
        createdAt: args.now,
      });
    }
    return Promise.resolve();
  }

  listUnusedRecoveryCodes(accountId: string): Promise<RecoveryCodeRow[]> {
    const out: RecoveryCodeRow[] = [];
    for (const row of this.recoveryCodes.values()) {
      if (row.accountId === accountId && row.usedAt === null) out.push(row);
    }
    out.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return Promise.resolve(out);
  }

  markRecoveryCodeUsed(id: string, now: Date): Promise<void> {
    const row = this.recoveryCodes.get(id);
    if (row && row.usedAt === null) {
      this.recoveryCodes.set(id, { ...row, usedAt: now });
    }
    return Promise.resolve();
  }

  markAllRecoveryCodesUsed(accountId: string, now: Date): Promise<void> {
    for (const [id, row] of this.recoveryCodes.entries()) {
      if (row.accountId === accountId && row.usedAt === null) {
        this.recoveryCodes.set(id, { ...row, usedAt: now });
      }
    }
    return Promise.resolve();
  }
}

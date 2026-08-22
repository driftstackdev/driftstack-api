// V-353b — in-memory MfaRepo for integration tests. Mirrors the
// Drizzle implementation behavior (upsert, single-use recovery codes,
// list-unused, mark-all-used).

import { randomUUID } from 'node:crypto';
import type { MfaEnrollmentRow, MfaRepo, RecoveryCodeRow } from '../../../src/services/mfa.js';
import { nextRevision } from '../../../src/db/mfa-repo.js';

interface MfaSessionAuthority {
  activateMfaEnrollmentSession(args: {
    accountId: string;
    currentWebSessionId: string;
    now: Date;
  }): boolean;
}

export class InMemoryMfaRepo implements MfaRepo {
  private readonly enrollments = new Map<string, MfaEnrollmentRow>();
  private readonly recoveryCodes = new Map<string, RecoveryCodeRow>();

  constructor(private readonly sessionAuthority: MfaSessionAuthority | null = null) {}

  findByAccount(accountId: string): Promise<MfaEnrollmentRow | null> {
    const row = this.enrollments.get(accountId);
    return Promise.resolve(row ? { ...row } : null);
  }

  startEnrollmentIfNotEnrolled(args: {
    accountId: string;
    ciphertext: string;
    iv: string;
    tag: string;
    now: Date;
  }): Promise<MfaEnrollmentRow | null> {
    const existing = this.enrollments.get(args.accountId);
    if (existing?.enrolledAt != null) return Promise.resolve(null);
    const updatedAt = existing ? nextRevision(args.now, existing.updatedAt) : args.now;
    const row: MfaEnrollmentRow = {
      accountId: args.accountId,
      totpSecretCiphertext: args.ciphertext,
      totpSecretIv: args.iv,
      totpSecretTag: args.tag,
      enrolledAt: null,
      lastUsedAt: existing?.lastUsedAt ?? null,
      lastUsedTotpCounter: existing?.lastUsedTotpCounter ?? null,
      createdAt: existing?.createdAt ?? args.now,
      updatedAt,
    };
    this.enrollments.set(args.accountId, row);
    return Promise.resolve({ ...row });
  }

  completeEnrollmentIfPending(args: {
    accountId: string;
    currentWebSessionId: string;
    expectedUpdatedAt: Date;
    hashes: string[];
    now: Date;
  }): Promise<boolean> {
    const row = this.enrollments.get(args.accountId);
    if (
      !row ||
      row.enrolledAt !== null ||
      row.updatedAt.getTime() !== args.expectedUpdatedAt.getTime()
    ) {
      return Promise.resolve(false);
    }
    if (this.sessionAuthority && !this.sessionAuthority.activateMfaEnrollmentSession(args)) {
      return Promise.resolve(false);
    }
    this.enrollments.set(args.accountId, {
      ...row,
      enrolledAt: args.now,
      updatedAt: nextRevision(args.now, row.updatedAt),
    });
    this.insertHashes(args);
    return Promise.resolve(true);
  }

  touchLastUsed(accountId: string, now: Date): Promise<void> {
    const r = this.enrollments.get(accountId);
    if (r) {
      this.enrollments.set(accountId, {
        ...r,
        lastUsedAt: now,
        updatedAt: nextRevision(now, r.updatedAt),
      });
    }
    return Promise.resolve();
  }

  // TOTP replay defence (migration 0090) — atomic strict-monotonic write. The
  // synchronous in-memory map has no await gap between the read + write, so the
  // guard is naturally atomic (the real concurrent-replay race lives only in
  // the multi-connection Postgres path, handled by the conditional UPDATE).
  consumeTotpCounter(args: { accountId: string; counter: number; now: Date }): Promise<boolean> {
    const r = this.enrollments.get(args.accountId);
    if (!r) return Promise.resolve(false);
    if (r.lastUsedTotpCounter !== null && r.lastUsedTotpCounter >= args.counter) {
      return Promise.resolve(false);
    }
    this.enrollments.set(args.accountId, {
      ...r,
      lastUsedTotpCounter: args.counter,
      updatedAt: nextRevision(args.now, r.updatedAt),
    });
    return Promise.resolve(true);
  }

  deleteForAccount(accountId: string): Promise<void> {
    this.enrollments.delete(accountId);
    for (const [id, row] of this.recoveryCodes.entries()) {
      if (row.accountId === accountId) this.recoveryCodes.delete(id);
    }
    return Promise.resolve();
  }

  listUnusedRecoveryCodes(accountId: string): Promise<RecoveryCodeRow[]> {
    const out: RecoveryCodeRow[] = [];
    for (const row of this.recoveryCodes.values()) {
      // V-1272 — a COPY, for the reason in the email-preferences double.
      if (row.accountId === accountId && row.usedAt === null) out.push({ ...row });
    }
    out.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return Promise.resolve(out);
  }

  markRecoveryCodeUsed(id: string, now: Date): Promise<boolean> {
    // Atomic single-use (mirrors the Drizzle conditional UPDATE): only flip if
    // STILL unused, and report whether THIS call consumed it (#5 double-spend gate).
    const row = this.recoveryCodes.get(id);
    if (row && row.usedAt === null) {
      this.recoveryCodes.set(id, { ...row, usedAt: now });
      return Promise.resolve(true);
    }
    return Promise.resolve(false);
  }

  replaceRecoveryCodesIfCurrent(args: {
    accountId: string;
    expectedUpdatedAt: Date;
    hashes: string[];
    now: Date;
  }): Promise<boolean> {
    const enrollment = this.enrollments.get(args.accountId);
    if (
      !enrollment ||
      enrollment.enrolledAt === null ||
      enrollment.updatedAt.getTime() !== args.expectedUpdatedAt.getTime()
    ) {
      return Promise.resolve(false);
    }
    this.enrollments.set(args.accountId, {
      ...enrollment,
      updatedAt: nextRevision(args.now, enrollment.updatedAt),
    });
    for (const [id, row] of this.recoveryCodes.entries()) {
      if (row.accountId === args.accountId && row.usedAt === null) {
        this.recoveryCodes.set(id, { ...row, usedAt: args.now });
      }
    }
    this.insertHashes(args);
    return Promise.resolve(true);
  }

  private insertHashes(args: { accountId: string; hashes: string[]; now: Date }): void {
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
  }
}

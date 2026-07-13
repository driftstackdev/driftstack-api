// V-353b — MFA service: TOTP enrollment + verification + recovery codes.
//
// The enrollment dance:
//   1. POST /v1/account/mfa/enroll  — service.startEnrollment(account)
//      generates a fresh secret, encrypts it, upserts the row WITHOUT
//      `enrolled_at` (still pending). Returns the otpauth:// URI for the
//      dashboard to render as QR + the manual-entry base32 secret.
//   2. Customer scans QR in their auth app, types the first 6-digit
//      code into the dashboard.
//   3. POST /v1/account/mfa/verify { code } — service.completeEnrollment
//      decrypts the pending secret, verifies the code, sets
//      `enrolled_at`, mints + returns 10 recovery codes (raw, shown ONCE).
//
// Disable: DELETE /v1/account/mfa requires step-up (caller already
// satisfied per V-353e gate). Service.disable wipes the row + recovery
// codes.
//
// Verification (login challenge or step-up): service.verifyCode(account,
// code) decrypts the row's secret, checks the 6-digit code OR consumes
// a recovery code (single-use; sets `used_at`).

import { hashApiKey, verifyApiKey } from '../lib/api-keys.js';
import {
  decryptSecret,
  encryptSecret,
  generateRecoveryCodes,
  generateTotpSecret,
  normalizeRecoveryCode,
  otpauthUri,
  verifyTotpCode,
  verifyTotpCodeWithCounter,
} from '../lib/mfa-totp.js';
import { BadRequestError, ConflictError, NotFoundError } from '../lib/errors.js';
import type { AccountAuditService } from './account-audit.js';

export interface MfaEnrollmentRow {
  accountId: string;
  totpSecretCiphertext: string;
  totpSecretIv: string;
  totpSecretTag: string;
  enrolledAt: Date | null;
  lastUsedAt: Date | null;
  /** TOTP replay defence (migration 0090) — last successfully-consumed TOTP
   *  timestep counter. null = none consumed yet under the guard. */
  lastUsedTotpCounter: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RecoveryCodeRow {
  id: string;
  accountId: string;
  codeHash: string;
  usedAt: Date | null;
  createdAt: Date;
}

export interface MfaRepo {
  /** V-353b — return the MFA row for the account (any state) or null. */
  findByAccount(accountId: string): Promise<MfaEnrollmentRow | null>;
  /** Atomically insert/replace a pending secret only while the account is not
   *  enrolled. Returns null when a concurrent request already enrolled it. */
  startEnrollmentIfNotEnrolled(args: {
    accountId: string;
    ciphertext: string;
    iv: string;
    tag: string;
    now: Date;
  }): Promise<MfaEnrollmentRow | null>;
  /** Atomically transition the exact pending snapshot to enrolled and insert
   *  its first recovery-code batch. Returns false when the snapshot is stale. */
  completeEnrollmentIfPending(args: {
    accountId: string;
    expectedUpdatedAt: Date;
    hashes: string[];
    now: Date;
  }): Promise<boolean>;
  /** V-353b — touch `last_used_at` after a successful verify. */
  touchLastUsed(accountId: string, now: Date): Promise<void>;
  /**
   * TOTP replay defence (migration 0090) — persist the matched TOTP timestep
   * counter so the same 30s window can't be replayed. Done in the SAME locked
   * step as the read (atomic guard: only write when the new counter strictly
   * exceeds the stored one) to close the concurrent-replay race; returns true
   * when the counter was accepted+written, false when a concurrent verify
   * already consumed this (or a later) counter.
   */
  consumeTotpCounter(args: { accountId: string; counter: number; now: Date }): Promise<boolean>;
  /** V-353b — delete the MFA row + recovery codes (cascade). */
  deleteForAccount(accountId: string): Promise<void>;
  /** V-353b — list unused recovery codes (used by the verify path). */
  listUnusedRecoveryCodes(accountId: string): Promise<RecoveryCodeRow[]>;
  /** V-353b — atomically consume a single recovery code. Returns true iff THIS
   *  call flipped it from unused → used (rowCount === 1); false when it was
   *  already spent (a concurrent consume won the race). Gates double-spend (#5). */
  markRecoveryCodeUsed(id: string, now: Date): Promise<boolean>;
  /** Atomically invalidate the existing batch and insert a replacement only
   *  when the enrollment snapshot is still current. */
  replaceRecoveryCodesIfCurrent(args: {
    accountId: string;
    expectedUpdatedAt: Date;
    hashes: string[];
    now: Date;
  }): Promise<boolean>;
}

export interface MfaServiceConfig {
  /** V-353b — base64-encoded 32-byte AES-256-GCM key. */
  encryptionKey: string;
}

export interface StartEnrollmentResult {
  /** otpauth:// URI for the dashboard to render as a QR code. */
  otpauthUri: string;
  /** Base32 secret for manual entry into auth apps that don't QR. */
  secretBase32: string;
}

export interface CompleteEnrollmentResult {
  /** Raw recovery codes — shown ONCE to the customer. */
  recoveryCodes: string[];
}

export class MfaService {
  constructor(
    private readonly repo: MfaRepo,
    private readonly config: MfaServiceConfig,
    private readonly accountAudit: AccountAuditService | null = null,
  ) {}

  /** V-353b — start enrollment: generate + encrypt + upsert pending
   *  secret. Re-enrolling overwrites the pending secret (customer
   *  re-scans QR + verifies fresh code). If the account is ALREADY
   *  enrolled (`enrolled_at` set), refuses with 409. The customer must
   *  disable first via DELETE /v1/account/mfa (step-up gated) and then
   *  re-enroll. */
  async startEnrollment(args: {
    accountId: string;
    email: string;
  }): Promise<StartEnrollmentResult> {
    const { secretBase32, secretBytes } = generateTotpSecret();
    const enc = encryptSecret(secretBytes, this.config.encryptionKey);
    const started = await this.repo.startEnrollmentIfNotEnrolled({
      accountId: args.accountId,
      ciphertext: enc.ciphertext,
      iv: enc.iv,
      tag: enc.tag,
      now: new Date(),
    });
    if (started === null) {
      throw new ConflictError(
        'MFA is already enrolled. Disable first via DELETE /v1/account/mfa, then re-enroll.',
      );
    }
    return {
      otpauthUri: otpauthUri({ email: args.email, secretBase32 }),
      secretBase32,
    };
  }

  /** V-353b — complete enrollment: verify the customer's first 6-digit
   *  code, set `enrolled_at`, mint + return 10 recovery codes. Returns
   *  401 (BadRequest) on invalid code; 409 if no pending enrollment
   *  exists (customer must call /enroll first). */
  async completeEnrollment(args: {
    accountId: string;
    code: string;
  }): Promise<CompleteEnrollmentResult> {
    const row = await this.repo.findByAccount(args.accountId);
    if (!row) {
      throw new ConflictError('No pending MFA enrollment. Call POST /v1/account/mfa/enroll first.');
    }
    if (row.enrolledAt !== null) {
      throw new ConflictError(
        'MFA is already enrolled. Disable + re-enroll if you need a fresh secret.',
      );
    }
    const secretBytes = decryptSecret(
      {
        ciphertext: row.totpSecretCiphertext,
        iv: row.totpSecretIv,
        tag: row.totpSecretTag,
      },
      this.config.encryptionKey,
    );
    if (!verifyTotpCode(secretBytes, args.code)) {
      throw new BadRequestError('Invalid 6-digit code. Try again.');
    }

    const codes = generateRecoveryCodes();
    // Hash the NORMALIZED form (hyphen-stripped, uppercased) so verify
    // can check against either typed form (with or without hyphen).
    const hashes = await Promise.all(codes.map((c) => hashApiKey(normalizeRecoveryCode(c))));
    const completed = await this.repo.completeEnrollmentIfPending({
      accountId: args.accountId,
      expectedUpdatedAt: row.updatedAt,
      hashes,
      now: new Date(),
    });
    if (!completed) {
      throw new ConflictError(
        'MFA enrollment changed while the code was being verified. Retry with the latest enrollment.',
      );
    }

    if (this.accountAudit) {
      try {
        await this.accountAudit.record({
          accountId: args.accountId,
          actorType: 'customer',
          actorAccountId: args.accountId,
          actorKeyId: null,
          action: 'account.mfa_enrolled',
          targetResourceId: null,
          payload: {},
        });
      } catch {
        /* swallow */
      }
    }

    return { recoveryCodes: codes };
  }

  /** V-353b — disable MFA: drop the row + recovery codes. Caller is
   *  responsible for the step-up gate (V-353e); the service trusts
   *  the route. */
  async disable(args: { accountId: string }): Promise<void> {
    const row = await this.repo.findByAccount(args.accountId);
    if (!row) {
      // Idempotent — already disabled.
      return;
    }
    await this.repo.deleteForAccount(args.accountId);
    if (this.accountAudit) {
      try {
        await this.accountAudit.record({
          accountId: args.accountId,
          actorType: 'customer',
          actorAccountId: args.accountId,
          actorKeyId: null,
          action: 'account.mfa_disabled',
          targetResourceId: null,
          payload: {},
        });
      } catch {
        /* swallow */
      }
    }
  }

  /** V-353b — verify a 6-digit code OR a recovery code for an
   *  enrolled account. Returns the kind matched on success or null
   *  on failure. Updates `last_used_at` on TOTP success; consumes the
   *  recovery code on recovery-code success. */
  async verifyCode(args: {
    accountId: string;
    input: string;
    nowSeconds?: number;
  }): Promise<'totp' | 'recovery' | null> {
    const row = await this.repo.findByAccount(args.accountId);
    if (!row || row.enrolledAt === null) {
      throw new NotFoundError('MFA is not enrolled for this account.');
    }
    const trimmed = args.input.trim();
    if (/^\d{6}$/.test(trimmed)) {
      const secretBytes = decryptSecret(
        {
          ciphertext: row.totpSecretCiphertext,
          iv: row.totpSecretIv,
          tag: row.totpSecretTag,
        },
        this.config.encryptionKey,
      );
      // TOTP replay defence (migration 0090). verifyTotpCodeWithCounter returns
      // the matched timestep counter; the code is only accepted when that
      // counter is STRICTLY GREATER than the last consumed one — so a code
      // observed (shoulder-surf / phishing relay / malicious proxy) can't be
      // replayed within its ~90s validity window, against EITHER the login
      // challenge OR the step-up gate (both flow through verifyCode). The
      // strict-monotonic check is enforced atomically in consumeTotpCounter so
      // two concurrent verifies of the same code can't both win.
      const matchedCounter = verifyTotpCodeWithCounter(secretBytes, trimmed, args.nowSeconds);
      if (matchedCounter === null) return null;
      const lastUsed = row.lastUsedTotpCounter;
      if (lastUsed !== null && matchedCounter <= lastUsed) {
        // Replay (or a stale-window code): the counter was already consumed.
        return null;
      }
      const accepted = await this.repo.consumeTotpCounter({
        accountId: args.accountId,
        counter: matchedCounter,
        now: new Date(),
      });
      if (!accepted) {
        // Lost the race — a concurrent verify consumed this (or a later)
        // counter first. Treat as a replay.
        return null;
      }
      await this.repo.touchLastUsed(args.accountId, new Date());
      return 'totp';
    }

    // Recovery code path: normalize, scrypt-verify against any
    // unused row.
    const normalized = normalizeRecoveryCode(trimmed);
    if (!/^[A-Z0-9]{10}$/.test(normalized)) return null;
    const candidates = await this.repo.listUnusedRecoveryCodes(args.accountId);
    for (const c of candidates) {
      // scrypt is constant-time-friendly per-row but the loop itself
      // leaks "how many unused codes." Customer's own action; not a
      // cross-account leak. Acceptable.

      const ok = await verifyApiKey(normalized, c.codeHash);
      if (ok) {
        // #5 — atomic single-use: only ONE concurrent consume of the same code
        // can flip it unused → used. If the conditional UPDATE matched 0 rows the
        // code was already spent (a sibling request won the race), so this attempt
        // must NOT grant access — reject as if the code were invalid. Without this
        // gate two concurrent requests with the same code both succeeded.
        const consumed = await this.repo.markRecoveryCodeUsed(c.id, new Date());
        if (!consumed) return null;
        await this.repo.touchLastUsed(args.accountId, new Date());
        if (this.accountAudit) {
          try {
            await this.accountAudit.record({
              accountId: args.accountId,
              actorType: 'customer',
              actorAccountId: args.accountId,
              actorKeyId: null,
              action: 'account.recovery_code_used',
              targetResourceId: null,
              payload: { remaining: candidates.length - 1 },
            });
          } catch {
            /* swallow */
          }
        }
        return 'recovery';
      }
    }
    return null;
  }

  /** V-353b — regenerate the 10 recovery codes. Requires an enrolled
   *  account. Marks every prior unused code consumed; inserts 10
   *  fresh hashes; returns the raw codes (shown ONCE). */
  async regenerateRecoveryCodes(args: { accountId: string }): Promise<{ recoveryCodes: string[] }> {
    const row = await this.repo.findByAccount(args.accountId);
    if (!row || row.enrolledAt === null) {
      throw new NotFoundError('MFA is not enrolled for this account.');
    }
    const codes = generateRecoveryCodes();
    const hashes = await Promise.all(codes.map((c) => hashApiKey(normalizeRecoveryCode(c))));
    const replaced = await this.repo.replaceRecoveryCodesIfCurrent({
      accountId: args.accountId,
      expectedUpdatedAt: row.updatedAt,
      hashes,
      now: new Date(),
    });
    if (!replaced) {
      throw new ConflictError(
        'MFA recovery codes changed during regeneration. Refresh and try again.',
      );
    }
    return { recoveryCodes: codes };
  }

  /** V-353b — minimal status for /v1/account/me + dashboard. */
  async getStatus(accountId: string): Promise<{
    enrolled: boolean;
    enrolledAt: Date | null;
    lastUsedAt: Date | null;
    unusedRecoveryCodes: number;
  }> {
    const row = await this.repo.findByAccount(accountId);
    if (!row || row.enrolledAt === null) {
      return { enrolled: false, enrolledAt: null, lastUsedAt: null, unusedRecoveryCodes: 0 };
    }
    const codes = await this.repo.listUnusedRecoveryCodes(accountId);
    return {
      enrolled: true,
      enrolledAt: row.enrolledAt,
      lastUsedAt: row.lastUsedAt,
      unusedRecoveryCodes: codes.length,
    };
  }
}

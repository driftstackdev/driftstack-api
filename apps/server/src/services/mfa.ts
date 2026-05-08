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
  /** V-353b — upsert the encrypted secret for the account. Sets
   *  `enrolled_at` only when explicitly provided (start-enrollment
   *  passes null to leave it pending; complete-enrollment passes
   *  the timestamp).  */
  upsertSecret(args: {
    accountId: string;
    ciphertext: string;
    iv: string;
    tag: string;
    enrolledAt: Date | null;
    now: Date;
  }): Promise<MfaEnrollmentRow>;
  /** V-353b — touch `last_used_at` after a successful verify. */
  touchLastUsed(accountId: string, now: Date): Promise<void>;
  /** V-353b — delete the MFA row + recovery codes (cascade). */
  deleteForAccount(accountId: string): Promise<void>;
  /** V-353b — bulk-insert N recovery code hashes for the account. */
  insertRecoveryCodes(args: { accountId: string; hashes: string[]; now: Date }): Promise<void>;
  /** V-353b — list unused recovery codes (used by the verify path). */
  listUnusedRecoveryCodes(accountId: string): Promise<RecoveryCodeRow[]>;
  /** V-353b — mark a single recovery code consumed. */
  markRecoveryCodeUsed(id: string, now: Date): Promise<void>;
  /** V-353b — bulk-mark every unused recovery code consumed (used by
   *  regenerate). */
  markAllRecoveryCodesUsed(accountId: string, now: Date): Promise<void>;
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
    const existing = await this.repo.findByAccount(args.accountId);
    if (existing && existing.enrolledAt !== null) {
      throw new ConflictError(
        'MFA is already enrolled. Disable first via DELETE /v1/account/mfa, then re-enroll.',
      );
    }
    const { secretBase32, secretBytes } = generateTotpSecret();
    const enc = encryptSecret(secretBytes, this.config.encryptionKey);
    await this.repo.upsertSecret({
      accountId: args.accountId,
      ciphertext: enc.ciphertext,
      iv: enc.iv,
      tag: enc.tag,
      enrolledAt: null,
      now: new Date(),
    });
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

    const now = new Date();
    await this.repo.upsertSecret({
      accountId: args.accountId,
      ciphertext: row.totpSecretCiphertext,
      iv: row.totpSecretIv,
      tag: row.totpSecretTag,
      enrolledAt: now,
      now,
    });

    const codes = generateRecoveryCodes();
    const hashes = await Promise.all(codes.map((c) => hashApiKey(c)));
    await this.repo.insertRecoveryCodes({
      accountId: args.accountId,
      hashes,
      now,
    });

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
      if (verifyTotpCode(secretBytes, trimmed, args.nowSeconds)) {
        await this.repo.touchLastUsed(args.accountId, new Date());
        return 'totp';
      }
      return null;
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
        await this.repo.markRecoveryCodeUsed(c.id, new Date());
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
    const now = new Date();
    await this.repo.markAllRecoveryCodesUsed(args.accountId, now);
    const codes = generateRecoveryCodes();
    const hashes = await Promise.all(codes.map((c) => hashApiKey(c)));
    await this.repo.insertRecoveryCodes({ accountId: args.accountId, hashes, now });
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

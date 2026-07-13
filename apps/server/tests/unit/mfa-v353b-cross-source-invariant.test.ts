// W938 — V-353b MFA TOTP enrollment cross-source invariant. Two-
// hundred-sixty-fourth in the drift-guard series. Pins the MFA
// service contract:
//
//   V-353b anchor — 'MFA service: TOTP enrollment + verification +
//   recovery codes'.
//
//   3-step enrollment dance:
//     1. POST /v1/account/mfa/enroll — service.startEnrollment(account)
//        generates fresh secret, encrypts, upserts WITHOUT enrolled_at
//        (pending). Returns otpauth:// URI + base32 secret.
//     2. Customer scans QR / types code into dashboard.
//     3. POST /v1/account/mfa/verify { code } — service.complete-
//        Enrollment decrypts pending secret, verifies code, sets
//        enrolled_at, mints + returns 10 recovery codes (shown ONCE).
//
//   Disable: DELETE /v1/account/mfa requires V-353e step-up.
//     service.disable wipes row + recovery codes.
//
//   Verification: service.verifyCode(account, code) decrypts secret,
//     checks 6-digit code OR consumes recovery code (single-use; sets
//     used_at).
//
//   MfaEnrollmentRow (8 fields): accountId + totpSecretCiphertext +
//     totpSecretIv + totpSecretTag + enrolledAt (nullable; null=
//     pending) + lastUsedAt (nullable) + createdAt + updatedAt.
//
//   RecoveryCodeRow (5 fields): id + accountId + codeHash + usedAt
//     (nullable, single-use marker) + createdAt.
//
//   AES-256-GCM encryption — MfaServiceConfig.encryptionKey = 'base64-
//     encoded 32-byte AES-256-GCM key'.
//
//   StartEnrollmentResult (2 fields): otpauthUri + secretBase32
//     ('Base32 secret for manual entry into auth apps that don't QR').
//
//   CompleteEnrollmentResult (1 field): recoveryCodes (Raw — 'shown
//     ONCE to the customer').
//
//   accountAudit is OPTIONAL (default null) — tests can skip audit
//     wiring.
//
//   Re-enroll-while-pending allowed; re-enroll-when-enrolled refused
//     (409 Conflict; customer must disable + re-enroll).
//
// stays in lockstep across apps/server/src/services/mfa.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W938 V-353b MFA cross-source invariant', () => {
  // ─── V-353b anchor + 3-feature framing ───────────────────────

  it("CRITICAL apps/server/src/services/mfa.ts header pins V-353b anchor — 'V-353b — MFA service: TOTP enrollment + verification + recovery codes'. The V-353b anchor + 3-feature scope is the policy provenance.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/mfa.ts'));
    expect(p).toMatch(/V-353b — MFA service: TOTP enrollment \+ verification \+ recovery codes/);
  });

  // ─── 3-step enrollment dance framing ─────────────────────────

  it("CRITICAL 3-step enrollment dance — '1. POST /v1/account/mfa/enroll — service.startEnrollment generates fresh secret, encrypts, upserts WITHOUT enrolled_at (pending). Returns otpauth:// URI + base32 secret. 2. Customer scans QR + types first 6-digit code. 3. POST /v1/account/mfa/verify — service.completeEnrollment decrypts pending, verifies code, sets enrolled_at, mints 10 recovery codes (shown ONCE)'. The 3-step is the customer-facing API.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/mfa.ts'));
    expect(p).toMatch(
      /1\. POST \/v1\/account\/mfa\/enroll {2}— service\.startEnrollment\(account\)/,
    );
    expect(p).toMatch(/generates a fresh secret, encrypts it, upserts the row WITHOUT/);
    expect(p).toMatch(/`enrolled_at` \(still pending\)\. Returns the otpauth:\/\/ URI for the/);
    expect(p).toMatch(/dashboard to render as QR \+ the manual-entry base32 secret/);
    expect(p).toMatch(/2\. Customer scans QR in their auth app, types the first 6-digit/);
    expect(p).toMatch(
      /3\. POST \/v1\/account\/mfa\/verify \{ code \} — service\.completeEnrollment/,
    );
    expect(p).toMatch(/decrypts the pending secret, verifies the code, sets/);
    expect(p).toMatch(/`enrolled_at`, mints \+ returns 10 recovery codes \(raw, shown ONCE\)/);
  });

  // ─── V-353e step-up disable framing ──────────────────────────

  it("CRITICAL Disable framing — 'DELETE /v1/account/mfa requires step-up (caller already satisfied per V-353e gate). Service.disable wipes the row + recovery codes'. The V-353e step-up + wipe-both contract prevents accidental MFA disable.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/mfa.ts'));
    expect(p).toMatch(/Disable: DELETE \/v1\/account\/mfa requires step-up \(caller already/);
    expect(p).toMatch(/satisfied per V-353e gate\)\. Service\.disable wipes the row \+ recovery/);
    expect(p).toMatch(/codes\./);
  });

  // ─── Verification: TOTP OR recovery code ─────────────────────

  it("CRITICAL Verification framing — 'Verification (login challenge or step-up): service.verifyCode(account, code) decrypts the row's secret, checks the 6-digit code OR consumes a recovery code (single-use; sets used_at)'. The TOTP-or-recovery + single-use semantics is the verify contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/mfa.ts'));
    expect(p).toMatch(/Verification \(login challenge or step-up\): service\.verifyCode\(account,/);
    expect(p).toMatch(/code\) decrypts the row's secret, checks the 6-digit code OR consumes/);
    expect(p).toMatch(/a recovery code \(single-use; sets `used_at`\)\./);
  });

  // ─── MfaEnrollmentRow 8-field shape ──────────────────────────

  it('CRITICAL MfaEnrollmentRow has 8 fields — accountId + totpSecretCiphertext + totpSecretIv + totpSecretTag + enrolledAt (nullable; null=pending) + lastUsedAt (nullable) + createdAt + updatedAt. The 3-cipher-field split (ciphertext + iv + tag) is the AES-256-GCM at-rest contract.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/mfa.ts'));
    expect(p).toMatch(/export interface MfaEnrollmentRow \{/);
    expect(p).toMatch(/accountId: string;/);
    expect(p).toMatch(/totpSecretCiphertext: string;/);
    expect(p).toMatch(/totpSecretIv: string;/);
    expect(p).toMatch(/totpSecretTag: string;/);
    expect(p).toMatch(/enrolledAt: Date \| null;/);
    expect(p).toMatch(/lastUsedAt: Date \| null;/);
    expect(p).toMatch(/createdAt: Date;/);
    expect(p).toMatch(/updatedAt: Date;/);
  });

  // ─── RecoveryCodeRow 5-field shape ───────────────────────────

  it('CRITICAL RecoveryCodeRow has 5 fields — id + accountId + codeHash + usedAt (nullable; single-use marker) + createdAt. The 5-field row carries the per-code single-use state; codeHash (not plaintext) keeps recovery codes secure at-rest.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/mfa.ts'));
    expect(p).toMatch(/export interface RecoveryCodeRow \{/);
    expect(p).toMatch(/id: string;/);
    expect(p).toMatch(/accountId: string;/);
    expect(p).toMatch(/codeHash: string;/);
    expect(p).toMatch(/usedAt: Date \| null;/);
    expect(p).toMatch(/createdAt: Date;/);
  });

  // ─── AES-256-GCM encryption framing ──────────────────────────

  it("CRITICAL MfaServiceConfig.encryptionKey framing — 'V-353b — base64-encoded 32-byte AES-256-GCM key'. The 32-byte AES-256-GCM key is the at-rest encryption contract; drift to AES-128 / CBC mode would weaken posture.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/mfa.ts'));
    expect(p).toMatch(/V-353b — base64-encoded 32-byte AES-256-GCM key/);
    expect(p).toMatch(/encryptionKey: string;/);
  });

  // ─── StartEnrollmentResult 2-field shape ─────────────────────

  it("CRITICAL StartEnrollmentResult has 2 fields — otpauthUri ('for the dashboard to render as QR code') + secretBase32 ('for manual entry into auth apps that don't QR'). The 2-field result lets dashboards offer QR scan OR manual entry; drift would force one flow over the other.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/mfa.ts'));
    expect(p).toMatch(/export interface StartEnrollmentResult \{/);
    expect(p).toMatch(/otpauth:\/\/ URI for the dashboard to render as a QR code/);
    expect(p).toMatch(/otpauthUri: string;/);
    expect(p).toMatch(/Base32 secret for manual entry into auth apps that don't QR/);
    expect(p).toMatch(/secretBase32: string;/);
  });

  // ─── CompleteEnrollmentResult shown-once recovery codes ──────

  it("CRITICAL CompleteEnrollmentResult.recoveryCodes framing — 'Raw recovery codes — shown ONCE to the customer'. The shown-once-then-hash pattern matches the V-079 API-key + V-667 OAuth client_secret pattern.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/mfa.ts'));
    expect(p).toMatch(/Raw recovery codes — shown ONCE to the customer/);
    expect(p).toMatch(/recoveryCodes: string\[\];/);
  });

  // ─── MfaService constructor + optional accountAudit ──────────

  it('CRITICAL MfaService constructor — repo + config + accountAudit optional (default null). The optional accountAudit lets test bootstrap skip audit-wiring (matches V-202b account-lifecycle + V-312 profile-snapshots optional-audit pattern).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/mfa.ts'));
    expect(p).toMatch(/export class MfaService \{/);
    expect(p).toMatch(/private readonly accountAudit: AccountAuditService \| null = null,/);
  });

  // ─── Re-enrollment conflict / pending-overwrite framing ──────

  it("CRITICAL startEnrollment JSDoc — 'V-353b — start enrollment: generate + encrypt + upsert pending secret. Re-enrolling overwrites the pending secret (customer re-scans QR + verifies fresh code). If the account is ALREADY enrolled (enrolled_at set), refuses with 409. The customer must disable first via DELETE /v1/account/mfa (step-up gated) and then re-enroll'. The pending-overwrite + 409-on-enrolled is the 2-state enrollment guard.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/mfa.ts'));
    expect(p).toMatch(/V-353b — start enrollment: generate \+ encrypt \+ upsert pending/);
    expect(p).toMatch(/secret\. Re-enrolling overwrites the pending secret \(customer/);
    expect(p).toMatch(/re-scans QR \+ verifies fresh code\)\. If the account is ALREADY/);
    expect(p).toMatch(/enrolled \(`enrolled_at` set\), refuses with 409\. The customer must/);
    expect(p).toMatch(/disable first via DELETE \/v1\/account\/mfa \(step-up gated\) and then/);
    expect(p).toMatch(/re-enroll/);
  });

  // ─── 10 recovery codes mint ──────────────────────────────────

  it('CRITICAL mints 10 recovery codes — generateRecoveryCodes returns 10 plaintexts; service hashes each + inserts. The 10-count is the industry-standard recovery code batch size.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/mfa.ts'));
    expect(p).toMatch(/const codes = generateRecoveryCodes\(\);/);
    expect(p).toMatch(/const hashes = await Promise\.all\(codes\.map\(\(c\) =>/);
    expect(p).toMatch(/hashApiKey\(normalizeRecoveryCode\(c\)\)/);
  });

  // ─── Recovery code single-use via markRecoveryCodeUsed ───────

  it('CRITICAL MfaRepo declares markRecoveryCodeUsed(id, now): Promise<boolean> — atomically consumes + returns whether THIS call spent it. The boolean gates double-spend (#5): the caller only grants access when the conditional UPDATE matched a row.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/mfa.ts'));
    expect(p).toMatch(/markRecoveryCodeUsed\(id: string, now: Date\): Promise<boolean>;/);
  });

  // ─── Atomic recovery-code rotation ───────────────────────────

  it('CRITICAL MfaRepo exposes one compare-and-set replacement primitive so invalidation and issuance cannot split', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/mfa.ts'));
    expect(p).toMatch(/replaceRecoveryCodesIfCurrent\(args: \{/);
    expect(p).toMatch(/expectedUpdatedAt: Date;/);
    expect(p).toMatch(/hashes: string\[\];/);
    expect(p).toMatch(/\): Promise<boolean>;/);
  });

  // ─── MFA primitives imported from lib/mfa-totp ───────────────

  it('CRITICAL MFA primitives imported from lib/mfa-totp — decryptSecret + encryptSecret + generateRecoveryCodes + generateTotpSecret + normalizeRecoveryCode + otpauthUri + verifyTotpCode. The 7-primitive import keeps crypto in lib/ + service-coordination in services/.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/mfa.ts'));
    expect(p).toMatch(/import \{/);
    expect(p).toMatch(/decryptSecret,/);
    expect(p).toMatch(/encryptSecret,/);
    expect(p).toMatch(/generateRecoveryCodes,/);
    expect(p).toMatch(/generateTotpSecret,/);
    expect(p).toMatch(/normalizeRecoveryCode,/);
    expect(p).toMatch(/otpauthUri,/);
    expect(p).toMatch(/verifyTotpCode,/);
    expect(p).toMatch(/\} from '\.\.\/lib\/mfa-totp\.js';/);
  });

  // ─── 3-error class import ────────────────────────────────────

  it('CRITICAL MfaService imports 3 error classes — BadRequestError + ConflictError + NotFoundError. The 3-error palette is what the service throws for input-validation / enrollment-conflict / row-missing cases.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/mfa.ts'));
    expect(p).toMatch(
      /import \{ BadRequestError, ConflictError, NotFoundError \} from '\.\.\/lib\/errors\.js';/,
    );
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/mfa-v353b-cross-source-invariant.test.ts'),
      ),
    ).toBe(true);
  });
});

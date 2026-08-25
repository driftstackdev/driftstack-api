// W402.C — drift guard for apps/server/src/services/mfa.ts.
// V-353b TOTP enrollment + verification + recovery codes. Drift here
// either breaks the 2-step enrollment dance (pending → enrolled_at
// set on first valid 6-digit code) or undermines recovery-code
// single-use invariant (raw codes shown ONCE).
//
//   • V-353b 3-step enrollment dance framing pinned (start →
//     scan-QR → verify-6-digit completes + mints 10 recovery codes
//     shown ONCE).
//   • Disable framing: V-353e step-up gate caller-enforced; service
//     trusts route; wipes row + recovery codes.
//   • verifyCode: TOTP path → touchLastUsed; recovery-code path →
//     normalize + scrypt-verify + single-use markUsed + remaining
//     count in audit.
//   • MfaEnrollmentRow: 8 fields including ciphertext+iv+tag triplet
//     for AES-256-GCM + enrolled_at nullable.
//   • RecoveryCodeRow: 5 fields with usedAt nullable.
//   • MfaRepo: 8 methods (findByAccount / upsertSecret / touchLastUsed
//     / deleteForAccount / insertRecoveryCodes / listUnusedRecoveryCodes
//     / markRecoveryCodeUsed / markAllRecoveryCodesUsed).
//   • startEnrollment: 409 ConflictError when already enrolled_at set
//     (must DELETE first).
//   • completeEnrollment: ConflictError on no-pending OR already-
//     enrolled; BadRequestError on invalid 6-digit code; mints 10
//     recovery codes; hashes NORMALIZED form (hyphen-stripped, upper-
//     cased) so verify accepts either typed form.
//   • disable: idempotent — findByAccount null → return (no-op).
//   • regenerateRecoveryCodes: markAllRecoveryCodesUsed → mint 10
//     fresh; requires enrolled.
//   • getStatus: enrolled=false short-circuit when not enrolled_at.
//   • accountAudit: try/catch swallow on mfa_enrolled /
//     mfa_disabled / recovery_code_used events (fire-and-forget).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/services/mfa.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W402.C apps/server/src/services/mfa.ts content parity', () => {
  const body = read(LIB);

  it('V-353b 3-step enrollment-dance framing pinned + V-353e step-up gate caller-enforced', () => {
    expect(body).toMatch(
      /V-353b — MFA service: TOTP enrollment \+ verification \+ recovery codes\./,
    );
    expect(body).toMatch(
      /1\. POST \/v1\/account\/mfa\/enroll {2}— service\.startEnrollment\(account\)\s*\/\/\s*generates a fresh secret, encrypts it, upserts the row WITHOUT\s*\/\/\s*`enrolled_at` \(still pending\)\. Returns the otpauth:\/\/ URI for the\s*\/\/\s*dashboard to render as QR \+ the manual-entry base32 secret\./,
    );
    expect(body).toMatch(
      /3\. POST \/v1\/account\/mfa\/verify \{ code \} — service\.completeEnrollment\s*\/\/\s*decrypts the pending secret, verifies the code, sets\s*\/\/\s*`enrolled_at`, mints \+ returns 10 recovery codes \(raw, shown ONCE\)\./,
    );
    expect(body).toMatch(
      /Disable: DELETE \/v1\/account\/mfa requires step-up \(caller already\s*\/\/\s*satisfied per V-353e gate\)\. Service\.disable wipes the row \+ recovery\s*\/\/\s*codes\./,
    );
  });

  it('MfaEnrollmentRow: 8 fields with AES-256-GCM triplet (ciphertext/iv/tag) + enrolledAt nullable + lastUsedAt nullable', () => {
    expect(body).toMatch(/export interface MfaEnrollmentRow \{/);
    expect(body).toMatch(/accountId: string;/);
    expect(body).toMatch(/totpSecretCiphertext: string;/);
    expect(body).toMatch(/totpSecretIv: string;/);
    expect(body).toMatch(/totpSecretTag: string;/);
    expect(body).toMatch(/enrolledAt: Date \| null;/);
    expect(body).toMatch(/lastUsedAt: Date \| null;/);
    expect(body).toMatch(/createdAt: Date;/);
    expect(body).toMatch(/updatedAt: Date;/);
  });

  it('RecoveryCodeRow: 5 fields with usedAt nullable (single-use marker)', () => {
    expect(body).toMatch(/export interface RecoveryCodeRow \{/);
    expect(body).toMatch(/id: string;/);
    expect(body).toMatch(/accountId: string;/);
    expect(body).toMatch(/codeHash: string;/);
    expect(body).toMatch(/usedAt: Date \| null;/);
    expect(body).toMatch(/createdAt: Date;/);
  });

  it('MfaRepo exposes atomic credential issuance transitions plus replay-safe consumption', () => {
    expect(body).toMatch(/export interface MfaRepo \{/);
    expect(body).toMatch(
      /\/\*\* V-353b — return the MFA row for the account \(any state\) or null\. \*\/\s*findByAccount\(accountId: string\): Promise<MfaEnrollmentRow \| null>;/,
    );
    expect(body).toMatch(
      /startEnrollmentIfNotEnrolled\(args: \{[\s\S]*?\}\): Promise<MfaEnrollmentRow \| null>;/,
    );
    expect(body).toMatch(
      /completeEnrollmentIfPending\(args: \{[\s\S]*?currentWebSessionId: string;[\s\S]*?expectedUpdatedAt: Date;[\s\S]*?hashes: string\[\];[\s\S]*?\}\): Promise<boolean>;/,
    );
    expect(body).toMatch(
      /\/\*\* V-353b — touch `last_used_at` after a successful verify\. \*\/\s*touchLastUsed\(accountId: string, now: Date\): Promise<void>;/,
    );
    expect(body).toMatch(
      /\/\*\* V-353b — delete the MFA row \+ recovery codes \(cascade\)\. \*\/\s*deleteForAccount\(accountId: string\): Promise<void>;/,
    );
    expect(body).toMatch(
      /listUnusedRecoveryCodes\(accountId: string\): Promise<RecoveryCodeRow\[\]>;/,
    );
    expect(body).toMatch(/markRecoveryCodeUsed\(id: string, now: Date\): Promise<boolean>;/);
    expect(body).toMatch(
      /replaceRecoveryCodesIfCurrent\(args: \{[\s\S]*?expectedUpdatedAt: Date;[\s\S]*?hashes: string\[\];[\s\S]*?\}\): Promise<boolean>;/,
    );
  });

  it('MfaServiceConfig: AES-256-GCM base64-encoded 32-byte encryption key', () => {
    expect(body).toMatch(/export interface MfaServiceConfig \{/);
    expect(body).toMatch(
      /\/\*\* V-353b — base64-encoded 32-byte AES-256-GCM key\. \*\/\s*encryptionKey: string;/,
    );
  });

  it('StartEnrollmentResult: otpauthUri + secretBase32 manual-entry fallback', () => {
    expect(body).toMatch(/export interface StartEnrollmentResult \{/);
    expect(body).toMatch(
      /\/\*\* otpauth:\/\/ URI for the dashboard to render as a QR code\. \*\/\s*otpauthUri: string;/,
    );
    expect(body).toMatch(
      /\/\*\* Base32 secret for manual entry into auth apps that don't QR\. \*\/\s*secretBase32: string;/,
    );
  });

  it('startEnrollment delegates the enrolled-state check and secret write to one atomic repo transition', () => {
    expect(body).toMatch(
      /async startEnrollment\(args: \{\s*accountId: string;\s*email: string;\s*\}\): Promise<StartEnrollmentResult> \{/,
    );
    expect(body).toMatch(/const started = await this\.repo\.startEnrollmentIfNotEnrolled\(\{/);
    expect(body).toMatch(/const \{ secretBase32, secretBytes \} = generateTotpSecret\(\);/);
    expect(body).toMatch(
      /const enc = encryptSecret\(secretBytes, this\.config\.encryptionKey, args\.accountId\);/,
    );
    expect(body).toMatch(/if \(started === null\) \{\s*throw new ConflictError\(/);
    expect(body).toMatch(/otpauthUri: otpauthUri\(\{ email: args\.email, secretBase32 \}\),/);
  });

  it('completeEnrollment: ConflictError on no-pending OR already-enrolled; BadRequestError on invalid 6-digit; mints 10 recovery codes hashed in NORMALIZED form', () => {
    expect(body).toMatch(
      /if \(!row\) \{\s*throw new ConflictError\('No pending MFA enrollment\. Call POST \/v1\/account\/mfa\/enroll first\.'\);/,
    );
    expect(body).toMatch(
      /if \(row\.enrolledAt !== null\) \{\s*throw new ConflictError\(\s*'MFA is already enrolled\. Disable \+ re-enroll if you need a fresh secret\.',\s*\);/,
    );
    expect(body).toMatch(
      /if \(!verifyTotpCode\(secretBytes, args\.code\)\) \{\s*throw new BadRequestError\('Invalid 6-digit code\. Try again\.'\);\s*\}/,
    );
    expect(body).toMatch(
      /\/\/ Hash the NORMALIZED form \(hyphen-stripped, uppercased\) so verify\s*\/\/ can check against either typed form \(with or without hyphen\)\.\s*const hashes = await Promise\.all\(codes\.map\(\(c\) => hashApiKey\(normalizeRecoveryCode\(c\)\)\)\);/,
    );
    expect(body).toMatch(/const completed = await this\.repo\.completeEnrollmentIfPending\(\{/);
    expect(body).toMatch(/currentWebSessionId: args\.currentWebSessionId,/);
    expect(body).toMatch(/expectedUpdatedAt: row\.updatedAt,/);
    expect(body).toMatch(/if \(!completed\) \{\s*throw new ConflictError\(/);
    expect(body).toMatch(/await this\.authCache\.invalidateAccount\(args\.accountId\);/);
  });

  it('completeEnrollment: emits account.mfa_enrolled audit; try/catch swallow', () => {
    expect(body).toMatch(
      /if \(this\.accountAudit\) \{\s*try \{\s*await this\.accountAudit\.record\(\{[\s\S]+?action: 'account\.mfa_enrolled',/,
    );
  });

  it('disable: idempotent — no row → no-op return; emit account.mfa_disabled audit + try/catch swallow', () => {
    expect(body).toMatch(/if \(!row\) \{\s*\/\/ Idempotent — already disabled\.\s*return;\s*\}/);
    expect(body).toMatch(/await this\.repo\.deleteForAccount\(args\.accountId\);/);
    expect(body).toMatch(/action: 'account\.mfa_disabled',/);
  });

  it('verifyCode: TOTP path (/^\\d{6}$/) → decrypt + verifyTotpCodeWithCounter + replay guard (consumeTotpCounter) + touchLastUsed → returns "totp"', () => {
    expect(body).toMatch(
      /async verifyCode\(args: \{\s*accountId: string;\s*input: string;\s*nowSeconds\?: number;\s*\}\): Promise<'totp' \| 'recovery' \| null> \{/,
    );
    expect(body).toMatch(
      /if \(!row \|\| row\.enrolledAt === null\) \{\s*throw new NotFoundError\('MFA is not enrolled for this account\.'\);/,
    );
    expect(body).toMatch(/if \(\/\^\\d\{6\}\$\/\.test\(trimmed\)\) \{/);
    // TOTP replay defence (migration 0090) — match the counter, reject when it
    // was already consumed, and consume atomically before accepting.
    expect(body).toMatch(
      /const matchedCounter = verifyTotpCodeWithCounter\(secretBytes, trimmed, args\.nowSeconds\);/,
    );
    expect(body).toMatch(/if \(matchedCounter === null\) return null;/);
    expect(body).toMatch(
      /if \(lastUsed !== null && matchedCounter <= lastUsed\) \{[\s\S]*?return null;\s*\}/,
    );
    expect(body).toMatch(
      /const accepted = await this\.repo\.consumeTotpCounter\(\{\s*accountId: args\.accountId,\s*counter: matchedCounter,/,
    );
    expect(body).toMatch(
      /await this\.repo\.touchLastUsed\(args\.accountId, new Date\(\)\);\s*return 'totp';/,
    );
  });

  it('verifyCode: recovery-code path → normalize + /^[A-Z0-9]{10}$/ + scrypt-verify-loop + single-use markRecoveryCodeUsed + audit with remaining count', () => {
    expect(body).toMatch(
      /\/\/ Recovery code path: normalize, scrypt-verify against any\s*\/\/ unused row\./,
    );
    expect(body).toMatch(/const normalized = normalizeRecoveryCode\(trimmed\);/);
    expect(body).toMatch(/if \(!\/\^\[A-Z0-9\]\{10\}\$\/\.test\(normalized\)\) return null;/);
    expect(body).toMatch(
      /\/\/ scrypt is constant-time-friendly per-row but the loop itself\s*\/\/ leaks "how many unused codes\." Customer's own action; not a\s*\/\/ cross-account leak\. Acceptable\./,
    );
    expect(body).toMatch(/const ok = await verifyApiKey\(normalized, c\.codeHash\);/);
    // #5 — success is gated on the atomic consume's rowcount: a concurrent
    // second consume of the same code returns false → null (no double-spend).
    expect(body).toMatch(
      /const consumed = await this\.repo\.markRecoveryCodeUsed\(c\.id, new Date\(\)\);\s*if \(!consumed\) return null;\s*await this\.repo\.touchLastUsed\(args\.accountId, new Date\(\)\);/,
    );
    expect(body).toMatch(
      /action: 'account\.recovery_code_used',[\s\S]+?payload: \{ remaining: candidates\.length - 1 \},/,
    );
    expect(body).toMatch(/return 'recovery';/);
  });

  it('regenerateRecoveryCodes: requires enrolled and atomically CAS-replaces one batch', () => {
    expect(body).toMatch(
      /async regenerateRecoveryCodes\(args: \{ accountId: string \}\): Promise<\{ recoveryCodes: string\[\] \}> \{/,
    );
    expect(body).toMatch(
      /if \(!row \|\| row\.enrolledAt === null\) \{\s*throw new NotFoundError\('MFA is not enrolled for this account\.'\);/,
    );
    expect(body).toMatch(/const codes = generateRecoveryCodes\(\);/);
    expect(body).toMatch(/const replaced = await this\.repo\.replaceRecoveryCodesIfCurrent\(\{/);
    expect(body).toMatch(/expectedUpdatedAt: row\.updatedAt,/);
    expect(body).toMatch(/if \(!replaced\) \{\s*throw new ConflictError\(/);
  });

  it('getStatus: enrolled=false short-circuit when not enrolled; otherwise enrolled+enrolledAt+lastUsedAt+unusedRecoveryCodes count', () => {
    expect(body).toMatch(
      /async getStatus\(accountId: string\): Promise<\{\s*enrolled: boolean;\s*enrolledAt: Date \| null;\s*lastUsedAt: Date \| null;\s*unusedRecoveryCodes: number;\s*\}> \{/,
    );
    expect(body).toMatch(
      /if \(!row \|\| row\.enrolledAt === null\) \{\s*return \{ enrolled: false, enrolledAt: null, lastUsedAt: null, unusedRecoveryCodes: 0 \};/,
    );
    expect(body).toMatch(
      /return \{\s*enrolled: true,\s*enrolledAt: row\.enrolledAt,\s*lastUsedAt: row\.lastUsedAt,\s*unusedRecoveryCodes: codes\.length,\s*\};/,
    );
  });

  it('Constructor: audit and auth cache are nullable defaults', () => {
    expect(body).toMatch(
      /constructor\(\s*private readonly repo: MfaRepo,\s*private readonly config: MfaServiceConfig,\s*private readonly accountAudit: AccountAuditService \| null = null,\s*private readonly authCache: AuthCache \| null = null,\s*\) \{\}/,
    );
  });

  it('imports: hashApiKey+verifyApiKey + mfa-totp helpers (8-import barrel incl. verifyTotpCodeWithCounter) + BadRequest/Conflict/NotFound from errors + AccountAuditService', () => {
    expect(body).toMatch(/import \{ hashApiKey, verifyApiKey \} from '\.\.\/lib\/api-keys\.js';/);
    expect(body).toMatch(
      /import \{\s*decryptSecret,\s*encryptSecret,\s*generateRecoveryCodes,\s*generateTotpSecret,\s*normalizeRecoveryCode,\s*otpauthUri,\s*verifyTotpCode,\s*verifyTotpCodeWithCounter,\s*\} from '\.\.\/lib\/mfa-totp\.js';/,
    );
    expect(body).toMatch(
      /import \{ BadRequestError, ConflictError, NotFoundError \} from '\.\.\/lib\/errors\.js';/,
    );
    expect(body).toMatch(/import type \{ AccountAuditService \} from '\.\/account-audit\.js';/);
    expect(body).toMatch(/import type \{ AuthCache \} from '\.\/auth-cache\.js';/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});

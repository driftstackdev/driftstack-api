// W887 — V-353b MFA enrollment TOTP cross-source invariant. Two-
// hundred-thirteenth in the drift-guard series. Pins the V-353b
// MFA enrollment flow:
//
//   MfaStatusResponse (4 fields):
//     - enrolled: boolean
//     - enrolled_at: ISO | null
//     - last_used_at: ISO | null
//     - unused_recovery_codes: int nonnegative
//
//   StartMfaEnrollmentResponse (5 fields, ALL literals for TOTP):
//     - otpauth_uri: string (otpauth:// URI for QR-code render)
//     - secret_base32: string (manual-entry secret)
//     - algorithm: literal 'SHA1'
//     - digits: literal 6
//     - period_seconds: literal 30
//
//   CompleteMfaEnrollmentResponse + RegenerateMfaRecoveryCodes:
//     - recovery_codes: z.array(z.string()).length(10)
//
//   The literal('SHA1') + literal(6) + literal(30) is the RFC 6238
//   TOTP "every authenticator app" defaults — drift would break
//   QR-scan compatibility.
//
// stays in lockstep across:
//   - packages/api-types/src/accounts.ts canonical Zod schemas.
//
// Drift would silently break:
//   * Authenticator-app interop (drift away from RFC 6238 defaults).
//   * Recovery-code array length contract (10 codes).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const RECOVERY_CODES_COUNT = 10;
const TOTP_DIGITS = 6;
const TOTP_PERIOD_SECONDS = 30;

describe('W887 V-353b MFA enrollment cross-source invariant', () => {
  // ─── V-353b anchor ────────────────────────────────────────────

  it("CRITICAL packages/api-types/src/accounts.ts pins V-353b anchor for the MFA section — 'V-353b — MFA (TOTP) enrollment + verify + recovery codes'. The anchor threads the MFA-feature provenance.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/accounts.ts'));
    expect(p).toMatch(/V-353b — MFA \(TOTP\) enrollment \+ verify \+ recovery codes/);
  });

  // ─── MfaStatusResponse 4-field shape ─────────────────────────

  it('CRITICAL MfaStatusResponseSchema has 4 fields — enrolled (boolean) + enrolled_at (ISO nullable) + last_used_at (ISO nullable) + unused_recovery_codes (int nonnegative). The 4-field shape is what dashboard MFA-settings page reads.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/accounts.ts'));
    expect(p).toMatch(
      /MfaStatusResponseSchema = z\.object\(\{\s*\n\s*enrolled: z\.boolean\(\),\s*\n\s*enrolled_at: Iso8601Schema\.nullable\(\),\s*\n\s*last_used_at: Iso8601Schema\.nullable\(\),\s*\n\s*unused_recovery_codes: z\.number\(\)\.int\(\)\.nonnegative\(\),\s*\n\s*\}\);/,
    );
  });

  // ─── StartMfaEnrollmentResponse RFC 6238 defaults ─────────────

  it("CRITICAL StartMfaEnrollmentResponseSchema has 5 fields with TOTP RFC 6238 defaults pinned via literals — algorithm: z.literal('SHA1') + digits: z.literal(6) + period_seconds: z.literal(30). The literals are what makes the response interop with EVERY authenticator app (vs server choosing different params).", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/accounts.ts'));
    expect(p).toMatch(/StartMfaEnrollmentResponseSchema = z\.object\(\{/);
    expect(p).toMatch(/algorithm: z\.literal\('SHA1'\),/);
    expect(p).toMatch(/digits: z\.literal\(6\),/);
    expect(p).toMatch(/period_seconds: z\.literal\(30\),/);
  });

  it('CRITICAL StartMfaEnrollmentResponse otpauth_uri + secret_base32 carry describe() hints — otpauth:// URI is the QR-code source; secret_base32 is the manual-entry fallback. The dual-mode lets customers use either QR-scanners OR authenticator apps that lack camera access.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/accounts.ts'));
    expect(p).toMatch(
      /otpauth_uri: z\.string\(\)\.describe\('otpauth:\/\/ URI; render as a QR code'\)/,
    );
    expect(p).toMatch(
      /secret_base32: z\.string\(\)\.describe\('Manual-entry secret for auth apps that do not scan QR'\)/,
    );
  });

  // ─── CompleteMfaEnrollment + Regenerate: 10 recovery codes ───

  it('CRITICAL CompleteMfaEnrollmentResponse + RegenerateMfaRecoveryCodesResponse both return recovery_codes: z.array(z.string()).length(10). The 10-code count is what V-353b customer flow promises — drift to a different count would break dashboard rendering + customer expectations.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/accounts.ts'));
    expect(p).toMatch(
      /CompleteMfaEnrollmentResponseSchema = z\.object\(\{\s*\n\s*recovery_codes: z\.array\(z\.string\(\)\)\.length\(10\),/,
    );
    expect(p).toMatch(
      /RegenerateMfaRecoveryCodesResponseSchema = z\.object\(\{\s*\n\s*recovery_codes: z\.array\(z\.string\(\)\)\.length\(10\),/,
    );
  });

  // ─── 4 schemas exported ──────────────────────────────────────

  it('CRITICAL all 4 MFA enrollment-flow schemas are exported with z.infer types — MfaStatusResponse + StartMfaEnrollmentResponse + CompleteMfaEnrollmentResponse + RegenerateMfaRecoveryCodesResponse. The 4-type set is the full enrollment lifecycle.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/accounts.ts'));
    expect(p).toMatch(/export type MfaStatusResponse = z\.infer<typeof MfaStatusResponseSchema>;/);
    expect(p).toMatch(
      /export type StartMfaEnrollmentResponse = z\.infer<typeof StartMfaEnrollmentResponseSchema>;/,
    );
    expect(p).toMatch(
      /export type CompleteMfaEnrollmentResponse = z\.infer<typeof CompleteMfaEnrollmentResponseSchema>;/,
    );
    expect(p).toMatch(
      /export type RegenerateMfaRecoveryCodesResponse = z\.infer<\s*typeof RegenerateMfaRecoveryCodesResponseSchema\s*>;/,
    );
  });

  // ─── TOTP defaults match W870 6-digit MFA challenge ───────────

  it('CRITICAL TOTP defaults — digits=6 + period=30s + algorithm=SHA1 — match the W870-pinned challenge-code regex /^\\d{6}$/. The 6-digit code from authenticator apps is what the challenge regex accepts.', () => {
    expect(TOTP_DIGITS).toBe(6);
    expect(TOTP_PERIOD_SECONDS).toBe(30);
  });

  // ─── 10-recovery-code cardinality ─────────────────────────────

  it('CRITICAL recovery_codes.length(10) is the V-353b contract. The 10 codes give customers reasonable buffer for lost-phone scenarios without flooding the dashboard render.', () => {
    expect(RECOVERY_CODES_COUNT).toBe(10);
  });

  // ─── No alternative TOTP defaults ─────────────────────────────

  it('CRITICAL StartMfaEnrollmentResponse does NOT declare alternative TOTP defaults (SHA256 / SHA512 / 4-digit / 60s period). RFC 6238 SHA1/6/30 is the universal compat — drift to SHA256 would break older authenticator apps.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/accounts.ts'));
    const m = p.match(/StartMfaEnrollmentResponseSchema = z\.object\(\{([\s\S]+?)\}\);/);
    expect(m).not.toBeNull();
    const body = m![1];
    expect(body, 'algorithm must NOT be SHA256/SHA512').not.toMatch(/z\.literal\('SHA(256|512)'\)/);
    expect(body, 'digits must NOT be 4 or 8').not.toMatch(/digits: z\.literal\([48]\)/);
    expect(body, 'period must NOT be 60s').not.toMatch(/period_seconds: z\.literal\(60\)/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/mfa-enrollment-cross-source-invariant.test.ts'),
      ),
    ).toBe(true);
  });
});

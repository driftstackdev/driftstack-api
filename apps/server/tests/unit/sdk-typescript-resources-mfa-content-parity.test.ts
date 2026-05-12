// W427.A — drift guard for packages/sdk-typescript/src/resources/mfa.ts.
// V-353b/V-448 MFA enrollment surface. Drift here either breaks the
// V-353e step-up gate (disable without fresh proof would skip 2FA)
// or strips the "shown ONCE" recovery-codes invariant (consumer
// forgets to store + locks themselves out).
//
//   • Framing pinned: V-353b/V-448 + per-account (NOT team-RBAC) +
//     pairs with auth.mfaChallenge + auth.mfaStepUp.
//   • MfaStatusResponse: enrolled + enrolled_at + last_used_at +
//     unused_recovery_codes.
//   • MfaEnrollResponse: otpauth_uri + secret_base32 + algorithm
//     SHA1 + digits 6 + period_seconds 30.
//   • MfaVerifyRequest.code + MfaVerifyResponse.recovery_codes
//     (10 single-use; shown ONCE).
//   • MfaDisableRequest.confirm: literal 'disable-mfa'.
//   • 5 verbs: status (GET) + enroll (POST empty body) + verify
//     (POST code) + disable (DELETE with confirm body) +
//     regenerateRecoveryCodes (POST empty).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/mfa.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W427.A packages/sdk-typescript/src/resources/mfa.ts content parity', () => {
  const body = read(LIB);

  it('Framing pinned: V-353b/V-448 typed methods for /v1/account/mfa/* + per-account (NOT team-RBAC) + pairs with auth.mfaChallenge/mfaStepUp', () => {
    expect(body).toMatch(
      /\/\/ MfaResource — typed methods for \/v1\/account\/mfa\/\* \(V-353b\/V-448\)\./,
    );
    expect(body).toMatch(
      /\/\/ Enrollment management \(status \/ enroll \/ verify \/ disable \/ regenerate\s*\n?\s*\/\/ recovery codes\)\. Uses the calling web-session bearer; the V-326e\s*\n?\s*\/\/ X-Driftstack-Account team-RBAC header is not honored — MFA is per-\s*\n?\s*\/\/ account, not per-team-context\./,
    );
    expect(body).toMatch(
      /\/\/ Pairs with `client\.auth\.mfaChallenge` \(login MFA exchange\) \+\s*\n?\s*\/\/ `client\.auth\.mfaStepUp` \(V-353e step-up gate\)\./,
    );
  });

  it('MfaStatusResponse: enrolled boolean + enrolled_at + last_used_at (nullable) + unused_recovery_codes counter', () => {
    expect(body).toMatch(
      /export interface MfaStatusResponse \{\s*\n?\s*enrolled: boolean;\s*\n?\s*enrolled_at: string \| null;\s*\n?\s*last_used_at: string \| null;\s*\n?\s*unused_recovery_codes: number;\s*\n?\s*\}/,
    );
  });

  it("MfaEnrollResponse: otpauth_uri (QR code) + plaintext secret_base32 (manual entry) + algorithm 'SHA1' literal + digits 6 literal + period_seconds 30 literal", () => {
    expect(body).toMatch(
      /export interface MfaEnrollResponse \{\s*\n?\s*\/\*\* otpauth:\/\/ URI for QR-code rendering in an authenticator app\. \*\/\s*\n?\s*otpauth_uri: string;\s*\n?\s*\/\*\* Plaintext base32-encoded TOTP secret for manual entry\. \*\/\s*\n?\s*secret_base32: string;\s*\n?\s*algorithm: 'SHA1';\s*\n?\s*digits: 6;\s*\n?\s*period_seconds: 30;\s*\n?\s*\}/,
    );
  });

  it('MfaVerifyRequest: code (first 6-digit TOTP) + MfaVerifyResponse: recovery_codes string[] (10 single-use, shown ONCE)', () => {
    expect(body).toMatch(
      /export interface MfaVerifyRequest \{\s*\n?\s*\/\*\* First 6-digit TOTP code from the customer's authenticator app\. \*\/\s*\n?\s*code: string;\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /export interface MfaVerifyResponse \{\s*\n?\s*\/\*\* 10 single-use recovery codes; shown ONCE\. \*\/\s*\n?\s*recovery_codes: string\[\];\s*\n?\s*\}/,
    );
  });

  it("MfaDisableRequest: confirm literal 'disable-mfa' (typo-safe destructive-action gate)", () => {
    expect(body).toMatch(
      /export interface MfaDisableRequest \{\s*\n?\s*\/\*\* Literal 'disable-mfa' confirmation phrase\. \*\/\s*\n?\s*confirm: 'disable-mfa';\s*\n?\s*\}/,
    );
  });

  it('status verb: GET /v1/account/mfa', () => {
    expect(body).toMatch(/\/\*\* Read MFA enrollment state for the calling account\. \*\//);
    expect(body).toMatch(
      /status\(\): Promise<MfaStatusResponse> \{\s*\n?\s*return this\.http\.request<MfaStatusResponse>\(\{\s*\n?\s*method: 'GET',\s*\n?\s*path: '\/v1\/account\/mfa',\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('enroll verb: POST /v1/account/mfa/enroll empty body; plaintext shown ONCE (secret stored encrypted at rest)', () => {
    expect(body).toMatch(
      /\*\s*Start TOTP enrollment\. Customer scans `otpauth_uri` with their\s*\n?\s*\*\s*authenticator app, then calls `verify\(\.\.\.\)` with the first\s*\n?\s*\*\s*6-digit code\. Server stores the secret encrypted at rest;\s*\n?\s*\*\s*plaintext is shown ONCE here\./,
    );
    expect(body).toMatch(
      /enroll\(\): Promise<MfaEnrollResponse> \{\s*\n?\s*return this\.http\.request<MfaEnrollResponse>\(\{\s*\n?\s*method: 'POST',\s*\n?\s*path: '\/v1\/account\/mfa\/enroll',\s*\n?\s*body: \{\},\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('verify verb: POST /v1/account/mfa/verify; returns 10 recovery codes', () => {
    expect(body).toMatch(
      /\/\*\* Confirm enrollment with the first code\. Returns 10 recovery codes\. \*\//,
    );
    expect(body).toMatch(
      /verify\(body: MfaVerifyRequest\): Promise<MfaVerifyResponse> \{\s*\n?\s*return this\.http\.request<MfaVerifyResponse>\(\{\s*\n?\s*method: 'POST',\s*\n?\s*path: '\/v1\/account\/mfa\/verify',\s*\n?\s*body,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('disable verb: DELETE /v1/account/mfa with confirm body; V-353e 15-min step-up gate; recovery codes invalidated', () => {
    expect(body).toMatch(
      /\*\s*Disable MFA\. Requires fresh MFA proof per V-353e step-up gate\s*\n?\s*\*\s*\(15-minute freshness window\) — call `client\.auth\.mfaStepUp\(\.\.\.\)`\s*\n?\s*\*\s*first if the gate is stale\. Recovery codes are invalidated\./,
    );
    expect(body).toMatch(
      /disable\(body: MfaDisableRequest\): Promise<void> \{\s*\n?\s*return this\.http\.request<void>\(\{\s*\n?\s*method: 'DELETE',\s*\n?\s*path: '\/v1\/account\/mfa',\s*\n?\s*body,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('regenerateRecoveryCodes verb: POST /v1/account/mfa/recovery-codes/regenerate empty body; 10 fresh codes shown ONCE; old invalidated', () => {
    expect(body).toMatch(
      /\/\*\* Mint 10 fresh recovery codes\. Old codes invalidated; shown ONCE\. \*\//,
    );
    expect(body).toMatch(
      /regenerateRecoveryCodes\(\): Promise<MfaVerifyResponse> \{\s*\n?\s*return this\.http\.request<MfaVerifyResponse>\(\{\s*\n?\s*method: 'POST',\s*\n?\s*path: '\/v1\/account\/mfa\/recovery-codes\/regenerate',\s*\n?\s*body: \{\},\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('imports: HttpClient only (MFA shapes are SDK-internal — not re-exported from api-types)', () => {
    expect(body).toMatch(/import type \{ HttpClient \} from '\.\.\/http\.js';/);
    expect(body).not.toMatch(/from '@driftstack\/api-types'/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});

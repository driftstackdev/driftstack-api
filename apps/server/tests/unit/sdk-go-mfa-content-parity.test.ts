// W590.C (W637-deepened) — drift guard for packages/sdk-go/mfa.go.
// MfaResource Go parity. V-353b/V-448 MFA enrollment management.
//
// W637 splits the original 3 it() blocks (framing-bundle + 5-verbs-
// bundle + file-exists) into 8 focused per-concept blocks + pins
// previously-implicit invariants:
//
//   • Per-account-only invariant: "MFA enrollment is per-account,
//     never per-team-context — these endpoints don't honor the
//     X-Driftstack-Account header." Drift to honoring the header
//     would let a team member set up MFA on the owner's account,
//     widening the auth surface.
//   • TOTP parameter triplet (SHA1 / 6 digits / 30s) pinned via
//     inline-comments on the struct fields — drift to SHA256 or a
//     different digit count would break existing authenticator-app
//     pairings.
//   • Show-ONCE invariants on (a) SecretBase32 in MfaEnrollResponse,
//     (b) RecoveryCodes in MfaVerifyResponse + RegenerateRecoveryCodes
//     response. The customer cannot re-read these later — if they
//     lose them, they must re-enroll. This is the load-bearing
//     security claim that justifies storing only encrypted hashes
//     server-side.
//   • Disable V-353e step-up gate: "Customer should call MfaStepUp
//     first if the 15-min window is stale" + "Recovery codes are
//     invalidated." Both pinned because dropping either would silently
//     make MFA-disable easier than intended.
//   • MfaDisableRequest literal "disable-mfa" confirmation phrase
//     (inline-comment // "disable-mfa") — prevents accidental UI
//     disables.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-go/mfa.go');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W590.C packages/sdk-go/mfa.go content parity', () => {
  const body = read(LIB);

  it("file exists at canonical path + V-353b/V-448 MfaResource binds /v1/account/mfa/* + pairs-with-auth-MfaChallenge/MfaStepUp + CRITICAL per-account-only invariant: 'MFA enrollment is per-account, never per-team-context — these endpoints don't honor the X-Driftstack-Account header.' Drift to honoring the header would let a team member set up MFA on the owner's account.", () => {
    expect(existsSync(LIB)).toBe(true);
    expect(body).toMatch(/^package driftstack$/m);
    expect(body).toMatch(
      /\/\/ MfaResource handles \/v1\/account\/mfa\/\* endpoints \(V-353b \/ V-448\)\./,
    );
    expect(body).toMatch(/\/\/ Pairs with `client\.Auth\.MfaChallenge` \(login MFA exchange\) and/);
    expect(body).toMatch(
      /\/\/ `client\.Auth\.MfaStepUp` \(V-353e step-up gate\)\. MFA enrollment is/,
    );
    expect(body).toMatch(/\/\/ per-account, never per-team-context — these endpoints don't honor/);
    expect(body).toMatch(/\/\/ the X-Driftstack-Account header\./);
    expect(body).toMatch(/^type MfaResource struct \{\s*\n\s*client \*Client\s*\n\}/m);
  });

  it("MfaStatus — V-353b 4-field enrollment state with nullable EnrolledAt + LastUsedAt + UnusedRecoveryCodes count. UnusedRecoveryCodes int is what lets the dashboard nag users when they've burnt through their codes and should regenerate before lockout.", () => {
    expect(body).toMatch(/\/\/ MfaStatus — V-353b enrollment state\./);
    expect(body).toMatch(
      /^type MfaStatus struct \{\s*\n\s*Enrolled\s+bool\s+`json:"enrolled"`\s*\n\s*EnrolledAt\s+\*time\.Time `json:"enrolled_at"`\s*\n\s*LastUsedAt\s+\*time\.Time `json:"last_used_at"`\s*\n\s*UnusedRecoveryCodes int\s+`json:"unused_recovery_codes"`\s*\n\}/m,
    );
  });

  it('MfaEnrollResponse — TOTP enrollment payload. SecretBase32 shown ONCE (the manual-entry fallback if the customer can\'t scan the QR code; encrypted at rest server-side). TOTP parameter triplet pinned via inline-comments: Algorithm "SHA1" + Digits 6 + PeriodSeconds 30. Drift to SHA256 or 8 digits would break existing authenticator-app pairings without warning.', () => {
    expect(body).toMatch(
      /\/\/ MfaEnrollResponse — first half of TOTP enrollment\. Customer scans\s*\n\/\/ `OtpauthURI` with their authenticator app, then calls Verify with/,
    );
    expect(body).toMatch(/\/\/ the first 6-digit code\. SecretBase32 is shown ONCE for manual/);
    expect(body).toMatch(/\/\/ entry; the server stores it encrypted at rest\./);
    expect(body).toMatch(
      /^type MfaEnrollResponse struct \{\s*\n\s*OtpauthURI\s+string `json:"otpauth_uri"`\s*\n\s*SecretBase32\s+string `json:"secret_base32"`\s*\n\s*Algorithm\s+string `json:"algorithm"`\s+\/\/ "SHA1"\s*\n\s*Digits\s+int\s+`json:"digits"`\s+\/\/ 6\s*\n\s*PeriodSeconds int\s+`json:"period_seconds"` \/\/ 30\s*\n\}/m,
    );
  });

  it('MfaVerifyRequest + MfaVerifyResponse — Verify takes the first 6-digit TOTP code; response returns 10 single-use recovery codes shown ONCE (customer must persist them now; the server stores only hashes). Same MfaVerifyResponse type re-used by RegenerateRecoveryCodes so customers process both flows with the same parser.', () => {
    expect(body).toMatch(
      /\/\/ MfaVerifyRequest — first 6-digit TOTP code from the customer's app\./,
    );
    expect(body).toMatch(
      /^type MfaVerifyRequest struct \{\s*\n\s*Code string `json:"code"`\s*\n\}/m,
    );
    expect(body).toMatch(/\/\/ MfaVerifyResponse — 10 single-use recovery codes\. Shown ONCE\./);
    expect(body).toMatch(
      /^type MfaVerifyResponse struct \{\s*\n\s*RecoveryCodes \[\]string `json:"recovery_codes"`\s*\n\}/m,
    );
  });

  it('MfaDisableRequest — literal "disable-mfa" confirmation phrase invariant (inline-comment // "disable-mfa" on the Confirm field). Prevents accidental UI disables; the dashboard must explicitly POST the literal string before MFA can be turned off.', () => {
    expect(body).toMatch(/\/\/ MfaDisableRequest — literal "disable-mfa" confirmation phrase\./);
    expect(body).toMatch(
      /^type MfaDisableRequest struct \{\s*\n\s*Confirm string `json:"confirm"` \/\/ "disable-mfa"\s*\n\}/m,
    );
  });

  it('Status — GET /v1/account/mfa reads enrollment state. Single-line requestOptions pinned because Status is the only verb that uses the inline {method:, path:, out:} struct-literal form (the others use multi-line for the body field).', () => {
    expect(body).toMatch(/\/\/ Status — read MFA enrollment state for the calling account\./);
    expect(body).toMatch(
      /func \(r \*MfaResource\) Status\(ctx context\.Context\) \(\*MfaStatus, error\) \{\s*\n\s*var out MfaStatus\s*\n\s*if err := r\.client\.do\(ctx, requestOptions\{method: "GET", path: "\/v1\/account\/mfa", out: &out\}\); err != nil \{/,
    );
  });

  it('Enroll — POST /v1/account/mfa/enroll, empty struct body (no input needed; the SDK provides struct{}{} so the wire body is "{}" not "null"). Returns MfaEnrollResponse with one-shot SecretBase32.', () => {
    expect(body).toMatch(
      /\/\/ Enroll — start TOTP enrollment\. Customer scans the otpauth URI\s*\n\/\/ from the response in their authenticator app, then calls Verify\./,
    );
    expect(body).toMatch(
      /func \(r \*MfaResource\) Enroll\(ctx context\.Context\) \(\*MfaEnrollResponse, error\)/,
    );
    expect(body).toMatch(
      /method: "POST",\s*\n\s*path:\s+"\/v1\/account\/mfa\/enroll",\s*\n\s*body:\s+struct\{\}\{\},/,
    );
  });

  it('Verify — POST /v1/account/mfa/verify with first TOTP code. Returns 10 recovery codes shown ONCE (the only chance the customer has to persist them; the server stores only single-use hashes).', () => {
    expect(body).toMatch(/\/\/ Verify — confirm enrollment with first 6-digit code\. Returns 10/);
    expect(body).toMatch(/\/\/ single-use recovery codes \(shown ONCE\)\./);
    expect(body).toMatch(
      /func \(r \*MfaResource\) Verify\(ctx context\.Context, body \*MfaVerifyRequest\) \(\*MfaVerifyResponse, error\)/,
    );
    expect(body).toMatch(/method: "POST",\s*\n\s*path:\s+"\/v1\/account\/mfa\/verify",/);
  });

  it('Disable — V-353e step-up-gated DELETE /v1/account/mfa. CRITICAL framing: "Requires fresh MFA proof per V-353e step-up gate. Customer should call MfaStepUp first if the 15-min window is stale. Recovery codes are invalidated." Both the 15-min step-up window AND the "recovery codes are invalidated" side-effect are pinned because dropping either would silently make MFA-disable easier than intended.', () => {
    expect(body).toMatch(
      /\/\/ Disable — disable MFA\. Requires fresh MFA proof per V-353e step-up/,
    );
    expect(body).toMatch(
      /\/\/ gate\. Customer should call MfaStepUp\(ctx, \.\.\.\) first if the 15-min/,
    );
    expect(body).toMatch(/\/\/ window is stale\. Recovery codes are invalidated\./);
    expect(body).toMatch(
      /func \(r \*MfaResource\) Disable\(ctx context\.Context, body \*MfaDisableRequest\) error \{\s*\n\s*return r\.client\.do\(ctx, requestOptions\{\s*\n\s*method: "DELETE",\s*\n\s*path:\s+"\/v1\/account\/mfa",\s*\n\s*body:\s+body,\s*\n\s*\}\)\s*\n\}/,
    );
  });

  it('RegenerateRecoveryCodes — POST /v1/account/mfa/recovery-codes/regenerate, empty struct body. Returns 10 fresh recovery codes shown ONCE; "old codes invalidated" framing pinned so customers know regeneration is a destructive rotation, not an append.', () => {
    expect(body).toMatch(/\/\/ RegenerateRecoveryCodes — mint 10 fresh recovery codes; old codes/);
    expect(body).toMatch(/\/\/ invalidated\. Shown ONCE\./);
    expect(body).toMatch(
      /func \(r \*MfaResource\) RegenerateRecoveryCodes\(ctx context\.Context\) \(\*MfaVerifyResponse, error\)/,
    );
    expect(body).toMatch(
      /method: "POST",\s*\n\s*path:\s+"\/v1\/account\/mfa\/recovery-codes\/regenerate",\s*\n\s*body:\s+struct\{\}\{\},/,
    );
  });
});

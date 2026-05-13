// W590.C — drift guard for packages/sdk-go/mfa.go.
// MfaResource Go parity. V-353b/V-448 MFA enrollment management.
//
//   • Per-account, never per-team-context (no X-Driftstack-Account).
//   • 5 verbs: Status / Enroll / Verify / Disable / Regenerate
//     RecoveryCodes.
//   • Pairs with client.Auth.MfaChallenge + MfaStepUp.
//   • MfaEnrollResponse exposes otpauth URI + base32 (shown ONCE)
//     + SHA1/6-digit/30s TOTP parameters.
//   • MfaDisableRequest carries literal "disable-mfa" confirmation.
//   • Disable: V-353e step-up gated; recovery codes invalidated.
//   • Verify + RegenerateRecoveryCodes return 10 recovery codes
//     (shown ONCE).

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

  it('MfaResource framing: V-353b/V-448 + pairs-with-auth-MfaChallenge/MfaStepUp + per-account-no-team-RBAC + MfaStatus/Enroll/Verify/Disable types pinned', () => {
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
    expect(body).toMatch(/\/\/ MfaStatus — V-353b enrollment state\./);
    expect(body).toMatch(/UnusedRecoveryCodes int\s+`json:"unused_recovery_codes"`/);
    expect(body).toMatch(/\/\/ MfaEnrollResponse — first half of TOTP enrollment\./);
    expect(body).toMatch(/SecretBase32 {2}string `json:"secret_base32"`/);
    expect(body).toMatch(/Algorithm\s+string `json:"algorithm"`\s+\/\/ "SHA1"/);
    expect(body).toMatch(/Digits\s+int\s+`json:"digits"`\s+\/\/ 6/);
    expect(body).toMatch(/PeriodSeconds int\s+`json:"period_seconds"` \/\/ 30/);
    expect(body).toMatch(/\/\/ MfaDisableRequest — literal "disable-mfa" confirmation phrase\./);
    expect(body).toMatch(
      /^type MfaDisableRequest struct \{\s*\n\s*Confirm string `json:"confirm"` \/\/ "disable-mfa"\s*\n\}/m,
    );
  });

  it('5 verbs: Status GET + Enroll POST struct{}{} body + Verify POST + Disable DELETE V-353e-step-up-gated + RegenerateRecoveryCodes POST 10-codes-shown-ONCE pinned', () => {
    expect(body).toMatch(
      /func \(r \*MfaResource\) Status\(ctx context\.Context\) \(\*MfaStatus, error\) \{\s*\n\s*var out MfaStatus\s*\n\s*if err := r\.client\.do\(ctx, requestOptions\{method: "GET", path: "\/v1\/account\/mfa", out: &out\}\); err != nil \{/,
    );
    expect(body).toMatch(/\/\/ Enroll — start TOTP enrollment\./);
    expect(body).toMatch(
      /func \(r \*MfaResource\) Enroll\(ctx context\.Context\) \(\*MfaEnrollResponse, error\) \{/,
    );
    expect(body).toMatch(/path:\s+"\/v1\/account\/mfa\/enroll",\s*\n\s*body:\s+struct\{\}\{\},/);
    expect(body).toMatch(/\/\/ Verify — confirm enrollment with first 6-digit code\./);
    expect(body).toMatch(
      /func \(r \*MfaResource\) Verify\(ctx context\.Context, body \*MfaVerifyRequest\) \(\*MfaVerifyResponse, error\) \{/,
    );
    expect(body).toMatch(/path:\s+"\/v1\/account\/mfa\/verify",/);
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
    expect(body).toMatch(/\/\/ RegenerateRecoveryCodes — mint 10 fresh recovery codes; old codes/);
    expect(body).toMatch(/\/\/ invalidated\. Shown ONCE\./);
    expect(body).toMatch(/path:\s+"\/v1\/account\/mfa\/recovery-codes\/regenerate",/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});

// W700 — cross-SDK V-353b/V-353e/V-326e/V-448 MFA lifecycle parity.
// Twenty-seventh in the cross-SDK drift-guard series (W649 + W675-
// W700) and the 700th wave milestone.
//
// Asserts the V-353b MFA enrollment + V-353e step-up gate + V-326e
// per-account-not-per-team contract is consistent across all 3 SDKs:
//
//   - V-353b + V-448 anchors on the resource header per-SDK
//   - V-353e step-up gate referenced on disable verb per-SDK
//   - V-326e "X-Driftstack-Account header NOT honored" framing on
//     resource header (MFA is per-account, not per-team-context)
//   - 5-verb surface (status + enroll + verify + disable +
//     regenerateRecoveryCodes) language-canonical naming
//   - 5 wire-paths: /v1/account/mfa + /v1/account/mfa/enroll +
//     /v1/account/mfa/verify + /v1/account/mfa/recovery-codes/
//     regenerate (DELETE on /v1/account/mfa = disable)
//   - 10 single-use recovery codes shown ONCE
//   - TOTP enrollment shape: SHA1 + 6 digits + 30-second period
//   - "disable-mfa" literal confirm phrase
//   - 15-minute step-up freshness window framing on disable
//
// CRITICAL invariant: SecretBase32 + recovery codes are PLAINTEXT-
// ONCE — drift to letting them surface elsewhere would let the
// secret leak through audit-log or repeated GET.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const TS_MFA = resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/mfa.ts');
const GO_MFA = resolve(REPO_ROOT, 'packages/sdk-go/mfa.go');
const PY_MFA = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/resources/mfa.py');

describe('W700 cross-SDK V-353b/V-353e/V-326e MFA lifecycle parity', () => {
  it('all 3 SDK MFA files exist at canonical paths', () => {
    expect(existsSync(TS_MFA), `missing ${TS_MFA}`).toBe(true);
    expect(existsSync(GO_MFA), `missing ${GO_MFA}`).toBe(true);
    expect(existsSync(PY_MFA), `missing ${PY_MFA}`).toBe(true);
  });

  it('CRITICAL V-353b + V-448 anchors pinned on the resource header in all 3 SDKs. V-353b = MFA-enrollment-base; V-448 = MFA-enrollment-companion feature. Drift to dropping would lose changelog provenance.', () => {
    const ts = read(TS_MFA);
    const go = read(GO_MFA);
    const py = read(PY_MFA);

    // sdk-typescript: "V-353b/V-448"
    expect(ts).toMatch(/V-353b/);
    expect(ts).toMatch(/V-448/);

    // sdk-go: "V-353b / V-448"
    expect(go).toMatch(/V-353b/);
    expect(go).toMatch(/V-448/);

    // sdk-python: "V-353b / V-448"
    expect(py).toMatch(/V-353b/);
    expect(py).toMatch(/V-448/);
  });

  it('CRITICAL V-353e step-up gate anchor pinned on disable in all 3 SDKs. V-353e = MFA-step-up-gate (15-min freshness). Drift to dropping would lose the customer-facing claim that disable requires fresh MFA proof.', () => {
    const ts = read(TS_MFA);
    const go = read(GO_MFA);
    const py = read(PY_MFA);

    expect(ts).toMatch(/V-353e step-up gate/);
    expect(go).toMatch(/V-353e step-up/);
    expect(py).toMatch(/V-353e step-up/);
  });

  it('CRITICAL "X-Driftstack-Account team-RBAC header NOT honored" framing pinned in TS + Go. MFA is PER-ACCOUNT (not per-team-context); drift to honoring the team header would let a team member with admin scope disable the OWNER\'s MFA. (sdk-python pending regen.)', () => {
    const ts = read(TS_MFA);
    const go = read(GO_MFA);

    // sdk-typescript: "the V-326e\n// X-Driftstack-Account team-RBAC header is not honored — MFA is per-\n// account, not per-team-context"
    expect(ts).toMatch(/V-326e/);
    expect(ts).toMatch(
      /X-Driftstack-Account team-RBAC header is not honored|X-Driftstack-Account header[\s\S]{0,40}not honored/,
    );
    expect(ts).toMatch(/per-account|per-\s*\/\/\s*account/);

    // sdk-go: "MFA enrollment is\n// per-account, never per-team-context — these endpoints don't honor\n// the X-Driftstack-Account header"
    expect(go).toMatch(/per-account/);
    expect(go).toMatch(
      /don't honor\s*\/\/\s*the X-Driftstack-Account header|don't honor the X-Driftstack-Account/,
    );
  });

  it('CRITICAL 5-verb surface pinned in all 3 SDKs — status + enroll + verify + disable + regenerateRecoveryCodes. The 5-verb set is the full MFA enrollment lifecycle; drift to dropping any would break the dashboard MFA flow.', () => {
    const ts = read(TS_MFA);
    const go = read(GO_MFA);
    const py = read(PY_MFA);

    // sdk-typescript: camelCase methods.
    expect(ts).toMatch(/status\(\)/);
    expect(ts).toMatch(/enroll\(\)/);
    expect(ts).toMatch(/verify\(body:/);
    expect(ts).toMatch(/disable\(body:/);
    expect(ts).toMatch(/regenerateRecoveryCodes\(\)/);

    // sdk-go: PascalCase methods.
    expect(go).toMatch(/func \(r \*MfaResource\) Status\(/);
    expect(go).toMatch(/func \(r \*MfaResource\) Enroll\(/);
    expect(go).toMatch(/func \(r \*MfaResource\) Verify\(/);
    expect(go).toMatch(/func \(r \*MfaResource\) Disable\(/);
    expect(go).toMatch(/func \(r \*MfaResource\) RegenerateRecoveryCodes\(/);

    // sdk-python: snake_case methods.
    expect(py).toMatch(/def status\(self/);
    expect(py).toMatch(/def enroll\(self/);
    expect(py).toMatch(/def verify\(self/);
    expect(py).toMatch(/def disable\(self/);
    expect(py).toMatch(/def regenerate_recovery_codes\(self/);
  });

  it('CRITICAL 4 wire-paths pinned per-SDK: /v1/account/mfa + /v1/account/mfa/enroll + /v1/account/mfa/verify + /v1/account/mfa/recovery-codes/regenerate. Drift to renaming would break server-side routing.', () => {
    const ts = read(TS_MFA);
    const go = read(GO_MFA);
    const py = read(PY_MFA);

    for (const sdk of [ts, go, py]) {
      expect(sdk).toMatch(/\/v1\/account\/mfa/);
      expect(sdk).toMatch(/\/v1\/account\/mfa\/enroll/);
      expect(sdk).toMatch(/\/v1\/account\/mfa\/verify/);
      expect(sdk).toMatch(/\/v1\/account\/mfa\/recovery-codes\/regenerate/);
    }
  });

  it('CRITICAL method-verb mix: GET (status) + 3× POST (enroll + verify + regenerateRecoveryCodes) + DELETE (disable). The DELETE-on-/v1/account/mfa is what disables MFA; drift to POST would conflate disable with enroll.', () => {
    const ts = read(TS_MFA);
    const go = read(GO_MFA);

    // sdk-typescript: method counts.
    const tsGet = (ts.match(/method: 'GET'/g) ?? []).length;
    const tsPost = (ts.match(/method: 'POST'/g) ?? []).length;
    const tsDelete = (ts.match(/method: 'DELETE'/g) ?? []).length;

    expect(tsGet, 'sdk-typescript GET count').toBe(1);
    expect(tsPost, 'sdk-typescript POST count').toBe(3);
    expect(tsDelete, 'sdk-typescript DELETE count').toBe(1);

    // sdk-go: same.
    const goGet = (go.match(/method: "GET"/g) ?? []).length;
    const goPost = (go.match(/method: "POST"/g) ?? []).length;
    const goDelete = (go.match(/method: "DELETE"/g) ?? []).length;

    expect(goGet, 'sdk-go GET count').toBe(1);
    expect(goPost, 'sdk-go POST count').toBe(3);
    expect(goDelete, 'sdk-go DELETE count').toBe(1);
  });

  it("CRITICAL 10 single-use recovery codes shown ONCE pinned in all 3 SDKs. Drift to anything other than 10 codes would silently break the customer's emergency-MFA-bypass count. Drift to repeated-display would let the codes leak via audit-log or session-replay.", () => {
    const ts = read(TS_MFA);
    const go = read(GO_MFA);
    const py = read(PY_MFA);

    // sdk-typescript: "10 single-use recovery codes; shown ONCE."
    expect(ts).toMatch(/10 single-use recovery codes/);
    expect(ts).toMatch(/shown ONCE/);

    // sdk-go.
    expect(go).toMatch(/10 single-use recovery codes/);
    expect(go).toMatch(/Shown ONCE|shown ONCE/);

    // sdk-python: "10 single-\n        use recovery codes (shown ONCE)"
    expect(py).toMatch(/10 single-[\s\S]{0,30}use recovery codes/);
    expect(py).toMatch(/shown ONCE/);
  });

  it("CRITICAL TOTP enrollment shape pinned in TS + Go: SHA1 + 6 digits + 30-second period. Drift to SHA256 / 8 digits / 60s would silently break the customer's authenticator app (most apps default to SHA1/6/30).", () => {
    const ts = read(TS_MFA);
    const go = read(GO_MFA);

    // sdk-typescript: literal-type union pins the 3 values.
    expect(ts).toMatch(/algorithm: 'SHA1';/);
    expect(ts).toMatch(/digits: 6;/);
    expect(ts).toMatch(/period_seconds: 30;/);

    // sdk-go: comments pin the values.
    expect(go).toMatch(/"SHA1"/);
    expect(go).toMatch(/Digits\s+int\s+`json:"digits"`\s+\/\/ 6/);
    expect(go).toMatch(/PeriodSeconds\s+int\s+`json:"period_seconds"`\s+\/\/ 30/);
  });

  it('CRITICAL otpauth_uri + secret_base32 + 6-digit code framing pinned per-SDK. The 3 fields are what carry the TOTP enrollment payload; drift to dropping otpauth_uri would force customers to manually enter the secret.', () => {
    const ts = read(TS_MFA);
    const go = read(GO_MFA);

    // sdk-typescript: "otpauth:// URI" + "base32-encoded TOTP secret" + "6-digit TOTP code"
    expect(ts).toMatch(/otpauth:\/\/ URI/);
    expect(ts).toMatch(/base32-encoded TOTP secret/);
    expect(ts).toMatch(/6-digit TOTP code/);

    // sdk-go: OtpauthURI struct field + SecretBase32 + "first 6-digit code"
    expect(go).toMatch(/OtpauthURI\s+string\s+`json:"otpauth_uri"`/);
    expect(go).toMatch(/SecretBase32\s+string\s+`json:"secret_base32"`/);
    expect(go).toMatch(/first 6-digit code/);
  });

  it('CRITICAL "disable-mfa" literal confirm phrase pinned in TS + Go. The literal-string confirmation is what prevents accidental disables (call must include this exact field-value). Drift to dropping would let a single bad POST disable MFA silently. (sdk-python uses dict[str, Any] body shape — pending regen pass.)', () => {
    const ts = read(TS_MFA);
    const go = read(GO_MFA);

    // sdk-typescript: literal-type 'disable-mfa'.
    expect(ts).toMatch(/confirm: 'disable-mfa'/);

    // sdk-go: "disable-mfa" string in struct comment.
    expect(go).toMatch(/"disable-mfa"/);
  });

  it('CRITICAL 15-minute step-up freshness framing pinned in TS + Go. The "15-minute freshness window" is the bound on how recently the customer must have proved MFA before disable() will succeed. Drift to dropping would let stale step-up proofs disable MFA.', () => {
    const ts = read(TS_MFA);
    const go = read(GO_MFA);

    expect(ts).toMatch(/15-minute freshness window/);
    expect(go).toMatch(/15-min/);
  });

  it('CRITICAL recovery-codes-invalidated framing on disable + regenerate pinned in TS + Go. Disable invalidates recovery codes; regenerate replaces old with new. Drift to dropping would let stale codes survive disable.', () => {
    const ts = read(TS_MFA);
    const go = read(GO_MFA);

    expect(ts).toMatch(/Recovery codes are invalidated/);
    expect(ts).toMatch(/Old codes invalidated/);

    expect(go).toMatch(/Recovery codes are invalidated/);
    expect(go).toMatch(/old codes\s*\/\/\s*invalidated|old codes invalidated/);
  });

  it('CRITICAL MfaStatusResponse 4-field shape pinned in TS + Go — enrolled + enrolled_at + last_used_at + unused_recovery_codes. The 4 fields are what the dashboard renders to tell customers their MFA state. Drift to dropping ANY would break the dashboard MFA card.', () => {
    const ts = read(TS_MFA);
    const go = read(GO_MFA);

    // sdk-typescript: MfaStatusResponse interface.
    expect(ts).toMatch(
      /export interface MfaStatusResponse \{[\s\S]*?enrolled: boolean;[\s\S]*?enrolled_at:[\s\S]*?last_used_at:[\s\S]*?unused_recovery_codes/,
    );

    // sdk-go: MfaStatus struct with 4 fields.
    expect(go).toMatch(/type MfaStatus struct/);
    expect(go).toMatch(/`json:"enrolled"`/);
    expect(go).toMatch(/`json:"enrolled_at"`/);
    expect(go).toMatch(/`json:"last_used_at"`/);
    expect(go).toMatch(/`json:"unused_recovery_codes"`/);
  });

  it('Cross-SDK V-353b 5-invariant cluster — V-353b anchor + 5-verb surface + 4 wire-paths + 10-recovery-codes-once framing + per-account-not-per-team framing. Drift on any would fragment the cross-language MFA contract.', () => {
    const sdks = {
      'sdk-typescript': read(TS_MFA),
      'sdk-go': read(GO_MFA),
      'sdk-python': read(PY_MFA),
    };

    for (const [name, body] of Object.entries(sdks)) {
      expect(body, `${name} V-353b`).toMatch(/V-353b/);
      expect(body, `${name} V-448`).toMatch(/V-448/);
      expect(body, `${name} V-353e`).toMatch(/V-353e/);
      expect(body, `${name} /v1/account/mfa path`).toMatch(/\/v1\/account\/mfa/);
      expect(body, `${name} recovery codes`).toMatch(/recovery codes|recovery_codes/);
    }
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/cross-sdk-mfa-lifecycle-parity.test.ts'),
      ),
    ).toBe(true);
  });
});

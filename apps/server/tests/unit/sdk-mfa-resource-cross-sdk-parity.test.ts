// W831 — cross-SDK MfaResource methods parity. One-hundred-fifty-
// seventh in the drift-guard series. Pins the MfaResource method set
// (V-353b MFA enrollment management) across all 3 SDKs. Pairs with
// W828 AuthResource mfaChallenge + mfaStepUp (V-353d/e login flow).
// Drift would break customer-dashboard MFA enrollment + recovery-
// code flows.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const TS = resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/mfa.ts');
const PY = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/resources/mfa.py');
const GO = resolve(REPO_ROOT, 'packages/sdk-go/mfa.go');

// 5 shared method names cross-SDK.
const REQUIRED_METHODS: Array<[string, string, string]> = [
  ['status', 'status', 'Status'],
  ['enroll', 'enroll', 'Enroll'],
  ['verify', 'verify', 'Verify'],
  ['disable', 'disable', 'Disable'],
  ['regenerateRecoveryCodes', 'regenerate_recovery_codes', 'RegenerateRecoveryCodes'],
];

describe('W831 cross-SDK MfaResource methods parity', () => {
  it('all 3 MfaResource files exist at canonical paths', () => {
    expect(existsSync(TS)).toBe(true);
    expect(existsSync(PY)).toBe(true);
    expect(existsSync(GO)).toBe(true);
  });

  // ─── 5-required-method set ────────────────────────────────────

  it('CRITICAL all 5 MfaResource methods exist in all 3 SDKs — status + enroll + verify + disable + regenerateRecoveryCodes. Drift would break customer-dashboard MFA enrollment + recovery-code flows.', () => {
    const ts = read(TS);
    const py = read(PY);
    const go = read(GO);

    for (const [tsName, pyName, goName] of REQUIRED_METHODS) {
      expect(ts, `TS missing '${tsName}('`).toMatch(new RegExp(`\\b${tsName}\\s*\\(`));
      expect(py, `Python missing 'def ${pyName}('`).toMatch(new RegExp(`def ${pyName}\\(`));
      expect(go, `Go missing 'func (r *MfaResource) ${goName}('`).toMatch(
        new RegExp(`func \\(r \\*MfaResource\\) ${goName}\\(`),
      );
    }
  });

  // ─── status() returns MfaStatusResponse ───────────────────────

  it('CRITICAL status() returns MfaStatusResponse/MfaStatus cross-SDK. TS: Promise<MfaStatusResponse>; Go: *MfaStatus + error. Drift to a different shape would break customer-dashboard /security MFA-enrolled check.', () => {
    expect(read(TS)).toMatch(/status\(\): Promise<MfaStatusResponse>/);
    expect(read(GO)).toMatch(/Status\(ctx context\.Context\) \(\*MfaStatus, error\)/);
  });

  // ─── enroll() returns MfaEnrollResponse ───────────────────────

  it('CRITICAL enroll() returns MfaEnrollResponse cross-SDK. The response carries the TOTP secret + QR code data — drift to dropping these would break the enrollment QR scan UX.', () => {
    expect(read(TS)).toMatch(/enroll\(\): Promise<MfaEnrollResponse>/);
    expect(read(GO)).toMatch(/Enroll\(ctx context\.Context\) \(\*MfaEnrollResponse, error\)/);
  });

  // ─── verify(body) returns MfaVerifyResponse ───────────────────

  it('CRITICAL verify(MfaVerifyRequest) returns MfaVerifyResponse cross-SDK. The response carries the recovery codes (shown once at enrollment). Drift to dropping recovery codes from the response would break customer recovery flow.', () => {
    expect(read(TS)).toMatch(/verify\(body: MfaVerifyRequest\): Promise<MfaVerifyResponse>/);
    expect(read(GO)).toMatch(
      /Verify\(ctx context\.Context, body \*MfaVerifyRequest\) \(\*MfaVerifyResponse, error\)/,
    );
  });

  // ─── disable(body) returns void ───────────────────────────────

  it('CRITICAL disable(MfaDisableRequest) returns void cross-SDK. TS Promise<void> / Python -> None / Go error-only. HTTP 204. Drift to returning the disabled state would let buggy customer code retry-with-still-enabled.', () => {
    expect(read(TS)).toMatch(/disable\(body: MfaDisableRequest\): Promise<void>/);
    expect(read(PY)).toMatch(/def disable\(self, body: dict\[str, Any\]\) -> None:/);
    expect(read(GO)).toMatch(/Disable\(ctx context\.Context, body \*MfaDisableRequest\) error/);
  });

  // ─── regenerateRecoveryCodes() returns MfaVerifyResponse ──────

  it("CRITICAL regenerateRecoveryCodes() returns MfaVerifyResponse (same shape as verify) cross-SDK. The reused MfaVerifyResponse type signals 'this is the same recovery-codes envelope you got at enrollment'. Drift to a different response type would break customer code that branches on the shape.", () => {
    expect(read(TS)).toMatch(/regenerateRecoveryCodes\(\): Promise<MfaVerifyResponse>/);
    expect(read(GO)).toMatch(
      /RegenerateRecoveryCodes\(ctx context\.Context\) \(\*MfaVerifyResponse, error\)/,
    );
  });

  // ─── Python sync + async dual ─────────────────────────────────

  it('CRITICAL Python provides BOTH MfaResource (sync) AND AsyncMfaResource (async). Every method has an async counterpart.', () => {
    const p = read(PY);
    for (const [, pyName] of REQUIRED_METHODS) {
      expect(p, `Python AsyncMfaResource missing 'async def ${pyName}'`).toMatch(
        new RegExp(`async def ${pyName}\\(`),
      );
    }
  });

  // ─── Go ctx-first convention ──────────────────────────────────

  it('CRITICAL Go MfaResource methods all take ctx context.Context as first arg. Matches W822-W830 cross-SDK Go convention.', () => {
    const p = read(GO);
    for (const [, , goName] of REQUIRED_METHODS) {
      expect(p, `Go ${goName} must take ctx context.Context as first arg`).toMatch(
        new RegExp(`func \\(r \\*MfaResource\\) ${goName}\\(\\s*ctx context\\.Context`),
      );
    }
  });

  // ─── Python __init__ wiring ───────────────────────────────────

  it('CRITICAL Python MfaResource + AsyncMfaResource constructors take http client. Matches W822-W830 cross-SDK wiring.', () => {
    const p = read(PY);
    expect(p).toMatch(/def __init__\(self, http: HttpClient\) -> None:/);
    expect(p).toMatch(/def __init__\(self, http: AsyncHttpClient\) -> None:/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/sdk-mfa-resource-cross-sdk-parity.test.ts'),
      ),
    ).toBe(true);
  });
});

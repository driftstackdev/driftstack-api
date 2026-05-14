// W828 — cross-SDK AuthResource methods parity. One-hundred-fifty-
// fourth in the drift-guard series. Pins the AuthResource method set
// (V-079 auth flow + V-353d/e MFA challenge+step-up + V-460/V-266
// CLI authorize trio) across all 3 SDKs. AuthResource is the highest-
// risk customer surface — drift would break every customer login,
// signup, password reset, MFA, and CLI/GUI activation flow.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const TS = resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/auth.ts');
const PY = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/resources/auth.py');
const GO = resolve(REPO_ROOT, 'packages/sdk-go/auth.go');

// 14 shared method names cross-SDK.
const REQUIRED_METHODS: Array<[string, string, string]> = [
  ['signup', 'signup', 'Signup'],
  ['verifyEmail', 'verify_email', 'VerifyEmail'],
  ['login', 'login', 'Login'],
  ['requestMagicLink', 'request_magic_link', 'RequestMagicLink'],
  ['consumeMagicLink', 'consume_magic_link', 'ConsumeMagicLink'],
  ['requestPasswordReset', 'request_password_reset', 'RequestPasswordReset'],
  ['confirmPasswordReset', 'confirm_password_reset', 'ConfirmPasswordReset'],
  ['refresh', 'refresh', 'Refresh'],
  ['logout', 'logout', 'Logout'],
  ['mfaChallenge', 'mfa_challenge', 'MfaChallenge'],
  ['mfaStepUp', 'mfa_step_up', 'MfaStepUp'],
  ['cliAuthorizeInitiate', 'cli_authorize_initiate', 'CliAuthorizeInitiate'],
  ['cliAuthorizeBind', 'cli_authorize_bind', 'CliAuthorizeBind'],
  ['cliAuthorizeExchange', 'cli_authorize_exchange', 'CliAuthorizeExchange'],
];

describe('W828 cross-SDK AuthResource methods parity', () => {
  it('all 3 AuthResource files exist at canonical paths', () => {
    expect(existsSync(TS)).toBe(true);
    expect(existsSync(PY)).toBe(true);
    expect(existsSync(GO)).toBe(true);
  });

  // ─── 14-required-method set ───────────────────────────────────

  it('CRITICAL all 14 AuthResource methods exist in all 3 SDKs — signup + verifyEmail + login + requestMagicLink + consumeMagicLink + requestPasswordReset + confirmPasswordReset + refresh + logout + mfaChallenge + mfaStepUp + 3 cliAuthorize methods. Drift would break every customer login/signup/MFA/CLI-activation flow.', () => {
    const ts = read(TS);
    const py = read(PY);
    const go = read(GO);

    for (const [tsName, pyName, goName] of REQUIRED_METHODS) {
      expect(ts, `TS missing '${tsName}('`).toMatch(new RegExp(`\\b${tsName}\\s*\\(`));
      expect(py, `Python missing 'def ${pyName}('`).toMatch(new RegExp(`def ${pyName}\\(`));
      expect(go, `Go missing 'func (r *AuthResource) ${goName}('`).toMatch(
        new RegExp(`func \\(r \\*AuthResource\\) ${goName}\\(`),
      );
    }
  });

  // ─── V-353d login MFA discriminated union (TS only) ───────────

  it('CRITICAL TS login returns LoginResponseUnion (discriminated-union: LoginResponse | LoginMfaRequiredResponse). The discriminated-union shape is what lets customer code branch on whether MFA step-up is required — drift to flat LoginResponse would lose the MFA branch.', () => {
    expect(read(TS)).toMatch(/login\(body: LoginRequest\): Promise<LoginResponseUnion>/);
  });

  // ─── V-460/V-266 CLI authorize trio ───────────────────────────

  it('CRITICAL V-460/V-266 CLI authorize 3-method trio pinned cross-SDK — initiate + bind + exchange. The initiate→bind→exchange flow is what powers GUI client + CLI activation; drift to a 2-method or 4-method shape would break the W819 client + cli-authorize integration.', () => {
    for (const f of [TS, PY, GO]) {
      const p = read(f);
      expect(p, `${f} missing cli authorize initiate`).toMatch(
        /cli[A-Za-z_]*authorize[_A-Za-z]*initiate/i,
      );
      expect(p, `${f} missing cli authorize bind`).toMatch(/cli[A-Za-z_]*authorize[_A-Za-z]*bind/i);
      expect(p, `${f} missing cli authorize exchange`).toMatch(
        /cli[A-Za-z_]*authorize[_A-Za-z]*exchange/i,
      );
    }
  });

  // ─── V-353d/e MFA challenge + step-up dual ────────────────────

  it('CRITICAL V-353d/e MFA challenge + step-up dual pinned cross-SDK. mfaChallenge issues the challenge; mfaStepUp confirms. Drift to a single MFA method would collapse the challenge-confirm separation that the V-353d login flow depends on.', () => {
    expect(read(TS)).toMatch(
      /mfaChallenge\(body: MfaChallengeRequest\): Promise<MfaChallengeResponse>/,
    );
    expect(read(TS)).toMatch(/mfaStepUp\(body: MfaStepUpRequest\): Promise<MfaStepUpResponse>/);
    expect(read(PY)).toMatch(
      /def mfa_challenge\(self, body: dict\[str, Any\]\) -> dict\[str, Any\]:/,
    );
    expect(read(PY)).toMatch(
      /def mfa_step_up\(self, body: dict\[str, Any\]\) -> dict\[str, Any\]:/,
    );
    expect(read(GO)).toMatch(
      /MfaChallenge\(ctx context\.Context, body \*MfaChallengeRequest\) \(\*MfaChallengeResponse, error\)/,
    );
    expect(read(GO)).toMatch(
      /MfaStepUp\(ctx context\.Context, body \*MfaStepUpRequest\) \(\*MfaStepUpResponse, error\)/,
    );
  });

  // ─── TS strongly-typed responses ──────────────────────────────

  it('CRITICAL TS AuthResource methods all return typed responses. Each method maps to a distinct ResponseType (SignupResponse / VerifyEmailResponse / etc). Drift to dropping types would lose customer typeahead for the highest-risk integration surface.', () => {
    const p = read(TS);
    expect(p).toMatch(/signup\(body: SignupRequest\): Promise<SignupResponse>/);
    expect(p).toMatch(/verifyEmail\(body: VerifyEmailRequest\): Promise<VerifyEmailResponse>/);
    expect(p).toMatch(/refresh\(body: RefreshSessionRequest\): Promise<RefreshSessionResponse>/);
    expect(p).toMatch(/logout\(body: LogoutRequest\): Promise<LogoutResponse>/);
  });

  // ─── Magic-link 2-method dual ─────────────────────────────────

  it('CRITICAL magic-link 2-method dual pinned cross-SDK — requestMagicLink + consumeMagicLink. Drift to a single method would conflate the email-send vs token-consume steps.', () => {
    expect(read(TS)).toMatch(/requestMagicLink\(/);
    expect(read(TS)).toMatch(/consumeMagicLink\(/);
    expect(read(PY)).toMatch(/def request_magic_link\(/);
    expect(read(PY)).toMatch(/def consume_magic_link\(/);
    expect(read(GO)).toMatch(/RequestMagicLink\(/);
    expect(read(GO)).toMatch(/ConsumeMagicLink\(/);
  });

  // ─── Password-reset 2-method dual ─────────────────────────────

  it('CRITICAL password-reset 2-method dual pinned cross-SDK — requestPasswordReset + confirmPasswordReset. Drift to a single method would conflate the email-send vs token-confirm-with-new-password steps.', () => {
    expect(read(TS)).toMatch(/requestPasswordReset\(/);
    expect(read(TS)).toMatch(/confirmPasswordReset\(/);
    expect(read(PY)).toMatch(/def request_password_reset\(/);
    expect(read(PY)).toMatch(/def confirm_password_reset\(/);
    expect(read(GO)).toMatch(/RequestPasswordReset\(/);
    expect(read(GO)).toMatch(/ConfirmPasswordReset\(/);
  });

  // ─── Python sync + async dual ─────────────────────────────────

  it('CRITICAL Python provides BOTH AuthResource (sync) AND AsyncAuthResource (async). Every method has an async counterpart.', () => {
    const p = read(PY);
    for (const [, pyName] of REQUIRED_METHODS) {
      expect(p, `Python AsyncAuthResource missing 'async def ${pyName}'`).toMatch(
        new RegExp(`async def ${pyName}\\(`),
      );
    }
  });

  // ─── Python dict[str, Any] return (pending codegen) ───────────

  it('CRITICAL Python AuthResource returns dict[str, Any] (untyped pending codegen — matches W824 profiles + W825 billing + W827 snapshots). All 14 methods return dict[str, Any].', () => {
    const p = read(PY);
    expect(p).toMatch(/def signup\(self, body: dict\[str, Any\]\) -> dict\[str, Any\]:/);
    expect(p).toMatch(/def login\(self, body: dict\[str, Any\]\) -> dict\[str, Any\]:/);
    expect(p).toMatch(/def refresh\(self, body: dict\[str, Any\]\) -> dict\[str, Any\]:/);
  });

  // ─── Go ctx-first + (T, error) convention ─────────────────────

  it('CRITICAL Go AuthResource methods all take ctx context.Context as first arg + return (*T, error). Matches W822-W827 cross-SDK Go convention.', () => {
    const p = read(GO);
    for (const [, , goName] of REQUIRED_METHODS) {
      expect(p, `Go ${goName} must take ctx context.Context as first arg`).toMatch(
        new RegExp(`func \\(r \\*AuthResource\\) ${goName}\\(\\s*ctx context\\.Context`),
      );
    }
  });

  // ─── Python __init__ wiring ───────────────────────────────────

  it('CRITICAL Python AuthResource + AsyncAuthResource constructors take http client. Matches W822-W827 cross-SDK wiring.', () => {
    const p = read(PY);
    expect(p).toMatch(/def __init__\(self, http: HttpClient\) -> None:/);
    expect(p).toMatch(/def __init__\(self, http: AsyncHttpClient\) -> None:/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/sdk-auth-resource-cross-sdk-parity.test.ts'),
      ),
    ).toBe(true);
  });
});

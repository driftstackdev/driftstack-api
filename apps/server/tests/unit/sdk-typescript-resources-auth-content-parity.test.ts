// W425.A — drift guard for packages/sdk-typescript/src/resources/auth.ts.
// V-079 AuthResource — the auth gate; these endpoints don't require
// an API key. Drift here either breaks login MFA branching (V-353d
// discriminated-union response), breaks the CLI-authorize 3-step
// activation handshake (V-460/V-266), or drops a recovery flow
// (magic-link / password-reset / mfa step-up).
//
//   • Framing pinned: V-079; auth gate; API key on client unused.
//   • 14 verbs pinned: signup + verifyEmail + login + magic-link
//     request/consume + password-reset request/confirm + refresh +
//     logout + mfa challenge/step-up + cli-authorize
//     initiate/bind/exchange.
//   • V-353d login MFA discriminated-union response framing.
//   • V-445 MFA challenge + step-up rationale.
//   • V-460/V-266 CLI/GUI 3-step activation flow rationale.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/auth.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W425.A packages/sdk-typescript/src/resources/auth.ts content parity', () => {
  const body = read(LIB);

  it('Framing pinned: V-079 typed methods for /v1/auth/*', () => {
    expect(body).toMatch(/\/\/ AuthResource — typed methods for \/v1\/auth\/\* \(V-079\)\./);
  });

  it('Auth-gate posture pinned: endpoints do NOT require an API key; resource exists for ergonomics + type safety, not for API-key-driven auth', () => {
    expect(body).toMatch(
      /\/\/ Note: these endpoints don't require an API key \(they ARE the auth\s*\n?\s*\/\/ gate\)\. Customers using the auth flow do so from a browser dashboard\s*\n?\s*\/\/ against the SDK's HTTP layer; the API key on the client is unused\s*\n?\s*\/\/ for these calls \(the server doesn't validate it\)\. The resource is\s*\n?\s*\/\/ here for ergonomics \+ type safety, not for API-key-driven auth\./,
    );
  });

  it('signup + verifyEmail verbs: POST /v1/auth/signup + /v1/auth/verify-email', () => {
    expect(body).toMatch(
      /signup\(body: SignupRequest\): Promise<SignupResponse> \{\s*\n?\s*return this\.http\.request<SignupResponse>\(\{\s*\n?\s*method: 'POST',\s*\n?\s*path: '\/v1\/auth\/signup',\s*\n?\s*body,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /verifyEmail\(body: VerifyEmailRequest\): Promise<VerifyEmailResponse> \{\s*\n?\s*return this\.http\.request<VerifyEmailResponse>\(\{\s*\n?\s*method: 'POST',\s*\n?\s*path: '\/v1\/auth\/verify-email',\s*\n?\s*body,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('V-353d login MFA discriminated-union framing: returns LoginResponseUnion; mfa_required branch with challenge_token + challenge_expires_at; example pattern pinned', () => {
    expect(body).toMatch(
      /\*\s*V-353d — discriminated-union response\. When the account has MFA\s*\n?\s*\*\s*enrolled, the server returns `\{ mfa_required: true, challenge_token,\s*\n?\s*\*\s*challenge_expires_at \}` instead of a session\. Branch on the\s*\n?\s*\*\s*`mfa_required` literal:/,
    );
    expect(body).toMatch(
      /\*\s*const out = await client\.auth\.login\(\{ email, password \}\);\s*\n?\s*\*\s*if \('mfa_required' in out && out\.mfa_required\) \{\s*\n?\s*\*\s*\/\/ exchange out\.challenge_token via \/v1\/auth\/mfa\/challenge\s*\n?\s*\*\s*\} else \{\s*\n?\s*\*\s*\/\/ out\.session is the real session\s*\n?\s*\*\s*\}/,
    );
    expect(body).toMatch(
      /login\(body: LoginRequest\): Promise<LoginResponseUnion> \{\s*\n?\s*return this\.http\.request<LoginResponseUnion>\(\{\s*\n?\s*method: 'POST',\s*\n?\s*path: '\/v1\/auth\/login',\s*\n?\s*body,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('Magic-link request/consume pair: POST /v1/auth/magic-link/request + /consume', () => {
    expect(body).toMatch(
      /requestMagicLink\(body: MagicLinkRequest\): Promise<MagicLinkRequestResponse> \{\s*\n?\s*return this\.http\.request<MagicLinkRequestResponse>\(\{\s*\n?\s*method: 'POST',\s*\n?\s*path: '\/v1\/auth\/magic-link\/request',\s*\n?\s*body,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /consumeMagicLink\(body: MagicLinkConsumeRequest\): Promise<MagicLinkConsumeResponse> \{\s*\n?\s*return this\.http\.request<MagicLinkConsumeResponse>\(\{\s*\n?\s*method: 'POST',\s*\n?\s*path: '\/v1\/auth\/magic-link\/consume',\s*\n?\s*body,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('Password-reset request/confirm pair: POST /v1/auth/password-reset/request + /confirm', () => {
    expect(body).toMatch(
      /requestPasswordReset\(body: PasswordResetRequest\): Promise<PasswordResetRequestResponse> \{\s*\n?\s*return this\.http\.request<PasswordResetRequestResponse>\(\{\s*\n?\s*method: 'POST',\s*\n?\s*path: '\/v1\/auth\/password-reset\/request',\s*\n?\s*body,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /confirmPasswordReset\(body: PasswordResetConfirmRequest\): Promise<PasswordResetConfirmResponse> \{\s*\n?\s*return this\.http\.request<PasswordResetConfirmResponse>\(\{\s*\n?\s*method: 'POST',\s*\n?\s*path: '\/v1\/auth\/password-reset\/confirm',\s*\n?\s*body,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('refresh + logout: POST /v1/auth/refresh + /logout', () => {
    expect(body).toMatch(
      /refresh\(body: RefreshSessionRequest\): Promise<RefreshSessionResponse> \{\s*\n?\s*return this\.http\.request<RefreshSessionResponse>\(\{\s*\n?\s*method: 'POST',\s*\n?\s*path: '\/v1\/auth\/refresh',\s*\n?\s*body,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /logout\(body: LogoutRequest\): Promise<LogoutResponse> \{\s*\n?\s*return this\.http\.request<LogoutResponse>\(\{\s*\n?\s*method: 'POST',\s*\n?\s*path: '\/v1\/auth\/logout',\s*\n?\s*body,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('V-445 mfaChallenge: POST /v1/auth/mfa/challenge; exchange challenge_token for session via TOTP or recovery code (response carries via: totp|recovery)', () => {
    expect(body).toMatch(
      /\*\s*V-445 — exchange a login challenge_token \(returned on the\s*\n?\s*\*\s*MFA-required branch\) for a real session via TOTP code or recovery\s*\n?\s*\*\s*code\. Distinguished response carries `via: 'totp' \| 'recovery'`\./,
    );
    expect(body).toMatch(
      /mfaChallenge\(body: MfaChallengeRequest\): Promise<MfaChallengeResponse> \{\s*\n?\s*return this\.http\.request<MfaChallengeResponse>\(\{\s*\n?\s*method: 'POST',\s*\n?\s*path: '\/v1\/auth\/mfa\/challenge',\s*\n?\s*body,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('V-445 mfaStepUp: refresh mfa_satisfied_at on web session (V-353e 15-min freshness window); pairs with MfaStepUpRequiredError; no new session issued', () => {
    expect(body).toMatch(
      /\*\s*V-445 — refresh `mfa_satisfied_at` on the calling web session\s*\n?\s*\*\s*\(V-353e step-up gate; 15-minute freshness window\)\. No new session\s*\n?\s*\*\s*issued; the existing session row's mfa timestamp advances\. Pair\s*\n?\s*\*\s*with `MfaStepUpRequiredError` recovery flows\./,
    );
    expect(body).toMatch(
      /mfaStepUp\(body: MfaStepUpRequest\): Promise<MfaStepUpResponse> \{\s*\n?\s*return this\.http\.request<MfaStepUpResponse>\(\{\s*\n?\s*method: 'POST',\s*\n?\s*path: '\/v1\/auth\/mfa\/step-up',\s*\n?\s*body,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('V-460/V-266 cliAuthorizeInitiate: CSRF nonce + optional client label; returns one-shot code + browser URL; CLI/GUI opens browser then polls exchange', () => {
    expect(body).toMatch(
      /\*\s*V-460 — V-266 CLI\/GUI activation flow: initiate\.\s*\n?\s*\*\s*\n?\s*\*\s*The CLI\/GUI calls this with a CSRF nonce \+ optional client label\.\s*\n?\s*\*\s*Returns a one-shot code \+ browser URL the CLI\/GUI opens; the user\s*\n?\s*\*\s*signs in to the dashboard and confirms the activation, after which\s*\n?\s*\*\s*the CLI\/GUI polls `cliAuthorizeExchange` to receive the API key\./,
    );
    expect(body).toMatch(
      /cliAuthorizeInitiate\(body: CliAuthorizeInitiateRequest\): Promise<CliAuthorizeInitiateResponse> \{\s*\n?\s*return this\.http\.request<CliAuthorizeInitiateResponse>\(\{\s*\n?\s*method: 'POST',\s*\n?\s*path: '\/v1\/auth\/cli-authorize\/initiate',\s*\n?\s*body,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('V-460/V-266 cliAuthorizeBind: web-session-authenticated; dashboard /cli/authorize confirmation page mints API key + stages for exchange; default scopes ["account_owner"]', () => {
    expect(body).toMatch(
      /\*\s*V-460 — V-266 CLI\/GUI activation flow: bind\.\s*\n?\s*\*\s*\n?\s*\*\s*Web-session-authenticated\. Called by the dashboard's\s*\n?\s*\*\s*\/cli\/authorize confirmation page after the user clicks Authorize:\s*\n?\s*\*\s*mints an API key on the calling account and stages it for delivery\s*\n?\s*\*\s*to the CLI\/GUI through the exchange endpoint\. Default scopes are\s*\n?\s*\*\s*`\["account_owner"\]` server-side\./,
    );
    expect(body).toMatch(
      /cliAuthorizeBind\(body: CliAuthorizeBindRequest\): Promise<CliAuthorizeBindResponse> \{\s*\n?\s*return this\.http\.request<CliAuthorizeBindResponse>\(\{\s*\n?\s*method: 'POST',\s*\n?\s*path: '\/v1\/auth\/cli-authorize\/bind',\s*\n?\s*body,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('V-460/V-266 cliAuthorizeExchange: 3-branch response (pending / bound + api_key + account_id one-shot / expired); subsequent calls after bound 404', () => {
    expect(body).toMatch(
      /\*\s*V-460 — V-266 CLI\/GUI activation flow: exchange\.\s*\n?\s*\*\s*\n?\s*\*\s*Polled by the CLI\/GUI\. Returns one of three branches:\s*\n?\s*\*\s*- `\{ status: 'pending' \}` — keep polling\.\s*\n?\s*\*\s*- `\{ status: 'bound', api_key, account_id \}` — one-shot delivery\s*\n?\s*\*\s*of the plaintext API key\. Subsequent calls 404\.\s*\n?\s*\*\s*- `\{ status: 'expired' \}` — user took too long; restart the flow\./,
    );
    expect(body).toMatch(
      /cliAuthorizeExchange\(body: CliAuthorizeExchangeRequest\): Promise<CliAuthorizeExchangeResponse> \{\s*\n?\s*return this\.http\.request<CliAuthorizeExchangeResponse>\(\{\s*\n?\s*method: 'POST',\s*\n?\s*path: '\/v1\/auth\/cli-authorize\/exchange',\s*\n?\s*body,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('14-verb surface complete: every public method present and POST-only (auth surface is uniformly POST)', () => {
    const verbMethods = [
      'signup',
      'verifyEmail',
      'login',
      'requestMagicLink',
      'consumeMagicLink',
      'requestPasswordReset',
      'confirmPasswordReset',
      'refresh',
      'logout',
      'mfaChallenge',
      'mfaStepUp',
      'cliAuthorizeInitiate',
      'cliAuthorizeBind',
      'cliAuthorizeExchange',
    ];
    for (const verb of verbMethods) {
      expect(body).toMatch(new RegExp(`\\b${verb}\\(body:`));
    }
    const postCount = body.match(/method: 'POST'/g);
    expect(postCount).not.toBeNull();
    expect((postCount ?? []).length).toBe(14);
  });

  it('imports: 27 api-types verb shapes + HttpClient', () => {
    expect(body).toMatch(/import type \{ HttpClient \} from '\.\.\/http\.js';/);
    for (const t of [
      'CliAuthorizeBindRequest',
      'CliAuthorizeBindResponse',
      'CliAuthorizeExchangeRequest',
      'CliAuthorizeExchangeResponse',
      'CliAuthorizeInitiateRequest',
      'CliAuthorizeInitiateResponse',
      'LoginRequest',
      'LoginResponseUnion',
      'MfaChallengeRequest',
      'MfaChallengeResponse',
      'MfaStepUpRequest',
      'MfaStepUpResponse',
      'LogoutRequest',
      'LogoutResponse',
      'MagicLinkConsumeRequest',
      'MagicLinkConsumeResponse',
      'MagicLinkRequest',
      'MagicLinkRequestResponse',
      'PasswordResetConfirmRequest',
      'PasswordResetConfirmResponse',
      'PasswordResetRequest',
      'PasswordResetRequestResponse',
      'RefreshSessionRequest',
      'RefreshSessionResponse',
      'SignupRequest',
      'SignupResponse',
      'VerifyEmailRequest',
      'VerifyEmailResponse',
    ] as const) {
      expect(body).toMatch(new RegExp(`\\b${t}\\b,`));
    }
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});

// W425.A (W666-deepened) — drift guard for packages/sdk-typescript/
// src/resources/auth.ts. V-079 AuthResource TS parity.
//
// W666 splits the original 15 it() blocks into 22 focused per-concept
// blocks + pins previously-implicit invariants. Mirrors the W647
// sdk-go-auth.go (5→16) + W651 sdk-python-auth (6→18) splits:
//
//   • V-079 auth-gate-API-key-unused invariant pinned per-line. The
//     SDK's HTTP layer always sends the Authorization header but the
//     server ignores it on these public routes. Drift to making
//     auth.signup() refuse without a key would break first-time
//     signup (the customer doesn't HAVE a key yet — that's why
//     they're signing up).
//   • V-353d login MFA discriminated-union response — the in-JSDoc
//     example pattern (5-line const-await branching) is load-bearing
//     because it shows customers how to handle the branch correctly.
//     Drift to dropping the example would lose the customer-facing
//     guidance for the "MFA required" branch.
//   • V-445 mfaChallenge 'via: totp|recovery' discriminator pinned —
//     drift to dropping would prevent customers from counting TOTP-
//     vs-recovery use in MFA-strength metrics.
//   • V-353e mfaStepUp 15-min freshness window + "No new session
//     issued" + MfaStepUpRequiredError pairing. Drift to issuing
//     new session on step-up would force cookie rotation mid-flow.
//   • V-460/V-266 CLI 3-step (initiate → bind → exchange) with each
//     step's auth posture pinned: initiate public, bind web-session-
//     authenticated (default scopes ["account_owner"]), exchange
//     polled 3-branch discriminated union (pending/bound/expired
//     with subsequent-calls-404 framing).
//   • 14-verb POST-only inventory + 28-shape api-types import surface.

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

  it('file exists at canonical path + module header V-079 anchor on the resource line', () => {
    expect(existsSync(LIB)).toBe(true);
    expect(body).toMatch(/\/\/ AuthResource — typed methods for \/v1\/auth\/\* \(V-079\)\./);
  });

  it('CRITICAL V-079 auth-gate-API-key-unused posture pinned per-line. "These endpoints don\'t require an API key (they ARE the auth gate)." + "the API key on the client is unused for these calls (the server doesn\'t validate it)." + "The resource is here for ergonomics + type safety, not for API-key-driven auth." Drift to making auth.signup() refuse without a key would break first-time signup.', () => {
    expect(body).toMatch(
      /\/\/ Note: these endpoints don't require an API key \(they ARE the auth\s*\/\/ gate\)\. Customers using the auth flow do so from a browser dashboard\s*\/\/ against the SDK's HTTP layer; the API key on the client is unused\s*\/\/ for these calls \(the server doesn't validate it\)\. The resource is\s*\/\/ here for ergonomics \+ type safety, not for API-key-driven auth\./,
    );
  });

  it('Imports — 28 api-types shapes (sorted alphabetical block; 14 verb pairs) + HttpClient. Drift to hand-rolling any of these types would diverge from @driftstack/api-types Zod single-source-of-truth.', () => {
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

  it('AuthResource class declaration + private-readonly http constructor field. Stateless wrapper pattern.', () => {
    expect(body).toMatch(/^export class AuthResource \{$/m);
    expect(body).toMatch(/constructor\(private readonly http: HttpClient\) \{\}/);
  });

  it('signup verb — POST /v1/auth/signup with SignupRequest body → Promise<SignupResponse>. First touch of the auth journey: empty Authorization header tolerated by server (V-079) so this verb is callable before any credentials.', () => {
    expect(body).toMatch(
      /signup\(body: SignupRequest\): Promise<SignupResponse> \{\s*return this\.http\.request<SignupResponse>\(\{\s*method: 'POST',\s*path: '\/v1\/auth\/signup',\s*body,\s*\}\);\s*\}/,
    );
  });

  it('verifyEmail verb — POST /v1/auth/verify-email. Step 2 of signup; customer clicks the verification link in their inbox; SDK exchanges the token from URL for a verified-email status. Drift to requiring a session would break the verification-link-from-email flow.', () => {
    expect(body).toMatch(
      /verifyEmail\(body: VerifyEmailRequest\): Promise<VerifyEmailResponse> \{\s*return this\.http\.request<VerifyEmailResponse>\(\{\s*method: 'POST',\s*path: '\/v1\/auth\/verify-email',\s*body,\s*\}\);\s*\}/,
    );
  });

  it("CRITICAL V-353d login discriminated-union JSDoc — full doc pinned per-line + in-JSDoc 5-line example pattern. The example shows `if ('mfa_required' in out && out.mfa_required) { ... } else { ... }` branching. Drift to dropping the example would lose the customer-facing guidance — without it, customers might unwrap `out.session` directly and silently break on MFA-required accounts.", () => {
    expect(body).toMatch(
      /\*\s*V-353d — discriminated-union response\. When the account has MFA\s*\*\s*enrolled, the server returns `\{ mfa_required: true, challenge_token,\s*\*\s*challenge_expires_at \}` instead of a session\. Branch on the\s*\*\s*`mfa_required` literal:/,
    );
    expect(body).toMatch(
      /\*\s*const out = await client\.auth\.login\(\{ email, password \}\);\s*\*\s*if \('mfa_required' in out && out\.mfa_required\) \{\s*\*\s*\/\/ exchange out\.challenge_token via \/v1\/auth\/mfa\/challenge\s*\*\s*\} else \{\s*\*\s*\/\/ out\.session is the real session\s*\*\s*\}/,
    );
  });

  it('login verb implementation — POST /v1/auth/login → Promise<LoginResponseUnion>. The Union return type forces TypeScript callers to discriminate at the type level; drift to a non-union return would let MFA-required branches slip past static checking.', () => {
    expect(body).toMatch(
      /login\(body: LoginRequest\): Promise<LoginResponseUnion> \{\s*return this\.http\.request<LoginResponseUnion>\(\{\s*method: 'POST',\s*path: '\/v1\/auth\/login',\s*body,\s*\}\);\s*\}/,
    );
  });

  it('Magic-link 2-step — requestMagicLink (POST /v1/auth/magic-link/request, anonymous; sends email) + consumeMagicLink (POST /v1/auth/magic-link/consume; exchange token-from-URL for session). The 2 verbs MUST stay paired — dropping consume would orphan the email links.', () => {
    expect(body).toMatch(
      /requestMagicLink\(body: MagicLinkRequest\): Promise<MagicLinkRequestResponse> \{\s*return this\.http\.request<MagicLinkRequestResponse>\(\{\s*method: 'POST',\s*path: '\/v1\/auth\/magic-link\/request',\s*body,\s*\}\);\s*\}/,
    );
    expect(body).toMatch(
      /consumeMagicLink\(body: MagicLinkConsumeRequest\): Promise<MagicLinkConsumeResponse> \{\s*return this\.http\.request<MagicLinkConsumeResponse>\(\{\s*method: 'POST',\s*path: '\/v1\/auth\/magic-link\/consume',\s*body,\s*\}\);\s*\}/,
    );
  });

  it('Password-reset 2-step — requestPasswordReset (POST /v1/auth/password-reset/request, anonymous; sends email) + confirmPasswordReset (POST /v1/auth/password-reset/confirm; exchange token + new_password for an updated credential). Mirror of magic-link 2-step but for lost-password flow.', () => {
    expect(body).toMatch(
      /requestPasswordReset\(body: PasswordResetRequest\): Promise<PasswordResetRequestResponse> \{\s*return this\.http\.request<PasswordResetRequestResponse>\(\{\s*method: 'POST',\s*path: '\/v1\/auth\/password-reset\/request',\s*body,\s*\}\);\s*\}/,
    );
    expect(body).toMatch(
      /confirmPasswordReset\(body: PasswordResetConfirmRequest\): Promise<PasswordResetConfirmResponse> \{\s*return this\.http\.request<PasswordResetConfirmResponse>\(\{\s*method: 'POST',\s*path: '\/v1\/auth\/password-reset\/confirm',\s*body,\s*\}\);\s*\}/,
    );
  });

  it('Session lifecycle — refresh (POST /v1/auth/refresh; exchanges the supplied session token for a new one, revoking the old row and minting a fresh one, so a replay of the old token fails) + logout (POST /v1/auth/logout; revokes the token supplied IN THE BODY rather than the session the call authenticated with; no-ops on an unknown or already-revoked token). V-1092: this title used to describe an OAuth refresh_token-for-access_token exchange, which is not the product — RefreshSessionRequest carries the single key `token` and there is no refresh_token anywhere outside redaction denylists.', () => {
    expect(body).toMatch(
      /refresh\(body: RefreshSessionRequest\): Promise<RefreshSessionResponse> \{\s*return this\.http\.request<RefreshSessionResponse>\(\{\s*method: 'POST',\s*path: '\/v1\/auth\/refresh',\s*body,\s*\}\);\s*\}/,
    );
    expect(body).toMatch(
      /logout\(body: LogoutRequest\): Promise<LogoutResponse> \{\s*return this\.http\.request<LogoutResponse>\(\{\s*method: 'POST',\s*path: '\/v1\/auth\/logout',\s*body,\s*\}\);\s*\}/,
    );
  });

  it("CRITICAL V-445 mfaChallenge JSDoc — `via: 'totp' | 'recovery'` 2-value discriminator pinned. Drift to dropping the discriminator would prevent customers from counting TOTP-vs-recovery use in MFA-strength metrics (recovery-code use signals higher account-risk than TOTP use). Drift to a 3rd value (e.g. 'webauthn') without coordinated server+client update would break the closed-set switch.", () => {
    expect(body).toMatch(
      /\*\s*V-445 — exchange a login challenge_token \(returned on the\s*\*\s*MFA-required branch\) for a real session via TOTP code or recovery\s*\*\s*code\. Distinguished response carries `via: 'totp' \| 'recovery'`\./,
    );
  });

  it('mfaChallenge implementation — POST /v1/auth/mfa/challenge with MfaChallengeRequest body → Promise<MfaChallengeResponse>. Body carries the challenge_token from login + the TOTP/recovery code.', () => {
    expect(body).toMatch(
      /mfaChallenge\(body: MfaChallengeRequest\): Promise<MfaChallengeResponse> \{\s*return this\.http\.request<MfaChallengeResponse>\(\{\s*method: 'POST',\s*path: '\/v1\/auth\/mfa\/challenge',\s*body,\s*\}\);\s*\}/,
    );
  });

  it('CRITICAL V-445 mfaStepUp JSDoc — 4-line invariant: "refresh `mfa_satisfied_at` on the calling web session" + V-353e 15-minute freshness window + "No new session issued; the existing session row\'s mfa timestamp advances" + "Pair with `MfaStepUpRequiredError` recovery flows". Drift to issuing a NEW session on step-up would force session-cookie rotation mid-flow — breaks the "same session identity, just freshly MFA-proved" contract.', () => {
    expect(body).toMatch(
      /\*\s*V-445 — refresh `mfa_satisfied_at` on the calling web session\s*\*\s*\(V-353e step-up gate; 15-minute freshness window\)\. No new session\s*\*\s*issued; the existing session row's mfa timestamp advances\. Pair\s*\*\s*with `MfaStepUpRequiredError` recovery flows\./,
    );
  });

  it('mfaStepUp implementation — POST /v1/auth/mfa/step-up with MfaStepUpRequest body → Promise<MfaStepUpResponse>. Returns success-ack only (no session change).', () => {
    expect(body).toMatch(
      /mfaStepUp\(body: MfaStepUpRequest\): Promise<MfaStepUpResponse> \{\s*return this\.http\.request<MfaStepUpResponse>\(\{\s*method: 'POST',\s*path: '\/v1\/auth\/mfa\/step-up',\s*body,\s*\}\);\s*\}/,
    );
  });

  it('V-460/V-266 cliAuthorizeInitiate documents the separate device-displayed user code', () => {
    expect(body).toMatch(
      /Returns a one-shot code, a separate user code displayed by the\s*\*\s*initiating device, and the browser URL\.[\s\S]*?types that code in\s*\*\s*the dashboard before the CLI\/GUI can receive the API key/,
    );
    expect(body).toMatch(
      /cliAuthorizeInitiate\(body: CliAuthorizeInitiateRequest\): Promise<CliAuthorizeInitiateResponse> \{\s*return this\.http\.request<CliAuthorizeInitiateResponse>\(\{\s*method: 'POST',\s*path: '\/v1\/auth\/cli-authorize\/initiate',\s*body,\s*\}\);\s*\}/,
    );
  });

  it('V-460/V-266 cliAuthorizeBind requires the initiating-device user_code', () => {
    expect(body).toMatch(
      /Web-session-authenticated\. Called by the dashboard's\s*\*\s*\/cli\/authorize confirmation page after the user enters the initiating\s*\*\s*device's `user_code` and clicks Authorize:[\s\S]*?Default scopes are\s*\*\s*`\["account_owner"\]` server-side\./,
    );
    expect(body).toMatch(
      /cliAuthorizeBind\(body: CliAuthorizeBindRequest\): Promise<CliAuthorizeBindResponse> \{\s*return this\.http\.request<CliAuthorizeBindResponse>\(\{\s*method: 'POST',\s*path: '\/v1\/auth\/cli-authorize\/bind-device-code',\s*body,\s*\}\);\s*\}/,
    );
  });

  it("CRITICAL V-460/V-266 cliAuthorizeExchange JSDoc — 3-branch discriminated union pinned per-line: (1) `{ status: 'pending' }` keep polling; (2) `{ status: 'bound', api_key, account_id }` ONE-SHOT delivery + \"Subsequent calls 404\" framing; (3) `{ status: 'expired' }` user took too long, restart. Drift to dropping the one-shot 404 framing would let CLIs re-fetch the plaintext key after binding (catastrophic key-leak).", () => {
    expect(body).toMatch(
      /\*\s*V-460 — V-266 CLI\/GUI activation flow: exchange\.\s*\*\s*\*\s*Polled by the CLI\/GUI\. Returns one of three branches:\s*\*\s*- `\{ status: 'pending' \}` — keep polling\.\s*\*\s*- `\{ status: 'bound', api_key, account_id \}` — one-shot delivery\s*\*\s*of the plaintext API key\. Subsequent calls 404\.\s*\*\s*- `\{ status: 'expired' \}` — user took too long; restart the flow\./,
    );
    expect(body).toMatch(
      /cliAuthorizeExchange\(body: CliAuthorizeExchangeRequest\): Promise<CliAuthorizeExchangeResponse> \{\s*return this\.http\.request<CliAuthorizeExchangeResponse>\(\{\s*method: 'POST',\s*path: '\/v1\/auth\/cli-authorize\/exchange',\s*body,\s*\}\);\s*\}/,
    );
  });

  it('14-verb inventory drift guard — exactly 14 method declarations (signup + verifyEmail + login + requestMagicLink + consumeMagicLink + requestPasswordReset + confirmPasswordReset + refresh + logout + mfaChallenge + mfaStepUp + cliAuthorizeInitiate + cliAuthorizeBind + cliAuthorizeExchange). Each verb declared as `name(body: ...): Promise<...>`. Drift to a 15th verb (e.g. SAML or webauthn flow) without coordinated test coverage would let an untested code path ship.', () => {
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
    const methods = body.match(/^ {2}(?!constructor)[a-zA-Z]+\(/gm) ?? [];
    expect(methods.length, 'expected exactly 14 verb declarations').toBe(14);
  });

  it('POST-only inventory invariant — exactly 14 POST verbs (auth surface is uniformly POST). ZERO GET verbs on /v1/auth/* (introspection lives on /v1/account/me which is post-auth). ZERO PATCH/PUT/DELETE — auth lifecycle is verb-based state-transitions, not REST-CRUD.', () => {
    const postCount = (body.match(/method: 'POST'/g) ?? []).length;
    expect(postCount, 'expected exactly 14 POST verbs').toBe(14);
    expect(body).not.toMatch(/method: 'GET'/);
    expect(body).not.toMatch(/method: 'PATCH'/);
    expect(body).not.toMatch(/method: 'PUT'/);
    expect(body).not.toMatch(/method: 'DELETE'/);
  });

  it('Wire-path inventory — 14 distinct /v1/auth/* paths threaded across 14 verbs. Every path starts with /v1/auth/ (no exceptions). Drift to a /v1/account/* path on this resource would mismatch the documented namespace.', () => {
    const authPaths = body.match(/path: '\/v1\/auth\/[a-z\-/]+'/g) ?? [];
    expect(authPaths.length, 'expected exactly 14 /v1/auth/* paths').toBe(14);
    const unique = new Set(authPaths);
    expect(unique.size, 'expected all 14 paths to be DISTINCT').toBe(14);
  });
});

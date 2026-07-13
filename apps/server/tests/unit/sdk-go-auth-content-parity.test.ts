// W589.A (W647-deepened) — drift guard for packages/sdk-go/auth.go.
// AuthResource Go parity — 14 V-079 auth-flow methods routing through
// client.do (so retries + structured errors apply even though
// Authorization header is ignored on these public routes).
//
// W647 splits the 5 it() blocks (where 9 baseline + 2 MFA + 3 CLI-
// authorize verbs were crammed into 3 verb-bundle blocks) into 17
// focused per-verb blocks + pins previously-implicit invariants:
//
//   • Empty-API-key-fine-for-auth-flows ergonomic — the entire auth
//     surface accepts client.Auth methods even when New("") was
//     called with no key. Drift here would break first-time-customer
//     CLI signup flows.
//   • Authorization header is set unconditionally but server IGNORES
//     it on these routes — load-bearing because customers can reuse
//     the same client for auth + authenticated calls.
//   • Magic-link 2-step request→consume contract.
//   • Password-reset 2-step request→confirm contract.
//   • Refresh issues a fresh session with extended expiry (NOT just
//     a JWT signature refresh).
//   • V-445 MFA challenge "totp"|"recovery" discriminator + V-353e
//     step-up 15-minute freshness window.
//   • V-460/V-266 CLI/GUI 3-step activation: initiate→bind→exchange
//     with "pending"|"bound"|"expired" status discriminator.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-go/auth.go');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W589.A packages/sdk-go/auth.go content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path + V-079 framing + empty-key-fine-for-auth contract pinned. CRITICAL: "These endpoints don\'t require an API key — they ARE the auth gate." Drift to requiring auth on auth endpoints would create a chicken-and-egg lockout.', () => {
    expect(existsSync(LIB)).toBe(true);
    expect(body).toMatch(/\/\/ AuthResource handles \/v1\/auth\/\* endpoints \(V-079\)\./);
    expect(body).toMatch(
      /\/\/ These endpoints don't require an API key — they ARE the auth gate\./,
    );
    expect(body).toMatch(/^type AuthResource struct \{\s*\n\s*client \*Client\s*\n\}/m);
  });

  it('Routes-through-client.do framing — customers get retry + rate-limit handling + structured-error parsing FOR FREE on auth endpoints. Drift to a hand-rolled httpx call here would lose the cross-resource consistency that customers rely on.', () => {
    expect(body).toMatch(
      /\/\/ The SDK still routes them through the same client\.do path so users/,
    );
    expect(body).toMatch(/\/\/ get retry, rate-limit handling, and structured-error parsing for/);
    expect(body).toMatch(/\/\/ free; the Authorization header is set unconditionally but the/);
    expect(body).toMatch(/\/\/ server ignores it for these routes\./);
  });

  it('CLI signup usage example pinned: `c := driftstack.New("")` empty-key constructor + Auth.Signup with email+password. Load-bearing because every CLI signup helper customer copies this exact 4-line pattern.', () => {
    expect(body).toMatch(
      /\/\/ Typical usage from a server-side flow \(e\.g\., a CLI signup helper\):/,
    );
    expect(body).toMatch(/\/\/\s+c := driftstack\.New\(""\) \/\/ empty key is fine for auth flows/);
    expect(body).toMatch(/\/\/\s+resp, err := c\.Auth\.Signup\(ctx, &driftstack\.SignupRequest\{/);
    expect(body).toMatch(/\/\/\s+Email:\s+"user@example\.com",/);
    expect(body).toMatch(/\/\/\s+Password: "\.\.\.",/);
  });

  it('Signup — POST /v1/auth/signup creates a new account. Returns SignupResponse (session token + account row).', () => {
    expect(body).toMatch(/\/\/ Signup creates a new account\./);
    expect(body).toMatch(
      /func \(r \*AuthResource\) Signup\(ctx context\.Context, body \*SignupRequest\) \(\*SignupResponse, error\)/,
    );
    expect(body).toMatch(/method: "POST",\s*\n\s*path:\s+"\/v1\/auth\/signup",/);
  });

  it('VerifyEmail — POST /v1/auth/verify-email consumes a verify-email token AND returns a session token. Drift to splitting verify (returns nothing) from a separate Login (issues session) would force every new customer through 2 round trips.', () => {
    expect(body).toMatch(
      /\/\/ VerifyEmail consumes a verify-email token \+ returns a session token\./,
    );
    expect(body).toMatch(
      /func \(r \*AuthResource\) VerifyEmail\(ctx context\.Context, body \*VerifyEmailRequest\) \(\*VerifyEmailResponse, error\)/,
    );
    expect(body).toMatch(/method: "POST",\s*\n\s*path:\s+"\/v1\/auth\/verify-email",/);
  });

  it('Login — POST /v1/auth/login exchanges email + password for a session token. NOTE: when MFA is enrolled, this returns a challenge_token (V-353d) instead, which the customer must exchange via MfaChallenge. The "exchanges email + password for a session token" framing pinned because the MFA-bypass behaviour is on the response shape, not the contract surface.', () => {
    expect(body).toMatch(/\/\/ Login exchanges email \+ password for a session token\./);
    expect(body).toMatch(
      /func \(r \*AuthResource\) Login\(ctx context\.Context, body \*LoginRequest\) \(\*LoginResponse, error\)/,
    );
    expect(body).toMatch(/method: "POST",\s*\n\s*path:\s+"\/v1\/auth\/login",/);
  });

  it('RequestMagicLink + ConsumeMagicLink — 2-STEP magic-link flow. Request emails the one-time link; Consume redeems the token for a session. Drift to merging the two would skip the email round-trip that gives customers passwordless login.', () => {
    expect(body).toMatch(/\/\/ RequestMagicLink emails a one-time login link to the address\./);
    expect(body).toMatch(
      /func \(r \*AuthResource\) RequestMagicLink\(ctx context\.Context, body \*MagicLinkRequest\) \(\*MagicLinkRequestResponse, error\)/,
    );
    expect(body).toMatch(/method: "POST",\s*\n\s*path:\s+"\/v1\/auth\/magic-link\/request",/);
    expect(body).toMatch(/\/\/ ConsumeMagicLink redeems a magic-link token for a session\./);
    expect(body).toMatch(
      /func \(r \*AuthResource\) ConsumeMagicLink\(ctx context\.Context, body \*MagicLinkConsumeRequest\) \(\*MagicLinkConsumeResponse, error\)/,
    );
    expect(body).toMatch(/method: "POST",\s*\n\s*path:\s+"\/v1\/auth\/magic-link\/consume",/);
  });

  it('RequestPasswordReset + ConfirmPasswordReset — 2-STEP password-reset flow. Request emails the reset link; Confirm sets the new password using the reset token. Drift to merging would skip the email round-trip + let anyone-with-an-email change passwords.', () => {
    expect(body).toMatch(/\/\/ RequestPasswordReset emails a reset link to the address\./);
    expect(body).toMatch(
      /func \(r \*AuthResource\) RequestPasswordReset\(ctx context\.Context, body \*PasswordResetRequest\) \(\*PasswordResetRequestResponse, error\)/,
    );
    expect(body).toMatch(/method: "POST",\s*\n\s*path:\s+"\/v1\/auth\/password-reset\/request",/);
    expect(body).toMatch(/\/\/ ConfirmPasswordReset sets a new password using a reset token\./);
    expect(body).toMatch(
      /func \(r \*AuthResource\) ConfirmPasswordReset\(ctx context\.Context, body \*PasswordResetConfirmRequest\) \(\*PasswordResetConfirmResponse, error\)/,
    );
    expect(body).toMatch(/method: "POST",\s*\n\s*path:\s+"\/v1\/auth\/password-reset\/confirm",/);
  });

  it('Refresh — POST /v1/auth/refresh exchanges an EXISTING session token for a NEW one + extended expiry. "Extended expiry" framing pinned because it tells customers refresh is not a JWT signature renewal — it mints a fresh session row, which is what makes the EXISTING session immediately revokable on logout.', () => {
    expect(body).toMatch(
      /\/\/ Refresh exchanges an existing session token for a new one \+ extended expiry\./,
    );
    expect(body).toMatch(
      /func \(r \*AuthResource\) Refresh\(ctx context\.Context, body \*RefreshSessionRequest\) \(\*RefreshSessionResponse, error\)/,
    );
    expect(body).toMatch(/method: "POST",\s*\n\s*path:\s+"\/v1\/auth\/refresh",/);
  });

  it('Logout — POST /v1/auth/logout invalidates the supplied session token. NOTE: invalidates the SUPPLIED token (not "the calling session" via header) so a customer can revoke any session they hold the token for, not just the active one. Drift to header-driven would force a logged-in client to call logout, which doesn\'t match the magic-link revoke-from-email flow.', () => {
    expect(body).toMatch(/\/\/ Logout invalidates the supplied session token\./);
    expect(body).toMatch(
      /func \(r \*AuthResource\) Logout\(ctx context\.Context, body \*LogoutRequest\) \(\*LogoutResponse, error\)/,
    );
    expect(body).toMatch(/method: "POST",\s*\n\s*path:\s+"\/v1\/auth\/logout",/);
  });

  it('MfaChallenge — V-445 POST /v1/auth/mfa/challenge exchanges the V-353d login challenge_token for a session via TOTP code OR recovery code. CRITICAL: response carries Via = "totp" | "recovery" discriminator so dashboards can show different post-MFA UI (e.g. "regenerate recovery codes" prompt after recovery-code use).', () => {
    expect(body).toMatch(/\/\/ MfaChallenge — V-445\. Exchange the V-353d login challenge_token/);
    expect(body).toMatch(/\/\/ for a session via TOTP code or recovery code\. Distinguished/);
    expect(body).toMatch(/\/\/ response carries Via = "totp" \| "recovery"\./);
    expect(body).toMatch(
      /func \(r \*AuthResource\) MfaChallenge\(ctx context\.Context, body \*MfaChallengeRequest\) \(\*MfaChallengeResponse, error\)/,
    );
    expect(body).toMatch(/method: "POST",\s*\n\s*path:\s+"\/v1\/auth\/mfa\/challenge",/);
  });

  it('MfaStepUp — V-445 POST /v1/auth/mfa/step-up REFRESHES mfa_satisfied_at on the CALLING web session (V-353e step-up gate; 15-MINUTE freshness window). CRITICAL: "No new session issued; returns the new mfa_satisfied_at timestamp." Drift to issuing a new session would let step-up double as login + force callers to swap session tokens mid-flow.', () => {
    expect(body).toMatch(/\/\/ MfaStepUp — V-445\. Refresh mfa_satisfied_at on the calling web/);
    expect(body).toMatch(
      /\/\/ session \(V-353e step-up gate; 15-minute freshness window\)\. No new/,
    );
    expect(body).toMatch(/\/\/ session issued; returns the new mfa_satisfied_at timestamp\./);
    expect(body).toMatch(
      /func \(r \*AuthResource\) MfaStepUp\(ctx context\.Context, body \*MfaStepUpRequest\) \(\*MfaStepUpResponse, error\)/,
    );
    expect(body).toMatch(/method: "POST",\s*\n\s*path:\s+"\/v1\/auth\/mfa\/step-up",/);
  });

  it('CliAuthorizeInitiate returns a separate device-displayed user_code', () => {
    expect(body).toMatch(
      /\/\/ CliAuthorizeInitiate — V-460 \/ V-266\. Start the CLI\/GUI activation/,
    );
    expect(body).toMatch(/\/\/ flow\. Returns a one-shot code, device-displayed user_code, and/);
    expect(body).toMatch(/\/\/ browser_url\. The user types that code in the dashboard before/);
    expect(body).toMatch(/\/\/ CliAuthorizeExchange can return the plaintext API key\./);
    expect(body).toMatch(
      /func \(r \*AuthResource\) CliAuthorizeInitiate\(ctx context\.Context, body \*CliAuthorizeInitiateRequest\) \(\*CliAuthorizeInitiateResponse, error\)/,
    );
    expect(body).toMatch(/method: "POST",\s*\n\s*path:\s+"\/v1\/auth\/cli-authorize\/initiate",/);
  });

  it('CliAuthorizeBind documents the required initiating-device UserCode', () => {
    expect(body).toMatch(
      /\/\/ CliAuthorizeBind — V-460 \/ V-266\. Web-session-authenticated\. Called/,
    );
    expect(body).toMatch(
      /\/\/ by the dashboard's confirm page after the user submits the initiating/,
    );
    expect(body).toMatch(/\/\/ device's UserCode and clicks Authorize:/);
    expect(body).toMatch(
      /\/\/ device's UserCode and clicks Authorize: mints a scoped API key on the/,
    );
    expect(body).toMatch(
      /\/\/ calling account and stages it for delivery via CliAuthorizeExchange\./,
    );
    expect(body).toMatch(
      /func \(r \*AuthResource\) CliAuthorizeBind\(ctx context\.Context, body \*CliAuthorizeBindRequest\) \(\*CliAuthorizeBindResponse, error\)/,
    );
    expect(body).toMatch(
      /method: "POST",\s*\n\s*path:\s+"\/v1\/auth\/cli-authorize\/bind-device-code",/,
    );
  });

  it('CliAuthorizeExchange — V-460/V-266 STEP 3 (polled by CLI/GUI). 3-state status discriminator: "pending" (keep polling) / "bound" (one-shot delivery; APIKey + AccountID populated) / "expired" (restart the flow). CRITICAL "one-shot delivery" framing: once exchange returns "bound", a subsequent poll will return "expired" — the key is not re-retrievable, mirroring the broader plaintext-once contract.', () => {
    expect(body).toMatch(/\/\/ CliAuthorizeExchange — V-460 \/ V-266\. Polled by the CLI\/GUI\./);
    expect(body).toMatch(
      /\/\/ Status discriminator: "pending" \(keep polling\), "bound" \(one-shot/,
    );
    expect(body).toMatch(/\/\/ delivery; APIKey \+ AccountID populated\), or "expired" \(restart/);
    expect(body).toMatch(/\/\/ the flow\)\./);
    expect(body).toMatch(
      /func \(r \*AuthResource\) CliAuthorizeExchange\(ctx context\.Context, body \*CliAuthorizeExchangeRequest\) \(\*CliAuthorizeExchangeResponse, error\)/,
    );
    expect(body).toMatch(/method: "POST",\s*\n\s*path:\s+"\/v1\/auth\/cli-authorize\/exchange",/);
  });

  it('14-verb wire-path inventory: 9 baseline + 2 MFA (V-445) + 3 CLI-authorize (V-460/V-266) under /v1/auth/*. Method-verb pairing pinned: every auth verb is POST (no GET or PATCH or DELETE) so the entire surface stays uniformly write-side. Drift to a GET verb here would let auth state leak via referer logs.', () => {
    // 14 method:"POST" appearances expected (matches the 14 verbs).
    const posts = body.match(/method: "POST"/g) ?? [];
    expect(posts.length, 'expected exactly 14 POST verbs (the full auth surface)').toBe(14);
    // No other methods on this resource.
    expect(body).not.toMatch(/method: "GET"/);
    expect(body).not.toMatch(/method: "PATCH"/);
    expect(body).not.toMatch(/method: "DELETE"/);
  });
});

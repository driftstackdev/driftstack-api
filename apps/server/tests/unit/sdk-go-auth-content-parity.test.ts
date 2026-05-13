// W589.A — drift guard for packages/sdk-go/auth.go.
// AuthResource Go parity — 14 V-079 auth-flow methods routing
// through client.do (so retries + structured errors apply even
// though Authorization header is ignored on these public routes).
//
//   • 9 baseline verbs + 2 MFA (V-445/V-353e) + 3 CLI-authorize
//     handshake (V-460/V-266 initiate→bind→exchange).
//   • Every method follows the same shape: var out X; r.client.do
//     (ctx, requestOptions{method, path, body, out}); return.

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

  it('Package docstring + V-079 framing + empty-key-fine-for-auth example + AuthResource struct pinned', () => {
    expect(body).toMatch(/\/\/ AuthResource handles \/v1\/auth\/\* endpoints \(V-079\)\./);
    expect(body).toMatch(
      /\/\/ These endpoints don't require an API key — they ARE the auth gate\./,
    );
    expect(body).toMatch(
      /\/\/ The SDK still routes them through the same client\.do path so users/,
    );
    expect(body).toMatch(/\/\/ get retry, rate-limit handling, and structured-error parsing for/);
    expect(body).toMatch(/\/\/ free; the Authorization header is set unconditionally but the/);
    expect(body).toMatch(/\/\/ server ignores it for these routes\./);
    expect(body).toMatch(/\/\/\s+c := driftstack\.New\(""\) \/\/ empty key is fine for auth flows/);
    expect(body).toMatch(/^type AuthResource struct \{\s*\n\s*client \*Client\s*\n\}/m);
  });

  it('9 baseline auth verbs (Signup + VerifyEmail + Login + RequestMagicLink + ConsumeMagicLink + RequestPasswordReset + ConfirmPasswordReset + Refresh + Logout) pinned with consistent path+body shape', () => {
    expect(body).toMatch(
      /func \(r \*AuthResource\) Signup\(ctx context\.Context, body \*SignupRequest\) \(\*SignupResponse, error\) \{/,
    );
    expect(body).toMatch(/path:\s+"\/v1\/auth\/signup",/);
    expect(body).toMatch(
      /func \(r \*AuthResource\) VerifyEmail\(ctx context\.Context, body \*VerifyEmailRequest\) \(\*VerifyEmailResponse, error\) \{/,
    );
    expect(body).toMatch(/path:\s+"\/v1\/auth\/verify-email",/);
    expect(body).toMatch(
      /func \(r \*AuthResource\) Login\(ctx context\.Context, body \*LoginRequest\) \(\*LoginResponse, error\) \{/,
    );
    expect(body).toMatch(/path:\s+"\/v1\/auth\/login",/);
    expect(body).toMatch(
      /func \(r \*AuthResource\) RequestMagicLink\(ctx context\.Context, body \*MagicLinkRequest\) \(\*MagicLinkRequestResponse, error\) \{/,
    );
    expect(body).toMatch(/path:\s+"\/v1\/auth\/magic-link\/request",/);
    expect(body).toMatch(
      /func \(r \*AuthResource\) ConsumeMagicLink\(ctx context\.Context, body \*MagicLinkConsumeRequest\) \(\*MagicLinkConsumeResponse, error\) \{/,
    );
    expect(body).toMatch(/path:\s+"\/v1\/auth\/magic-link\/consume",/);
    expect(body).toMatch(
      /func \(r \*AuthResource\) RequestPasswordReset\(ctx context\.Context, body \*PasswordResetRequest\) \(\*PasswordResetRequestResponse, error\) \{/,
    );
    expect(body).toMatch(/path:\s+"\/v1\/auth\/password-reset\/request",/);
    expect(body).toMatch(
      /func \(r \*AuthResource\) ConfirmPasswordReset\(ctx context\.Context, body \*PasswordResetConfirmRequest\) \(\*PasswordResetConfirmResponse, error\) \{/,
    );
    expect(body).toMatch(/path:\s+"\/v1\/auth\/password-reset\/confirm",/);
    expect(body).toMatch(
      /func \(r \*AuthResource\) Refresh\(ctx context\.Context, body \*RefreshSessionRequest\) \(\*RefreshSessionResponse, error\) \{/,
    );
    expect(body).toMatch(/path:\s+"\/v1\/auth\/refresh",/);
    expect(body).toMatch(
      /func \(r \*AuthResource\) Logout\(ctx context\.Context, body \*LogoutRequest\) \(\*LogoutResponse, error\) \{/,
    );
    expect(body).toMatch(/path:\s+"\/v1\/auth\/logout",/);
  });

  it('V-445 MFA: MfaChallenge (V-353d login challenge_token exchange via "totp"|"recovery") + MfaStepUp (V-353e 15-minute step-up window; no new session) pinned', () => {
    expect(body).toMatch(/\/\/ MfaChallenge — V-445\. Exchange the V-353d login challenge_token/);
    expect(body).toMatch(/\/\/ for a session via TOTP code or recovery code\. Distinguished/);
    expect(body).toMatch(/\/\/ response carries Via = "totp" \| "recovery"\./);
    expect(body).toMatch(
      /func \(r \*AuthResource\) MfaChallenge\(ctx context\.Context, body \*MfaChallengeRequest\) \(\*MfaChallengeResponse, error\) \{/,
    );
    expect(body).toMatch(/path:\s+"\/v1\/auth\/mfa\/challenge",/);
    expect(body).toMatch(/\/\/ MfaStepUp — V-445\. Refresh mfa_satisfied_at on the calling web/);
    expect(body).toMatch(
      /\/\/ session \(V-353e step-up gate; 15-minute freshness window\)\. No new/,
    );
    expect(body).toMatch(/\/\/ session issued; returns the new mfa_satisfied_at timestamp\./);
    expect(body).toMatch(
      /func \(r \*AuthResource\) MfaStepUp\(ctx context\.Context, body \*MfaStepUpRequest\) \(\*MfaStepUpResponse, error\) \{/,
    );
    expect(body).toMatch(/path:\s+"\/v1\/auth\/mfa\/step-up",/);
  });

  it('V-460/V-266 CLI/GUI 3-step activation: CliAuthorizeInitiate (one-shot code + browser_url) → CliAuthorizeBind (web-session-auth + mint+stage) → CliAuthorizeExchange (polled; pending/bound/expired discriminator) pinned', () => {
    expect(body).toMatch(
      /\/\/ CliAuthorizeInitiate — V-460 \/ V-266\. Start the CLI\/GUI activation/,
    );
    expect(body).toMatch(
      /\/\/ flow\. Returns a one-shot code \+ browser_url; the CLI\/GUI opens the/,
    );
    expect(body).toMatch(/\/\/ URL, the user signs in to the dashboard and confirms, after which/);
    expect(body).toMatch(/\/\/ CliAuthorizeExchange returns the plaintext API key\./);
    expect(body).toMatch(
      /func \(r \*AuthResource\) CliAuthorizeInitiate\(ctx context\.Context, body \*CliAuthorizeInitiateRequest\) \(\*CliAuthorizeInitiateResponse, error\) \{/,
    );
    expect(body).toMatch(/path:\s+"\/v1\/auth\/cli-authorize\/initiate",/);
    expect(body).toMatch(
      /\/\/ CliAuthorizeBind — V-460 \/ V-266\. Web-session-authenticated\. Called/,
    );
    expect(body).toMatch(/\/\/ by the dashboard's confirm page after the user clicks Authorize:/);
    expect(body).toMatch(/\/\/ mints a scoped API key on the calling account and stages it for/);
    expect(body).toMatch(/\/\/ delivery via CliAuthorizeExchange\./);
    expect(body).toMatch(
      /func \(r \*AuthResource\) CliAuthorizeBind\(ctx context\.Context, body \*CliAuthorizeBindRequest\) \(\*CliAuthorizeBindResponse, error\) \{/,
    );
    expect(body).toMatch(/path:\s+"\/v1\/auth\/cli-authorize\/bind",/);
    expect(body).toMatch(/\/\/ CliAuthorizeExchange — V-460 \/ V-266\. Polled by the CLI\/GUI\./);
    expect(body).toMatch(
      /\/\/ Status discriminator: "pending" \(keep polling\), "bound" \(one-shot/,
    );
    expect(body).toMatch(/\/\/ delivery; APIKey \+ AccountID populated\), or "expired" \(restart/);
    expect(body).toMatch(/\/\/ the flow\)\./);
    expect(body).toMatch(
      /func \(r \*AuthResource\) CliAuthorizeExchange\(ctx context\.Context, body \*CliAuthorizeExchangeRequest\) \(\*CliAuthorizeExchangeResponse, error\) \{/,
    );
    expect(body).toMatch(/path:\s+"\/v1\/auth\/cli-authorize\/exchange",/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});

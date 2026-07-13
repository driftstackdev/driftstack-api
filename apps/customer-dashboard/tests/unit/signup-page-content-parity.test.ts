// W368.B — drift guard for customer-dashboard /signup page
// content. V-184a + V-267 + V-269. The entry point of the
// onboarding funnel; existing signup-page-parity + signup-page-
// endpoints-parity + signup-route-parity tests cover route +
// fetch wiring. This guard pins the load-bearing UX claims:
//
//   • Flow framing comment: signup → verify-email → welcome →
//     select-tier → dashboard. A future short-circuit (e.g.
//     skipping verify-email) must update this comment first.
//   • POST /v1/auth/signup is the registered server route.
//   • Password minlength=12 + passphrase guidance pinned.
//   • V-267 ?next= deep-link preservation through verify-email
//     redirect (so /cli/authorize flow resumes correctly).
//   • V-269 ?next= preservation on the "Sign in" cross-link
//     (so the user who already has an account doesn't lose
//     their deep-link target).
//   • sessionStorage ds_signup_email stash for verify-email
//     page; debug_token stash for dev-mode paste-in.
//   • withSidebar={false} (pre-auth surface).
//   • "one signup per email" framing pinned.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/signup.astro');
const AUTH_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/auth.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W368.B customer-dashboard /signup page content parity', () => {
  const body = read(PAGE);

  it('V-184a onboarding flow comment pinned (signup → verify-email → welcome → select-tier → dashboard)', () => {
    expect(body).toMatch(/Flow: signup → verify-email → welcome → select-tier → dashboard/);
  });

  it('POST /v1/auth/signup wired client-side + registered server-side', () => {
    expect(existsSync(AUTH_ROUTE)).toBe(true);
    expect(read(AUTH_ROUTE)).toContain("'/v1/auth/signup'");
    expect(body).toMatch(/fetch\(apiBaseUrl \+ '\/v1\/auth\/signup'/);
    expect(body).toMatch(/method: 'POST'/);
  });

  it('account creation has a real single-flight lease and bounded network deadline', () => {
    expect(body).toMatch(/const SIGNUP_REQUEST_TIMEOUT_MS = 15_000/);
    expect(body).toMatch(/let signupInFlight = false/);
    expect(body).toMatch(/if \(signupInFlight\) return/);
    expect(body).toMatch(/signupInFlight = true/);
    expect(body).toMatch(/const controller = new AbortController\(\)/);
    expect(body).toMatch(/setTimeout\(\(\) => controller\.abort\(\), SIGNUP_REQUEST_TIMEOUT_MS\)/);
    expect(body).toMatch(/signal: controller\.signal/);
    expect(body).toMatch(/clearTimeout\(timeoutId\)/);
    expect(body).toMatch(/signupInFlight = false/);
    expect(body).toMatch(/Account creation took too long/);
  });

  it('password minlength=12 + passphrase guidance pinned', () => {
    expect(body).toMatch(/<input[^>]*id="signup-password"[\s\S]*?minlength="12"/);
    expect(body).toMatch(/12\+ characters\. Use a passphrase/);
  });

  it('V-267 ?next= preserved on verify-email redirect (deep-link resume), open-redirect guarded', () => {
    expect(body).toMatch(
      /const verifyUrl = rawNext\s*\n?\s*\?\s*'\/verify-email\?next=' \+ encodeURIComponent\(next\)\s*\n?\s*:\s*'\/verify-email';/,
    );
    expect(body).toMatch(/V-267 — pass through the \?next= deep link/);
    // ?next= sanitized via the inline safeNextPath() (same-origin) before forward.
    expect(body).toMatch(/function safeNextPath\(next, origin\) \{/);
    expect(body).toMatch(/const next = safeNextPath\(rawNext, window\.location\.origin\);/);
  });

  it('V-269 ?next= preserved on "Sign in" cross-link, sanitized through safeNextPath()', () => {
    expect(body).toMatch(/V-269 — preserve \?next= when bouncing the user to \/login/);
    expect(body).toMatch(
      /'\/login\?next=' \+ encodeURIComponent\(safeNextPath\(nextRaw, window\.location\.origin\)\)/,
    );
  });

  it('sessionStorage stashes ds_signup_email + ds_debug_verify_token (dev paste-in)', () => {
    expect(body).toContain('ds_signup_email');
    expect(body).toContain('ds_debug_verify_token');
    expect(body).toMatch(/sessionStorage\.setItem\('ds_signup_email'/);
    // debug_token only stashed when server returns it (test/dev mode).
    expect(body).toMatch(
      /if \(body\.debug_token\) \{\s*\n?\s*sessionStorage\.setItem\('ds_debug_verify_token'/,
    );
  });

  it('withSidebar={false} layout (pre-auth surface)', () => {
    expect(body).toMatch(/<DashboardLayout title="Sign up" withSidebar=\{false\}/);
  });

  it('"one signup per email" framing pinned', () => {
    expect(body).toMatch(/one signup\s+per email/);
  });

  it('Email autocomplete + new-password autocomplete attributes pinned (a11y + UX)', () => {
    expect(body).toMatch(/<input[^>]*id="signup-email"[\s\S]*?autocomplete="email"/);
    expect(body).toMatch(/<input[^>]*id="signup-password"[\s\S]*?autocomplete="new-password"/);
    expect(body).toMatch(/<input[^>]*id="signup-name"[\s\S]*?autocomplete="name"/);
  });

  it('Name field is OPTIONAL (only email + password are required)', () => {
    // Required attribute on email + password; NOT on name.
    expect(body).toMatch(/<input[^>]*id="signup-email"[\s\S]*?required/);
    expect(body).toMatch(/<input[^>]*id="signup-password"[\s\S]*?required/);
    const nameInput = body.match(/<input[^>]*id="signup-name"[\s\S]*?\/>/);
    expect(nameInput).not.toBeNull();
    expect(nameInput![0]).not.toMatch(/\brequired\b/);
  });

  it('credentials: "include" on signup fetch (cookie-session post-issuance)', () => {
    expect(body).toMatch(/credentials: 'include'/);
  });

  it('email-already-registered (409) renders inline Sign in + Reset password links carrying the entered email (not a dead text banner)', () => {
    // Match on the problem `type` URI (server EmailAlreadyRegisteredError).
    expect(body).toContain('https://errors.driftstack.dev/email-already-registered');
    expect(body).toMatch(/err\.problemType\s*=\s*b\.type/);
    // The inline-link branch is invoked on that problem type.
    expect(body).toMatch(/showAlreadyRegistered\(payload\.email\)/);
    // The banner gains a /login link + a /forgot-password link, both
    // carrying the email through the query string.
    expect(body).toMatch(/'\/login' \+ q/);
    expect(body).toMatch(/'\/forgot-password' \+ q/);
    expect(body).toMatch(/encodeURIComponent\(email\)/);
  });
});

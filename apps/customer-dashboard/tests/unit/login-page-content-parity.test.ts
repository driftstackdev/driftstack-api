// W369.B — drift guard for customer-dashboard /login page
// content. V-269 + V-079 + V-353d. Existing login-page-parity +
// login-page-endpoints-parity + login-page-route-parity tests
// cover route + fetch wiring. This guard pins the load-bearing
// claims for returning customers:
//
//   • POST /v1/auth/login registered server-side + wired client-
//     side; localStorage token key is `ds_web_session_token`
//     (same key as signup → verify-email, so cross-page reads
//     just work).
//   • V-353d discriminated-union response handling pinned:
//     mfa_required branch shows a clear banner pointing at API
//     + CLI workaround (so MFA-enrolled users aren't silently
//     bounced).
//   • V-269 ?next= deep-link preservation on /signup cross-
//     link (so "Create one" → signup doesn't lose deep-link
//     target).
//   • ?next= round-trip on successful login (fall back to "/"
//     for typical marketing-site → /login flow).
//   • Email autocomplete + current-password autocomplete (a11y
//     + UX — distinguishes login from signup's new-password).
//   • Forgot-password cross-link present.
//   • withSidebar={false} (pre-auth surface).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/login.astro');
const AUTH_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/auth.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W369.B customer-dashboard /login page content parity', () => {
  const body = read(PAGE);

  it('POST /v1/auth/login wired client-side + registered server-side', () => {
    expect(existsSync(AUTH_ROUTE)).toBe(true);
    expect(read(AUTH_ROUTE)).toContain("'/v1/auth/login'");
    expect(body).toMatch(/fetch\(apiBaseUrl \+ '\/v1\/auth\/login'/);
    expect(body).toMatch(/method: 'POST'/);
  });

  it('session-token persistence: localStorage key ds_web_session_token (matches signup convention)', () => {
    expect(body).toMatch(/localStorage\.setItem\('ds_web_session_token', session\.token\)/);
  });

  it('password login has a real single-flight lease and bounded network deadline', () => {
    expect(body).toMatch(/const LOGIN_REQUEST_TIMEOUT_MS = 15_000/);
    expect(body).toMatch(/let loginInFlight = false/);
    expect(body).toMatch(/if \(loginInFlight\) return/);
    expect(body).toMatch(/loginInFlight = true/);
    expect(body).toMatch(/const controller = new AbortController\(\)/);
    expect(body).toMatch(/setTimeout\(\(\) => controller\.abort\(\), LOGIN_REQUEST_TIMEOUT_MS\)/);
    expect(body).toMatch(/signal: controller\.signal/);
    expect(body).toMatch(/clearTimeout\(timeoutId\)/);
    expect(body).toMatch(/loginInFlight = false/);
    expect(body).toMatch(/Sign-in took too long/);
  });

  it('V-353d/W528 MFA-required branch opens the challenge form (no dead-end banner, no silent redirect-loop)', () => {
    expect(body).toMatch(/V-353d/);
    expect(body).toMatch(/body\.mfa_required === true/);
    // W528 — the branch now starts the challenge step instead of the old
    // "UI not available yet" dead-end that locked MFA users out.
    expect(body).toMatch(/startMfaChallenge\(body\.challenge_token\)/);
    expect(body).toMatch(/data-form="mfa"/);
    expect(body).toMatch(/\/v1\/auth\/mfa\/challenge/);
    expect(body).toMatch(/autocomplete="one-time-code"/);
    expect(body).not.toMatch(/not available yet/);
  });

  it('MFA verification has a real single-flight lease and bounded network deadline', () => {
    expect(body).toMatch(/let mfaInFlight = false/);
    expect(body).toMatch(/const MFA_REQUEST_TIMEOUT_MS = 15_000/);
    expect(body).toMatch(/if \(mfaInFlight\) return/);
    expect(body).toMatch(/mfaInFlight = true/);
    expect(body).toMatch(/mfaSubmit\.textContent = 'Verifying…'/);
    expect(body).toMatch(/setTimeout\(\(\) => controller\.abort\(\), MFA_REQUEST_TIMEOUT_MS\)/);
    expect(body).toMatch(/signal: controller\.signal/);
    expect(body).toMatch(/clearTimeout\(timeoutId\)/);
    expect(body).toMatch(/mfaInFlight = false/);
    expect(body).toMatch(/Verification took too long/);
  });

  it("V-269 ?next= preserved on /signup cross-link (deep-link doesn't leak)", () => {
    expect(body).toMatch(/V-269 — preserve \?next= when bouncing the user to \/signup/);
    expect(body).toMatch(
      /signupLink\.setAttribute\('href', '\/signup\?next=' \+ encodeURIComponent\(next\)\)/,
    );
  });

  it('?next= round-trip on successful login (falls back to "/")', () => {
    expect(body).toMatch(/window\.location\.href = next \? next : '\/'/);
  });

  it('email autocomplete + current-password autocomplete (distinguishes login from signup)', () => {
    expect(body).toMatch(/<input[^>]*id="login-email"[\s\S]*?autocomplete="email"/);
    expect(body).toMatch(/<input[^>]*id="login-password"[\s\S]*?autocomplete="current-password"/);
  });

  it('forgot-password cross-link to /forgot-password pinned', () => {
    expect(body).toMatch(
      /<a href="\/forgot-password" class="[^"]+"\s*>\s*Forgot your password\?\s*<\/a\s*>/,
    );
    expect(
      existsSync(resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/forgot-password.astro')),
    ).toBe(true);
  });

  it('withSidebar={false} layout (pre-auth surface)', () => {
    expect(body).toMatch(/<DashboardLayout title="Sign in" withSidebar=\{false\}/);
  });

  it("'/cli/authorize' deep-link round-trip framing pinned in V-269 comment", () => {
    expect(body).toMatch(/V-267 cli\/authorize deep-link round-trip/);
  });

  it('both email + password are REQUIRED (no anonymous login)', () => {
    expect(body).toMatch(/<input[^>]*id="login-email"[\s\S]*?required/);
    expect(body).toMatch(/<input[^>]*id="login-password"[\s\S]*?required/);
  });

  it('credentials NOT set on login fetch (token-only, no cookie-session)', () => {
    // Unlike /signup which uses credentials:'include' for cookie-
    // session post-issuance, /login is token-only — the response
    // body carries the session token and the page stashes it in
    // localStorage. A future "credentials: include" add here would
    // change the auth posture and must be deliberate.
    const fetchBlock = body.match(/fetch\(apiBaseUrl \+ '\/v1\/auth\/login'[\s\S]*?\}\)\s*\.then/);
    expect(fetchBlock).not.toBeNull();
    expect(fetchBlock![0]).not.toMatch(/credentials: 'include'/);
  });
});

// W372.B — drift guard for customer-dashboard /reset-password
// page content. V-273 + V-079. Existing reset-password-page-
// endpoints-parity + password-reset-route-parity + reset-
// password-token-from-url tests cover route + URL parsing. This
// guard pins the load-bearing security + UX claims:
//
//   • V-273 + V-079 framing comment pinned (4-step flow:
//     read ?token=… → enter new password → POST → mint session).
//   • POST /v1/auth/password-reset/confirm registered server-
//     side + wired client-side.
//   • One-shot token framing pinned ("Token is one-shot — second
//     use returns 400") + "link is single-use" customer-facing
//     copy.
//   • Missing-token UX: data-missing block visible when ?token=
//     absent + cross-link back to /forgot-password.
//   • Confirm-password match check (client-side) before POST.
//   • Password minlength=12 + passphrase guidance.
//   • Both inputs autocomplete="new-password".
//   • Session-token persistence: localStorage ds_web_session_
//     token + redirect to "/" (auto-signed-in post-reset).
//   • withSidebar={false} pre-auth layout.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/reset-password.astro');
const AUTH_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/auth.ts');
const FORGOT = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/forgot-password.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W372.B customer-dashboard /reset-password page content parity', () => {
  const body = read(PAGE);

  it('V-273 + V-079 framing comment pinned (4-step flow: read token → enter password → POST → mint session)', () => {
    expect(body).toMatch(/V-273 — Password-reset confirmation page/);
    expect(body).toMatch(/V-079\s+\/\/ backend route `POST \/v1\/auth\/password-reset\/confirm`/);
    expect(body).toMatch(/User clicks the reset link from email; page reads `\?token=…`/);
    expect(body).toMatch(/Server returns a session, or an MFA challenge for enrolled accounts/);
  });

  it('POST /v1/auth/password-reset/confirm wired client + registered server-side', () => {
    expect(existsSync(AUTH_ROUTE)).toBe(true);
    expect(read(AUTH_ROUTE)).toContain("'/v1/auth/password-reset/confirm'");
    expect(body).toMatch(/fetch\(apiBaseUrl \+ '\/v1\/auth\/password-reset\/confirm'/);
    expect(body).toMatch(/body: JSON\.stringify\(\{ token: token, new_password: password \}\)/);
  });

  it('one-shot token framing pinned: "second use returns 400" + customer-facing "single-use"', () => {
    expect(body).toMatch(
      /Token is one-shot — second use returns 400; a successful MFA challenge is too\./,
    );
    expect(body).toMatch(/The link is single-use; if you need\s+another/);
  });

  it('missing-token UX: data-missing block + back-to-/forgot-password cross-link', () => {
    expect(body).toMatch(/<div\s*\n?\s*data-missing[\s\S]*?No reset token in URL/);
    expect(body).toMatch(
      /Open the page from the link in your reset email, or\s+<a\s*\n?\s*href="\/forgot-password"\s*\n?\s*class="[^"]+"\s*>\s*request a new one\s*<\/a\s*>/,
    );
    expect(existsSync(FORGOT)).toBe(true);
    // Token-absent branch swaps form for missing UI.
    expect(body).toMatch(
      /if \(!token\) \{\s*\n?\s*form\.classList\.add\('hidden'\);\s*\n?\s*missing\.classList\.remove\('hidden'\);/,
    );
  });

  it('confirm-password match check (client-side) before POST', () => {
    expect(body).toMatch(
      /if \(password !== confirm\) \{\s*\n?\s*showBanner\('Passwords do not match\.'\);/,
    );
    expect(body).toMatch(
      /if \(password\.length < 12\) \{\s*\n?\s*showBanner\('Password must be at least 12 characters\.'\);/,
    );
  });

  it('password minlength=12 + passphrase guidance', () => {
    expect(body).toMatch(/<input[^>]*id="reset-password-input"[\s\S]*?minlength="12"/);
    expect(body).toMatch(/<input[^>]*id="reset-confirm-input"[\s\S]*?minlength="12"/);
    expect(body).toMatch(/12\+ characters\. Use a passphrase/);
  });

  it('both inputs autocomplete="new-password" (browser password-manager hint)', () => {
    expect(body).toMatch(/<input[^>]*id="reset-password-input"[\s\S]*?autocomplete="new-password"/);
    expect(body).toMatch(/<input[^>]*id="reset-confirm-input"[\s\S]*?autocomplete="new-password"/);
  });

  it('session-token persistence on success: localStorage ds_web_session_token + redirect to "/"', () => {
    expect(body).toMatch(/localStorage\.setItem\('ds_web_session_token', session\.token\)/);
    expect(body).toMatch(/window\.location\.href = '\/'/);
  });

  it('enrolled accounts finish the reset through memory-only TOTP/recovery MFA', () => {
    expect(body).toContain('data-form="reset-mfa"');
    expect(body).toContain('if (body.mfa_required === true)');
    expect(body).toContain("'/v1/auth/mfa/challenge'");
    expect(body).toContain('recovery_code: recoveryCode');
    expect(body).toContain('let mfaChallengeToken = null;');
    expect(body).not.toMatch(/localStorage\.setItem\([^,]+, mfaChallengeToken\)/);
    expect(body).toContain('MFA sign-in outcome is unknown after the request timed out.');
    expect(body).toContain('Do not submit this code again. Sign in afresh with your new password');
  });

  it('withSidebar={false} pre-auth layout', () => {
    expect(body).toMatch(/<DashboardLayout title="Reset password" withSidebar=\{false\}/);
  });

  it('"Reset password + sign in" CTA framing pinned (single-step auto-signin)', () => {
    // Load-bearing UX claim — the user doesn't have to sign in again
    // after a successful reset; the POST returns a session token.
    expect(body).toMatch(/Reset password \+ sign in<\/button>/);
  });

  it('both fields REQUIRED (no anonymous reset)', () => {
    expect(body).toMatch(/<input[^>]*id="reset-password-input"[\s\S]*?required/);
    expect(body).toMatch(/<input[^>]*id="reset-confirm-input"[\s\S]*?required/);
  });

  it('one-time reset consumption is single-flight and bounded', () => {
    expect(body).toMatch(/const RESET_REQUEST_TIMEOUT_MS = 15_000;/);
    expect(body).toMatch(/let resetInFlight = false;/);
    expect(body).toMatch(/let resetOutcomeUnknown = false;/);
    expect(body).toMatch(/if \(resetInFlight \|\| resetOutcomeUnknown\) return;/);
    expect(body).toMatch(/setTimeout\(\(\) => controller\.abort\(\), RESET_REQUEST_TIMEOUT_MS\)/);
    expect(body).toMatch(/signal: controller\.signal/);
    expect(body).toMatch(/clearTimeout\(timeoutId\);\s*resetInFlight = false;/);
  });

  it('never replays a consumed reset link after an ambiguous timeout', () => {
    expect(body).toContain('data-unknown-recovery');
    expect(body).toContain('Try signing in with the new password');
    expect(body).toContain('Request a fresh reset link');
    expect(body).toContain('Password-reset outcome is unknown because the request timed out.');
    expect(body).toContain('consumed this one-time link');
    expect(body).toContain('Do not submit this link again.');
    expect(body).toContain('submitBtn.disabled = on || resetOutcomeUnknown;');
  });
});

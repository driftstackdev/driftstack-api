// W492.A — drift guard for apps/customer-dashboard/src/pages/reset-password.astro.
// V-273 password-reset confirmation page. Drift here either drops
// the one-shot token framing (drift to letting users re-submit the
// same token would break the V-079 single-use invariant) or breaks
// the auto-login flow (token-as-session handoff would force the
// customer to log in again after reset, hostile UX).
//
//   • V-273 + V-079 framing pinned (5-step flow comment).
//   • One-shot token: 'second use returns 400'.
//   • Token-from-URL via URLSearchParams.get('token') + missing-
//     token bail.
//   • Password match + minLength=12 validation.
//   • Auto-login: ds_web_session_token write + redirect to '/'.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/reset-password.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W492.A apps/customer-dashboard/src/pages/reset-password.astro content parity', () => {
  const body = read(LIB);

  it('V-273 + V-079 framing pins session-or-MFA recovery and one-shot tokens', () => {
    expect(body).toMatch(
      /\/\/ V-273 — Password-reset confirmation page\. Pairs with the V-079\s*\n?\s*\/\/ backend route `POST \/v1\/auth\/password-reset\/confirm`\./,
    );
    expect(body).toMatch(
      /\/\/ {3}6\. Token is one-shot — second use returns 400; a successful MFA challenge is too\./,
    );
    expect(body).toMatch(
      /\/\/ {3}4\. Server returns a session, or an MFA challenge for enrolled accounts\./,
    );
  });

  it("Missing-token bail: URLSearchParams + params.get('token') → if !token: form.add('hidden') + missing.remove('hidden') + early return — pinned so the form doesn't allow submission without a token (drift to leaving the form visible would let customers fill in a password and get a confusing server error instead of the clear 'No reset token in URL' explanation)", () => {
    expect(body).toMatch(
      /const params = new URLSearchParams\(window\.location\.search\);\s*\n?\s*const token = params\.get\('token'\);\s*\n?\s*\n?\s*if \(!token\) \{\s*\n?\s*form\.classList\.add\('hidden'\);\s*\n?\s*missing\.classList\.remove\('hidden'\);\s*\n?\s*return;\s*\n?\s*\}/,
    );
    // S23 2026-07-06 — this link sits INSIDE the rose-wash missing-token notice
    // (bg-rose-400/10 over the auth-card surface), where accent-text measures
    // 4.42:1 — so it reads the ink underline tone instead (hover accent-text).
    expect(body).toMatch(
      /No reset token in URL\. Open the page from the link in your reset email, or\s*\n?\s*<a\s*\n?\s*href="\/forgot-password\/"\s*\n?\s*class="font-medium text-tk-ink underline[^"]*"\s*\n?\s*>request a new one<\/a\s*\n?\s*>\./,
    );
  });

  it("Client-side validation: password !== confirm → 'Passwords do not match.' bail-banner + password.length < 12 → 'Password must be at least 12 characters.' bail-banner — pinned so the dual checks happen client-side before the server roundtrip (drift to relying on server-only validation would surface 422s for what should be inline UX errors)", () => {
    expect(body).toMatch(
      /if \(password !== confirm\) \{\s*\n?\s*showBanner\('Passwords do not match\.'\);\s*\n?\s*return;\s*\n?\s*\}\s*\n?\s*if \(password\.length < 12\) \{\s*\n?\s*showBanner\('Password must be at least 12 characters\.'\);\s*\n?\s*return;\s*\n?\s*\}/,
    );
  });

  it("Input minlength=12 + autocomplete='new-password' on both password fields — pinned so browsers + password managers know this is a new password (not a sign-in form) and don't auto-fill with the OLD password from the customer's vault (which would defeat the entire reset flow)", () => {
    expect(body).toMatch(
      /<input\s*\n?\s*id="reset-password-input"\s*\n?\s*name="password"\s*\n?\s*type="password"\s*\n?\s*required\s*\n?\s*minlength="12"\s*\n?\s*autocomplete="new-password"/,
    );
    expect(body).toMatch(
      /<input\s*\n?\s*id="reset-confirm-input"\s*\n?\s*name="confirm"\s*\n?\s*type="password"\s*\n?\s*required\s*\n?\s*minlength="12"\s*\n?\s*autocomplete="new-password"/,
    );
  });

  it('POST /v1/auth/password-reset/confirm contract: body:{token, new_password} (snake_case new_password matching server schema) + content-type:application/json — pinned so the field name stays in sync with V-079 schema (drift to camelCase newPassword would silently 400)', () => {
    expect(body).toMatch(
      /fetch\(apiBaseUrl \+ '\/v1\/auth\/password-reset\/confirm', \{[\s\S]+?body: JSON\.stringify\(\{ token: token, new_password: password \}\),[\s\S]+?signal: controller\.signal,/,
    );
  });

  it('persists the session only after the direct or MFA branch returns it', () => {
    expect(body).toMatch(
      /function persistWebSession\(session\) \{[\s\S]*?const staleKeys = \['ds_act_as_account', 'ds_is_team_user', 'ds_is_staff_user'\];[\s\S]*?localStorage\.removeItem\(key\);[\s\S]*?localStorage\.setItem\('ds_web_session_token', session\.token\);[\s\S]*?localStorage\.getItem\('ds_web_session_token'\) !== session\.token[\s\S]*?function completeSession/,
    );
    expect(body).toMatch(
      /function completeSession\(session\) \{\s*persistWebSession\(session\);\s*window\.location\.href = '\/';\s*\}/,
    );
    expect(body.replace('persistWebSession(session);', '')).not.toMatch(
      /function completeSession\(session\) \{\s*persistWebSession\(session\);/,
    );
    expect(
      body.replace("localStorage.setItem('ds_web_session_token', session.token);", ''),
    ).not.toMatch(
      /function persistWebSession\(session\) \{[\s\S]*?localStorage\.setItem\('ds_web_session_token', session\.token\);[\s\S]*?function completeSession/,
    );
    expect(body).toContain('if (body.mfa_required === true)');
    expect(body).toContain("'/v1/auth/mfa/challenge'");
  });

  it('maps password-reset problem+json through the shared fixed response boundary', () => {
    expect(body).toMatch(
      /return r\s*\.json\(\)\s*\.catch\(\(\) => \(\{\}\)\)\s*\.then\(\(b\) =>\s*Promise\.reject\(window\.driftstackResponseError\(r, b\)\),?\s*\);/,
    );
    expect(body.replace('window.driftstackResponseError(r, b)', 'new Error(b.detail)')).not.toMatch(
      /return r\s*\.json\(\)\s*\.catch\(\(\) => \(\{\}\)\)\s*\.then\(\(b\) =>\s*Promise\.reject\(window\.driftstackResponseError\(r, b\)\),?\s*\);/,
    );
    expect(body).not.toMatch(/new Error\(b\.detail/);
  });

  it("Page chrome + cross-link: withSidebar={false} + 'Choose a new password for your Driftstack account. The link is single-use; if you need another, request one from the forgot-password page.' framing + /forgot-password cross-link — pinned so customers landing on an expired token have a clear path back to request a new one (instead of getting stuck)", () => {
    expect(body).toMatch(/<DashboardLayout title="Reset password" withSidebar=\{false\}>/);
    // S23 2026-07-06 — accent-toned TEXT re-pinned raw tk-accent → AA-safe tk-accent-text (cross-app WCAG sweep).
    expect(body).toMatch(
      /Choose a new password for your Driftstack account\. The link is single-use; if you need\s*\n?\s*another, request one from the\s*\n?\s*<a\s*\n?\s*href="\/forgot-password\/"\s*\n?\s*class="text-tk-accent-text[^"]*"\s*\n?\s*>forgot-password<\/a\s*\n?\s*> page\./,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});

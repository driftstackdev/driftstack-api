// W492.B — drift guard for apps/customer-dashboard/src/pages/signup.astro.
// V-184a onboarding step 1 (account creation). Drift here either
// drops the V-267 next-param preservation (deep-links from /cli/
// authorize would lose their continuation across signup → verify
// flow) or breaks the debug_token sessionStorage handoff (dev
// flow loses the paste-into-verify convenience).
//
//   • V-184a framing pinned + onboarding-flow comment.
//   • signup → verify-email → welcome → select-tier → first-
//     session flow.
//   • email + optional name + minlength=12 password.
//   • sessionStorage: ds_signup_email + ds_debug_verify_token.
//   • V-267 + V-269: next= URL preservation through signup →
//     verify-email redirect AND to /login fallback link.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/signup.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W492.B apps/customer-dashboard/src/pages/signup.astro content parity', () => {
  const body = read(LIB);

  it("V-184a framing pinned: 'onboarding flow Tier 1 scaffolding. Minimal placeholder UX; full Tier 3 visual lands as V-184b draft for founder review.' + flow: 'signup → verify-email → welcome → select-tier → dashboard. Each page uses localStorage.ds_web_session_token for cross-page state.' (2026-07-02: terminal step moved from /first-session to the dashboard home with the account-portal IA) — pinned so the canonical onboarding sequence + the cross-page state-key contract survive", () => {
    expect(body).toMatch(
      /\/\/ V-184a — onboarding flow Tier 1 scaffolding\. Minimal placeholder\s*\n?\s*\/\/ UX; full Tier 3 visual lands as V-184b draft for founder review\./,
    );
    expect(body).toMatch(
      /\/\/ Flow: signup → verify-email → welcome → select-tier → dashboard\.\s*\n?\s*\/\/ Each page uses localStorage\.ds_web_session_token for cross-page state\./,
    );
  });

  it("Form structure: email required + name optional ('Name (optional)' label) + password required minlength=12 + '12+ characters. Use a passphrase.' hint — pinned so the minimum-12-char password policy + the 'passphrase encouraged' hint stay consistent with reset-password page (both client-side enforce the same floor)", () => {
    expect(body).toMatch(/required\s*\n?\s*autocomplete="email"/);
    expect(body).toMatch(/<label class="form-label" for="signup-name">Name \(optional\)<\/label>/);
    expect(body).toMatch(
      /<input\s*\n?\s*id="signup-password"\s*\n?\s*name="password"\s*\n?\s*type="password"\s*\n?\s*required\s*\n?\s*minlength="12"\s*\n?\s*autocomplete="new-password"/,
    );
    expect(body).toMatch(/<p class="form-helper">12\+ characters\. Use a passphrase\.<\/p>/);
  });

  it("Page intro framing pinned: 'Create your Driftstack account. After signup we'll email you a verification code; one signup per email.' — pinned so the 'one signup per email' uniqueness invariant is surfaced before submission (drift to dropping would surprise customers who try to signup with an already-taken email)", () => {
    expect(body).toMatch(
      /Create your Driftstack account\. After signup we'll email you a verification code; one signup\s*\n?\s*per email\./,
    );
  });

  it("Optional name handling: const name = fd.get('name'); if (name) payload.name = name — pinned so the name field only goes into the payload when non-empty (drift to always-include would send an empty string and might fail server-side min-length validation; drift to always-exclude would lose the friendly customer name)", () => {
    expect(body).toMatch(
      /const name = fd\.get\('name'\);\s*\n?\s*if \(name\) payload\.name = name;/,
    );
  });

  it("sessionStorage handoff: ds_signup_email (so verify-email page can show 'Code sent to X') + ds_debug_verify_token (only set when server returns debug_token, i.e. AUTH_EXPOSE_DEBUG_TOKEN=true) — pinned so the post-signup → verify-email handoff carries both the email context AND the dev-mode paste-in token", () => {
    expect(body).toMatch(
      /sessionStorage\.setItem\('ds_signup_email', payload\.email\);\s*\n?\s*if \(body\.debug_token\) \{\s*\n?\s*sessionStorage\.setItem\('ds_debug_verify_token', body\.debug_token\);\s*\n?\s*\}/,
    );
  });

  it("V-267 next= preservation through signup → verify-email redirect: params.get('next') → safeNextPath → verificationUrl() — pinned so deep-links from /cli/authorize (and other entry points) preserve their sanitized same-origin continuation target across the onboarding flow", () => {
    expect(body).toMatch(
      /\/\/ V-267 — pass through the \?next= deep link so flows that\s*\n?\s*\/\/ brought the user to signup \(e\.g\. GUI activation at\s*\n?\s*\/\/ \/cli\/authorize\) can resume after verify-email completes\./,
    );
    // Open-redirect guard: ?next= is sanitized via the inline safeNextPath()
    // (same-origin, unit-tested in safe-next.test.ts) before being forwarded;
    // gated on the RAW presence so /verify-email (no next) stays the default.
    expect(body).toMatch(/function safeNextPath\(next, origin\) \{/);
    expect(body).toMatch(/const nextRaw = params\.get\('next'\);/);
    expect(body).toMatch(
      /function verificationUrl\(\) \{\s*\n?\s*const next = safeNextPath\(nextRaw, window\.location\.origin\);\s*\n?\s*return nextRaw \? '\/verify-email\?next=' \+ encodeURIComponent\(next\) : '\/verify-email';\s*\n?\s*\}/,
    );
    expect(body).toMatch(/window\.location\.href = verificationUrl\(\);/);
  });

  it("V-269 next= preservation on /login fallback link: nextRaw → loginLink href becomes '/login?next=' + encodeURIComponent(safeNextPath(nextRaw, …)) — pinned so customers who click 'Already have an account? Sign in' from a deep-linked signup still hit their intended (same-origin) destination after sign-in (drift would lose the next= or reopen the open-redirect)", () => {
    expect(body).toMatch(/\/\/ V-269 — preserve \?next= when bouncing the user to \/login\./);
    expect(body).toMatch(/if \(nextRaw && loginLink\) \{/);
    expect(body).toMatch(
      /'\/login\?next=' \+ encodeURIComponent\(safeNextPath\(nextRaw, window\.location\.origin\)\)/,
    );
  });

  it('POST /v1/auth/signup contract: payload {email, password, name?}, credentials, 15s timeout signal, fixed response mapper, and outcome-unknown recovery — pinned so cookie handoff remains correct without making an ambiguous timed-out signup safe to repeat', () => {
    expect(body).toMatch(/const SIGNUP_REQUEST_TIMEOUT_MS = 15_000;/);
    expect(body).toMatch(
      /const controller = new AbortController\(\);\s*\n?\s*const timeoutId = setTimeout\(\(\) => controller\.abort\(\), SIGNUP_REQUEST_TIMEOUT_MS\);/,
    );
    expect(body).toMatch(
      /fetch\(apiBaseUrl \+ '\/v1\/auth\/signup', \{\s*\n?\s*method: 'POST',\s*\n?\s*headers: \{ 'content-type': 'application\/json' \},\s*\n?\s*body: JSON\.stringify\(payload\),\s*\n?\s*credentials: 'include',\s*\n?\s*signal: controller\.signal,\s*\n?\s*\}\)/,
    );
    expect(body).toMatch(/window\.driftstackResponseError\(r, b\)/);
    expect(body).toMatch(
      /if \(controller\.signal\.aborted\) \{\s*\n?\s*showSignupOutcomeUnknown\(payload\.email\);\s*\n?\s*return;/,
    );
    expect(body).toMatch(/\.finally\(\(\) => \{\s*\n?\s*clearTimeout\(timeoutId\);/);
  });

  it("Page chrome: withSidebar={false} + 'Already have an account? Sign in' fallback link — pinned so the no-sidebar auth-page convention stays consistent + the sign-in escape hatch survives for customers who realize they already have an account mid-flow", () => {
    expect(body).toMatch(/<DashboardLayout title="Sign up" withSidebar=\{false\}>/);
    // S23 2026-07-06 — accent-toned TEXT re-pinned raw tk-accent → AA-safe tk-accent-text (cross-app WCAG sweep).
    expect(body).toMatch(
      /Already have an account\? <a\s*\n?\s*data-login-link\s*\n?\s*href="\/login\/"\s*\n?\s*class="text-tk-accent-text[^"]*"\s*\n?\s*>\s*Sign in\s*<\/a\s*\n?\s*>/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});

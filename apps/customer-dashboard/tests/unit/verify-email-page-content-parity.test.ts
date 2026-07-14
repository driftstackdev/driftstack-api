// W371.B — drift guard for customer-dashboard /verify-email page
// content. V-184a + V-184a.B + V-267 + #187. Existing verify-
// email-page-endpoints-parity + verify-email-route-parity +
// verify-email-auto-submit tests cover route + auto-submit. This
// guard pins the load-bearing UX + flow claims:
//
//   • V-184a.B URL-token pre-fill + auto-submit. The form stays
//     mounted as a fallback for mangled mail-client links.
//   • POST /v1/auth/verify-email server registration + client
//     wiring + credentials:'include' (post-issuance cookie).
//   • V-267 ?next= round-trip on success (falls back to /welcome
//     for first-time onboarding).
//   • Token-stash cleanup on success: ds_signup_email +
//     ds_debug_verify_token both removed from sessionStorage.
//   • #187 self-service /v1/auth/resend-verification with
//     sessionStorage-or-prompt fallback for the email address.
//   • Resend anti-double-click: 60s disable after success (per-
//     IP 3/min server-side cap protection).
//   • autocomplete="one-time-code" on token input.
//   • /signup "restart signup" cross-link present.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/verify-email.astro');
const AUTH_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/auth.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W371.B customer-dashboard /verify-email page content parity', () => {
  const body = read(PAGE);

  it('Issue 3 wave 1085+ URL-token pre-fill + auto-submit pinned (mail-client link short-circuit) — form is HIDDEN by default and a spinner shows during auto-verify; the form is revealed via showFallback() only when auto-verify fails OR no ?token= URL param is present', () => {
    expect(body).toMatch(/Issue 3 wave 1085\+|V-184a\.B/);
    expect(body).toMatch(/const linkToken = params\.get\('token'\);/);
    expect(body).toMatch(
      /if \(linkToken && linkToken\.length > 0\) \{\s*\n?\s*submitToken\(linkToken\);/,
    );
    // showFallback() reveals the manual code-paste form on failure or no-token.
    expect(body).toMatch(/function showFallback\(\)/);
    expect(body).toMatch(/data-form-fallback/);
  });

  it('auto and manual verification share one accessible request lease', () => {
    expect(body).toMatch(/let verifyInFlight = false;/);
    expect(body).toMatch(/let verifyOutcomeUnknown = false;/);
    expect(body).toMatch(
      /if \(verifyInFlight \|\| verifyOutcomeUnknown\) return Promise\.resolve\(false\);/,
    );
    expect(body).toMatch(/verifyInFlight = true;/);
    expect(body).toMatch(/form\.setAttribute\('aria-busy', busy \? 'true' : 'false'\)/);
    expect(body).toMatch(/verifySubmit\.disabled = busy \|\| verifyOutcomeUnknown/);
    expect(body).toMatch(
      /\.finally\(\(\) => \{\s*(?:clearTimeout\(timeoutId\);\s*)?verifyInFlight = false;/,
    );
  });

  it('one-time email verification has a bounded network deadline', () => {
    expect(body).toMatch(/const VERIFY_REQUEST_TIMEOUT_MS = 15_000/);
    expect(body).toMatch(/const controller = new AbortController\(\)/);
    expect(body).toMatch(/setTimeout\(\(\) => controller\.abort\(\), VERIFY_REQUEST_TIMEOUT_MS\)/);
    expect(body).toMatch(/signal: controller\.signal/);
    expect(body).toMatch(/clearTimeout\(timeoutId\)/);
    expect(body).toContain('Email-verification outcome is unknown after the request timed out.');
    expect(body).toContain('consumed this one-time token');
    expect(body).toContain('Do not submit this token again.');
    expect(body).toContain('Continue to sign in');
    expect(body).toContain('Resend verification email');
  });

  it('POST /v1/auth/verify-email wired client + registered server-side (credentials:"include")', () => {
    expect(existsSync(AUTH_ROUTE)).toBe(true);
    expect(read(AUTH_ROUTE)).toContain("'/v1/auth/verify-email'");
    expect(body).toMatch(/fetch\(apiBaseUrl \+ '\/v1\/auth\/verify-email'/);
    expect(body).toMatch(/credentials: 'include'/);
  });

  it('V-267 ?next= round-trip on success (falls back to /welcome), open-redirect guarded', () => {
    expect(body).toMatch(/V-267 — honor \?next= round-trip from \/cli\/authorize/);
    // Open-redirect guard (inline copy of src/lib/safe-next.ts, unit-tested in
    // safe-next.test.ts): ?next= is sanitized to a same-origin path before the
    // nav, gated on the RAW presence to keep the /welcome onboarding fallback.
    expect(body).toMatch(/function safeNextPath\(next, origin\) \{/);
    expect(body).toMatch(/if \(u\.origin !== origin\) return '\/';/);
    expect(body).toMatch(/const next = safeNextPath\(rawNext, window\.location\.origin\);/);
    expect(body).toMatch(/window\.location\.href = rawNext \? next : '\/welcome'/);
  });

  it('token-stash cleanup on success (ds_signup_email + ds_debug_verify_token removed)', () => {
    expect(body).toMatch(/removeSignupState\('ds_signup_email'\)/);
    expect(body).toMatch(/removeSignupState\('ds_debug_verify_token'\)/);
  });

  it('#187 self-service POST /v1/auth/resend-verification wired with email-fallback prompt', () => {
    expect(body).toMatch(/#187 — self-service resend of the signup-verification email/);
    expect(body).toMatch(/fetch\(apiBaseUrl \+ '\/v1\/auth\/resend-verification'/);
    expect(read(AUTH_ROUTE)).toContain("'/v1/auth/resend-verification'");
    // Email fallback prompt when sessionStorage is empty (branded modal).
    expect(body).toMatch(/await window\.driftstackPrompt\('Email address used at signup:', \{/);
  });

  it('resend acquires its lease before the async prompt and has a bounded request', () => {
    expect(body).toMatch(/const RESEND_REQUEST_TIMEOUT_MS = 15_000/);
    expect(body).toMatch(/let resendInFlight = false/);
    expect(body).toMatch(/let resendOutcomeUnknown = false/);
    expect(body).toMatch(
      /addEventListener\('click', async \(\) => \{\s*if \(resendInFlight \|\| resendOutcomeUnknown\) return;\s*resendInFlight = true/,
    );
    expect(body).toMatch(/resendBtn\.setAttribute\('aria-busy', 'true'\)/);
    expect(body).toMatch(/signal: controller\.signal/);
    expect(body).toMatch(/\.finally\(\(\) => clearTimeout\(timeoutId\)\)/);
    expect(body).toMatch(/resendOutcomeUnknown = true/);
    expect(body).toMatch(/Verification-email delivery is unknown/);
    expect(body).toMatch(/Check inbox before retrying/);
  });

  it('resend anti-double-click: 60s disable post-success (per-IP 3/min cap protection)', () => {
    expect(body).toMatch(
      /Re-enable after 60s so accidental double-clicks don't\s*\n?\s*\/\/\s*burn through the per-IP 3\/min cap on the server side/,
    );
    expect(body).toMatch(
      /window\.setTimeout\(\(\) => \{\s*\n?\s*resendInFlight = false;\s*\n?\s*resendBtn\.disabled = false;\s*\n?\s*\}, 60_000\);/,
    );
  });

  it('token input autocomplete="one-time-code" (a11y + mobile UX)', () => {
    expect(body).toMatch(/<input[^>]*id="verify-token"[\s\S]*?autocomplete="one-time-code"/);
    expect(body).toMatch(/<input[^>]*id="verify-token"[\s\S]*?required/);
  });

  it('/signup "restart signup" cross-link present', () => {
    expect(body).toMatch(
      /<a\s*\n?\s*href="\/signup\/"\s*\n?\s*class="[^"]+"\s*>\s*restart signup\s*<\/a\s*>/,
    );
    expect(body).toMatch(/Token expired or never arrived\?/);
  });

  it('linkToken-wins-over-debugToken fallback chain pinned (URL token always wins when both present; dev paste-in kept for back-compat)', () => {
    expect(body).toMatch(/const prefill = linkToken \?\? debugToken/);
  });

  it('Issue 3 wave 1085+ — "Verifying your account…" intro swap + spinner-shown when auto-submitting (replaces the prior "Verifying your email — one moment…" intro-only swap; full visual surface is the spinner now)', () => {
    expect(body).toMatch(/introEl\.textContent = 'Verifying your account…'/);
    expect(body).toMatch(/spinnerEl\.hidden = false/);
    expect(body).toMatch(/data-field="auto-verify-spinner"/);
  });

  it('session-token persistence on success: localStorage ds_web_session_token (matches /login + /signup)', () => {
    expect(body).toMatch(/localStorage\.setItem\('ds_web_session_token', session\.token\)/);
  });

  it('preflights one-time verification storage and verifies the final session write', () => {
    expect(body).toContain('function canPersistWebSession()');
    expect(body).toContain("const probeKey = 'ds_web_session_storage_probe'");
    expect(body).toMatch(/if \(!canPersistWebSession\(\)\) \{/);
    expect(body).toContain('It has not been consumed');
    expect(body).toMatch(/localStorage\.getItem\('ds_web_session_token'\) !== session\.token/);
    expect(body).toContain('Do not submit this token again. Continue to sign in');
  });

  it('withSidebar={false} pre-auth surface', () => {
    expect(body).toMatch(/<DashboardLayout title="Verify email" withSidebar=\{false\}/);
  });
});

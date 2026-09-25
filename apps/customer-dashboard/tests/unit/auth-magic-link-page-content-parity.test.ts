// W374.B — drift guard for customer-dashboard /auth/magic-link
// page content. #190 + V-079. Existing magic-link-page-parity
// test covers basic shape. This guard pins the load-bearing
// security + UX claims for the passwordless-signin landing:
//
//   • #190 + V-079 framing comment pinned (5-step flow + form-
//     as-fallback for mail-client link mangling).
//   • POST /v1/auth/magic-link/consume registered server-side
//     + wired client-side with credentials:'include'.
//   • One-shot token framing ("Token is one-shot — second use
//     returns 400") matches /reset-password's same posture.
//   • URL-token auto-submit (when ?token= present) + fallback
//     form with paste-in instructions.
//   • autocomplete="one-time-code" on token input (a11y +
//     mobile-OTP UX).
//   • Success: localStorage ds_web_session_token + ?next=
//     round-trip (falls back to /).
//   • Error: fallback form revealed + banner shown (so user can
//     retry by pasting).
//   • /login cross-link present ("Link expired? Request a
//     fresh one").
//   • withSidebar={false} pre-auth layout.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/auth/magic-link.astro');
const AUTH_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/auth.ts');
const LOGIN_PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/login.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W374.B customer-dashboard /auth/magic-link page content parity', () => {
  const body = read(PAGE);

  it('#190 + V-079 framing comment pinned (5-step flow + form-as-fallback rationale)', () => {
    expect(body).toMatch(/#190 — magic-link consume page/);
    expect(body).toMatch(/V-079 backend route\s+\/\/ `POST \/v1\/auth\/magic-link\/consume`/);
    expect(body).toMatch(
      /Token is one-shot — second use returns 400; a successful MFA challenge is too\./,
    );
    expect(body).toMatch(
      /The form is rendered as a fallback for the rare case where a mail\s*\/\/\s*client mangles the link/,
    );
  });

  it('POST /v1/auth/magic-link/consume wired client + registered server-side', () => {
    expect(existsSync(AUTH_ROUTE)).toBe(true);
    expect(read(AUTH_ROUTE)).toContain("'/v1/auth/magic-link/consume'");
    expect(body).toMatch(/fetch\(apiBaseUrl \+ '\/v1\/auth\/magic-link\/consume'/);
    expect(body).toMatch(/body: JSON\.stringify\(\{ token: token \}\)/);
    expect(body).toMatch(/credentials: 'include'/);
  });

  // Security sweep #21 — auto-submit stays for a browser with no session; a browser
  // already signed in is asked first (confirmAccountSwitch), so a link someone else
  // requested cannot swap it into their account without a click.
  it('URL-token auto-submit when ?token= present and no session is held (no manual paste required)', () => {
    expect(body).toMatch(
      /const linkToken = params\.get\('token'\);[\s\S]*?if \(linkToken && linkToken\.length > 0\) \{\s*if \(previousSessionToken\) confirmAccountSwitch\(linkToken\);\s*else submitToken\(linkToken\);/,
    );
    expect(body).toMatch(
      /if \(linkToken\) \{\s*params\.delete\('token'\);[\s\S]*?window\.history\.replaceState\([\s\S]*?window\.location\.pathname[\s\S]*?window\.location\.hash/,
    );
    expect(body).toMatch(/showFallbackForm\(null\);/);
  });

  it('URL auto-consume and fallback form share one accessible request lease', () => {
    expect(body).toMatch(/let consumeInFlight = false;/);
    expect(body).toMatch(/let consumeOutcomeUnknown = false;/);
    expect(body).toMatch(
      /if \(consumeInFlight \|\| consumeOutcomeUnknown\) return Promise\.resolve\(false\);/,
    );
    expect(body).toMatch(/consumeInFlight = true;/);
    expect(body).toMatch(/form\.setAttribute\('aria-busy', busy \? 'true' : 'false'\)/);
    expect(body).toMatch(/consumeSubmit\.disabled = busy \|\| consumeOutcomeUnknown/);
    expect(body).toMatch(
      /\.finally\(\(\) => \{\s*window\.clearTimeout\(timeout\);\s*consumeInFlight = false;/,
    );
  });

  it('proves session persistence before consuming the one-time link', () => {
    expect(body).toMatch(/function canPersistWebSession\(\)/);
    expect(body).toMatch(/localStorage\.setItem\(probeKey, '1'\)/);
    expect(body).toMatch(/localStorage\.getItem\(probeKey\) !== '1'/);
    expect(body).toMatch(/localStorage\.getItem\(probeKey\) === null/);
    expect(body).toMatch(
      /function submitToken\(token\) \{[\s\S]*if \(!canPersistWebSession\(\)\)[\s\S]*open the link again — it still works[\s\S]*return Promise\.resolve\(false\);[\s\S]*fetch\(apiBaseUrl \+ '\/v1\/auth\/magic-link\/consume'/,
    );
  });

  it('bounds consume requests and makes an ambiguous timeout terminal', () => {
    expect(body).toContain('const CONSUME_TIMEOUT_MS = 15_000;');
    expect(body).toMatch(/const controller = new AbortController\(\);/);
    expect(body).toMatch(/window\.setTimeout\(\(\) => controller\.abort\(\), CONSUME_TIMEOUT_MS\)/);
    expect(body).toMatch(/signal: controller\.signal/);
    expect(body).toMatch(/window\.clearTimeout\(timeout\)/);
    expect(body).toContain('The request took too long, so this link may already have been used.');
    expect(body).toContain("Don't try it again — request a fresh sign-in link.");
    expect(body).toContain('Request a fresh sign-in link');
  });

  it('autocomplete="one-time-code" on token input (a11y + mobile OTP)', () => {
    expect(body).toMatch(/<input[^>]*id="magic-link-token"[\s\S]*?autocomplete="one-time-code"/);
    expect(body).toMatch(/<input[^>]*id="magic-link-token"[\s\S]*?required/);
  });

  it('success: localStorage ds_web_session_token + ?next= round-trip (falls back to /)', () => {
    expect(body).toContain('function persistWebSession(session)');
    expect(body).toMatch(/localStorage\.setItem\('ds_web_session_token', session\.token\)/);
    expect(body).toMatch(/localStorage\.getItem\('ds_web_session_token'\) !== session\.token/);
    expect(body).toContain("['ds_act_as_account', 'ds_is_team_user', 'ds_is_staff_user']");
    // audit w2flmiw48 #5-7 — open-redirect-guarded: navigates via safeNextPath, not raw next.
    expect(body).toMatch(
      /window\.location\.href = safeNextPath\(params\.get\('next'\), window\.location\.origin\)/,
    );
  });

  it('enrolled accounts exchange a memory-only MFA challenge with TOTP or recovery', () => {
    expect(body).toContain('data-form="magic-link-mfa"');
    expect(body).toContain('if (body.mfa_required === true)');
    expect(body).toContain("'/v1/auth/mfa/challenge'");
    expect(body).toContain('recovery_code: recoveryCode');
    expect(body).toContain('let mfaChallengeToken = null;');
    expect(body).not.toMatch(/localStorage\.setItem\([^,]+, mfaChallengeToken\)/);
    expect(body).toContain('The request took too long, so your code may already have been used.');
    expect(body).toContain("Don't enter it again — request a fresh sign-in link.");
  });

  it('preflights the MFA exchange and locks both one-time credentials after accepted responses', () => {
    expect(body.match(/if \(!canPersistWebSession\(\)\)/g)).toHaveLength(2);
    expect(body).toMatch(/let consumeAccepted = false;/);
    expect(body).toMatch(/if \(r\.ok\) \{\s*consumeAccepted = true;/);
    expect(body).toMatch(/if \(consumeAccepted\) \{\s*showConsumeTerminal\(/);
    expect(body).toMatch(/let mfaAccepted = false;/);
    expect(body).toMatch(/if \(response\.ok\) \{\s*mfaAccepted = true;/);
    expect(body).toMatch(/if \(mfaAccepted\) \{\s*showMfaTerminal\(/);
    expect(body).toContain(
      'Your browser is blocking site storage, which sign-in needs. Allow it, then enter your code again.',
    );
    expect(body).toContain("Don't use this link again — request a fresh one.");
  });

  it('authoritative error path: fallback form revealed + banner shown (retry by paste)', () => {
    expect(body).toMatch(/showFallbackForm\(token\);\s*showBanner/);
    expect(body).toMatch(/data-state="fallback"/);
  });

  it('fallback-form copy pinned: "Paste the code from your sign-in email" + ?token= hint', () => {
    expect(body).toMatch(
      /We couldn't find a code in this link\. Paste the code from your sign-in email below\s+\(the part after <code[^>]*>\?token=<\/code>\)/,
    );
  });

  it('/login cross-link present ("Link expired? Request a fresh one")', () => {
    expect(body).toMatch(/Link expired\? Request a fresh one from the/);
    expect(body).toMatch(/<a\s*href="\/login\/"\s*class="[^"]+"\s*>\s*login page\s*<\/a\s*>/);
    expect(existsSync(LOGIN_PAGE)).toBe(true);
  });

  it('withSidebar={false} pre-auth layout', () => {
    expect(body).toMatch(/<DashboardLayout title="Magic link" withSidebar=\{false\}/);
  });

  it('"Signing you in…" intro copy pinned (status surface during auto-submit)', () => {
    expect(body).toMatch(
      /<h1 class="[^"]*text-4xl[^"]*text-tk-ink[^"]*"[^>]*>\s*Signing you in…\s*<\/h1>/,
    );
    expect(body).toMatch(/intro\.textContent = 'Signing you in…'/);
  });

  it('intro swap on no-token: "Couldn\'t find a code in this link. Paste it from your email"', () => {
    expect(body).toMatch(
      /intro\.textContent =\s*"Couldn't find a code in this link\. Paste it from your email to sign in\."/,
    );
  });
});

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
    expect(body).toMatch(/Token is one-shot — second use returns 400\./);
    expect(body).toMatch(
      /The form is rendered as a fallback for the rare case where a mail\s*\n?\s*\/\/\s*client mangles the link/,
    );
  });

  it('POST /v1/auth/magic-link/consume wired client + registered server-side', () => {
    expect(existsSync(AUTH_ROUTE)).toBe(true);
    expect(read(AUTH_ROUTE)).toContain("'/v1/auth/magic-link/consume'");
    expect(body).toMatch(/fetch\(apiBaseUrl \+ '\/v1\/auth\/magic-link\/consume'/);
    expect(body).toMatch(/body: JSON\.stringify\(\{ token: token \}\)/);
    expect(body).toMatch(/credentials: 'include'/);
  });

  it('URL-token auto-submit when ?token= present (no manual paste required)', () => {
    expect(body).toMatch(
      /const linkToken = params\.get\('token'\);\s*\n?\s*if \(linkToken && linkToken\.length > 0\) \{\s*\n?\s*submitToken\(linkToken\);/,
    );
    expect(body).toMatch(/showFallbackForm\(null\);/);
  });

  it('URL auto-consume and fallback form share one accessible request lease', () => {
    expect(body).toMatch(/let consumeInFlight = false;/);
    expect(body).toMatch(/if \(consumeInFlight\) return Promise\.resolve\(false\);/);
    expect(body).toMatch(/consumeInFlight = true;/);
    expect(body).toMatch(/form\.setAttribute\('aria-busy', busy \? 'true' : 'false'\)/);
    expect(body).toMatch(/consumeSubmit\.textContent = busy \? 'Signing in…' : consumeSubmitText/);
    expect(body).toMatch(/\.finally\(\(\) => \{\s*consumeInFlight = false;/);
  });

  it('autocomplete="one-time-code" on token input (a11y + mobile OTP)', () => {
    expect(body).toMatch(/<input[^>]*id="magic-link-token"[\s\S]*?autocomplete="one-time-code"/);
    expect(body).toMatch(/<input[^>]*id="magic-link-token"[\s\S]*?required/);
  });

  it('success: localStorage ds_web_session_token + ?next= round-trip (falls back to /)', () => {
    expect(body).toMatch(/localStorage\.setItem\('ds_web_session_token', session\.token\)/);
    // audit w2flmiw48 #5-7 — open-redirect-guarded: navigates via safeNextPath, not raw next.
    expect(body).toMatch(
      /window\.location\.href = safeNextPath\(params\.get\('next'\), window\.location\.origin\)/,
    );
  });

  it('error path: fallback form revealed + banner shown (retry by paste)', () => {
    expect(body).toMatch(
      /\.catch\(\(err\) => \{\s*\n?\s*showFallbackForm\(token\);\s*\n?\s*showBanner/,
    );
    expect(body).toMatch(/data-state="fallback"/);
  });

  it('fallback-form copy pinned: "Paste the one from your magic-link email" + ?token= hint', () => {
    expect(body).toMatch(
      /We couldn't find a token in the URL\. Paste the one from your magic-link email below\s+\(everything after <code[^>]*>\?token=<\/code>\)/,
    );
  });

  it('/login cross-link present ("Link expired? Request a fresh one")', () => {
    expect(body).toMatch(/Link expired\? Request a fresh one from the/);
    expect(body).toMatch(
      /<a\s*\n?\s*href="\/login"\s*\n?\s*class="[^"]+"\s*>\s*login page\s*<\/a\s*>/,
    );
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

  it('intro swap on no-token: "Couldn\'t find a token in the URL. Paste it from your email"', () => {
    expect(body).toMatch(
      /intro\.textContent =\s*\n?\s*"Couldn't find a token in the URL\. Paste it from your email to sign in\."/,
    );
  });
});

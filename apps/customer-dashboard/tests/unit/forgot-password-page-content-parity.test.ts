// W370.B — drift guard for customer-dashboard /forgot-password
// page content. V-273 + V-079. Existing forgot-password-page-
// parity + forgot-password-page-endpoints-parity + forgot-
// password-expiry-window-parity tests cover route + expiry math.
// This guard pins the load-bearing security + UX claims:
//
//   • V-273 anti-enumeration framing pinned: "server never
//     confirms account existence via this endpoint". A future
//     copy softening that says "Account not found" would
//     introduce a user-enumeration oracle.
//   • POST /v1/auth/password-reset/request server registration
//     + client wiring.
//   • "If <email> matches a Driftstack account, a reset link
//     is on the way" — stable language regardless of match.
//   • expires_at countdown rendered as minutes (computed
//     client-side from server response).
//   • AUTH_EXPOSE_DEBUG_TOKEN dev-mode debug_token paste-in
//     (URL: /reset-password?token=…).
//   • withSidebar={false} pre-auth surface.
//   • /login cross-link present (Sign in).
//   • Email input required + autocomplete="email".

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/forgot-password.astro');
const AUTH_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/auth.ts');
const RESET_PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/reset-password.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W370.B customer-dashboard /forgot-password page content parity', () => {
  const body = read(PAGE);

  it('V-273 anti-enumeration framing pinned in page comment (server never confirms account existence)', () => {
    expect(body).toMatch(/V-273 — Password-reset request page/);
    expect(body).toMatch(
      /the server\s*\n?\s*\/\/\s*never confirms account existence via this endpoint — anti-\s*\n?\s*\/\/\s*enumeration/,
    );
  });

  it('POST /v1/auth/password-reset/request wired client + registered server-side', () => {
    expect(existsSync(AUTH_ROUTE)).toBe(true);
    expect(read(AUTH_ROUTE)).toContain("'/v1/auth/password-reset/request'");
    expect(body).toMatch(/fetch\(apiBaseUrl \+ '\/v1\/auth\/password-reset\/request'/);
    expect(body).toMatch(/method: 'POST'/);
  });

  it('"If <email> matches a Driftstack account, a reset link is on the way" anti-enumeration copy', () => {
    expect(body).toMatch(
      /If\s*<span data-success-email[^>]*><\/span>\s*matches a Driftstack\s*[\n\r]?\s*account, a reset link/,
    );
  });

  it('expires_at countdown rendered as minutes from server response', () => {
    expect(body).toMatch(
      /const minutes = Math\.max\(\s*\n?\s*1,\s*\n?\s*Math\.round\(\(new Date\(body\.expires_at\)\.getTime\(\) - Date\.now\(\)\) \/ 60000\),\s*\n?\s*\);/,
    );
    expect(body).toMatch(/successWindow\.textContent = minutes \+ ' minutes'/);
    // Default fallback copy when no expires_at returned.
    // (Astro source splits the closing `</span\n>` across lines.)
    expect(body).toMatch(/<span\s*\n?\s*data-success-window[^>]*>60 minutes<\/span\s*>/);
  });

  it('AUTH_EXPOSE_DEBUG_TOKEN dev paste-in: debug_token surfaces /reset-password?token=…', () => {
    expect(body).toMatch(/AUTH_EXPOSE_DEBUG_TOKEN=true/);
    expect(body).toMatch(/if \(body\.debug_token\) \{/);
    expect(body).toMatch(/'\/reset-password\?token=' \+ encodeURIComponent\(body\.debug_token\)/);
    // Dev-mode badge copy pinned.
    expect(body).toMatch(/Dev mode:/);
  });

  it('withSidebar={false} pre-auth layout', () => {
    expect(body).toMatch(/<DashboardLayout title="Forgot password" withSidebar=\{false\}/);
  });

  it('/login cross-link present ("Remembered it? Sign in")', () => {
    expect(body).toMatch(
      /<a\s*\n?\s*href="\/login"\s*\n?\s*class="[^"]+"\s*>\s*Sign in\s*<\/a\s*>/,
    );
    expect(body).toMatch(/Remembered it\?/);
  });

  it('email input required + autocomplete="email"', () => {
    expect(body).toMatch(/<input[^>]*id="forgot-email"[\s\S]*?required/);
    expect(body).toMatch(/<input[^>]*id="forgot-email"[\s\S]*?autocomplete="email"/);
  });

  it('success-state replaces form (form hidden, success surfaced) — no double-submit', () => {
    expect(body).toMatch(
      /form\.classList\.add\('hidden'\);\s*\n?\s*success\.classList\.remove\('hidden'\);/,
    );
  });

  it('reset-link request has a real single-flight lease and bounded network deadline', () => {
    expect(body).toMatch(/const RESET_LINK_REQUEST_TIMEOUT_MS = 15_000/);
    expect(body).toMatch(/let resetLinkRequestInFlight = false/);
    expect(body).toMatch(/if \(resetLinkRequestInFlight\) return/);
    expect(body).toMatch(/resetLinkRequestInFlight = true/);
    expect(body).toMatch(/const controller = new AbortController\(\)/);
    expect(body).toMatch(
      /setTimeout\([\s\S]*?controller\.abort\(\)[\s\S]*?RESET_LINK_REQUEST_TIMEOUT_MS/,
    );
    expect(body).toMatch(/signal: controller\.signal/);
    expect(body).toMatch(/clearTimeout\(timeoutId\)/);
    expect(body).toMatch(/resetLinkRequestInFlight = false/);
    expect(body).toMatch(/Sending the reset link took too long/);
  });

  it('downstream /reset-password page exists (debug_token deep-link target)', () => {
    expect(existsSync(RESET_PAGE)).toBe(true);
  });

  it('flow framing comment pinned: 4-step (submit → server returns stable shape → success → link → /reset-password)', () => {
    expect(body).toMatch(/User enters their email \+ submits/);
    expect(body).toMatch(/Server returns `\{sent: true, expires_at\}`/);
    expect(body).toMatch(/Page shows "Check your inbox" message/);
    expect(body).toMatch(/\/reset-password\?token=…\s*\n?\s*\/\/\s*page handles the actual reset/);
  });
});

// W491.C — drift guard for apps/customer-dashboard/src/pages/forgot-password.astro.
// V-273 password-reset request page. Drift here either drops the
// V-079 anti-enumeration framing ('shape is stable regardless of
// whether the email matches' — drift to confirming account-not-
// found via a different error message would leak account
// existence) or breaks the AUTH_EXPOSE_DEBUG_TOKEN dev hatch
// (developers couldn't paste a reset link locally without
// Postmark/email infra).
//
//   • V-273 + V-079 framing pinned.
//   • Anti-enumeration: success surface 'If <email> matches a
//     Driftstack account, a reset link is on the way.'
//   • debug_token dev-mode reveal: AUTH_EXPOSE_DEBUG_TOKEN=true
//     → page surfaces a direct 'Open reset link' anchor.
//   • POST /v1/auth/password-reset/request contract.
//   • Expires_at → minutes computation (Math.max(1, round((iso -
//     now) / 60000))).
//   • problem+json detail error surfacing.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/forgot-password.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W491.C apps/customer-dashboard/src/pages/forgot-password.astro content parity', () => {
  const body = read(LIB);

  it("V-273 + V-079 framing pinned: 'Password-reset request page. Pairs with the V-079 backend route POST /v1/auth/password-reset/request.' + flow framing — pinned so the backend-route pairing + the anti-enumeration framing ('the server never confirms account existence via this endpoint') stays documented", () => {
    expect(body).toMatch(
      /\/\/ V-273 — Password-reset request page\. Pairs with the V-079 backend\s*\n?\s*\/\/ route `POST \/v1\/auth\/password-reset\/request`\./,
    );
    expect(body).toMatch(
      /\/\/ {3}2\. Server returns `\{sent: true, expires_at\}`\. The shape is stable\s*\n?\s*\/\/ {6}regardless of whether the email matches an account \(the server\s*\n?\s*\/\/ {6}never confirms account existence via this endpoint — anti-\s*\n?\s*\/\/ {6}enumeration\)\./,
    );
  });

  it("AUTH_EXPOSE_DEBUG_TOKEN dev framing pinned: 'when the server returns a debug_token (set when AUTH_EXPOSE_DEBUG_TOKEN=true), the page surfaces it for paste-into-/reset-password during local development.' — pinned so the dev-mode reveal contract (server env-var gates exposure; client surfaces it when present) stays documented", () => {
    expect(body).toMatch(
      /\/\/ Dev convenience: when the server returns a `debug_token` \(set when\s*\n?\s*\/\/ AUTH_EXPOSE_DEBUG_TOKEN=true\), the page surfaces it for paste-into-\s*\n?\s*\/\/ \/reset-password during local development\./,
    );
  });

  it("Anti-enumeration success copy: 'If <email> matches a Driftstack account, a reset link is on the way. The link expires in <window>.' (conditional 'if' phrasing — never confirms whether the email matched) — pinned so the customer-facing copy doesn't accidentally leak account existence by phrasing it as 'we sent a link' (which would imply confirmation) instead of 'if it matches' (which doesn't)", () => {
    expect(body).toMatch(
      /If <span data-success-email class="[^"]+"><\/span> matches a Driftstack\s*\n?\s*account, a reset link is on the way\. The link expires in <span\s*\n?\s*data-success-window\s*\n?\s*class="[^"]+">60 minutes<\/span/,
    );
  });

  it('POST /v1/auth/password-reset/request fetch contract: content-type:application/json + body:{email} — pinned so the endpoint path + payload shape stays in sync with the V-079 server route (drift would silently break the reset flow)', () => {
    expect(body).toMatch(
      /fetch\(apiBaseUrl \+ '\/v1\/auth\/password-reset\/request', \{\s*\n?\s*method: 'POST',\s*\n?\s*headers: \{ 'content-type': 'application\/json' \},\s*\n?\s*body: JSON\.stringify\(\{ email: email \}\),\s*\n?\s*signal: controller\.signal,\s*\n?\s*\}\)/,
    );
  });

  it("debug_token dev-mode anchor: body.debug_token present → debugLink.href = '/reset-password?token=' + encodeURIComponent(debug_token) + debugWrap.classList.remove('hidden') — pinned so the dev-mode reveal opens the right page with the right query param + URL encoding handles tokens with reserved chars", () => {
    expect(body).toMatch(
      /if \(body\.debug_token\) \{\s*\n?\s*debugLink\.setAttribute\(\s*\n?\s*'href',\s*\n?\s*'\/reset-password\?token=' \+ encodeURIComponent\(body\.debug_token\),\s*\n?\s*\);\s*\n?\s*debugWrap\.classList\.remove\('hidden'\);\s*\n?\s*\}/,
    );
  });

  it("expires_at → minutes computation: Math.max(1, Math.round((new Date(expires_at).getTime() - Date.now()) / 60000)) — pinned so the minimum-1-minute floor prevents '0 minutes' or negative-minutes display when the server's clock is slightly ahead of the client's (drift to dropping Math.max(1, ...) would surface '-1 minutes' on clock skew)", () => {
    expect(body).toMatch(
      /const minutes = Math\.max\(\s*\n?\s*1,\s*\n?\s*Math\.round\(\(new Date\(body\.expires_at\)\.getTime\(\) - Date\.now\(\)\) \/ 60000\),\s*\n?\s*\);\s*\n?\s*successWindow\.textContent = minutes \+ ' minutes';/,
    );
  });

  it('maps problem+json through the shared fixed response boundary', () => {
    expect(body).toMatch(
      /return r\s*\.json\(\)\s*\.catch\(\(\) => \(\{\}\)\)\s*\.then\(\(b\) =>\s*Promise\.reject\(window\.driftstackResponseError\(r, b\)\),?\s*\);/,
    );
    expect(body.replace('window.driftstackResponseError(r, b)', 'new Error(b.detail)')).not.toMatch(
      /return r\s*\.json\(\)\s*\.catch\(\(\) => \(\{\}\)\)\s*\.then\(\(b\) =>\s*Promise\.reject\(window\.driftstackResponseError\(r, b\)\),?\s*\);/,
    );
    expect(body).not.toMatch(/new Error\(b\.detail/);
  });

  it("Success-state visibility flip: form.classList.add('hidden') + success.classList.remove('hidden') after successful submission — pinned so the form disappears after submit (drift to leaving form visible would let customers re-submit and trigger rate limits)", () => {
    expect(body).toMatch(
      /form\.classList\.add\('hidden'\);\s*\n?\s*success\.classList\.remove\('hidden'\);/,
    );
  });

  it("Page chrome: withSidebar={false} layout + 'Remembered it? Sign in.' fallback link to /login — pinned so the no-sidebar auth-page convention stays consistent + the sign-in escape hatch survives for customers who realize they remember their password mid-flow", () => {
    expect(body).toMatch(/<DashboardLayout title="Forgot password" withSidebar=\{false\}>/);
    // S23 2026-07-06 — accent-toned TEXT re-pinned raw tk-accent → AA-safe tk-accent-text (cross-app WCAG sweep).
    expect(body).toMatch(
      /Remembered it\? <a\s*\n?\s*href="\/login\/"\s*\n?\s*class="text-tk-accent-text[^"]*"\s*\n?\s*>Sign in<\/a\s*\n?\s*>/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});

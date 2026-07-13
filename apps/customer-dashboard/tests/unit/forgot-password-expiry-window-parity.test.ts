// W346.B — drift guard for /forgot-password expiry-window default
// + anti-enumeration framing. The page renders a fallback "60
// minutes" string (replaced live by the script using the server's
// expires_at). The fallback must match AUTH_TOKEN_TTL_MS.passwordReset
// (60 minutes = 60*60*1000ms) so a JS-disabled fallback shows the
// honest number.
//
// Prior drift caught + fixed by this wave: page said "15 minutes",
// server TTL is 60 minutes. JS would have masked the bug for any
// modern browser, but a screenshot of the SSG paint would have
// misled.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/forgot-password.astro');
const TOKENS = resolve(REPO_ROOT, 'apps/server/src/lib/auth-tokens.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W346.B /forgot-password expiry-window parity', () => {
  const page = read(PAGE);
  const tokens = read(TOKENS);

  it('AUTH_TOKEN_TTL_MS.passwordReset is 60 minutes', () => {
    // 60 * 60 * 1000ms in the source. Pin the literal.
    expect(tokens).toMatch(/passwordReset:\s*60\s*\*\s*60\s*\*\s*1000/);
  });

  it('static fallback window matches the server TTL (60 minutes)', () => {
    expect(page).toMatch(/data-success-window[^>]*>60 minutes</);
    // Old 15-minute drift must be gone.
    expect(page).not.toMatch(/data-success-window[^>]*>15 minutes</);
  });

  it('inline-script computes minutes from server expires_at (live override path)', () => {
    // The placeholder is only shown if JS fails — pin the script
    // path that overrides it.
    expect(page).toMatch(/successWindow\.textContent\s*=\s*minutes\s*\+\s*' minutes'/);
    expect(page).toMatch(/new Date\(body\.expires_at\)/);
  });

  it('anti-enumeration framing: "If <email> matches a Driftstack account"', () => {
    // Pin the exact "If … matches" framing — the page must never
    // confirm or deny account existence.
    expect(page).toMatch(/If [\s\S]{0,200}matches a Driftstack[\s\S]{0,40}account/);
    expect(page).not.toMatch(/account does not exist/i);
    expect(page).not.toMatch(/no account found/i);
    expect(page).not.toMatch(/email not registered/i);
  });

  it('deep-link target on success is /reset-password?token=<debug_token>', () => {
    // V-273 dev convenience: AUTH_EXPOSE_DEBUG_TOKEN=true makes the
    // server include `debug_token` in the response; the page must
    // route customers to the canonical /reset-password page.
    expect(page).toMatch(/debugLink\.setAttribute\([\s\S]*?'\/reset-password\?token='/);
  });

  it('debug-token reveal stays hidden unless body.debug_token is set', () => {
    // Catches a regression where the dev-mode bypass leaks into
    // prod. The script must guard on `if (body.debug_token) {`.
    expect(page).toMatch(/if \(body\.debug_token\)/);
  });

  it('POST /v1/auth/password-reset/request body carries email only (anti-enumeration)', () => {
    // The request body sends just { email }. No client-side
    // pre-validation that would reveal account existence.
    expect(page).toMatch(/JSON\.stringify\(\{\s*email:\s*email\s*\}\)/);
  });

  it('cancel link routes back to /login (consistent with sign-in flow)', () => {
    expect(page).toMatch(/href="\/login\/"/);
  });
});

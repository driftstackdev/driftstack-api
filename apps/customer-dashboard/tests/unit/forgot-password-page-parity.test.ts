// W352.B — drift guard for /forgot-password. The customer-dashboard
// password-reset request page is the entry to V-079's password-reset
// flow. Pins:
//
//   • POST /v1/auth/password-reset/request is the registered server
//     route
//   • PasswordResetRequestSchema is the wire contract (email required)
//   • Shape-stable response posture (no account-existence enumeration)
//     is preserved on the page copy — "If <email> matches a Driftstack
//     account, a reset link is on the way."
//   • debug_token round-trip works in dev (AUTH_EXPOSE_DEBUG_TOKEN=true)
//   • Token TTL displayed comes from server's body.expires_at (not a
//     hardcoded number) so a server-side bump propagates without a
//     copy change
//   • Cross-link to /login resolves (Remembered it?)

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PasswordResetRequestSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/forgot-password.astro');
const LOGIN_PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/login.astro');
const RESET_PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/reset-password.astro');
const AUTH_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/auth.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W352.B /forgot-password page parity', () => {
  const body = read(PAGE);

  it('page file exists at the conventional /forgot-password path', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('PasswordResetRequestSchema sanity check (email required)', () => {
    expect(PasswordResetRequestSchema.safeParse({}).success).toBe(false);
    expect(PasswordResetRequestSchema.safeParse({ email: 'user@example.com' }).success).toBe(true);
    expect(PasswordResetRequestSchema.safeParse({ email: 'not-an-email' }).success).toBe(false);
  });

  it('POSTs to /v1/auth/password-reset/request (registered server-side)', () => {
    expect(body).toContain("'/v1/auth/password-reset/request'");
    expect(read(AUTH_ROUTE)).toContain("'/v1/auth/password-reset/request'");
  });

  it('shape-stable response copy avoids account-existence enumeration', () => {
    // The success banner must not say "we sent" or "an email is on
    // the way" unconditionally — it must say "If <email> matches…"
    // because the server's response is shape-stable regardless of
    // whether the email matched.
    expect(body).toMatch(
      /If\s*<span[^>]*data-success-email[^>]*>[^<]*<\/span>\s*matches a Driftstack\s*[\n\r]?\s*account/,
    );
  });

  it('token TTL displayed is derived from body.expires_at (no hardcoded minute count drives the live UI)', () => {
    // The successWindow text is computed from
    // (body.expires_at - Date.now()) / 60000, so a server bump
    // propagates without a copy change. Pin the derivation.
    expect(body).toMatch(/body\.expires_at[\s\S]{0,200}\/ 60000/);
    expect(body).toMatch(/successWindow\.textContent\s*=\s*minutes\s*\+\s*' minutes'/);
  });

  it('debug_token round-trip surfaces an Open-reset-link CTA in dev', () => {
    expect(body).toMatch(/body\.debug_token/);
    expect(body).toContain('/reset-password?token=');
    expect(body).toContain('encodeURIComponent(body.debug_token)');
  });

  it('reset-password page exists (the success-flow target)', () => {
    expect(existsSync(RESET_PAGE)).toBe(true);
  });

  it('cross-link to /login resolves ("Remembered it?")', () => {
    expect(body).toContain('/login');
    expect(existsSync(LOGIN_PAGE)).toBe(true);
  });
});

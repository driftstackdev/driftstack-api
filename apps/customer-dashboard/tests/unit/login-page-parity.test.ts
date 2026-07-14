// W351.B — drift guard for /login. The customer-dashboard login page
// POSTs to the discriminated-union /v1/auth/login endpoint and must:
//
//   • POST to /v1/auth/login with { email, password }
//   • On success: stash `body.session.token` in localStorage under
//     `ds_web_session_token` (same key signup → verify-email writes)
//   • On the V-353d `mfa_required: true` branch: surface a clear
//     banner instead of silently dropping the user back to /login
//     (which is what happened before the W351.B patch — `body.session`
//     was undefined so localStorage didn't get set, but the redirect
//     to / fired anyway, looping the user)
//   • Honor `?next=` round-trip on success; preserve `?next=` on the
//     /signup fallback link too
//   • Cross-link to /forgot-password resolves
//
// Until the MFA challenge UI ships, the parity test pins the
// "banner instead of broken redirect" posture; when the UI lands the
// branch flips to redirect-into-challenge-page.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LoginResponseUnionSchema, LoginRequestSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/login.astro');
const FORGOT_PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/forgot-password.astro');
const AUTH_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/auth.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W351.B /login page parity', () => {
  const body = read(PAGE);

  it('page file exists at the conventional /login path', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('LoginRequestSchema sanity check', () => {
    expect(
      LoginRequestSchema.safeParse({
        email: 'user@example.com',
        password: 'correct horse battery staple',
      }).success,
    ).toBe(true);
    expect(LoginRequestSchema.safeParse({}).success).toBe(false);
  });

  it('POSTs to /v1/auth/login (registered server-side)', () => {
    expect(body).toContain("'/v1/auth/login'");
    expect(read(AUTH_ROUTE)).toContain("'/v1/auth/login'");
  });

  it('on the success branch, stashes session.token in ds_web_session_token', () => {
    expect(body).toContain("localStorage.setItem('ds_web_session_token', session.token)");
  });

  it('handles the V-353d mfa_required=true branch with a banner (not a silent redirect)', () => {
    // The server schema literally surfaces mfa_required as a discriminator.
    // Pin the client read.
    expect(body).toMatch(/body\.mfa_required\s*===\s*true/);
    // The banner copy must mention MFA so the user knows why.
    expect(body).toMatch(/MFA/);
    // The early `return` keeps localStorage untouched + skips the
    // redirect-to-/ — verify both behaviours stay pinned.
    expect(body).toMatch(/body\.mfa_required[\s\S]{0,400}return;/);
  });

  it('LoginResponseUnionSchema validates both branches the page handles', () => {
    // Success branch.
    expect(
      LoginResponseUnionSchema.safeParse({
        session: {
          token: 't',
          expires_at: '2026-05-12T00:00:00.000Z',
          account_id: 'acc_test',
        },
      }).success,
    ).toBe(true);
    // MFA-required branch.
    expect(
      LoginResponseUnionSchema.safeParse({
        mfa_required: true,
        challenge_token: 'challenge',
        challenge_expires_at: '2026-05-12T00:05:00.000Z',
      }).success,
    ).toBe(true);
  });

  it('honors ?next= on success; preserves ?next= through the /signup fallback link', () => {
    expect(body).toMatch(/window\.location\.href\s*=\s*next\s*\?\s*next\s*:\s*['"]\/['"]/);
    expect(body).toMatch(/signupLink\.setAttribute\('href',\s*'\/signup\/\?next='/);
  });

  it('cross-link to /forgot-password resolves', () => {
    expect(body).toContain('/forgot-password');
    expect(existsSync(FORGOT_PAGE)).toBe(true);
  });

  it('unverified-email recovery: detects the 403 email-not-verified problem type + offers resend + a /verify-email link (no dead banner)', () => {
    // Match on the problem `type` URI (server EmailNotVerifiedError), not
    // the human detail string which can change.
    expect(body).toContain('https://errors.driftstack.dev/email-not-verified');
    // The login error carries the problem type so the catch can branch.
    expect(body).toMatch(/err\.problemType\s*=\s*b\.type/);
    // Resend posts the resend-verification endpoint with the entered email.
    expect(body).toContain('/v1/auth/resend-verification');
    expect(read(AUTH_ROUTE)).toContain("'/v1/auth/resend-verification'");
    expect(body).toMatch(/data-resend-verification/);
    // Stash the email so /verify-email prefills it (same key signup uses).
    expect(body).toMatch(/sessionStorage\.setItem\('ds_signup_email'/);
    // A link to /verify-email exists for entering the code.
    expect(body).toMatch(/data-verify-link/);
    expect(body).toContain('/verify-email');
  });

  it('prefills the email input from ?email= (carried from a signup → sign-in link)', () => {
    expect(body).toMatch(/params\.get\('email'\)/);
  });
});

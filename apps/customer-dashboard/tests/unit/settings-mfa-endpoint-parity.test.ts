// W343.B — drift guard for /settings page MFA lifecycle endpoints.
// The settings page hits 6 distinct MFA routes:
//
//   GET    /v1/account/mfa                          (status)
//   POST   /v1/account/mfa/enroll                   (start TOTP enroll)
//   POST   /v1/account/mfa/verify                   (consume first code)
//   DELETE /v1/account/mfa                          (disable)
//   POST   /v1/account/mfa/recovery-codes/regenerate
//   POST   /v1/auth/mfa/step-up                     (login-path step-up)
//
// If any rename, the relevant button on the MFA panel silently
// 404s. Pin every one to its server-side registration.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/settings.astro');
const ACCOUNT_MFA_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/account-mfa.ts');
const AUTH_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/auth.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W343.B /settings MFA endpoint parity', () => {
  const page = read(PAGE);
  const mfaRoute = read(ACCOUNT_MFA_ROUTE);
  const authRoute = read(AUTH_ROUTE);

  it('page reads MFA status from GET /v1/account/mfa', () => {
    expect(page).toMatch(/'\/v1\/account\/mfa'/);
    expect(mfaRoute).toContain("'/v1/account/mfa'");
  });

  it('enrollment starts via POST /v1/account/mfa/enroll', () => {
    expect(page).toMatch(/'\/v1\/account\/mfa\/enroll'/);
    expect(mfaRoute).toContain("'/v1/account/mfa/enroll'");
  });

  it('first-code verification posts to /v1/account/mfa/verify', () => {
    expect(page).toMatch(/'\/v1\/account\/mfa\/verify'/);
    expect(mfaRoute).toContain("'/v1/account/mfa/verify'");
  });

  it('disable issues DELETE /v1/account/mfa (the GET path is reused with method DELETE)', () => {
    // The settings inline script reuses the same path string for
    // GET and DELETE; verify both ends agree.
    expect(page).toMatch(/method:\s*'DELETE'/);
    expect(mfaRoute).toContain("'/v1/account/mfa'");
  });

  it('recovery-code regeneration: POST /v1/account/mfa/recovery-codes/regenerate', () => {
    expect(page).toContain('/v1/account/mfa/recovery-codes/regenerate');
    expect(mfaRoute).toContain("'/v1/account/mfa/recovery-codes/regenerate'");
  });

  it('step-up MFA challenge posts to /v1/auth/mfa/step-up', () => {
    // Belongs to the auth router (login-path freshness check), not
    // account-mfa.ts.
    expect(page).toContain('/v1/auth/mfa/step-up');
    expect(authRoute).toContain('/v1/auth/mfa/step-up');
  });

  it('page pins customer-facing TOTP framing (authenticator-app, 6-digit code)', () => {
    expect(page).toMatch(/TOTP code/);
    expect(page).toMatch(/from your authenticator app/);
  });

  it('page reveals recovery codes once, prompts download/copy/acknowledge', () => {
    // Recovery codes are non-recoverable after acknowledge; pin
    // each of the three buttons so a refactor can't silently drop
    // the safety prompts.
    expect(page).toMatch(/data-button="mfa-recovery-copy"/);
    expect(page).toMatch(/data-button="mfa-recovery-download"/);
    expect(page).toMatch(/data-button="mfa-recovery-acknowledge"/);
  });

  it('page reads ds_web_session_token for the bearer auth header (consistent with other pages)', () => {
    expect(page).toContain('ds_web_session_token');
  });
});

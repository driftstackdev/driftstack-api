// W255.C — drift-guard for docs.driftstack.io/api/mfa. Pins every
// /v1/account/mfa/* + /v1/auth/mfa/* endpoint the doc names to live
// route registrations, plus the 15-minute step-up window.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const DOC = resolve(REPO_ROOT, 'apps/docs/src/pages/api/mfa.md');
const ROUTE_ACCT = resolve(REPO_ROOT, 'apps/server/src/routes/account-mfa.ts');
const ROUTE_AUTH = resolve(REPO_ROOT, 'apps/server/src/routes/auth.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W255.C docs/api/mfa ↔ live MFA route parity', () => {
  const doc = read(DOC);
  const acct = read(ROUTE_ACCT);
  const auth = read(ROUTE_AUTH);

  it('every account-side MFA endpoint is registered', () => {
    for (const path of [
      '/v1/account/mfa',
      '/v1/account/mfa/enroll',
      '/v1/account/mfa/verify',
      '/v1/account/mfa/disable',
      '/v1/account/mfa/recovery-codes/regenerate',
    ]) {
      expect(acct).toContain(`'${path}'`);
      expect(doc).toContain(path);
    }
  });

  it('login-time challenge + step-up endpoints are registered on auth.ts', () => {
    expect(auth).toMatch(/'\/v1\/auth\/mfa\/challenge'/);
    expect(auth).toMatch(/'\/v1\/auth\/mfa\/step-up'/);
    expect(doc).toMatch(/\/v1\/auth\/mfa\/challenge/);
    expect(doc).toMatch(/\/v1\/auth\/mfa\/step-up/);
  });

  it('TOTP algorithm is SHA1 6-digit 30-second period (RFC 6238 default)', () => {
    expect(doc).toMatch(/algorithm=SHA1/);
    expect(doc).toMatch(/digits=6/);
    expect(doc).toMatch(/period=30/);
  });

  it('step-up window is 15 minutes', () => {
    expect(doc).toMatch(/15-minute window/);
  });

  it('409 Conflict returned when MFA already enrolled', () => {
    expect(doc).toMatch(/409 Conflict/);
  });
});

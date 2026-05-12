// W301.C — drift guard for docs/api/mfa.md endpoint coverage.
// Every MFA route registered on the server (account-mfa.ts + the
// auth.ts mfa/challenge + mfa/step-up endpoints) must be cited by
// the docs page. Catches drift where a new MFA endpoint ships but
// the docs page doesn't mention it.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const DOC = resolve(REPO_ROOT, 'apps/docs/src/pages/api/mfa.md');
const ACCOUNT_MFA = resolve(REPO_ROOT, 'apps/server/src/routes/account-mfa.ts');
const AUTH = resolve(REPO_ROOT, 'apps/server/src/routes/auth.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W301.C docs/api/mfa.md ↔ live MFA route parity', () => {
  const doc = read(DOC);
  const accountMfa = read(ACCOUNT_MFA);
  const auth = read(AUTH);

  const REQUIRED_PATHS = [
    '/v1/account/mfa',
    '/v1/account/mfa/enroll',
    '/v1/account/mfa/verify',
    '/v1/account/mfa/disable',
    '/v1/account/mfa/recovery-codes/regenerate',
    '/v1/auth/mfa/challenge',
    '/v1/auth/mfa/step-up',
  ];

  for (const path of REQUIRED_PATHS) {
    it(`docs/api/mfa.md cites ${path}`, () => {
      expect(doc).toContain(path);
    });

    it(`server actually registers ${path}`, () => {
      const liveRoutes = accountMfa + auth;
      expect(liveRoutes).toContain(path);
    });
  }

  it('doc cites the mfa-step-up-required problem-type slug', () => {
    expect(doc).toMatch(/errors\.driftstack\.dev\/mfa-step-up-required/);
  });

  it('doc explains the 10-recovery-code disclosure on enrollment', () => {
    expect(doc).toMatch(/10\s+(?:single-use\s+)?recovery codes/i);
  });
});

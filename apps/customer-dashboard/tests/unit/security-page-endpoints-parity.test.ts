// W270.D-security — drift-guard for customer-dashboard /security page.
// Pins every /v1/account/* and /v1/auth/* endpoint cited by the page's
// inline web-sessions / audit-log / password-reset handlers to a live
// route registration on the server. These pins lived in
// settings-page-endpoints-parity.test.ts until the 2026-07-03
// design-system v2 split moved the security surfaces to /security.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/security.astro');
const ACCOUNT_ME = resolve(REPO_ROOT, 'apps/server/src/routes/account-me.ts');
const WEB_SESSIONS = resolve(REPO_ROOT, 'apps/server/src/routes/account-web-sessions.ts');
const ACCOUNT_AUDIT = resolve(REPO_ROOT, 'apps/server/src/routes/account-audit.ts');
const AUTH = resolve(REPO_ROOT, 'apps/server/src/routes/auth.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W270.D-security /security page ↔ live route parity', () => {
  const page = read(PAGE);

  it('GET /v1/account/me is registered and used by the page (accountEmail capture)', () => {
    expect(page).toMatch(/\/v1\/account\/me(?!\/)/);
    expect(read(ACCOUNT_ME)).toContain(`'/v1/account/me'`);
  });

  it('GET /v1/account/audit-log is registered', () => {
    expect(page).toMatch(/\/v1\/account\/audit-log\?limit=20/);
    expect(read(ACCOUNT_AUDIT)).toContain(`'/v1/account/audit-log'`);
  });

  it('GET/DELETE /v1/account/web-sessions is registered', () => {
    expect(page).toMatch(/\/v1\/account\/web-sessions(?!\/)/);
    const ws = read(WEB_SESSIONS);
    expect(ws).toContain(`'/v1/account/web-sessions'`);
    expect(ws).toContain(`'/v1/account/web-sessions/:id'`);
  });

  it('POST /v1/auth/password-reset/request is registered', () => {
    expect(page).toMatch(/\/v1\/auth\/password-reset\/request/);
    expect(read(AUTH)).toContain(`'/v1/auth/password-reset/request'`);
  });

  it('uses ds_web_session_token for auth', () => {
    expect(page).toMatch(/ds_web_session_token/);
  });
});

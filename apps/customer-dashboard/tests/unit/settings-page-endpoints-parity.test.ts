// W270.D — drift-guard for customer-dashboard /settings page. Pins
// every /v1/account/* and /v1/auth/* endpoint cited by the page's
// inline profile / email-prefs / web-sessions / password-reset
// handlers to a live route registration on the server.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/settings.astro');
const ACCOUNT_ME = resolve(REPO_ROOT, 'apps/server/src/routes/account-me.ts');
const WEB_SESSIONS = resolve(REPO_ROOT, 'apps/server/src/routes/account-web-sessions.ts');
const EMAIL_PREFS = resolve(REPO_ROOT, 'apps/server/src/routes/email-preferences.ts');
const ACCOUNT_AUDIT = resolve(REPO_ROOT, 'apps/server/src/routes/account-audit.ts');
const AUTH = resolve(REPO_ROOT, 'apps/server/src/routes/auth.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W270.D /settings page ↔ live route parity', () => {
  const page = read(PAGE);

  it('GET/PUT /v1/account/me is registered and used by the page', () => {
    expect(page).toMatch(/\/v1\/account\/me(?!\/)/);
    expect(read(ACCOUNT_ME)).toContain(`'/v1/account/me'`);
  });

  it('PUT/DELETE /v1/account/me/avatar is registered', () => {
    expect(page).toMatch(/\/v1\/account\/me\/avatar/);
    expect(read(ACCOUNT_ME)).toContain(`'/v1/account/me/avatar'`);
  });

  it('GET/PUT /v1/account/email-preferences is registered', () => {
    expect(page).toMatch(/\/v1\/account\/email-preferences/);
    expect(read(EMAIL_PREFS)).toContain(`'/v1/account/email-preferences'`);
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

// W270.D — drift-guard for customer-dashboard /settings page. Pins
// every /v1/account/* endpoint cited by the page's inline profile /
// avatar / email-prefs handlers to a live route registration on the
// server. The security-surface endpoints (web-sessions / audit-log /
// password-reset) moved to /security with the 2026-07-03 design-system
// v2 split — see security-page-endpoints-parity.test.ts.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/settings.astro');
const ACCOUNT_ME = resolve(REPO_ROOT, 'apps/server/src/routes/account-me.ts');
const EMAIL_PREFS = resolve(REPO_ROOT, 'apps/server/src/routes/email-preferences.ts');

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

  it('uses ds_web_session_token for auth', () => {
    expect(page).toMatch(/ds_web_session_token/);
  });
});

// W271.C — drift-guard for customer-dashboard /signup page. Pins
// POST /v1/auth/signup to its live route handler in auth.ts.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/signup.astro');
const AUTH = resolve(REPO_ROOT, 'apps/server/src/routes/auth.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W271.C /signup page ↔ /v1/auth/signup route parity', () => {
  const page = read(PAGE);
  const auth = read(AUTH);

  it('POST /v1/auth/signup is registered on the server', () => {
    expect(page).toMatch(/\/v1\/auth\/signup/);
    expect(auth).toMatch(/['"`]\/v1\/auth\/signup['"`]/);
  });

  it('stores session token as ds_web_session_token in localStorage', () => {
    expect(page).toMatch(/ds_web_session_token/);
  });

  it('does not advertise tiers that do not exist in AccountTierSchema', () => {
    expect(page).not.toMatch(/team_growth/);
    expect(page).not.toMatch(/solo_pro/);
    expect(page).not.toMatch(/enterprise_plus/);
  });
});

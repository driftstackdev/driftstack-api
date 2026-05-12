// W271.B — drift-guard for customer-dashboard /login page. Pins
// POST /v1/auth/login to its live route handler in auth.ts.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/login.astro');
const AUTH = resolve(REPO_ROOT, 'apps/server/src/routes/auth.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W271.B /login page ↔ /v1/auth/login route parity', () => {
  const page = read(PAGE);
  const auth = read(AUTH);

  it('POST /v1/auth/login is registered on the server', () => {
    expect(page).toMatch(/\/v1\/auth\/login/);
    expect(auth).toMatch(/['"`]\/v1\/auth\/login['"`]/);
  });

  it('stores session token as ds_web_session_token in localStorage', () => {
    expect(page).toMatch(/ds_web_session_token/);
  });

  it('does not reference the old PUBLIC_DASHBOARD_URL env var', () => {
    expect(page).not.toMatch(/PUBLIC_DASHBOARD_URL/);
  });
});

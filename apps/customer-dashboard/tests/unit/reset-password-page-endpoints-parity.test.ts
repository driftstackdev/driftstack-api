// W272.C — drift-guard for customer-dashboard /reset-password page.
// Pins POST /v1/auth/password-reset/confirm to its live registration
// in auth.ts. The existing reset-password-token-from-url.test.ts pins
// the URL-token UX; this one pins the wire endpoint.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/reset-password.astro');
const AUTH = resolve(REPO_ROOT, 'apps/server/src/routes/auth.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W272.C /reset-password page ↔ /v1/auth/password-reset/confirm parity', () => {
  const page = read(PAGE);
  const auth = read(AUTH);

  it('POST /v1/auth/password-reset/confirm is registered on the server', () => {
    expect(page).toMatch(/\/v1\/auth\/password-reset\/confirm/);
    expect(auth).toMatch(/['"`]\/v1\/auth\/password-reset\/confirm['"`]/);
  });

  it('stores fresh session token on success (auto-login after reset)', () => {
    expect(page).toMatch(/ds_web_session_token/);
    expect(page).toMatch(/setItem\(['"]ds_web_session_token['"]/);
  });

  it('does not redirect to the legacy /signin path', () => {
    expect(page).not.toMatch(/['"]\/signin['"]/);
  });
});

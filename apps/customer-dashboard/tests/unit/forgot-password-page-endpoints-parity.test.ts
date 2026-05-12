// W272.B — drift-guard for customer-dashboard /forgot-password page.
// Pins POST /v1/auth/password-reset/request to its live registration
// in auth.ts.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/forgot-password.astro');
const AUTH = resolve(REPO_ROOT, 'apps/server/src/routes/auth.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W272.B /forgot-password page ↔ /v1/auth/password-reset/request parity', () => {
  const page = read(PAGE);
  const auth = read(AUTH);

  it('POST /v1/auth/password-reset/request is registered on the server', () => {
    expect(page).toMatch(/\/v1\/auth\/password-reset\/request/);
    expect(auth).toContain(`'/v1/auth/password-reset/request'`);
  });

  it('does not promise the response reveals whether an account exists', () => {
    // Enumeration-safe: 200 OK regardless of account existence.
    expect(page).not.toMatch(/no account found/i);
    expect(page).not.toMatch(/account does not exist/i);
  });
});

// W272.A — drift-guard for customer-dashboard /verify-email page.
// Pins POST /v1/auth/verify-email to its live registration in auth.ts.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/verify-email.astro');
const AUTH = resolve(REPO_ROOT, 'apps/server/src/routes/auth.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W272.A /verify-email page ↔ /v1/auth/verify-email parity', () => {
  const page = read(PAGE);
  const auth = read(AUTH);

  it('POST /v1/auth/verify-email is registered on the server', () => {
    expect(page).toMatch(/\/v1\/auth\/verify-email/);
    expect(auth).toMatch(/['"`]\/v1\/auth\/verify-email['"`]/);
  });

  it('extracts token from URL query for auto-submit (V-178)', () => {
    expect(page).toMatch(/token/);
    expect(page).toMatch(/URLSearchParams|location\.search|searchParams/);
  });

  it('does not log the verification token to the page DOM', () => {
    // We don't expect any token to appear as a literal rendered string;
    // page may inject into a hidden input but should not log/echo it.
    expect(page).not.toMatch(/console\.log\(['"`].*token/);
  });
});

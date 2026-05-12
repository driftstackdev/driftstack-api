// W327.C — drift guard for /forgot-password + /reset-password pages.
//   POST /v1/auth/password-reset/request  — kick off email
//   POST /v1/auth/password-reset/confirm  — set new password
// Both must be registered on the server.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const FORGOT = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/forgot-password.astro');
const RESET = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/reset-password.astro');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/auth.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W327.C password-reset pages ↔ route parity', () => {
  const forgot = read(FORGOT);
  const reset = read(RESET);
  const route = read(ROUTE);

  it('forgot-password page calls /v1/auth/password-reset/request', () => {
    expect(forgot).toContain('/v1/auth/password-reset/request');
  });

  it('reset-password page calls /v1/auth/password-reset/confirm', () => {
    expect(reset).toContain('/v1/auth/password-reset/confirm');
  });

  it('server registers /v1/auth/password-reset/request', () => {
    expect(route).toContain("'/v1/auth/password-reset/request'");
  });

  it('server registers /v1/auth/password-reset/confirm', () => {
    expect(route).toContain("'/v1/auth/password-reset/confirm'");
  });

  it('reset page consumes a token (from URL or form)', () => {
    expect(reset).toMatch(/['"]token['"]/);
  });
});

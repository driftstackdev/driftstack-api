// W326.C — drift guard for /verify-email page. The page collects a
// verification token and POSTs it to /v1/auth/verify-email. The
// server must register that route. The page also implements the
// V-178 auto-submit-from-URL behavior — pin that the token query
// param is consumed.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/verify-email.astro');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/auth.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W326.C /verify-email page parity', () => {
  const page = read(PAGE);
  const route = read(ROUTE);

  it('page calls POST /v1/auth/verify-email', () => {
    expect(page).toContain('/v1/auth/verify-email');
  });

  it('server registers /v1/auth/verify-email', () => {
    expect(route).toContain("'/v1/auth/verify-email'");
  });

  it('page consumes ?token=... from URL (V-178 auto-submit)', () => {
    // The token query param drives the auto-submit path.
    expect(page).toMatch(/searchParams\.get\(['"]token['"]\)|URLSearchParams|location\.search/);
    expect(page).toMatch(/['"]token['"]/);
  });

  it('page has a verification-token input field', () => {
    expect(page).toMatch(/id=['"]verify-token['"]/);
  });
});

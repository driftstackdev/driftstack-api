// W328.C — drift guard for /login page. The page POSTs credentials
// to /v1/auth/login. The server must register that route. The page
// also exposes magic-link request as an alternative path.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/login.astro');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/auth.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W328.C /login ↔ auth route parity', () => {
  const page = read(PAGE);
  const route = read(ROUTE);

  it('page calls POST /v1/auth/login', () => {
    expect(page).toContain('/v1/auth/login');
  });

  it('server registers /v1/auth/login', () => {
    expect(route).toContain("'/v1/auth/login'");
  });

  it('page collects email + password inputs', () => {
    expect(page).toMatch(/type=['"]email['"]/);
    expect(page).toMatch(/type=['"]password['"]/);
  });

  it('page links to /forgot-password for the recovery path', () => {
    expect(page).toMatch(/href=['"]\/forgot-password\/['"]/);
  });
});

// W329.C — drift guard for /signup page. The page POSTs new
// account details to /v1/auth/signup. The server must register
// that route.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/signup.astro');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/auth.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W329.C /signup ↔ auth route parity', () => {
  const page = read(PAGE);
  const route = read(ROUTE);

  it('page calls POST /v1/auth/signup', () => {
    expect(page).toContain('/v1/auth/signup');
  });

  it('server registers /v1/auth/signup', () => {
    expect(route).toContain("'/v1/auth/signup'");
  });

  it('page links to /login as the sign-in path', () => {
    expect(page).toMatch(/href=['"]\/login\/['"]/);
  });

  it('page collects email + password (signup uses password auth, not magic-link)', () => {
    expect(page).toMatch(/type=['"]email['"]/);
    expect(page).toMatch(/type=['"]password['"]/);
  });
});

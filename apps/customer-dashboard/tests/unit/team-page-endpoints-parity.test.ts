// W270.C — drift-guard for customer-dashboard /team page. Pins every
// /v1/team/* endpoint cited by the page's inline list / invite /
// remove handlers to a live route registration in
// apps/server/src/routes/team.ts.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/team.astro');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/team.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W270.C /team page ↔ /v1/team/* route parity', () => {
  const page = read(PAGE);
  const route = read(ROUTE);

  it('GET /v1/team/members is registered and used by the page', () => {
    expect(page).toMatch(/\/v1\/team\/members(?!\/)/);
    expect(route).toContain(`'/v1/team/members'`);
  });

  it('DELETE /v1/team/members/:id is registered', () => {
    expect(page).toMatch(/\/v1\/team\/members\/'\s*\+\s*encodeURIComponent/);
    expect(route).toContain(`'/v1/team/members/:id'`);
  });

  it('GET + POST /v1/team/invites are registered and used by the page', () => {
    expect(page).toMatch(/\/v1\/team\/invites/);
    expect(route).toContain(`'/v1/team/invites'`);
  });

  it('uses ds_web_session_token for auth', () => {
    expect(page).toMatch(/ds_web_session_token/);
  });

  it('every /v1/team/* string-literal path in the page is a live route', () => {
    const paths = [...page.matchAll(/['"`](\/v1\/team\/[a-z-]+)['"`]/g)].map((m) => m[1]!);
    expect(paths.length).toBeGreaterThan(0);
    const missing = paths.filter((p) => !route.includes(`'${p}'`));
    expect(missing).toEqual([]);
  });
});

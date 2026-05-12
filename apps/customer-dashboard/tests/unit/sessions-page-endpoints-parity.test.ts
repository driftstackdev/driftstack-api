// W270.A — drift-guard for customer-dashboard /sessions page. Pins
// /v1/sessions list/create endpoints used by the inline session list
// + active-state narrative to live registrations in
// apps/server/src/routes/sessions.ts.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/sessions.astro');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/sessions.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W270.A /sessions page ↔ /v1/sessions route parity', () => {
  const page = read(PAGE);
  const route = read(ROUTE);

  it('GET /v1/sessions is registered and used by the page', () => {
    expect(page).toMatch(/\/v1\/sessions/);
    expect(route).toContain(`'/v1/sessions'`);
  });

  it('uses ds_web_session_token for auth', () => {
    expect(page).toMatch(/ds_web_session_token/);
  });

  it('narrative references real session active states (creating/ready/running)', () => {
    expect(page).toMatch(/creating/);
    expect(page).toMatch(/ready/);
    expect(page).toMatch(/running/);
  });

  it('references concurrent_limit from the live /v1/sessions response', () => {
    expect(page).toMatch(/concurrent_limit/);
  });

  it('uses ses_ as the canonical session id prefix (no sess_/sn_)', () => {
    const offenders = [...page.matchAll(/\b(sess_|sn_)[a-zA-Z0-9]/g)];
    expect(offenders).toEqual([]);
  });
});

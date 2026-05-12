// W270.B — drift-guard for customer-dashboard /snapshots page. Pins
// every /v1/profile-snapshots* endpoint cited by the page's inline
// list / restore / delete handlers to a live route registration in
// apps/server/src/routes/profile-snapshots.ts.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/snapshots.astro');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/profile-snapshots.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W270.B /snapshots page ↔ /v1/profile-snapshots* route parity', () => {
  const page = read(PAGE);
  const route = read(ROUTE);

  it('GET + POST /v1/profile-snapshots are registered and used by the page', () => {
    expect(page).toMatch(/\/v1\/profile-snapshots(?!\/)/);
    expect(route).toContain(`'/v1/profile-snapshots'`);
  });

  it('DELETE /v1/profile-snapshots/:id is registered', () => {
    expect(page).toMatch(/\/v1\/profile-snapshots\/'\s*\+\s*encodeURIComponent/);
    expect(route).toContain(`'/v1/profile-snapshots/:id'`);
  });

  it('POST /v1/profile-snapshots/:id/restore is registered', () => {
    expect(page).toMatch(/\/restore/);
    expect(route).toContain(`'/v1/profile-snapshots/:id/restore'`);
  });

  it('uses ds_web_session_token for auth', () => {
    expect(page).toMatch(/ds_web_session_token/);
  });

  it('uses psnap_ as the canonical snapshot id prefix (no snap_<uuid>/sn_)', () => {
    const offenders = [...page.matchAll(/\bsnap_<uuid>/g), ...page.matchAll(/\bsn_[a-z0-9]{4,}/g)];
    expect(offenders).toEqual([]);
  });
});

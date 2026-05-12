// W271.D — drift-guard for customer-dashboard /profiles page. Pins
// every /v1/profiles* endpoint cited by the page's inline list /
// snapshot / clone / delete / export / import handlers to a live
// route registration on the server.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/profiles.astro');
const PROFILES = resolve(REPO_ROOT, 'apps/server/src/routes/profiles.ts');
const SNAPSHOTS = resolve(REPO_ROOT, 'apps/server/src/routes/profile-snapshots.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W271.D /profiles page ↔ /v1/profiles* route parity', () => {
  const page = read(PAGE);
  const profiles = read(PROFILES);
  const snapshots = read(SNAPSHOTS);

  it('GET + POST /v1/profiles are registered and used by the page', () => {
    expect(page).toMatch(/\/v1\/profiles(?!\/|-)/);
    expect(profiles).toContain(`'/v1/profiles'`);
  });

  it('DELETE /v1/profiles/:id is registered', () => {
    expect(page).toMatch(/\/v1\/profiles\/'\s*\+\s*encodeURIComponent/);
    expect(profiles).toContain(`'/v1/profiles/:id'`);
  });

  it('POST /v1/profiles/:id/clone is registered', () => {
    expect(page).toMatch(/\/clone/);
    expect(profiles).toContain(`'/v1/profiles/:id/clone'`);
  });

  it('GET /v1/profiles/:id/export is registered', () => {
    expect(page).toMatch(/\/export/);
    expect(profiles).toContain(`'/v1/profiles/:id/export'`);
  });

  it('POST /v1/profiles/import is registered', () => {
    expect(page).toMatch(/\/v1\/profiles\/import/);
    expect(profiles).toContain(`'/v1/profiles/import'`);
  });

  it('POST /v1/profiles/:id/snapshots is registered (on profile-snapshots router)', () => {
    expect(page).toMatch(/\/snapshots/);
    expect(snapshots).toContain(`'/v1/profiles/:id/snapshots'`);
  });

  it('uses ds_web_session_token for auth', () => {
    expect(page).toMatch(/ds_web_session_token/);
  });

  it('uses prof_ as canonical profile id prefix (no prf_)', () => {
    const offenders = [...page.matchAll(/\bprf_[a-zA-Z0-9]+/g)];
    expect(offenders).toEqual([]);
  });
});

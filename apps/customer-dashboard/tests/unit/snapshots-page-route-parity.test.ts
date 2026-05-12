// W319.C — drift guard for /snapshots page. The page hits:
//   GET    /v1/profile-snapshots
//   POST   /v1/profile-snapshots/:id/restore
//   DELETE /v1/profile-snapshots/:id
// All three must be registered server-side.

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

describe('W319.C /snapshots ↔ profile-snapshots route parity', () => {
  const page = read(PAGE);
  const route = read(ROUTE);

  it('page calls /v1/profile-snapshots', () => {
    expect(page).toContain('/v1/profile-snapshots');
  });

  it('page references /restore action', () => {
    // Built via concatenation: '/v1/profile-snapshots/' + id + '/restore'
    expect(page).toContain('/v1/profile-snapshots/');
    expect(page).toMatch(/['"]\/restore['"]/);
  });

  it('server registers /v1/profile-snapshots', () => {
    expect(route).toContain("'/v1/profile-snapshots'");
  });

  it('server registers /v1/profile-snapshots/:id/restore', () => {
    expect(route).toContain("'/v1/profile-snapshots/:id/restore'");
  });

  it('server registers /v1/profile-snapshots/:id (single + delete)', () => {
    expect(route).toContain("'/v1/profile-snapshots/:id'");
  });
});

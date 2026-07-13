// W320.C — drift guard for admin /incidents pages. List page hits
// GET + POST /v1/admin/incidents; detail page hits
// /v1/admin/incidents/:id/{updates,resolve}. All must be
// registered on the server.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIST = resolve(REPO_ROOT, 'apps/admin-panel/src/pages/incidents/index.astro');
const DETAIL = resolve(REPO_ROOT, 'apps/admin-panel/src/pages/shells/incident-detail.astro');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/admin-incidents.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W320.C admin /incidents ↔ admin-incidents route parity', () => {
  const list = read(LIST);
  const detail = read(DETAIL);
  const route = read(ROUTE);

  it('list page calls /v1/admin/incidents', () => {
    expect(list).toContain('/v1/admin/incidents');
  });

  it('detail page references the incidents endpoint with id', () => {
    expect(detail).toContain('/v1/admin/incidents/');
  });

  it('server registers /v1/admin/incidents', () => {
    expect(route).toContain("'/v1/admin/incidents'");
  });

  it('server registers /v1/admin/incidents/:id', () => {
    expect(route).toContain("'/v1/admin/incidents/:id'");
  });

  it('server registers /v1/admin/incidents/:id/updates', () => {
    expect(route).toContain("'/v1/admin/incidents/:id/updates'");
  });

  it('server registers /v1/admin/incidents/:id/resolve', () => {
    expect(route).toContain("'/v1/admin/incidents/:id/resolve'");
  });
});

// W323.C — drift guard for /api-keys page. The page hits:
//   POST   /v1/api-keys             — mint
//   GET    /v1/api-keys             — list
//   DELETE /v1/api-keys/:id         — revoke
//   POST   /v1/api-keys/:id/rotate  — rotate (V-296)
// All four must be registered on the server.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/api-keys.astro');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/admin.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W323.C /api-keys page ↔ api-keys route parity', () => {
  const page = read(PAGE);
  const route = read(ROUTE);

  it('page calls /v1/api-keys', () => {
    expect(page).toContain('/v1/api-keys');
  });

  it('page references rotate action', () => {
    expect(page).toMatch(/['"`]\/rotate['"`]/);
  });

  it('server registers /v1/api-keys', () => {
    expect(route).toContain("'/v1/api-keys'");
  });

  it('server registers /v1/api-keys/:id (single + delete)', () => {
    expect(route).toContain("'/v1/api-keys/:id'");
  });

  it('server registers /v1/api-keys/:id/rotate', () => {
    expect(route).toContain("'/v1/api-keys/:id/rotate'");
  });
});

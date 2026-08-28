// W317.C — drift guard for admin /api-keys page. The page hits:
//   GET  /v1/admin/api-keys
//   POST /v1/admin/api-keys/:id/revoke
// Both must be registered on the server. The page narrative must
// confirm the audit posture: a "required reason" is captured on
// revoke.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/admin-panel/src/pages/api-keys.astro');
const ROUTES = resolve(REPO_ROOT, 'apps/server/src/routes');

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir))
    throw new Error(
      `walk root is missing: ${dir} — a sweep over a missing tree reports nothing to sweep, which reads as clean; if the tree moved, update the root`,
    );
  for (const e of readdirSync(dir)) {
    const full = resolve(dir, e);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W317.C admin /api-keys ↔ route parity', () => {
  const page = read(PAGE);
  const allRouteBodies = walk(ROUTES)
    .filter((f) => /\.ts$/.test(f))
    .map(read)
    .join('\n');

  it('page calls GET /v1/admin/api-keys', () => {
    expect(page).toContain('/v1/admin/api-keys');
  });

  it('page references revoke endpoint', () => {
    expect(page).toMatch(/\/v1\/admin\/api-keys\/[^'"`]*revoke/);
  });

  it('server registers /v1/admin/api-keys', () => {
    expect(allRouteBodies).toContain("'/v1/admin/api-keys'");
  });

  it('server registers /v1/admin/api-keys/:id/revoke', () => {
    expect(allRouteBodies).toContain("'/v1/admin/api-keys/:id/revoke'");
  });

  it('page narrative confirms a required reason is captured on revoke', () => {
    expect(page).toMatch(/required reason/i);
  });
});

// W312.C — drift guard for admin /sessions page. The page hits:
//   GET  /v1/admin/sessions
//   POST /v1/admin/sessions/:id/destroy
// Both must be registered on the server. The force-destroy
// narrative must also confirm an audit row is written.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/admin-panel/src/pages/sessions.astro');
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

describe('W312.C admin /sessions ↔ admin route parity', () => {
  const page = read(PAGE);
  const allRoutes = walk(ROUTES)
    .filter((f) => /\.ts$/.test(f))
    .map(read)
    .join('\n');

  it('page calls GET /v1/admin/sessions', () => {
    expect(page).toContain('/v1/admin/sessions');
  });

  it('page references the force-destroy endpoint', () => {
    expect(page).toMatch(/\/v1\/admin\/sessions\/[^'"`]*destroy/);
  });

  it('server registers GET /v1/admin/sessions', () => {
    expect(allRoutes).toContain("'/v1/admin/sessions'");
  });

  it('server registers POST /v1/admin/sessions/:id/destroy', () => {
    expect(allRoutes).toContain("'/v1/admin/sessions/:id/destroy'");
  });

  it('page narrative confirms an audit row is written on force-destroy', () => {
    expect(page).toMatch(/audit log/i);
  });
});

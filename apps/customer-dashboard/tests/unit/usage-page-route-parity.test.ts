// W325.C — drift guard for /usage page. The page calls
// /v1/usage + /v1/usage/series?days=30 with credentials. Both
// endpoints must be registered on the server.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/usage.astro');
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

describe('W325.C /usage page ↔ usage route parity', () => {
  const page = read(PAGE);
  const allRouteBodies = walk(ROUTES)
    .filter((f) => /\.ts$/.test(f))
    .map(read)
    .join('\n');

  it('page calls /v1/usage', () => {
    expect(page).toMatch(/['"`]\/v1\/usage['"`]/);
  });

  it('page calls /v1/usage/series with a days query', () => {
    expect(page).toMatch(/\/v1\/usage\/series\?days=/);
  });

  it('server registers /v1/usage', () => {
    expect(allRouteBodies).toContain("'/v1/usage'");
  });

  it('server registers /v1/usage/series', () => {
    expect(allRouteBodies).toContain("'/v1/usage/series'");
  });
});

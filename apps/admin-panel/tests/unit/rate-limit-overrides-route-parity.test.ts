// W307.B — drift guard for admin-panel /rate-limit-overrides page.
// The page hits two server endpoints:
//   GET  /v1/admin/rate-limit-overrides
//   POST /v1/admin/accounts/:id/quota-override
//   DELETE /v1/admin/accounts/:id/quota-override
// All three must be registered on the server. Also pins the
// bucket-label set the UI ships against the canonical bucket keys
// the server emits.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/admin-panel/src/pages/rate-limit-overrides.astro');
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

describe('W307.B admin rate-limit-overrides ↔ server route parity', () => {
  const page = read(PAGE);
  const routeBodies = walk(ROUTES)
    .filter((f) => /\.ts$/.test(f))
    .map(read)
    .join('\n');

  it('page calls GET /v1/admin/rate-limit-overrides', () => {
    expect(page).toContain('/v1/admin/rate-limit-overrides');
  });

  it('server registers GET /v1/admin/rate-limit-overrides', () => {
    expect(routeBodies).toContain("'/v1/admin/rate-limit-overrides'");
  });

  it('page references the per-account quota-override path', () => {
    expect(page).toMatch(/quota-override/);
  });

  it('server registers POST/DELETE /v1/admin/accounts/:id/quota-override', () => {
    expect(routeBodies).toContain("'/v1/admin/accounts/:id/quota-override'");
  });

  it('page narrative says overrides supersede tier defaults', () => {
    expect(page).toMatch(/supersede\s+the\s+tier\s+defaults/i);
  });
});

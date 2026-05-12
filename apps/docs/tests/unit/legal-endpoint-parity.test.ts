// W324.A — drift guard for /api/legal endpoint citations. Each
// /v1/legal/* endpoint cited in a backtick-fenced heading must
// resolve to a route registration in apps/server/src/routes/legal.ts.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/api/legal.md');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/legal.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W324.A /api/legal ↔ route parity', () => {
  const page = read(PAGE);
  const route = read(ROUTE);

  const liveRoutes = new Set<string>();
  for (const m of route.matchAll(/['"`](\/v1\/legal\/[a-z0-9/_-]+)['"`]/g)) {
    liveRoutes.add(m[1]!);
  }

  it('captures at least 3 live legal routes', () => {
    expect(liveRoutes.size).toBeGreaterThanOrEqual(3);
  });

  it('covers GET /v1/legal/documents + /required + POST /v1/legal/accept', () => {
    expect(page).toContain('GET /v1/legal/documents');
    expect(page).toContain('GET /v1/legal/required');
    expect(page).toContain('POST /v1/legal/accept');
  });

  it('every cited /v1/legal/... endpoint resolves to a live registration', () => {
    const cited = [...page.matchAll(/`(?:[A-Z]+\s+)?(\/v1\/legal\/[a-z0-9/_-]+)/g)].map(
      (m) => m[1]!,
    );

    expect(cited.length).toBeGreaterThanOrEqual(3);

    const offenders: string[] = [];
    for (const p of cited) {
      if (!liveRoutes.has(p)) offenders.push(p);
    }
    expect(offenders).toEqual([]);
  });
});

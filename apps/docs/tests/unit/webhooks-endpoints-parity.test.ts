// W327.A — drift guard for /webhooks/endpoints page. Every /v1/webhooks
// path cited in a backtick-fenced heading must resolve to a route
// registration in apps/server/src/routes/webhooks.ts. The page also
// covers the per-endpoint delivery list (with cursor pagination).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/webhooks/endpoints.md');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/webhooks.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

function canonical(p: string): string {
  return p.replace(/:[a-zA-Z_][a-zA-Z_0-9]*/g, ':id').replace(/\/$/, '');
}

describe('W327.A /webhooks/endpoints ↔ webhooks route parity', () => {
  const page = read(PAGE);
  const route = read(ROUTE);

  const liveRoutes = new Set<string>();
  for (const m of route.matchAll(/['"`](\/v1\/webhooks[a-z0-9/:_-]*)['"`]/g)) {
    liveRoutes.add(canonical(m[1]!));
  }

  it('captures at least 5 live webhooks routes (sanity)', () => {
    expect(liveRoutes.size).toBeGreaterThanOrEqual(5);
  });

  it('every cited /v1/webhooks endpoint resolves to a live registration', () => {
    const cited = [...page.matchAll(/`(?:[A-Z]+\s+)?(\/v1\/webhooks(?:[a-z0-9/:_-]+)?)/g)]
      .map((m) => canonical(m[1]!))
      // Strip query strings.
      .map((p) => p.split('?')[0]!);

    expect(cited.length).toBeGreaterThanOrEqual(5);

    const offenders: string[] = [];
    for (const p of cited) {
      if (!liveRoutes.has(p)) offenders.push(p);
    }
    expect(offenders).toEqual([]);
  });

  it('covers CRUD + test + rotate-secret + deliveries-list', () => {
    expect(page).toContain('POST /v1/webhooks');
    expect(page).toContain('PATCH /v1/webhooks/:id');
    expect(page).toContain('DELETE /v1/webhooks/:id');
    expect(page).toContain('/v1/webhooks/:id/test');
    expect(page).toContain('/v1/webhooks/:id/rotate-secret');
    expect(page).toContain('/v1/webhooks/:id/deliveries');
  });
});

// W311.A — drift guard for /api/sessions endpoint citations. Every
// /v1/sessions* path mentioned in a code-block-ish heading must
// resolve to a route registration in apps/server/src/routes/sessions.ts
// (route param style normalised to `:id`).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/api/sessions.md');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/sessions.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

function canonical(p: string): string {
  return p.replace(/:[a-zA-Z_][a-zA-Z_0-9]*/g, ':id').replace(/\/$/, '');
}

describe('W311.A /api/sessions ↔ sessions route parity', () => {
  const page = read(PAGE);
  const route = read(ROUTE);

  const liveRoutes = new Set<string>();
  for (const m of route.matchAll(/['"`](\/v1\/sessions[a-z0-9/:_-]*)['"`]/g)) {
    liveRoutes.add(canonical(m[1]!));
  }

  it('captures multiple session routes (sanity)', () => {
    expect(liveRoutes.size).toBeGreaterThanOrEqual(5);
  });

  it('every backtick-wrapped /v1/sessions endpoint in the doc resolves to a live registration', () => {
    const cited = [...page.matchAll(/`(?:[A-Z]+\s+)?(\/v1\/sessions[a-z0-9/:_-]*)/g)]
      .map((m) => canonical(m[1]!))
      // The list endpoint cites a query-string variant — strip that.
      .map((p) => p.split('?')[0]!);

    const offenders: string[] = [];
    for (const p of cited) {
      if (!liveRoutes.has(p)) offenders.push(p);
    }
    expect(offenders).toEqual([]);
  });

  it('documents the real single-resource GET /v1/sessions/:id endpoint (2026-06-24)', () => {
    // Earlier this guard asserted GET /v1/sessions/:id was "fictional" and
    // forced the "Get one" section to redirect to /state — but the single-
    // resource detail endpoint IS registered (routes/sessions.ts:475, backs
    // SDK sessions.get()). The doc now documents it; /state stays the
    // separate "Get state" endpoint.
    expect(page).toMatch(/`GET \/v1\/sessions\/:id` — fetch a single session resource\./);
    // And it must resolve to a live route registration (not fictional).
    expect(liveRoutes.has('/v1/sessions/:id')).toBe(true);
  });
});

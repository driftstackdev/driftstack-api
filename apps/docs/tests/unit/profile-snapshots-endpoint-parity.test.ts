// W319.A — drift guard for /api/profile-snapshots endpoint citations.
// Every endpoint cited in a backtick-fenced heading must resolve to
// a registration in apps/server/src/routes/profile-snapshots.ts.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/api/profile-snapshots.md');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/profile-snapshots.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

function canonical(p: string): string {
  return p.replace(/:[a-zA-Z_][a-zA-Z_0-9]*/g, ':id').replace(/\/$/, '');
}

describe('W319.A /api/profile-snapshots ↔ route parity', () => {
  const page = read(PAGE);
  const route = read(ROUTE);

  const liveRoutes = new Set<string>();
  for (const m of route.matchAll(
    /['"`](\/v1\/(?:profile-snapshots|profiles\/[a-z:_-]+\/snapshots)[a-z0-9/:_-]*)['"`]/g,
  )) {
    liveRoutes.add(canonical(m[1]!));
  }

  it('captures at least 4 live snapshot routes', () => {
    expect(liveRoutes.size).toBeGreaterThanOrEqual(4);
  });

  it('every cited endpoint resolves to a live registration', () => {
    const cited = [
      ...page.matchAll(
        /`(?:[A-Z]+\s+)?(\/v1\/(?:profile-snapshots|profiles\/[a-z:_-]+\/snapshots)[a-z0-9/:_-]*)/g,
      ),
    ].map((m) => canonical(m[1]!));

    expect(cited.length).toBeGreaterThanOrEqual(5);

    const offenders: string[] = [];
    for (const p of cited) {
      if (!liveRoutes.has(p)) offenders.push(p);
    }
    expect(offenders).toEqual([]);
  });

  it('covers capture (per-profile POST) + list + restore + delete', () => {
    expect(page).toContain('POST /v1/profiles/:id/snapshots');
    expect(page).toContain('GET /v1/profile-snapshots');
    expect(page).toContain('/restore');
    expect(page).toContain('DELETE /v1/profile-snapshots/:id');
  });

  it('mentions the psnap_ id prefix (canonical snapshot id format)', () => {
    expect(page).toMatch(/psnap_[a-z0-9-]+|psnap_<uuid>/);
  });
});

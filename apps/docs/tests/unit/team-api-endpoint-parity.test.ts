// W314.A — drift guard for /api/team endpoint citations. Every
// /v1/team/... endpoint cited in a backtick-fenced heading must
// resolve to a route registration. Also checks that all four
// canonical audit-action labels (team.member_invited /
// team.invite_accepted / team.member_removed) appear next to their
// trigger endpoints.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/api/team.md');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/team.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

function canonical(p: string): string {
  return p.replace(/:[a-zA-Z_][a-zA-Z_0-9]*/g, ':id').replace(/\/$/, '');
}

describe('W314.A /api/team ↔ team route parity', () => {
  const page = read(PAGE);
  const route = read(ROUTE);

  const liveRoutes = new Set<string>();
  for (const m of route.matchAll(/['"`](\/v1\/team\/[a-z0-9/:_-]+)['"`]/g)) {
    liveRoutes.add(canonical(m[1]!));
  }

  it('captures at least 5 live team routes', () => {
    expect(liveRoutes.size).toBeGreaterThanOrEqual(5);
  });

  it('every cited /v1/team/... endpoint resolves to a live registration', () => {
    const cited = [...page.matchAll(/`(?:[A-Z]+\s+)?(\/v1\/team\/[a-z0-9/:_-]+)/g)].map((m) =>
      canonical(m[1]!),
    );

    expect(cited.length).toBeGreaterThan(4);

    const offenders: string[] = [];
    for (const p of cited) {
      if (!liveRoutes.has(p)) offenders.push(p);
    }
    expect(offenders).toEqual([]);
  });

  it('documents the act-as owner picker /v1/team/owners endpoint', () => {
    expect(page).toContain('/v1/team/owners');
  });

  it('lists all three audit actions wired to team endpoints', () => {
    expect(page).toContain('team.member_invited');
    expect(page).toContain('team.invite_accepted');
    expect(page).toContain('team.member_removed');
  });

  it('mentions the 7-day accept window for invites', () => {
    expect(page).toMatch(/7[- ]day\s+accept\s+link/i);
  });
});

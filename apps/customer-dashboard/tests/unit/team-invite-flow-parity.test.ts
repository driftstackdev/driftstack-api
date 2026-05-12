// W311.C — drift guard for /team page invite flow. The page hits:
//   POST   /v1/team/invites
//   GET    /v1/team/invites
//   GET    /v1/team/members
//   DELETE /v1/team/members/:id
// All must be registered server-side. The page also promises a
// 7-day invite accept window, which must match
// TEAM_INVITE_TTL_MS in apps/server/src/services/team-members.ts.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/team.astro');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/team.ts');
const SVC = resolve(REPO_ROOT, 'apps/server/src/services/team-members.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W311.C /team invite-flow ↔ server parity', () => {
  const page = read(PAGE);
  const route = read(ROUTE);
  const svc = read(SVC);

  it('page calls /v1/team/invites', () => {
    expect(page).toContain('/v1/team/invites');
  });

  it('page calls /v1/team/members', () => {
    expect(page).toContain('/v1/team/members');
  });

  it('server registers /v1/team/invites (POST + GET)', () => {
    expect(route).toMatch(/'\/v1\/team\/invites'/);
  });

  it('server registers /v1/team/members (GET) + /v1/team/members/:id (DELETE)', () => {
    expect(route).toMatch(/'\/v1\/team\/members'/);
    expect(route).toMatch(/'\/v1\/team\/members\/:id'/);
  });

  it('page promises a 7-day accept link', () => {
    expect(page).toMatch(/7[- ]day\s+accept\s+link/i);
  });

  it('server invite TTL is 7 * 24 * 60 * 60 * 1000 ms (matches 7-day claim)', () => {
    expect(svc).toMatch(/TEAM_INVITE_TTL_MS\s*=\s*7\s*\*\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/);
  });

  it('page references the X-Driftstack-Account act-as header (team-RBAC)', () => {
    expect(page).toContain('X-Driftstack-Account');
  });
});

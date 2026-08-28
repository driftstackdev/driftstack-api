// W315.A — drift guard for /api/account endpoint citations. Every
// /v1/account/... path cited in a backtick-fenced heading must
// resolve to a route registration in apps/server/src/routes/account-*.ts.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/api/account.md');
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

function canonical(p: string): string {
  return p.replace(/:[a-zA-Z_][a-zA-Z_0-9]*/g, ':id').replace(/\/$/, '');
}

describe('W315.A /api/account ↔ route parity', () => {
  const page = read(PAGE);
  const allRouteBodies = walk(ROUTES)
    .filter((f) => /\.ts$/.test(f))
    .map(read)
    .join('\n');

  const liveAccountRoutes = new Set<string>();
  for (const m of allRouteBodies.matchAll(/['"`](\/v1\/account[a-z0-9/:_-]*)['"`]/g)) {
    liveAccountRoutes.add(canonical(m[1]!));
  }

  it('captures at least 6 live account routes', () => {
    expect(liveAccountRoutes.size).toBeGreaterThanOrEqual(6);
  });

  it('every cited /v1/account/... endpoint in the doc resolves to a live registration', () => {
    const cited = [...page.matchAll(/`(?:[A-Z]+\s+)?(\/v1\/account[a-z0-9/:_-]+)/g)].map((m) =>
      canonical(m[1]!),
    );

    expect(cited.length).toBeGreaterThan(3);

    const offenders: string[] = [];
    for (const p of cited) {
      if (!liveAccountRoutes.has(p)) offenders.push(p);
    }
    expect(offenders).toEqual([]);
  });

  it('covers GET/PATCH /v1/account/me (the self-edit surface)', () => {
    expect(page).toContain('GET /v1/account/me');
    expect(page).toContain('PATCH /v1/account/me');
  });

  it('covers avatar upload + clear endpoints', () => {
    expect(page).toContain('/v1/account/me/avatar');
  });
});

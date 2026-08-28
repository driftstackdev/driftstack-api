// W316.A — drift guard for /api/billing endpoint citations. Every
// /v1/billing/... path cited in a backtick-fenced heading must
// resolve to a route registration in apps/server/src/routes/billing*.ts.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/api/billing.md');
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

describe('W316.A /api/billing ↔ billing route parity', () => {
  const page = read(PAGE);
  const allRouteBodies = walk(ROUTES)
    .filter((f) => /billing.*\.ts$/.test(f))
    .map(read)
    .join('\n');

  const liveBillingRoutes = new Set<string>();
  for (const m of allRouteBodies.matchAll(/['"`](\/v1\/billing[a-z0-9/:_.-]*)['"`]/g)) {
    liveBillingRoutes.add(canonical(m[1]!));
  }

  it('captures at least 4 live billing routes', () => {
    expect(liveBillingRoutes.size).toBeGreaterThanOrEqual(4);
  });

  it('every cited /v1/billing/... endpoint in the doc resolves to a live registration', () => {
    const cited = [...page.matchAll(/`(?:[A-Z]+\s+)?(\/v1\/billing[a-z0-9/:_-]*)/g)].map((m) =>
      canonical(m[1]!),
    );

    expect(cited.length).toBeGreaterThan(3);

    const offenders: string[] = [];
    for (const p of cited) {
      if (!liveBillingRoutes.has(p)) offenders.push(p);
    }
    expect(offenders).toEqual([]);
  });

  it('covers GET /v1/billing (billing state)', () => {
    expect(page).toContain('GET /v1/billing');
  });

  it('covers checkout-session + portal-session (trial-pack retired 2026-05-27)', () => {
    expect(page).toContain('/v1/billing/checkout-session');
    expect(page).toContain('/v1/billing/portal-session');
    expect(page).not.toContain('/v1/billing/trial-pack');
  });
});

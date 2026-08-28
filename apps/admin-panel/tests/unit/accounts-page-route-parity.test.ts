// W315.C — drift guard for admin accounts pages (list +
// per-account detail). Both pages cite a slew of /v1/admin/accounts
// endpoints. Every cited endpoint must be registered on the server.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIST = resolve(REPO_ROOT, 'apps/admin-panel/src/pages/accounts.astro');
const DETAIL = resolve(REPO_ROOT, 'apps/admin-panel/src/pages/shells/account-detail.astro');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/admin-accounts.ts');

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

describe('W315.C admin /accounts ↔ admin-accounts route parity', () => {
  const list = read(LIST);
  const detail = read(DETAIL);
  const route = read(ROUTE);

  const liveRoutes = new Set<string>();
  for (const m of route.matchAll(/['"`](\/v1\/admin\/accounts[a-z0-9/:_-]*)['"`]/g)) {
    liveRoutes.add(canonical(m[1]!));
  }

  it('captures at least 8 admin-accounts routes (sanity)', () => {
    expect(liveRoutes.size).toBeGreaterThanOrEqual(8);
  });

  it('every cited /v1/admin/accounts endpoint in detail page resolves to a live registration', () => {
    // The detail page uses template-literal concatenation, so we
    // capture both string-literal forms and concatenation prefixes.
    const cited = [...detail.matchAll(/['"`](\/v1\/admin\/accounts(?:[a-z0-9/:_-]+)?)['"`]/g)]
      .map((m) => m[1]!)
      // Tail off the suffix that comes from concatenation prefixes
      // (e.g. `/v1/admin/accounts/` immediately followed by `+ id`).
      .map((p) => canonical(p.replace(/\/$/, '/:id')))
      // The bare base used as a prefix matches the list endpoint.
      .map((p) => (p === '/v1/admin/accounts/:id' ? p : p));

    const offenders: string[] = [];
    for (const p of cited) {
      const tryPaths = [p, p.replace(/\/:id$/, '')];
      if (!tryPaths.some((tp) => liveRoutes.has(tp))) {
        offenders.push(p);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('list page hits /v1/admin/accounts', () => {
    expect(list).toContain('/v1/admin/accounts');
  });

  it('detail page references the canonical sub-endpoints (tier / suspend / unsuspend / quota-override / audit-note / refund-record)', () => {
    // The detail page assembles paths via string concatenation:
    //   `/v1/admin/accounts/` + id + `/tier`
    // So each suffix appears as `/tier`, `/suspend`, etc. on the
    // tail of a string-literal next to `/v1/admin/accounts/`.
    expect(detail).toContain('/v1/admin/accounts/');
    expect(detail).toMatch(/['"]\/tier['"]/);
    expect(detail).toMatch(/['"]\/suspend['"]/);
    expect(detail).toMatch(/['"]\/unsuspend['"]/);
    expect(detail).toMatch(/['"]\/quota-override['"]/);
    expect(detail).toMatch(/['"]\/audit-note['"]/);
    expect(detail).toMatch(/['"]\/refund-record['"]/);
  });
});

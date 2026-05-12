// W222.A — drift-guard between /docs/admin-api and the actual
// admin-crypto-orders route registrations. Every endpoint in the
// doc must be a registered route, and the doc must keep up as
// new admin endpoints land (otherwise customers reviewing the
// admin-scope blast radius see a stale picture).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = join(__dirname, '..', '..', '..', '..');
const DOC_PATH = join(REPO, 'apps', 'marketing-site', 'src', 'pages', 'docs', 'admin-api.astro');
const ADMIN_ROUTE_PATH = join(REPO, 'apps', 'server', 'src', 'routes', 'admin-crypto-orders.ts');

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('W222.A admin-api doc parity', () => {
  const doc = read(DOC_PATH);
  const routes = read(ADMIN_ROUTE_PATH);

  it('every /v1/admin/crypto-orders endpoint shown in the doc is registered', () => {
    // Pull `<code>METHOD /v1/admin/...</code>` mentions from the doc.
    const docPaths = Array.from(
      doc.matchAll(/<code>(GET|POST|PATCH|DELETE)\s+(\/v1\/admin\/crypto-orders[^<?]*)/g),
    ).map((m) => m[2]!);
    expect(docPaths.length).toBeGreaterThan(0);
    const normalise = (p: string) => p.replace(/:[A-Za-z_]+/g, ':*');
    const normalisedRoutes = normalise(routes);
    for (const p of docPaths) {
      const np = normalise(p);
      const ok = normalisedRoutes.includes(`'${np}'`) || normalisedRoutes.includes(`"${np}"`);
      expect(ok, `${p} not registered in admin-crypto-orders.ts`).toBe(true);
    }
  });

  it('every registered /v1/admin/crypto-orders endpoint is mentioned in the doc', () => {
    const registered = Array.from(routes.matchAll(/'(\/v1\/admin\/crypto-orders[^']*)'/g)).map(
      (m) => m[1]!,
    );
    expect(registered.length).toBeGreaterThan(0);
    const normalise = (p: string) => p.replace(/:[A-Za-z_]+/g, ':*');
    const normalisedDoc = normalise(doc);
    for (const r of registered) {
      const nr = normalise(r);
      expect(normalisedDoc, `${r} missing from /docs/admin-api`).toContain(nr);
    }
  });
});

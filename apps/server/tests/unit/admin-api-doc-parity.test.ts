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

/**
 * Paths this route file REGISTERS, param names erased.
 *
 * Anchored on `app.<verb>(`, allowing a type argument and a path on the next
 * line — the forms the routes use. A quoted literal on its own may be a comment,
 * an error message or a policy row.
 */
function registeredPaths(blob: string): Set<string> {
  const out = new Set<string>();
  for (const m of blob.matchAll(
    /app\.(?:get|post|put|patch|delete)\s*(?:<[^(]*>)?\s*\(\s*['"`](\/v1\/[^'"`]*)['"`]/g,
  )) {
    out.add((m[1] ?? '').replace(/:[A-Za-z_]+/g, ':*').replace(/\/+$/, ''));
  }
  return out;
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
    // V-989 — a quoted literal is not a registration. Same correction as the
    // three SDK path guards (V-987/V-988): the message below says "not
    // registered", so the check should be one. Within this file every quoted
    // literal happens to be a registration today (11 of 11, measured), which is
    // why the looseness was invisible rather than why it was safe.
    const registeredHere = registeredPaths(routes);
    for (const p of docPaths) {
      const np = normalise(p.replace(/\/+$/, ''));
      expect(
        registeredHere.has(np),
        `${p} is not registered in admin-crypto-orders.ts — a path named only in a comment or an error message is not an endpoint`,
      ).toBe(true);
    }
  });

  it('every registered /v1/admin/crypto-orders endpoint is mentioned in the doc', () => {
    const registered = [...registeredPaths(routes)].filter((p) =>
      p.startsWith('/v1/admin/crypto-orders'),
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

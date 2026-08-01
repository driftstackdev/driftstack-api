// Every path-parameterised route either documents 404 or says why it cannot.
//
// The OpenAPI spec drives codegen — `packages/sdk-python/openapi.json` encodes
// each operation's response status set — so a status a route returns but the
// spec omits is a status a customer's generated client never models. Seven
// routes were in that state, three of them customer-facing proxy endpoints
// whose own source comment already said "404 for an unknown/foreign id".
//
// A blanket "every `/{id}` route must document 404" would be wrong in the other
// direction, and that is not hypothetical: five routes here legitimately never
// 404, and telling an SDK to model a branch that cannot occur is its own defect.
// So the rule is: document it, or be listed with a reason that was checked.
//
// Every exemption below was verified at the source, not inferred from the path:
// each names the file and the behaviour that makes 404 unreachable. An entry
// that cannot be justified that way does not belong here — an allowlist whose
// entries nobody re-checked is how a guard turns into decoration.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SPEC = resolve(HERE, '..', '..', 'src', 'lib', 'openapi.ts');

/**
 * Routes that CANNOT return 404, with the reason each was cleared.
 *
 * Keyed `METHOD path`. Verified individually; the reason is the point of the
 * entry, because it is what a reviewer checks when the handler changes.
 */
const NO_404_BY_DESIGN: ReadonlyMap<string, string> = new Map([
  [
    'DELETE /v1/profiles/{id}',
    'idempotent delete — profiles service does `if (!ok) return`, so a missing profile is a 204',
  ],
  [
    'POST /v1/admin/oauth/clients/{id}/rotate-secret',
    'unknown client throws OAuthError(invalid_client), which oauthErrorToHttp maps to 401 — not 404',
  ],
  [
    'PUT /v1/admin/owner/secrets/{name}',
    'upsert — an absent name is created, so there is nothing to miss',
  ],
  [
    'PATCH /v1/admin/owner/pricing/{tier}',
    'tier is enum-validated in the params schema, so an unknown tier is a 400',
  ],
  [
    'POST /v1/admin/validation-schedules/{archetype}/trigger',
    'harness.triggerNow accepts any archetype id and enqueues; it never looks one up',
  ],
]);

/** Status codes carried by each `...spread` constant in the spec. */
function spreadCodes(spec: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const m of spec.matchAll(/const (\w+) = \{([\s\S]{0,1200}?)\n {2}\};/g)) {
    const codes = new Set([...m[2]!.matchAll(/\n\s*(\d{3}):/g)].map((c) => c[1]!));
    if (codes.size > 0) out.set(m[1]!, codes);
  }
  return out;
}

interface Route {
  readonly key: string;
  readonly codes: ReadonlySet<string>;
}

/**
 * Every registered route with its documented status codes, spreads resolved.
 *
 * Resolving spreads is not optional: `directSessionOperationErrors` alone
 * carries 404/409/410/502/503, and a scan that only reads literal numbers
 * reported eight session routes as missing a 404 they document perfectly well.
 */
function routes(): Route[] {
  const spec = readFileSync(SPEC, 'utf8');
  const spreads = spreadCodes(spec);
  const out: Route[] = [];
  for (const block of spec.split('registerRoute(r, {').slice(1)) {
    const path = /path: '([^']+)'/.exec(block);
    const method = /method: '(\w+)'/.exec(block);
    if (path === null || method === null) continue;
    const start = block.indexOf('responses:');
    const body = start >= 0 ? block.slice(start, start + 1400) : '';
    const codes = new Set([...body.matchAll(/\n\s*(\d{3}):/g)].map((c) => c[1]!));
    for (const s of body.matchAll(/\.\.\.(\w+)/g)) {
      for (const c of spreads.get(s[1]!) ?? []) codes.add(c);
    }
    out.push({ key: `${method[1]!.toUpperCase()} ${path[1]!}`, codes });
  }
  return out;
}

describe('path-parameterised routes document 404 or are exempt with a reason', () => {
  it('CRITICAL the spec parsed into real routes with real codes. An empty parse would make the check below vacuously true, and the failure it guards is an omission — so a broken parse would hide the same shape twice.', () => {
    const all = routes();
    expect(all.length, 'routes parsed from the spec').toBeGreaterThan(200);
    expect(
      all.filter((r) => r.codes.size > 0).length,
      'routes with documented status codes',
    ).toBeGreaterThan(200);
  });

  it('CRITICAL spreads are resolved, so a route documenting 404 via `...directSessionOperationErrors` is not reported as missing it. Without this the guard produces false findings and gets ignored, which is worse than not existing.', () => {
    const nav = routes().find((r) => r.key === 'POST /v1/sessions/{id}/navigate');
    expect(nav, 'the session navigate route is in the spec').toBeDefined();
    expect(nav!.codes, 'its 404 comes from a spread, not a literal').toContain('404');
  });

  it('CRITICAL every parameterised route documents 404 or is exempt. A status the route returns but the spec omits is one a generated SDK never models — that is how three customer-facing proxy endpoints shipped a 404 no client handled.', () => {
    const missing = routes()
      .filter((r) => r.key.includes('{'))
      .filter((r) => !r.codes.has('404'))
      .filter((r) => !NO_404_BY_DESIGN.has(r.key))
      .map((r) => r.key)
      .sort();
    expect(
      missing,
      'parameterised route(s) with no documented 404 — document it, or add an exemption with the reason it cannot 404:',
    ).toEqual([]);
  });

  it('CRITICAL the exemption list may only SHRINK. An entry for a route that no longer exists, or that has since gained a 404, stops meaning "checked" and starts meaning "ignored" — which is exactly how the stale dashboard-only list in this repo began misleading people.', () => {
    const byKey = new Map(routes().map((r) => [r.key, r]));
    const stale: string[] = [];
    for (const key of NO_404_BY_DESIGN.keys()) {
      const route = byKey.get(key);
      if (route === undefined) stale.push(`${key} — no longer in the spec`);
      else if (route.codes.has('404'))
        stale.push(`${key} — now documents 404, remove the exemption`);
    }
    expect(stale.sort(), 'exemption(s) that no longer describe reality:').toEqual([]);
  });
});

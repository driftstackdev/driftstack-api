// V-1369 — a `Querystring` generic is a claim about the request, not a check on it.
//
// `app.get<{ Querystring: { active_only?: string } }>` tells TypeScript the parameter is a
// `string | undefined`. Nothing enforces that. A repeated query key parses to an ARRAY, so
// the real type is `string | string[] | undefined` on every one of these routes, and the
// handler is written against the declared shape.
//
// Two defects came out of that in one sweep, and they failed in opposite directions:
//
//   V-1367  `?active_only=true&active_only=true` — the array is not equal to 'true', so the
//           filter silently did not apply and the read returned the revoked links the caller
//           asked to hide. A 200 with the wrong answer.
//   V-1368  `?keep=current&keep=current` — `.toLowerCase()` is not a method on an array, so
//           the bulk sign-out confirmation threw a TypeError and answered 500 where it means
//           400.
//
// Both are now fixed and behaviourally covered. This guard is for the NEXT one: it discovers
// every route declaring a `Querystring` generic from source and requires each to validate the
// querystring at the read site, or to be listed below with the reason it does not.
//
// The population is DISCOVERED rather than listed, so adding a route without a schema fails
// here rather than waiting for someone to send the parameter twice.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { codeOnly } from './_helpers/code-only.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTES_DIR = resolve(HERE, '..', '..', 'src', 'routes');

/**
 * Validation rooted in the querystring itself. A bare `typeof x === 'string'` somewhere in a
 * long handler is NOT accepted: the first pass of this sweep counted exactly that and
 * cleared two routes that validate somewhere else entirely.
 */
const VALIDATES_QUERY =
  /safeParse\(\s*(?:req|request)\.query|parseOrThrow\(\s*\w+,\s*(?:req|request)\.query|typeof\s+(?:req|request)\.query\.\w+\s*===\s*'string'/;

/**
 * Routes that do not validate at the read site, each with the reason. Keyed by file plus the
 * declared generic, so changing a route's shape re-opens its exemption rather than carrying
 * it silently.
 */
const EXCEPTIONS = new Map<string, string>([
  [
    'account-notifications.ts::{ Querystring: { ds_token?: string } }',
    'SSE. `ds_token` is consumed by the requireAuthEventSource preHandler, which narrows with ' +
      "typeof query.ds_token === 'string' and 401s otherwise. The handler never reads the query.",
  ],
  [
    'agent-sessions.ts::{ Params: { id: string }; Querystring: { ds_token?: string } }',
    'SSE transcript stream, same requireAuthEventSource preHandler as the notifications stream.',
  ],
  [
    'auth-oauth-client.ts::{ Querystring: Record<string, string> }',
    "Forwards the IDP's query string verbatim to the dashboard. It iterates Object.entries and " +
      "appends only `typeof v === 'string'` values, so a repeated key is dropped rather than " +
      'mishandled, and the SPA exchange route then refuses the incomplete callback.',
  ],
]);

interface QuerystringRoute {
  file: string;
  line: number;
  generic: string;
  validates: boolean;
}

function discover(): QuerystringRoute[] {
  const found: QuerystringRoute[] = [];
  for (const file of readdirSync(ROUTES_DIR)
    .filter((f) => f.endsWith('.ts'))
    .sort()) {
    const code = codeOnly(readFileSync(join(ROUTES_DIR, file), 'utf8'));
    const decl = /app\.(?:get|post|put|patch|delete)</g;
    let m: RegExpExecArray | null;
    while ((m = decl.exec(code)) !== null) {
      const after = code.slice(m.index + m[0].length);
      const generic = after.slice(0, after.indexOf('>('));
      if (generic.length === 0 || generic.length > 400 || !generic.includes('Querystring')) {
        continue;
      }
      found.push({
        file,
        line: code.slice(0, m.index).split('\n').length,
        generic: generic.replace(/\s+/g, ' ').trim(),
        validates: VALIDATES_QUERY.test(after.slice(0, 6000)),
      });
    }
  }
  return found;
}

const ROUTES = discover();

describe('every route declaring a Querystring generic validates it', () => {
  it('CRITICAL the sweep found a real population AND its detector can tell the two apart. A discovery regex that silently matched nothing would satisfy the rule below vacuously, and one that matched everything would satisfy it just as well — so both the count and the classifier are floored.', () => {
    expect(
      ROUTES.length,
      'no routes discovered — the declaration regex stopped matching',
    ).toBeGreaterThanOrEqual(16);
    expect(
      ROUTES.filter((r) => r.validates).length,
      'nothing classified as validated — the detector regex stopped matching',
    ).toBeGreaterThanOrEqual(13);

    // Known positive and known negative, fed to the same classifier the rule uses.
    expect(
      VALIDATES_QUERY.test('const q = ListQuerySchema.safeParse(req.query); if (!q.success)'),
      'the classifier no longer recognises a safeParse of the query',
    ).toBe(true);
    expect(
      VALIDATES_QUERY.test("const keep = (request.query?.keep ?? '').toLowerCase();"),
      'the classifier accepts a raw query read — it would have cleared both V-1367 and V-1368',
    ).toBe(false);

    // A route that only MENTIONS the parse in prose must not read as validated. Asserted
    // here rather than left to the discovery pass: with every route currently either
    // validating or excepted, nothing in the population exercises the comment handling, so
    // dropping codeOnly above would go unnoticed until the first unvalidated route landed
    // — which is exactly when this guard is supposed to speak.
    expect(
      VALIDATES_QUERY.test(codeOnly('// const q = Schema.safeParse(req.query);\nconst x = 1;')),
      'a parse mentioned in a comment reads as validation',
    ).toBe(false);
  });

  it('CRITICAL every discovered route either validates the querystring where it reads it, or is listed as an exception with the reason. A route added with a Querystring generic and no schema is the shape of both defects this guard was written for: one answered 200 with the wrong data, the other answered 500.', () => {
    const unaccounted = ROUTES.filter(
      (r) => !r.validates && !EXCEPTIONS.has(`${r.file}::${r.generic}`),
    ).map((r) => `${r.file}:${String(r.line)} ${r.generic}`);

    expect(
      unaccounted,
      'a Querystring generic is a claim, not a check — validate req.query at the read site, ' +
        'or add an entry to EXCEPTIONS saying what does',
    ).toEqual([]);
  });

  it('CRITICAL no exception outlives the route it excuses. An entry that stops matching any discovered route is a stale exemption, and the next route to land in that file inherits an excuse written for something else.', () => {
    const keys = new Set(ROUTES.map((r) => `${r.file}::${r.generic}`));
    const stale = [...EXCEPTIONS.keys()].filter((k) => !keys.has(k));
    expect(stale, 'these exceptions no longer describe any route').toEqual([]);
  });

  it('CRITICAL the two routes this sweep repaired are on the validated side, so the guard cannot be satisfied by exempting them back', () => {
    const byUrl = (file: string): QuerystringRoute[] => ROUTES.filter((r) => r.file === file);
    for (const file of ['account-oauth-links.ts', 'account-web-sessions.ts']) {
      const routes = byUrl(file);
      expect(routes.length, `${file} declares a Querystring route`).toBeGreaterThan(0);
      for (const route of routes) {
        expect(route.validates, `${file}:${String(route.line)} must validate its querystring`).toBe(
          true,
        );
        expect(
          EXCEPTIONS.has(`${route.file}::${route.generic}`),
          `${file} must not be exempted — it was fixed, not excused`,
        ).toBe(false);
      }
    }
  });
});

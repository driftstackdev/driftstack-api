// Drift-guard: the hand-written OpenAPI spec (apps/server/src/lib/openapi.ts)
// must advertise the SAME `limit` query max as the route schema actually
// enforces, for every admin list endpoint.
//
// Why this guard exists: the spec is hand-maintained separately from the
// route Zod schemas. /v1/admin/accounts drifted — the spec advertised
// `limit` max 200 while the route enforced 100, so an integrator trusting
// the published spec who sent limit=150 got an unexpected 400. No test
// pinned the spec-max ↔ route-max relationship, so the drift was silent.
// This asserts the equality invariant directly (extracts both sides, no
// hardcoded expected value) so any future divergence on either side fails.
//
// V-1323 — the imperative blind spot V-1110 named is now covered, so the note
// describing it as out of scope no longer applies.
//
// The Zod extractor above reads a declared `limit … max(N)`. Three endpoints
// declare no bound at all: they take `limit` as a digit-string and refuse
// out-of-range values in code, which the Zod reader cannot see. The yield was
// measured before the work was done — all three agree with the spec today — so
// this closes a gap rather than fixing a live defect, and the second describe
// below keeps them agreeing.
//
// Those three carry their ceiling TWICE: once in the comparison and once in the
// message the caller reads back. That second copy is checked here too, because
// a route refusing at 200 while telling the integrator the limit is 500 is the
// same defect as the spec drifting — the caller is misinformed either way, and
// the message is the part they actually see.
//
// One of the three is `/v1/billing/crypto-orders`, a CUSTOMER path. The Zod
// half of this file is scoped to `/v1/admin` by its completeness arm, so that
// endpoint would have stayed outside this guard even after the extractor
// learned imperative bounds.
//
// The spec declares the query two ways: inline inside the registerRoute
// block (anchor = the path string) or via a named `*QueryOpenApi` const
// above it (anchor = the const name). Each admin list route file carries
// exactly one `limit: z.coerce...max(N)` field, so extracting the single
// match is unambiguous.

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..', '..');
const SPEC = readFileSync(resolve(REPO, 'apps/server/src/lib/openapi.ts'), 'utf8');

function read(rel: string): string {
  return readFileSync(resolve(REPO, rel), 'utf8');
}

/** The single `limit ... max(N)` the route Zod schema enforces. */
function routeLimitMax(routeFile: string): number | null {
  const src = read(`apps/server/src/routes/${routeFile}`);
  const m = src.match(/limit: z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.max\((\d+)\)/);
  const g = m?.[1];
  return g !== undefined ? Number(g) : null;
}

/**
 * The `limit ... max(N)` the spec advertises. `anchor` is either a route
 * path (inline query) or a `*QueryOpenApi` const name; in both cases we
 * slice the enclosing block and read the single limit max inside it.
 */
function specLimitMax(anchor: string): number | null {
  const startToken = anchor.startsWith('/v1/')
    ? `path: '${anchor}'`
    : `const ${anchor} = z.object({`;
  const start = SPEC.indexOf(startToken);
  if (start < 0) return null;
  const rest = SPEC.slice(start);
  // Inline path blocks terminate at the next registerRoute(); named const
  // blocks terminate at their first `});`.
  const endTok = anchor.startsWith('/v1/') ? 'registerRoute(' : '});';
  const endIdx = rest.indexOf(endTok, 1);
  const block = endIdx > 0 ? rest.slice(0, endIdx) : rest;
  // Tolerant of the chained multi-line form prettier produces once the
  // declaration grows a `.describe(...)`: `/v1/billing/crypto-orders` writes
  // `limit: z.coerce\n.number()\n…\n.max(100)`, which a single-line pattern
  // reads as absent — and "absent" is indistinguishable from "no bound" unless
  // the caller asserts non-null, which every arm below does.
  const m = block.match(/limit:\s*z\.[\s\S]{0,200}?\.max\((\d+)\)/);
  const g = m?.[1];
  return g !== undefined ? Number(g) : null;
}

// endpoint → { route file, spec anchor (path for inline, const for named) }
const ADMIN_LIST_ENDPOINTS: ReadonlyArray<{
  label: string;
  routeFile: string;
  specAnchor: string;
}> = [
  { label: '/v1/admin/accounts', routeFile: 'admin-accounts.ts', specAnchor: '/v1/admin/accounts' },
  {
    label: '/v1/admin/api-keys',
    routeFile: 'admin-api-keys.ts',
    specAnchor: 'ListAdminApiKeysQueryOpenApi',
  },
  {
    label: '/v1/admin/rate-limit-overrides',
    routeFile: 'admin-rate-limit-overrides.ts',
    specAnchor: 'ListAdminOverridesQueryOpenApi',
  },
  {
    label: '/v1/admin/sessions',
    routeFile: 'admin-sessions.ts',
    specAnchor: 'ListAdminSessionsQueryOpenApi',
  },
  {
    label: '/v1/admin/status-subscribers',
    routeFile: 'admin-status-subscribers.ts',
    specAnchor: '/v1/admin/status-subscribers',
  },
  // V-1110 — published as an admin list endpoint (`GET /v1/admin/atlas-priority/queue`)
  // and enforcing its own `limit … max(1000)`, but never compared. Its route file is
  // named `internal-atlas-priority.ts` because it also serves the `/v1/internal/…`
  // twin, so a roster keyed on the `admin-` filename prefix never reached it.
  {
    label: '/v1/admin/atlas-priority/queue',
    routeFile: 'internal-atlas-priority.ts',
    specAnchor: 'AtlasPriorityQueueQueryOpenApi',
  },
];

/**
 * The bound an endpoint enforces IN CODE, plus the bound its refusal message
 * states. Sliced from the quoted route path to the next handler registration,
 * because one file can register several bounded lists — `admin-crypto-orders.ts`
 * carries both the 200-row list and the 1000-row CSV export, and a file-wide
 * match would read whichever came first for both.
 */
function routeImperativeLimit(
  routeFile: string,
  pathToken: string,
): { enforced: number; stated: number } | null {
  const src = read(`apps/server/src/routes/${routeFile}`);
  const i = src.indexOf(pathToken);
  if (i < 0) return null;
  const rest = src.slice(i + pathToken.length);
  const ends = [rest.indexOf('app.get'), rest.indexOf('app.post')].filter((n) => n > 0);
  const block = ends.length > 0 ? rest.slice(0, Math.min(...ends)) : rest;
  const enforced = block.match(/n > (\d+)\)/);
  const stated = block.match(/between 1 and (\d+)\./);
  if (!enforced?.[1] || !stated?.[1]) return null;
  return { enforced: Number(enforced[1]), stated: Number(stated[1]) };
}

/** Endpoints whose limit bound is enforced in code rather than declared in Zod. */
const IMPERATIVE_LIMIT_ENDPOINTS: ReadonlyArray<{
  label: string;
  routeFile: string;
  pathToken: string;
  specAnchor: string;
}> = [
  {
    label: '/v1/admin/crypto-orders',
    routeFile: 'admin-crypto-orders.ts',
    pathToken: "'/v1/admin/crypto-orders',",
    specAnchor: '/v1/admin/crypto-orders',
  },
  {
    label: '/v1/admin/crypto-orders.csv',
    routeFile: 'admin-crypto-orders.ts',
    pathToken: "'/v1/admin/crypto-orders.csv',",
    specAnchor: '/v1/admin/crypto-orders.csv',
  },
  {
    label: '/v1/billing/crypto-orders',
    routeFile: 'billing-crypto-orders.ts',
    pathToken: "'/v1/billing/crypto-orders',",
    specAnchor: '/v1/billing/crypto-orders',
  },
];

describe('OpenAPI spec ↔ route `limit` max parity (admin list endpoints)', () => {
  for (const ep of ADMIN_LIST_ENDPOINTS) {
    it(`${ep.label}: spec-advertised limit max === route-enforced limit max`, () => {
      const routeMax = routeLimitMax(ep.routeFile);
      const specMax = specLimitMax(ep.specAnchor);
      expect(routeMax, `route limit max not found in ${ep.routeFile}`).not.toBeNull();
      expect(specMax, `spec limit max not found for ${ep.specAnchor}`).not.toBeNull();
      expect(
        specMax,
        `${ep.label}: spec advertises max ${specMax} but route enforces ${routeMax}`,
      ).toBe(routeMax);
    });
  }
  it('CRITICAL V-1110 every route that enforces a limit on a published /v1/admin path is in the table. The pairs this file compares are the pairs someone listed, so an endpoint left out is not reported as unchecked — its spec max and its route max simply never meet. That is the drift the file exists to catch: /v1/admin/accounts advertised 200 while the route enforced 100, and an integrator trusting the published spec got a 400.', () => {
    const routesDir = resolve(REPO, 'apps/server/src/routes');
    const LIMIT = /limit: z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.max\(\d+\)/;
    const enforcing = readdirSync(routesDir)
      .filter((f) => f.endsWith('.ts'))
      .filter((f) => {
        const src = readFileSync(resolve(routesDir, f), 'utf8');
        // `z.coerce` is the marker of a QUERY bound, not a body bound: query
        // values arrive as strings and must be coerced, while a JSON body
        // limit is a plain `z.number()`. Dropping that requirement matched
        // admin-crypto-orders.ts on its POST sweep-body limit (500) and would
        // have compared it against the list query's advertised 200.
        //
        // The file name is not the test either — internal-atlas-priority.ts
        // serves both an /v1/admin and an /v1/internal surface.
        return LIMIT.test(src) && /['"`]\/v1\/admin\//.test(src);
      })
      .sort();
    expect(
      enforcing.length,
      'route files enforcing a limit on an admin path',
    ).toBeGreaterThanOrEqual(6);

    const rostered = new Set(ADMIN_LIST_ENDPOINTS.map((e) => e.routeFile));
    expect(
      enforcing.filter((f) => !rostered.has(f)),
      'these route files enforce a limit on a published admin path but no row compares their ' +
        'enforced max against the advertised one:',
    ).toEqual([]);

    const stale = [...rostered].filter((f) => !enforcing.includes(f)).sort();
    expect(
      stale,
      'rows for route files that no longer enforce a limit on an admin path — the row compares ' +
        'nothing while making the coverage look wider:',
    ).toEqual([]);
  });
});

describe('OpenAPI spec ↔ route `limit` max parity (imperatively bounded endpoints)', () => {
  for (const ep of IMPERATIVE_LIMIT_ENDPOINTS) {
    it(`${ep.label}: spec-advertised limit max === the max the route enforces in code`, () => {
      const route = routeImperativeLimit(ep.routeFile, ep.pathToken);
      const specMax = specLimitMax(ep.specAnchor);
      expect(route, `no imperative limit bound found for ${ep.label}`).not.toBeNull();
      expect(specMax, `spec limit max not found for ${ep.specAnchor}`).not.toBeNull();
      expect(
        specMax,
        `${ep.label}: spec advertises max ${specMax} but the route refuses above ${route?.enforced}`,
      ).toBe(route?.enforced);
    });

    it(`${ep.label}: the refusal message states the bound the route actually applies`, () => {
      const route = routeImperativeLimit(ep.routeFile, ep.pathToken);
      expect(route, `no imperative limit bound found for ${ep.label}`).not.toBeNull();
      expect(
        route?.stated,
        `${ep.label}: refuses above ${route?.enforced} but tells the caller the limit is ` +
          `${route?.stated} — the message is the part an integrator reads`,
      ).toBe(route?.enforced);
    });
  }

  it('CRITICAL every imperatively bounded limit in the route layer is in the table. The pairs compared here are the pairs someone listed, so an endpoint left out is not reported as unchecked — its two numbers simply never meet. Counted from the refusal message, which is the one marker every such bound carries.', () => {
    const routesDir = resolve(REPO, 'apps/server/src/routes');
    const MARKER = /limit must be an integer between 1 and \d+\./g;
    let found = 0;
    const files: string[] = [];
    for (const f of readdirSync(routesDir).filter((n) => n.endsWith('.ts'))) {
      const n = (readFileSync(resolve(routesDir, f), 'utf8').match(MARKER) ?? []).length;
      if (n > 0) {
        found += n;
        files.push(`${f} (${n})`);
      }
    }
    expect(
      found,
      `imperative limit bounds in routes/: ${files.sort().join(', ')} — every one needs a row ` +
        'in IMPERATIVE_LIMIT_ENDPOINTS, or it is enforced with nothing comparing it to the spec',
    ).toBe(IMPERATIVE_LIMIT_ENDPOINTS.length);
  });
});

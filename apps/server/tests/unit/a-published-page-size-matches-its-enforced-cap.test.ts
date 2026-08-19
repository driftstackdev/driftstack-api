// V-933 — four paginated endpoints published a page-size parameter with no type
// and no bounds.
//
// The `openapi-*-shadow-caps-cross-source-invariant` guards already state the
// principle: "Shadow drift means generated SDKs ship request-shape validators
// without the caps the route enforces." They cover the STRING caps —
// account_id, search, payment_id, cursor, order_id. They do not cover `limit` or
// `days`, and could not have: those caps are not in a route schema at all. Each
// route declares the parameter as a numeric string and then enforces the range
// in the handler:
//
//     const n = Number.parseInt(query.limit, 10);
//     if (!Number.isInteger(n) || n < 1 || n > 200) throw new BadRequestError(…)
//
// So the shadow copied the schema faithfully and the caps stayed behind. The
// four crypto endpoints published `type: string` — two of them with no pattern,
// no bounds and no description whatsoever — while the rest of the paginated
// endpoints in the same document published `type: integer` with minimum/maximum.
//
// V-1030: all four are fixed, and the document now publishes 22 paginated
// parameters, every one an integer with bounds. The named four below stay,
// because they also pin the published maximum against the cap the handler
// actually enforces. An arm at the end derives the weaker property — integer,
// minimum, maximum — across all 22, since the eighteen this file never named
// were correct but pinned by nothing.
//
// Fixed on the document side only. The routes still accept a numeric string off
// the wire, which is what HTTP delivers; `type: integer` is how OpenAPI declares
// a numeric parameter and is what the 19 siblings already use.
//
// Both ends are asserted. The published bound is compared against the route's own
// rejection message, which is the authoritative statement of the cap — check only
// the document and it keeps passing when a route widens; check only the route and
// it keeps passing when the document forgets again.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const SPEC = resolve(REPO_ROOT, 'packages/sdk-python/openapi.json');

interface Param {
  name?: string;
  in?: string;
  schema?: { type?: string; minimum?: number; maximum?: number };
}
interface SpecShape {
  paths: Record<string, Record<string, { parameters?: Param[] }>>;
}

function publishedParam(path: string, name: string): Param['schema'] {
  const spec = JSON.parse(readFileSync(SPEC, 'utf8')) as SpecShape;
  const params = spec.paths[path]?.['get']?.parameters ?? [];
  return params.find((p) => p.in === 'query' && p.name === name)?.schema;
}

interface Cap {
  readonly path: string;
  readonly param: string;
  readonly max: number;
  readonly routeFile: string;
  /** The handler's own rejection message — the authoritative cap statement. */
  readonly rejection: RegExp;
}

const CAPS: readonly Cap[] = [
  {
    path: '/v1/billing/crypto-orders',
    param: 'limit',
    max: 100,
    routeFile: 'apps/server/src/routes/billing-crypto-orders.ts',
    rejection: /limit must be an integer between 1 and 100\./,
  },
  {
    path: '/v1/admin/crypto-orders',
    param: 'limit',
    max: 200,
    routeFile: 'apps/server/src/routes/admin-crypto-orders.ts',
    rejection: /limit must be an integer between 1 and 200\./,
  },
  {
    path: '/v1/admin/crypto-orders.csv',
    param: 'limit',
    max: 1000,
    routeFile: 'apps/server/src/routes/admin-crypto-orders.ts',
    rejection: /limit must be an integer between 1 and 1000\./,
  },
  {
    path: '/v1/admin/crypto-orders/daily',
    param: 'days',
    max: 90,
    routeFile: 'apps/server/src/routes/admin-crypto-orders.ts',
    rejection: /days must be an integer between 1 and 90\./,
  },
];

describe('V-933 a published page size matches its enforced cap', () => {
  it('CRITICAL every route still states the cap it enforces. The published numbers below are compared against these messages, so if a handler widened its range and nothing said so, the document arm would keep passing against a cap that no longer exists.', () => {
    for (const { routeFile, rejection, path } of CAPS) {
      const src = readFileSync(resolve(REPO_ROOT, routeFile), 'utf8');
      expect(src.length, `${routeFile} was read`).toBeGreaterThan(500);
      expect(src, `${path} still rejects out-of-range values`).toMatch(rejection);
    }
  });

  it('CRITICAL each parameter is published as a bounded integer. Two of these carried no type, no bounds and no description at all, so a generated client had nothing to validate and no way to know the field was numeric — the caller discovered both facts from a 400.', () => {
    const gaps: string[] = [];
    for (const { path, param, max } of CAPS) {
      const schema = publishedParam(path, param);
      if (schema?.type !== 'integer') {
        gaps.push(`${path} ${param}: type is ${String(schema?.type)}, not integer`);
      }
      if (schema?.minimum !== 1) {
        gaps.push(`${path} ${param}: minimum is ${String(schema?.minimum)}, route enforces 1`);
      }
      if (schema?.maximum !== max) {
        gaps.push(
          `${path} ${param}: maximum is ${String(schema?.maximum)}, route enforces ${String(max)}`,
        );
      }
    }
    expect(gaps, 'the document does not carry these enforced caps:').toEqual([]);
  });

  it('CRITICAL the caps are genuinely different per endpoint, so the arm above is comparing real numbers rather than one repeated constant. A list caps at 100, the admin list at 200, the CSV export at 1000 and the daily breakdown at 90 — four distinct values, which is what makes a single shared expectation impossible.', () => {
    expect(new Set(CAPS.map((c) => c.max)).size, 'distinct enforced caps').toBe(4);
  });

  it('CRITICAL every published paginated parameter is an integer with bounds, not just the four this file names. The four crypto endpoints were fixed; the other eighteen were correct all along and pinned by nothing, so a regression to the exact shape this guard exists for — `type: string`, no minimum, no maximum — would only be caught on four of twenty-two.', () => {
    const spec = JSON.parse(readFileSync(SPEC, 'utf8')) as SpecShape;
    const offenders: string[] = [];
    let seen = 0;
    for (const [path, ops] of Object.entries(spec.paths)) {
      for (const [verb, op] of Object.entries(ops)) {
        for (const param of op.parameters ?? []) {
          if (!['limit', 'days', 'page_size', 'per_page'].includes(param.name ?? '')) continue;
          seen += 1;
          const schema = param.schema ?? {};
          if (
            schema.type !== 'integer' ||
            schema.minimum === undefined ||
            schema.maximum === undefined
          ) {
            offenders.push(
              `${verb.toUpperCase()} ${path} ${param.name}: type=${String(schema.type)} min=${String(schema.minimum)} max=${String(schema.maximum)}`,
            );
          }
        }
      }
    }
    expect(
      seen,
      'paginated parameters found in the published spec — 22 at V-1030; a collapse here makes the ' +
        'check below vacuous',
    ).toBeGreaterThanOrEqual(20);
    expect(
      offenders.sort(),
      'these published paginated parameters are not integers with minimum and maximum, so a ' +
        'generated SDK ships a validator without the cap the route enforces:',
    ).toEqual([]);
  });
});

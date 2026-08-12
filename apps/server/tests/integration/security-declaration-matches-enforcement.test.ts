// What the contract calls authenticated, the server actually refuses to serve
// anonymously — and what it serves anonymously is exactly the reviewed public
// set.
//
// `route-auth-coverage-invariant` already proves that every route registration
// in `src/routes` carries an authority preHandler. That is a STATIC check over
// SOURCE TEXT, and it has two blind spots this closes:
//
//   1. It parses `src/routes` only. Routes registered elsewhere — `/v1/whoami`
//      lives in `lib/app.ts` — are invisible to it.
//   2. Listing a preHandler is not the same as the gate firing. A handler that
//      is registered twice, wired in the wrong order, or shadowed still reads
//      as authorised in the AST.
//
// So this asks the running server instead, with no credentials at all, and
// compares the answer to the contract's OWN `security` declaration. That makes
// it a cross-source invariant rather than a restatement: the published document
// and the enforcement have to agree.
//
// The public set is pinned EXACTLY, and that is the sharper half. A route that
// silently loses its `security` block, or arrives without one, becomes readable
// by anybody — and the failure mode is a passing test suite, because nothing
// else asserts the negative. Adding a public route should be a deliberate edit
// here, with a reason.
//
// What this asserts is the OUTCOME — data served to an anonymous caller — not
// the presence of any particular gate, and that distinction is deliberate.
// Measured while building it: deleting `requireAuth` from GET /v1/profiles does
// NOT open the route, because `app.rateLimit('global')` resolves an account
// context of its own and answers 401 first. Defence in depth is real here, so a
// guard that asserted "this preHandler is present" would fail on a harmless
// refactor while still missing a route that genuinely leaks through some other
// path. A red here therefore means data actually reached an anonymous caller.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp } from './_helpers/build-test-app.js';

let fx: Awaited<ReturnType<typeof buildTestApp>>;
let spec: SpecDocument;

interface SpecDocument {
  paths?: Record<string, Record<string, Operation>>;
}
interface Operation {
  security?: unknown;
  responses?: Record<string, { content?: Record<string, unknown> }>;
}

const METHODS = ['get', 'post', 'patch', 'delete'] as const;

/**
 * Operations the contract declares unauthenticated AND that really serve an
 * anonymous caller a 2xx.
 *
 * Every entry is deliberate: the archetype catalogue is the pre-signup
 * discovery surface, the three status endpoints back the public status page,
 * and the echo endpoint exists so a proxy probe can read back its own exit IP
 * before it has a key. Nothing here returns account-scoped data.
 */
const PUBLIC_2XX = [
  'GET /v1/archetypes',
  'GET /v1/egress/echo',
  'GET /v1/status',
  'GET /v1/status/incidents',
  'GET /v1/status/sla',
];

interface Probe {
  op: string;
  status: number;
  secured: boolean;
}

const probes: Probe[] = [];

beforeAll(async () => {
  fx = await buildTestApp({
    scopes: ['read'],
    withOauthStore: true,
    enableAgentRuntime: true,
    enableByokAnthropic: true,
  });
  spec = (await fx.app.inject({ method: 'GET', url: '/openapi.json' })).json<SpecDocument>();

  for (const path of Object.keys(spec.paths ?? {})) {
    // Templated paths need a real id, and a 404 from a synthetic one says
    // nothing about the auth gate.
    if (path.includes('{') || !path.startsWith('/v1/')) continue;
    for (const method of METHODS) {
      const op = spec.paths?.[path]?.[method];
      if (op === undefined) continue;
      // Streams hold the connection open; requesting one hangs the sweep.
      const responses = Object.values(op.responses ?? {});
      if (responses.some((r) => r.content?.['text/event-stream'] !== undefined)) continue;

      const res = await fx.app.inject({
        method: method.toUpperCase() as 'GET',
        url: path,
        // No authorization header at all. Not a bad key — none.
        ...(method === 'get' ? {} : { payload: {} }),
      });
      probes.push({
        op: `${method.toUpperCase()} ${path}`,
        status: res.statusCode,
        secured: op.security !== undefined,
      });
    }
  }
}, 180_000);

afterAll(async () => {
  await fx.app.close();
});

describe('the contract security declaration matches what the server enforces', () => {
  it('CRITICAL the sweep reached a real population, split across both declarations. Every assertion below reports an ABSENCE, so a sweep that probed nothing — or only public routes — would satisfy them all having proved nothing.', () => {
    expect(probes.length, '/v1 operations probed anonymously').toBeGreaterThan(100);
    expect(
      probes.filter((p) => p.secured).length,
      'operations the contract declares authenticated',
    ).toBeGreaterThan(70);
    expect(
      probes.filter((p) => !p.secured).length,
      'operations the contract declares public',
    ).toBeGreaterThan(5);
  });

  it('CRITICAL every operation the contract declares authenticated REFUSES an anonymous caller. A preHandler can be listed in source and still not fire — registered twice, ordered wrongly, shadowed — and the static AST check would read all three as authorised.', () => {
    expect(
      probes.filter((p) => p.secured && p.status >= 200 && p.status < 300).map((p) => p.op),
      'secured operation(s) served to a caller with NO credentials:',
    ).toEqual([]);
  });

  it('CRITICAL no secured operation validates a payload BEFORE authenticating. A 400 to an anonymous caller means the request body was parsed and judged before the gate ran, which tells an unauthenticated prober what the endpoint expects.', () => {
    expect(
      probes.filter((p) => p.secured && p.status === 400).map((p) => p.op),
      'secured operation(s) answering 400 rather than 401 to an anonymous caller:',
    ).toEqual([]);
  });

  it('CRITICAL the set of operations that serve an anonymous caller is EXACTLY the reviewed list. This is the direction that fails silently: a route losing its security block becomes world-readable while every other test still passes.', () => {
    const actual = probes
      .filter((p) => p.status >= 200 && p.status < 300)
      .map((p) => p.op)
      .sort();
    expect(actual, 'operations serving 2xx without credentials:').toEqual([...PUBLIC_2XX].sort());
  });
});

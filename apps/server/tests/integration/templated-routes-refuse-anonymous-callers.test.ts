// Every path-parameterised route refuses a caller with no credentials.
//
// 106 of the 230 documented /v1 operations — 46% of the API — carry a path
// parameter, and NINE existing guards skip every one of them with the same
// line: `if (path.includes('{')) continue`. Conformance, cacheability, RFC 7807
// error shape, credential leaks, reached-status documentation and the anonymous
// auth probe all stop at the same boundary. Nearly half the surface had never
// been asked a question at runtime, and the shared skip means one blind spot,
// not nine independent ones: nothing else was going to notice.
//
// The reason they skip is stated in `security-declaration-matches-enforcement`:
// "templated paths need a real id, and a 404 from a synthetic one says nothing
// about the auth gate". For conformance that is right — you cannot validate a
// body you could not fetch. For AUTH it is backwards, and that is what this
// guard rests on.
//
// A gated route answers 401 in a preHandler, BEFORE the handler ever looks the
// id up. So a synthetic id is not a limitation here, it is the sharpest signal
// available: an authenticated route can only answer 401, because it never
// reaches the lookup. If a synthetic id comes back 404, the handler RAN — the
// request got past the gate and queried for the resource. 200 is worse. Either
// way the caller had no credentials, so the outcome is the whole finding and
// no real id is needed to see it.
//
// UNREGISTERED routes are excluded by asking the live route table via
// `app.hasRoute()`, never a hand-kept list. Two operations are documented but
// conditionally registered — `GET /v1/admin/atlas-priority/event/{id}` and
// `POST /v1/agent-sessions/{id}/livekit-token` (app.ts: "Partial config =
// unregistered route") — and both answer 404 from fastify's not-found handler,
// which is indistinguishable from an ungated handler by status alone. Deriving
// the exclusion means the day either one becomes registered it is covered
// automatically, instead of sitting on an allowlist nobody rechecks. That is
// also why the registered COUNT is floored below: if the fixture stopped
// registering routes, every operation would be "exempt" and this file would
// pass having probed nothing. That is not theoretical — measured while building
// this, with every route forced down the unregistered branch, both absence
// assertions still PASSED on an empty set and only the floor caught it.
//
// MEASURED baseline: all 102 probed operations answer 401 today, none 403.
// 403 is admitted by the allowlist because a scope gate may legitimately answer
// it, but nothing produces one right now — so a 403 appearing here is worth
// reading rather than assuming, even though it does not fail.

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

const METHODS = ['get', 'post', 'patch', 'put', 'delete'] as const;

/** A well-formed id that belongs to nobody. Existence is not the subject. */
const SYNTHETIC_ID = '00000000-0000-4000-8000-0000000000ff';

/**
 * Templated operations that serve an anonymous caller a 2xx.
 *
 * Empty, and that is the assertion. Every templated route in the API is
 * account-scoped or staff-scoped — there is no public `/{id}` surface, because
 * the public status page reads collections and the one public detail route
 * (`GET /v1/status/incidents/{id}`) validates its id before serving. An entry
 * arriving here means a route that takes an identifier became world-readable,
 * which is the exact shape of an enumeration vulnerability.
 */
const PUBLIC_2XX: string[] = [];

interface Probe {
  op: string;
  status: number;
  secured: boolean;
}

const probes: Probe[] = [];
let documented = 0;
let unregistered = 0;
let streaming = 0;

beforeAll(async () => {
  fx = await buildTestApp({
    scopes: ['read'],
    withOauthStore: true,
    enableAgentRuntime: true,
    enableByokAnthropic: true,
  });
  spec = (await fx.app.inject({ method: 'GET', url: '/openapi.json' })).json<SpecDocument>();

  for (const path of Object.keys(spec.paths ?? {})) {
    if (!path.startsWith('/v1/') || !path.includes('{')) continue;
    // OpenAPI spells parameters `{id}`; fastify spells them `:id`.
    const routeUrl = path.replace(/\{([^}]+)\}/g, ':$1');
    const url = path.replace(/\{[^}]+\}/g, SYNTHETIC_ID);

    for (const method of METHODS) {
      const op = spec.paths?.[path]?.[method];
      if (op === undefined) continue;
      documented += 1;

      // Streams hold the connection open; requesting one hangs the sweep.
      const responses = Object.values(op.responses ?? {});
      if (responses.some((r) => r.content?.['text/event-stream'] !== undefined)) {
        streaming += 1;
        continue;
      }

      // Asked of the running app, not assumed. An unregistered route 404s from
      // the not-found handler, which no status check can tell from a handler
      // that ran without a gate.
      if (!fx.app.hasRoute({ method: method.toUpperCase(), url: routeUrl })) {
        unregistered += 1;
        continue;
      }

      const res = await fx.app.inject({
        method: method.toUpperCase() as 'GET',
        url,
        // No authorization header at all. Not a bad key — none.
        ...(method === 'get' || method === 'delete' ? {} : { payload: {} }),
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

describe('path-parameterised routes refuse anonymous callers', () => {
  it('CRITICAL the sweep probed the real templated population. Every assertion below reports an ABSENCE, so a sweep that resolved no routes — or excluded them all as unregistered — would satisfy them having proved nothing.', () => {
    // MEASURED: 106 templated operations documented, of which 2 stream and 2
    // are conditionally unregistered, leaving 102 probed. Floors sit below the
    // measured numbers so ordinary growth does not trip them, and high enough
    // that a collapse in what gets probed fails loudly.
    expect(documented, 'templated /v1 operations in the contract').toBeGreaterThanOrEqual(100);
    expect(
      probes.length,
      'templated operations actually probed anonymously',
    ).toBeGreaterThanOrEqual(95);
    expect(
      probes.filter((p) => p.secured).length,
      'templated operations the contract declares authenticated',
    ).toBeGreaterThanOrEqual(95);

    // The exclusions are meant to be a rounding error. If either grows into a
    // real population, this guard is quietly covering less than it claims.
    expect(unregistered, 'documented but not registered in this fixture').toBeLessThanOrEqual(6);
    expect(streaming, 'excluded as event streams').toBeLessThanOrEqual(4);
  });

  it('CRITICAL every secured templated route answers exactly 401 or 403 to an anonymous caller. Stated as an ALLOWLIST of acceptable statuses rather than a list of forbidden ones, because the forbidden list is unbounded: 404 means the handler reached the lookup, 400 means the body was parsed and judged before the gate, 5xx means the handler ran and crashed on the account context it was promised, and 2xx means it simply served. All four are the same defect — the request got past the gate — and only an allowlist catches the one nobody thought to enumerate.', () => {
    expect(
      probes
        .filter((p) => p.secured && p.status !== 401 && p.status !== 403)
        .map((p) => `${p.op} -> ${String(p.status)}`),
      'secured templated route(s) answering something other than 401/403 to a caller with NO credentials:',
    ).toEqual([]);
  });

  it('CRITICAL the set of templated routes serving an anonymous caller is EXACTLY the reviewed list, which is empty. A route that takes an identifier and answers 2xx without credentials is an enumeration surface, and it fails silently — every other test still passes.', () => {
    expect(
      probes
        .filter((p) => p.status >= 200 && p.status < 300)
        .map((p) => p.op)
        .sort(),
      'templated operation(s) serving 2xx without credentials:',
    ).toEqual([...PUBLIC_2XX].sort());
  });
});

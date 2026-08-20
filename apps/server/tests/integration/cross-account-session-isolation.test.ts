// Account B cannot reach account A's session through ANY of its routes.
//
// `cross-account-404-anti-enumeration` opens by promising that "every
// customer-facing route that scopes to the calling account MUST 404 (NOT 403)".
// It then tests two of them: GET and DELETE on `/v1/sessions/:id`. The session
// resource has thirteen.
//
// That gap is not theoretical. Removing the account predicate from the session
// lookup reds only TWO tests in the entire integration suite; eleven session
// routes would serve one customer another customer's live browser with nothing
// failing. With this file, that same mutation reds 16.
//
// Worth knowing before mutating this area: session ownership is enforced by TWO
// independent predicates, not one. `findSession(id, accountId)` guards the read
// path (GET), and `claimSessionOperation(id, accountId)` guards every action
// path (navigate, interact, extract, capture, wait, gui-input, state, delete).
// Removing only the first reds 2 cases and looks like thin coverage; removing
// only the second reds 14; removing both reds 16. A mutation test that touches
// one predicate and concludes the other routes are untested is wrong — that is
// how these nine cases nearly got written off as vacuous.
//
// 404 rather than 403 is deliberate and load-bearing: 403 confirms the resource
// exists, which turns any of these routes into an enumeration oracle. The same
// call against an id that never existed must be indistinguishable, and that is
// asserted here rather than assumed.

import { afterEach, describe, expect, it } from 'vitest';
import {
  buildTestApp,
  seedAdditionalAccount,
  type TestAppFixture,
} from './_helpers/build-test-app.js';
import { assertCensusSaw, opsUnder } from './_helpers/registered-ops.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

/**
 * Every `/v1/sessions/:id...` route, with a minimally-valid body where the
 * schema requires one. The body matters: a route that 400s on payload
 * validation before reaching the ownership check would pass this suite while
 * proving nothing about isolation, so each entry sends something the schema
 * accepts and relies on ownership to be the reason for the 404.
 */
const SESSION_ROUTES: ReadonlyArray<{
  method: 'GET' | 'POST' | 'DELETE';
  suffix: string;
  payload?: Record<string, unknown>;
}> = [
  { method: 'GET', suffix: '' },
  { method: 'DELETE', suffix: '' },
  { method: 'GET', suffix: '/state' },
  { method: 'POST', suffix: '/navigate', payload: { url: 'https://example.test/' } },
  { method: 'POST', suffix: '/interact', payload: { action: { kind: 'tap', selector: '#go' } } },
  {
    method: 'POST',
    suffix: '/extract',
    payload: { extractions: [{ name: 'title', selector: 'h1', type: 'text' }] },
  },
  { method: 'POST', suffix: '/capture', payload: { kind: 'screenshot' } },
  { method: 'POST', suffix: '/wait', payload: { condition: { kind: 'time', ms: 10 } } },
  {
    method: 'POST',
    suffix: '/gui-input',
    payload: { action: { kind: 'tap_at', x: 1, y: 1 } },
  },
];

/**
 * Routes whose CAPABILITY gate answers before ownership is ever consulted, so
 * they cannot demonstrate isolation. Direct login/search return a truthful 503
 * on every shipped driver — there is no real direct driver yet — so a 404 here
 * would be the wrong assertion, not a stricter one. Listed with the reason and
 * asserted to still behave that way, so the exemption cannot quietly become
 * cover for a route that later starts answering.
 */
const CAPABILITY_GATED: ReadonlyArray<{
  method: 'GET' | 'POST';
  suffix: string;
  payload?: Record<string, unknown>;
}> = [
  { method: 'POST', suffix: '/login', payload: { username: 'u', password: 'p' } },
  { method: 'POST', suffix: '/search', payload: { query: 'driftstack' } },
  { method: 'GET', suffix: '/proxy' },
  { method: 'POST', suffix: '/proxy', payload: { url: 'socks5://user:pass@proxy.test:1080' } },
];

/**
 * Account B holds FULL rights over its OWN account, including `gui_control`.
 * That is deliberate: a key missing a scope is refused at the scope gate before
 * ownership is consulted, so a scope-poor key would make these cases pass
 * without testing isolation at all. The only thing standing between B and A's
 * session here is ownership.
 */
const FULL_SCOPES = ['read', 'write', 'account_owner', 'gui_control'] as const;

/**
 * An id that is well-formed but owned by nobody, derived from a real one so it
 * cannot fail id-format validation. A hand-written placeholder 400s on format
 * before reaching the lookup, which would compare a 404 against a 400 and make
 * the whole indistinguishability check meaningless.
 */
function nonexistentLike(realId: string): string {
  const last = realId.slice(-1);
  return `${realId.slice(0, -1)}${last === '0' ? '1' : '0'}`;
}

async function createSessionForAccountA(fixture: TestAppFixture): Promise<string> {
  const res = await fixture.app.inject({
    method: 'POST',
    url: '/v1/sessions',
    headers: { authorization: `Bearer ${fixture.plaintext}` },
    payload: { label: 'owned-by-a' },
  });
  expect(res.statusCode, 'account A must be able to create its own session').toBe(201);
  return res.json<{ id: string }>().id;
}

describe("account B cannot reach account A's session on any route", () => {
  it.each(SESSION_ROUTES.map((r) => [`${r.method} /v1/sessions/:id${r.suffix}`, r] as const))(
    'CRITICAL %s returns 404 for a different account. A 200 here serves one customer another customer’s live browser session; a 403 confirms the session exists and makes the route an enumeration oracle.',
    async (_label, route) => {
      fx = await buildTestApp({
        tier: 'api_builder',
        enableAgentRuntime: true,
      });
      const sessionId = await createSessionForAccountA(fx);
      const other = await seedAdditionalAccount(fx, {
        email: 'b@session-isolation.test',
        tier: 'api_builder',
        scopes: [...FULL_SCOPES],
      });

      const res = await fx.app.inject({
        method: route.method,
        url: `/v1/sessions/${sessionId}${route.suffix}`,
        headers: { authorization: `Bearer ${other.plaintext}` },
        ...(route.payload === undefined ? {} : { payload: route.payload }),
      });

      expect(
        res.statusCode,
        `${route.method} /v1/sessions/:id${route.suffix} returned ${res.statusCode} for a foreign account`,
      ).toBe(404);
    },
  );

  it.each(SESSION_ROUTES.map((r) => [`${r.method} /v1/sessions/:id${r.suffix}`, r] as const))(
    '%s is INDISTINGUISHABLE from a nonexistent id, so the 404 leaks nothing',
    async (_label, route) => {
      fx = await buildTestApp({
        tier: 'api_builder',
        enableAgentRuntime: true,
      });
      const sessionId = await createSessionForAccountA(fx);
      const other = await seedAdditionalAccount(fx, {
        email: 'b@session-isolation.test',
        tier: 'api_builder',
        scopes: [...FULL_SCOPES],
      });

      const call = (id: string): Promise<{ statusCode: number; body: string }> =>
        fx.app
          .inject({
            method: route.method,
            url: `/v1/sessions/${id}${route.suffix}`,
            headers: { authorization: `Bearer ${other.plaintext}` },
            ...(route.payload === undefined ? {} : { payload: route.payload }),
          })
          .then((r) => ({ statusCode: r.statusCode, body: r.body }));

      const foreign = await call(sessionId);
      const missingId = nonexistentLike(sessionId);
      const missing = await call(missingId);

      expect(foreign.statusCode).toBe(missing.statusCode);
      // Compare with every request-unique identifier masked. The echoed id
      // differs by construction, and `instance` is a per-request correlation id
      // that legitimately differs on any two calls. What must NOT differ is
      // anything else: a distinct problem type, title, or wording between "not
      // yours" and "does not exist" rebuilds the oracle that the matching
      // status code closes.
      const mask = (body: string): string =>
        body.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, 'UUID');
      // The detail must not echo the id back differently for the two cases —
      // that alone would rebuild the oracle the matching status code closes.
      expect(mask(foreign.body)).toBe(mask(missing.body));
    },
  );

  it.each(CAPABILITY_GATED.map((r) => [`${r.method} /v1/sessions/:id${r.suffix}`, r] as const))(
    '%s is capability-gated ahead of ownership, so its exemption is still accurate rather than stale cover',
    async (label, route) => {
      fx = await buildTestApp({ tier: 'api_builder', enableAgentRuntime: true });
      const sessionId = await createSessionForAccountA(fx);
      const other = await seedAdditionalAccount(fx, {
        email: 'b@session-isolation.test',
        tier: 'api_builder',
        scopes: [...FULL_SCOPES],
      });
      const res = await fx.app.inject({
        method: route.method,
        url: `/v1/sessions/${sessionId}${route.suffix}`,
        headers: { authorization: `Bearer ${other.plaintext}` },
        ...(route.payload === undefined ? {} : { payload: route.payload }),
      });
      expect(
        res.statusCode,
        `${label} answered ${res.statusCode}. If the capability gate no longer fires first, move this route into SESSION_ROUTES so ownership is actually proved.`,
      ).toBe(503);
    },
  );
  it('CRITICAL V-1106 a new /v1/sessions/:id route must be in SESSION_ROUTES or CAPABILITY_GATED, or its ownership check ships untested. Both tables are hand-written and were complete when measured — but a table that is also its own population cannot report a route missing from it, so the next route added to sessions.ts would get no cross-account arm and nothing would say so. The three sibling isolation guards (agent-session, profile, crypto-order) each derive this census already; this file was the one that did not.', async () => {
    // Own fixture rather than whatever a previous arm left in `fx` — reading a
    // closed instance's route tree happens to work, so the order-dependence
    // would surface as this arm throwing rather than failing.
    fx = await buildTestApp();
    const registered = opsUnder(fx.app.printRoutes({ commonPrefix: false }), '/v1/sessions/:id');
    // A base path whose parameter name is wrong matches nothing and would pass
    // while checking nothing.
    assertCensusSaw(registered, '/v1/sessions/:id', 11);

    // Query strings in a table entry are fixture detail, not route identity.
    const covered = new Set(
      [...SESSION_ROUTES, ...CAPABILITY_GATED].map(
        (r) => `${r.method} /v1/sessions/:id${r.suffix.split('?')[0] ?? ''}`,
      ),
    );
    const missing = registered.filter((op) => !covered.has(op));
    expect(
      missing,
      `these :id routes have no cross-account arm:\n  ${missing.join('\n  ')}`,
    ).toEqual([]);
  });
});

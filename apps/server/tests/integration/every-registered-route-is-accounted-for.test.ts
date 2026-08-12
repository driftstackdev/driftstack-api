// Every route the server actually registers is either in the published contract
// or on a reviewed list with the reason it is not.
//
// This exists because of a structural blind spot rather than a single bug.
// Almost every sweep in this suite derives its population from `/openapi.json`
// — conformance, cacheability, credential leaks, RFC 7807 shape, reached-status
// documentation, the security declaration, the templated-route probes. That is
// a good source, but it has one consequence nobody had measured: a route that
// is registered and NOT documented is invisible to all of them at once. Not one
// guard with a gap — every spec-driven guard, simultaneously, with no failure
// anywhere to indicate it.
//
// MEASURED when this was written: 244 registered operations against 232
// documented, and 19 of the registered ones absent from the contract. Seven sit
// on the `/v1` customer surface, including a route that mints a GUI control
// token and one that relays input into a live browser session. Those had never
// been probed by anything.
//
// So the exemptions are not a formality. Each names why a route is legitimately
// outside the customer contract, and the arm below re-checks that every exempt
// `/v1` route still refuses an anonymous caller — because the sweep that
// normally proves that reads the spec, and by construction cannot see these.
//
// The route table is read back out of Fastify rather than parsed from source,
// so conditional registration, plugin-mounted routes and anything declared
// outside `src/routes` are all included. `/v1/whoami` lives in `lib/app.ts` and
// is exactly the kind of registration a source scanner misses.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp } from './_helpers/build-test-app.js';

let fx: Awaited<ReturnType<typeof buildTestApp>>;
let spec: SpecDocument;

interface SpecDocument {
  paths?: Record<string, Record<string, unknown>>;
}

/**
 * Registered operations that are deliberately absent from the customer
 * contract, each with the reason it does not belong there.
 *
 * Verified individually at the registration site. An entry that stops matching
 * a real route is reported below — an allowlist nobody rechecks stops meaning
 * "reviewed" and starts meaning "ignored".
 */
const NOT_IN_THE_CONTRACT: ReadonlyMap<string, string> = new Map([
  // ── Operational surface. Not customer API; no versioned contract. ──
  ['GET /healthz', 'liveness probe for the load balancer'],
  ['GET /ready', 'readiness probe — reports dependency wiring, not customer data'],
  ['GET /metrics', 'Prometheus scrape endpoint, gated separately from the customer API'],
  ['GET /openapi.json', 'the contract document itself; it cannot be an operation inside itself'],
  ['GET /docs', 'the rendered API reference (Scalar) — a page, not an API operation'],
  ['GET /docs/js/scalar.js', 'static asset for the docs page'],
  ['GET /docs/openapi.json', 'the docs page fetching the contract it renders'],
  ['GET /docs/openapi.yaml', 'YAML rendering of the same contract'],

  // ── Internal fleet plane. Called by the harvester and fleet scripts with a
  //    separate credential (lib/internal-fleet-auth.ts), never by customers. ──
  ['GET /v1/internal/atlas-priority/queue', 'internal fleet observability; not a customer surface'],
  ['GET /v1/internal/atlas-priority/event/:id', 'internal fleet observability'],
  ['POST /v1/internal/atlas-priority/event-status', 'internal fleet ingest'],
  ['POST /v1/internal/atlas-priority/probe-signature', 'internal fleet ingest'],

  // ── /v1 routes that are real but deliberately uncontracted. ──
  ['GET /v1/whoami', 'auth smoke test registered in lib/app.ts; requireAuth + global rate limit'],
  [
    'GET /v1/status/stream',
    'SSE feed behind the public status page. Streams are excluded from every spec-driven sweep anyway because holding the connection open hangs them.',
  ],
  [
    'GET /v1/agent-sessions/:id/gui-control-key',
    'mints a single-session control token for the desktop client. Deliberately uncontracted — it is a client-transport detail, and the token is unrecoverable by design.',
  ],
  [
    'POST /v1/agent-sessions/:id/transport-report',
    'desktop-client transport telemetry. Its own source notes it reveals nothing and mutates nothing, so it carries no write scope.',
  ],
  [
    'POST /v1/sessions/:id/gui-input',
    'relays raw input into a live session for the desktop client; admin-only on team-scoped requests (V-326e3).',
  ],
  [
    'POST /v1/oauth/authorize/complete',
    'the browser consent form target — an HTML flow, not a JSON API operation.',
  ],
  [
    'POST /v1/webhooks/stripe',
    'Stripe calls this, not customers. Needs the raw body for signature verification, which is why it is registered through _webhook-raw-body.ts.',
  ],
]);

/**
 * Rebuild absolute paths from Fastify's indented route TREE.
 *
 * `printRoutes` prints each node RELATIVE to its parent, so a naive
 * line-by-line read yields fragments like `/:id` and `/avatar`. That is not a
 * hypothetical: the first version of this file did exactly that and reported 71
 * "undocumented routes" that were really path segments. The parser is asserted
 * against known full paths below for that reason.
 */
function registeredOps(tree: string): Set<string> {
  const out = new Set<string>();
  const stack: string[] = [];
  for (const raw of tree.split('\n')) {
    if (raw.trim() === '') continue;
    const markerAt = raw.search(/[├└]/);
    // Four characters of box-drawing per level of depth.
    const depth = markerAt < 0 ? 0 : Math.floor(markerAt / 4);
    const body = markerAt < 0 ? raw.trim() : raw.slice(markerAt + 4).trim();
    const m = /^(\S*?)\s*(?:\(([A-Z, ]+)\))?$/.exec(body);
    if (m === null) continue;
    stack.length = depth;
    stack[depth] = m[1] ?? '';
    if (m[2] === undefined) continue;
    const full =
      stack
        .slice(0, depth + 1)
        .join('')
        .replace(/\/$/, '') || '/';
    for (const method of m[2].split(',')) {
      const verb = method.trim();
      // Fastify synthesises HEAD for every GET; OPTIONS comes from CORS.
      if (verb === 'HEAD' || verb === 'OPTIONS') continue;
      out.add(`${verb} ${full}`);
    }
  }
  return out;
}

/**
 * Exempt routes this fixture cannot exercise, so their auth cannot be observed.
 *
 * The internal fleet plane needs an atlas-priority repo that `buildTestApp`
 * does not wire, so every one of these answers 503 before any gate runs. They
 * are named rather than tolerated: a 503 satisfies "never serves 2xx" perfectly
 * while proving nothing, and pinning the set means a route that starts 503ing
 * for some other reason fails instead of quietly joining the excused.
 */
const UNWIRED_HERE: ReadonlySet<string> = new Set([
  'GET /v1/internal/atlas-priority/queue',
  'GET /v1/internal/atlas-priority/event/:id',
  'POST /v1/internal/atlas-priority/event-status',
  'POST /v1/internal/atlas-priority/probe-signature',
]);

let registered: Set<string>;
let documented: Set<string>;
const anonymousStatus = new Map<string, number>();
/** `op -> cache-control` for uncontracted routes that served an authenticated 2xx. */
const authorisedCaching = new Map<string, string>();

beforeAll(async () => {
  fx = await buildTestApp({
    scopes: ['read', 'write', 'account_owner', 'driftstack_internal_admin'],
    withOauthStore: true,
    enableAgentRuntime: true,
    enableByokAnthropic: true,
  });
  spec = (await fx.app.inject({ method: 'GET', url: '/openapi.json' })).json<SpecDocument>();

  registered = registeredOps(fx.app.printRoutes({ commonPrefix: false }));
  documented = new Set<string>();
  for (const path of Object.keys(spec.paths ?? {})) {
    for (const method of Object.keys(spec.paths?.[path] ?? {})) {
      // The contract spells parameters `{id}`; the route table spells them `:id`.
      documented.add(`${method.toUpperCase()} ${path.replace(/\{([^}]+)\}/g, ':$1')}`);
    }
  }

  // Probe the exempt /v1 surface anonymously. The sweep that normally proves
  // this reads the spec, so these are precisely the routes it cannot reach.
  for (const op of NOT_IN_THE_CONTRACT.keys()) {
    if (!op.startsWith('GET /v1/') && !op.startsWith('POST /v1/')) continue;
    // A stream would hold the connection open and hang the sweep.
    if (op === 'GET /v1/status/stream') continue;
    const [method, template] = op.split(' ') as ['GET' | 'POST', string];
    const url = template.replace(/:[a-zA-Z_]+/g, '00000000-0000-4000-8000-0000000000ff');
    const res = await fx.app.inject({
      method,
      url,
      // No authorization header at all.
      ...(method === 'GET' ? {} : { payload: {} }),
    });
    anonymousStatus.set(op, res.statusCode);
  }

  // And again WITH credentials and real ids, because two of these serve real
  // secrets: gui-control-key mints a session control token, and whoami returns
  // the account id, key id, tier and scope set. A synthetic id only ever gets
  // 404 out of them, so the response that actually matters is never seen.
  const auth = { authorization: `Bearer ${fx.plaintext}` };
  const newId = async (url: string): Promise<string> => {
    const res = await fx.app.inject({ method: 'POST', url, headers: auth, payload: {} });
    if (res.statusCode !== 201) return '';
    return res.json<{ id?: string }>().id ?? '';
  };
  const agentId = await newId('/v1/agent-sessions');
  const sessionId = await newId('/v1/sessions');

  const withRealIds: [string, string, boolean][] = [
    ['GET /v1/whoami', '/v1/whoami', false],
    [
      'GET /v1/agent-sessions/:id/gui-control-key',
      `/v1/agent-sessions/${agentId}/gui-control-key`,
      false,
    ],
    [
      'POST /v1/agent-sessions/:id/transport-report',
      `/v1/agent-sessions/${agentId}/transport-report`,
      true,
    ],
    ['POST /v1/sessions/:id/gui-input', `/v1/sessions/${sessionId}/gui-input`, true],
  ];
  for (const [op, url, isPost] of withRealIds) {
    if (url.includes('//')) continue; // a create failed; no id to substitute
    const res = await fx.app.inject({
      method: isPost ? 'POST' : 'GET',
      url,
      headers: auth,
      ...(isPost ? { payload: {} } : {}),
    });
    if (res.statusCode < 200 || res.statusCode >= 300) continue;
    authorisedCaching.set(op, String(res.headers['cache-control'] ?? '<none>'));
  }
}, 180_000);

afterAll(async () => {
  await fx.app.close();
});

describe('every registered route is accounted for', () => {
  it('CRITICAL the route table parsed into real ABSOLUTE paths. Fastify prints a tree whose nodes are relative to their parent, so a naive read yields fragments like /:id — the first version of this file did that and reported 71 phantom findings. Everything below compares against this set, so a broken parse would make the comparison meaningless in whichever direction the fragments happened to fall.', () => {
    expect(registered.size, 'operations recovered from the route table').toBeGreaterThan(200);
    expect(documented.size, 'operations in the contract').toBeGreaterThan(200);
    // Concrete absolute paths, nested at different depths, whose presence
    // proves segments were joined rather than reported on their own.
    for (const op of [
      'POST /v1/sessions/:id/navigate',
      'GET /v1/status/incidents/:id',
      'DELETE /v1/webhooks/:id',
      // Depth 0, to prove a top-level route is not lost by the depth handling.
      'GET /healthz',
    ]) {
      expect(
        registered,
        `parser did not recover ${op}. These are canaries for the tree walk, not a claim about the route itself — if this route was deliberately renamed, update the canary; the parse is only broken if the OTHER canaries also fail`,
      ).toContain(op);
    }
    // And the fragments the broken parse produced must NOT be present.
    for (const fragment of ['GET /:id', 'DELETE /:id', 'GET /content']) {
      expect(registered, `${fragment} is a tree fragment, not a route`).not.toContain(fragment);
    }
  });

  it('CRITICAL every registered route is documented or exempt with a reason. An undocumented route is invisible to EVERY spec-driven sweep at once — conformance, cacheability, credential leaks, error shape, the security declaration — and nothing fails to say so.', () => {
    const unaccounted = [...registered]
      .filter((op) => !documented.has(op))
      .filter((op) => !NOT_IN_THE_CONTRACT.has(op))
      .sort();
    expect(
      unaccounted,
      'registered route(s) neither documented nor exempt — document it, or add an exemption with the reason it is not customer-facing:',
    ).toEqual([]);
  });

  it('CRITICAL the exemption list may only SHRINK. An entry for a route that no longer exists, or that has since been documented, stops meaning "reviewed" and starts meaning "ignored".', () => {
    const stale: string[] = [];
    for (const op of NOT_IN_THE_CONTRACT.keys()) {
      if (!registered.has(op)) stale.push(`${op} — no longer registered`);
      else if (documented.has(op)) stale.push(`${op} — now in the contract, remove the exemption`);
    }
    expect(stale.sort(), 'exemption(s) that no longer describe reality:').toEqual([]);
  });

  it('CRITICAL every REACHABLE exempt /v1 route answers exactly 401 or 403 anonymously. Stated as an allowlist, not as "never 2xx": the first version of this assertion only forbade 2xx, and a 503 from an unwired route satisfied that having proved nothing. Four of the ten probes were exactly that. These routes are also the ones security-declaration-matches-enforcement cannot reach, because it reads the contract — and one of them mints a session control token while another relays raw input into a live browser session.', () => {
    const reachable = [...anonymousStatus.entries()].filter(([op]) => !UNWIRED_HERE.has(op));
    expect(reachable.length, 'exempt /v1 routes actually reachable in this fixture').toBe(6);
    expect(
      reachable
        .filter(([, status]) => status !== 401 && status !== 403)
        .map(([op, status]) => `${op} -> ${String(status)}`)
        .sort(),
      'uncontracted /v1 route(s) answering something other than 401/403 to a caller with NO credentials:',
    ).toEqual([]);
  });

  it('CRITICAL uncontracted routes that serve real data are never publicly cacheable. private-responses-are-never-cacheable reads the contract, so it has never seen these — and one of them mints a session control token while another returns the account id, key id, tier and scope set. A shared cache holding either is a credential handed to the next caller.', () => {
    // MEASURED: 2 of the four reach a 2xx here — whoami and gui-control-key.
    // The other two need live session state the fixture does not have, so they
    // answer 404/403; floored at 2 so a probe that stopped reaching ANY body
    // cannot pass as "nothing was cacheable".
    expect(
      authorisedCaching.size,
      'uncontracted routes that returned an authenticated 2xx',
    ).toBeGreaterThanOrEqual(2);
    expect(
      [...authorisedCaching.entries()]
        .filter(([, cc]) => !(cc.includes('no-store') && cc.includes('private')))
        .map(([op, cc]) => `${op} -> ${cc}`)
        .sort(),
      'uncontracted route(s) serving real data without no-store + private:',
    ).toEqual([]);
  });

  it('CRITICAL the set of exempt routes this fixture cannot reach is EXACTLY the internal fleet plane. Without pinning it, any route that started answering 503 would quietly move from "checked" to "excused" — which is how the arm above was vacuous for four routes before anyone looked.', () => {
    const unreachable = [...anonymousStatus.entries()]
      .filter(([, status]) => status === 503)
      .map(([op]) => op)
      .sort();
    expect(
      unreachable,
      'routes excused from the auth check because they are unwired here:',
    ).toEqual([...UNWIRED_HERE].sort());
  });
});

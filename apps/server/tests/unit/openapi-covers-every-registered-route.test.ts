// Every route the server registers is either in the OpenAPI spec or on an
// exact, reasoned exemption list.
//
// The spec is not documentation-that-follows-the-code here — `dump-openapi.ts`
// says plainly that it is "the input to the Python and Go SDK codegen tooling".
// A route absent from it is a route those two SDKs cannot call, no matter what
// the docs say about it.
//
// Measured against the built app rather than the source: 242 registered
// operations, 232 spec operations, 18 registered routes with no spec entry.
// Most are correctly outside the customer API — the docs UI, the health and
// readiness probes, the metrics scrape, the internal fleet endpoints that
// `internal-fleet-auth.ts` describes as "NOT customer-facing", and the inbound
// Stripe webhook, which a customer never calls.
//
// TWO ARE NOT, and they are recorded below as a known gap rather than folded in
// with the infrastructure: `GET /v1/whoami` is documented in
// reference/scopes.md as the way to check what a key carries, and
// `POST /v1/sessions/{id}/gui-input` is listed in api/team.md as part of the
// session surface. Both are real customer endpoints, both are missing from the
// spec, and both are therefore missing from the generated SDKs. Splitting the
// two lists is deliberate: an exemption that means "correctly not customer API"
// and one that means "we owe this an entry" should not look the same, or the
// second quietly becomes the first.
//
// Route discovery here is intentionally NOT a source scan. `buildApp` gates
// whole surfaces on optional dependencies — OAuth on `deps.oauthStore`,
// atlas-priority, livekit and fleet on theirs — so what is registered depends
// on what is wired, and only the built app knows.

import { describe, expect, it } from 'vitest';
import { generateOpenApiSpec } from '../../src/lib/openapi.js';
import { buildTestApp } from '../integration/_helpers/build-test-app.js';

/** Registered routes that are correctly absent from the customer API spec. */
const NOT_CUSTOMER_API = [
  'GET /docs',
  'GET /docs/',
  'GET /docs/js/scalar.js',
  'GET /docs/openapi.json',
  'GET /docs/openapi.yaml',
  'GET /healthz',
  'GET /metrics',
  'GET /openapi.json',
  'GET /ready',
  // Operator-trusted fleet surface. `internal-fleet-auth.ts` states these are
  // not customer-facing and rejects every request when its token is unset.
  'GET /v1/internal/atlas-priority/event/:id',
  'GET /v1/internal/atlas-priority/queue',
  'POST /v1/internal/atlas-priority/event-status',
  'POST /v1/internal/atlas-priority/probe-signature',
  // Inbound provider callbacks and the browser-driven OAuth consent step: the
  // caller is Stripe, or our own consent page, never a customer's SDK.
  'POST /v1/webhooks/stripe',
  'POST /v1/oauth/authorize/complete',
  // Server-Sent Events. OpenAPI models this poorly and api/status.md documents
  // it with a raw EventSource example rather than an SDK call.
  'GET /v1/status/stream',
];

/**
 * Customer endpoints the docs describe that the spec does not carry.
 *
 * NOT an approved shape — a recorded debt. Each one is reachable, documented to
 * customers, and absent from the Python and Go SDKs because those are generated
 * from the spec. Pinned exactly so a third cannot join them silently; the fix
 * is to give them spec entries, at which point they leave this list.
 */
const DOCUMENTED_BUT_UNSPECCED = ['GET /v1/whoami', 'POST /v1/sessions/:id/gui-input'];

/** Flatten Fastify's printRoutes tree into `METHOD /full/path` entries. */
function flattenRoutes(tree: string): string[] {
  const out: string[] = [];
  const stack: { depth: number; seg: string }[] = [];
  for (const raw of tree.split('\n')) {
    if (raw.trim() === '') continue;
    const cleaned = raw.replace(/[│├└─]/g, ' ');
    const depth = Math.floor((cleaned.length - cleaned.trimStart().length) / 4);
    const body = cleaned.trim();
    const m = /^(\S*)\s*(?:\(([^)]*)\))?$/.exec(body);
    if (m === null) continue;
    while (stack.length > 0 && stack[stack.length - 1]!.depth >= depth) stack.pop();
    stack.push({ depth, seg: m[1] ?? '' });
    if (m[2] === undefined) continue;
    const full = stack.map((s) => s.seg).join('');
    for (const method of m[2].split(',').map((x) => x.trim())) {
      // HEAD is synthesised for every GET; OPTIONS is CORS plumbing.
      if (method === 'HEAD' || method === 'OPTIONS') continue;
      out.push(`${method} ${full}`);
    }
  }
  return out;
}

interface Surface {
  readonly routes: string[];
  readonly specOps: Set<string>;
}

async function surface(): Promise<Surface> {
  const spec = generateOpenApiSpec() as { paths?: Record<string, Record<string, unknown>> };
  const specOps = new Set<string>();
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    // OpenAPI writes `{id}`; Fastify writes `:id`.
    const url = path.replace(/\{([^}]+)\}/g, ':$1');
    for (const method of Object.keys(item)) specOps.add(`${method.toUpperCase()} ${url}`);
  }

  // OAuth is gated on `deps.oauthStore`, so without this the whole
  // /v1/oauth/* + /v1/admin/oauth/* surface is simply not registered and would
  // look like seventeen undocumented-by-omission routes that do not exist.
  const fixture = await buildTestApp({ withOauthStore: true });
  const app = (
    fixture as unknown as {
      app: { printRoutes: (o?: unknown) => string; close: () => Promise<void> };
    }
  ).app;
  const routes = flattenRoutes(app.printRoutes({ commonPrefix: false }));
  await app.close();
  return { routes, specOps };
}

describe('the OpenAPI spec covers every registered route', () => {
  it('CRITICAL both sides were actually discovered. Every assertion here reports an absence, so an empty route table or an empty spec satisfies all of them having compared nothing — and the route table in particular comes from a built app, which is exactly the kind of thing that returns nothing when a dependency fails to wire.', async () => {
    const { routes, specOps } = await surface();
    expect(routes.length, 'routes discovered from the built app').toBeGreaterThan(200);
    expect(specOps.size, 'operations declared in the OpenAPI spec').toBeGreaterThan(200);
    expect(
      routes.filter((r) => r.startsWith('GET /v1/sessions')),
      'a known customer route is present, so the tree parse produced real paths',
    ).toContain('GET /v1/sessions');
  }, 180000);

  it('CRITICAL every registered route is either in the spec or exactly one reviewed exemption. The spec generates the Python and Go SDKs, so a route missing from it is a route those SDKs cannot call — which is invisible from the server side, where the endpoint works perfectly.', async () => {
    const { routes, specOps } = await surface();
    const exempt = new Set([...NOT_CUSTOMER_API, ...DOCUMENTED_BUT_UNSPECCED]);
    const unaccounted = routes.filter((r) => !specOps.has(r) && !exempt.has(r)).sort();
    expect(
      [...new Set(unaccounted)],
      'registered route(s) with no spec entry and no exemption — add the spec entry, or classify it:',
    ).toEqual([]);
  }, 180000);

  it('CRITICAL every exemption is still a registered route. An entry for a route that no longer exists exempts nothing and reads as reviewed, which is the state that lets a real one be added beside it unnoticed.', async () => {
    const { routes } = await surface();
    const live = new Set(routes);
    const stale = [...NOT_CUSTOMER_API, ...DOCUMENTED_BUT_UNSPECCED].filter((e) => !live.has(e));
    expect(stale, 'exempted route(s) that are no longer registered — delete the entry').toEqual([]);
  }, 180000);

  it('CRITICAL the recorded gap has not grown, and nothing in it has quietly been reclassified as not-customer-API. These two are documented to customers and absent from the generated SDKs; the fix is a spec entry, not a longer list.', async () => {
    const { specOps } = await surface();
    expect(DOCUMENTED_BUT_UNSPECCED, 'the known-gap list is exactly these two').toEqual([
      'GET /v1/whoami',
      'POST /v1/sessions/:id/gui-input',
    ]);
    const closed = DOCUMENTED_BUT_UNSPECCED.filter((op) => specOps.has(op));
    expect(closed, 'gap(s) now covered by the spec — remove them from the list').toEqual([]);
  }, 180000);
});

// No response carrying caller-specific data is advertised as publicly
// cacheable, and the set that IS publicly cacheable is exactly the reviewed one.
//
// The failure this prevents is one of the worst an API can have and one of the
// quietest: a shared cache — a CDN, a corporate proxy, a browser's disk cache —
// storing one customer's response and serving it to another. Nothing in the
// server would error, no test would fail, and the first symptom is a customer
// seeing somebody else's account.
//
// `private-response-cache-cors` proves this for the SSE routes, where hijacked
// replies bypass Fastify's onSend hooks entirely. Individual suites assert it
// for the endpoints they cover. What neither can see is the POPULATION: whether
// the route added last week also sets the header.
//
// Both directions are pinned, because over-correcting is a real failure too.
// The public status endpoints are deliberately cacheable, and the rate-limit
// gates on that family are sized on the assumption that a CDN absorbs the
// normal read load (`status_incidents_list` and friends say so in their own
// comments). Slapping `no-store` across the board would quietly remove the
// protection those budgets depend on, so the cacheable set is asserted exactly
// rather than merely bounded.

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

interface Observed {
  op: string;
  secured: boolean;
  cacheControl: string;
}

const observed: Observed[] = [];

/**
 * Operations whose 2xx may be stored by a SHARED cache.
 *
 * Exact, and checked for staleness below. Every entry is public, static or
 * near-static, and account-independent: the archetype catalogue is the
 * pre-signup discovery surface, and the three status reads back the public
 * status page, whose rate-limit budgets assume a CDN in front of them.
 */
const PUBLICLY_CACHEABLE = [
  'GET /v1/archetypes',
  'GET /v1/status',
  'GET /v1/status/incidents',
  'GET /v1/status/sla',
];

beforeAll(async () => {
  fx = await buildTestApp({
    scopes: ['read', 'write', 'account_owner', 'driftstack_internal_admin'],
  });
  spec = (await fx.app.inject({ method: 'GET', url: '/openapi.json' })).json<SpecDocument>();

  for (const path of Object.keys(spec.paths ?? {})) {
    if (path.includes('{') || !path.startsWith('/v1/')) continue;
    const op = spec.paths?.[path]?.['get'];
    if (op === undefined) continue;
    // Streams hold the connection open; their cache posture is covered by
    // private-response-cache-cors, which reads them off a real socket.
    const responses = Object.values(op.responses ?? {});
    if (responses.some((r) => r.content?.['text/event-stream'] !== undefined)) continue;

    const res = await fx.app.inject({
      method: 'GET',
      url: path,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    if (res.statusCode < 200 || res.statusCode >= 300) continue;
    observed.push({
      op: `GET ${path}`,
      secured: op.security !== undefined,
      cacheControl: String(res.headers['cache-control'] ?? '<none>'),
    });
  }
}, 180_000);

afterAll(async () => {
  await fx.app.close();
});

describe('caller-private responses are never publicly cacheable', () => {
  it('CRITICAL the sweep reached a real population on both sides of the split. Every assertion below reports an ABSENCE, so a sweep that read nothing would satisfy them all.', () => {
    expect(observed.length, '2xx GET responses observed').toBeGreaterThan(40);
    expect(
      observed.filter((o) => o.secured).length,
      'authenticated responses observed',
    ).toBeGreaterThan(35);
    expect(observed.filter((o) => !o.secured).length, 'public responses observed').toBeGreaterThan(
      3,
    );
  });

  it('CRITICAL no authenticated response is advertised as publicly cacheable. A shared cache storing one of these and serving it to the next caller is a cross-account disclosure that nothing in the server would report.', () => {
    expect(
      observed.filter((o) => o.secured && /(^|[\s,])public([\s,]|$)/.test(o.cacheControl)),
      'authenticated response(s) advertising public caching:',
    ).toEqual([]);
  });

  it('CRITICAL every authenticated response actively forbids storage rather than merely omitting a directive. A missing header is not safe: shared caches apply heuristic freshness to a 200 that says nothing.', () => {
    const unprotected = observed
      .filter((o) => o.secured)
      .filter((o) => !(o.cacheControl.includes('no-store') && o.cacheControl.includes('private')))
      .map((o) => `${o.op} -> ${o.cacheControl}`);
    expect(unprotected, 'authenticated response(s) without no-store + private:').toEqual([]);
  });

  it('CRITICAL the publicly cacheable set is EXACTLY the reviewed list. This is the direction that fails silently in both ways — a per-caller response becoming cacheable, or a blanket no-store quietly removing the CDN absorption the status rate-limit budgets are sized against.', () => {
    const cacheable = observed
      .filter((o) => /(^|[\s,])public([\s,]|$)/.test(o.cacheControl))
      .map((o) => o.op)
      .sort();
    expect(cacheable, 'operations advertising public caching:').toEqual(
      [...PUBLICLY_CACHEABLE].sort(),
    );
  });

  it('CRITICAL /v1/egress/echo is UNAUTHENTICATED yet uncacheable, and that is not an oversight. It echoes the CALLER-S own exit IP, so a shared cache storing it would hand one probe another probe-S egress address — the one public response that must never be shared.', () => {
    const echo = observed.find((o) => o.op === 'GET /v1/egress/echo');
    expect(echo, 'the echo endpoint was reached').toBeDefined();
    expect(echo?.secured, 'it really is public — no security block').toBe(false);
    expect(echo?.cacheControl, 'and it still forbids storage').toContain('no-store');
    expect(echo?.cacheControl, 'and marks itself private').toContain('private');
  });
});

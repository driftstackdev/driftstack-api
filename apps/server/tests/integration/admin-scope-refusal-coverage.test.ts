// Every staff-only route refuses an ordinary customer key — proved by CALLING
// each one, not by reading its source.
//
// Motivation, measured rather than assumed. Disabling `requireScope` wholesale
// reds 96 tests across 35 files, so scope enforcement is broadly covered. But
// cross-referencing the 163 scope-enforcing routes against the tests that
// assert a refusal left 13 with no refusal coverage anywhere — 11 of them
// `driftstack_internal_admin`, including the OAuth client-secret routes. Those
// gates were enforced in source and simply never exercised, which means a
// future edit could delete one and the suite would stay green.
//
// This is table-driven off the route source rather than a hand-written list, so
// a NEW admin route is covered the day it is added instead of joining the gap.
//
// The refusal is asserted with a valid, ordinary customer key. That is the
// interesting case: an unauthenticated call is refused by `requireAuth`, which
// proves nothing about the scope gate behind it.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTES_DIR = resolve(HERE, '..', '..', 'src', 'routes');

const STAFF_SCOPE = 'driftstack_internal_admin';

interface StaffRoute {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  file: string;
}

/**
 * Registrations that enforce the staff scope, read from route source. The same
 * window technique the OpenAPI scope-disclosure invariant uses: attribute each
 * `requireScope` to the registration it follows.
 */
function staffRoutes(): StaffRoute[] {
  const out: StaffRoute[] = [];
  for (const file of readdirSync(ROUTES_DIR)) {
    if (!file.endsWith('.ts')) continue;
    const src = readFileSync(resolve(ROUTES_DIR, file), 'utf8');
    const regs = [
      ...src.matchAll(/\bapp\.(get|post|put|patch|delete)\b[^(]*\(\s*['"`](\/v1\/[^'"`]+)['"`]/g),
    ];
    regs.forEach((m, i) => {
      const start = m.index + m[0].length;
      const end = i + 1 < regs.length ? regs[i + 1]!.index : Math.min(src.length, start + 2500);
      if (!new RegExp(`requireScope\\(\\s*'${STAFF_SCOPE}'`).test(src.slice(start, end))) return;
      out.push({
        method: m[1]!.toUpperCase() as StaffRoute['method'],
        path: m[2]!,
        file,
      });
    });
  }
  return out.sort((a, b) => `${a.path}${a.method}`.localeCompare(`${b.path}${b.method}`));
}

/** Params are irrelevant — the scope gate is a preHandler and runs first. */
function concreteUrl(path: string): string {
  return path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '00000000-0000-4000-8000-000000000000');
}

/**
 * Staff routes `buildApp` does NOT register for an in-memory fixture, with the
 * exact dependency that gates each. They are listed rather than silently
 * skipped, and the suite asserts they really are absent — so if one becomes
 * registrable, this entry fails and the route moves into the proven set instead
 * of quietly keeping its exemption.
 *
 * The OAuth client routes are deliberately NOT here: their gate is
 * `deps.oauthStore`, which the fixture can now supply, so they are exercised
 * for real below.
 */
const NOT_REGISTERED_IN_MEMORY: Record<string, string> = {
  'GET /v1/mac-nodes': 'needs drizzleFleetNodesRepo + livekitSecretEncryptionKey',
  'POST /v1/mac-nodes': 'needs drizzleFleetNodesRepo + livekitSecretEncryptionKey',
  'POST /v1/mac-nodes/register': 'needs drizzleFleetNodesRepo + livekitSecretEncryptionKey',
  'POST /v1/mac-nodes/:id/control': 'needs drizzleFleetNodesRepo + livekitSecretEncryptionKey',
  'GET /v1/admin/atlas-priority/queue': 'atlas-priority surface is registered only when enabled',
  'GET /v1/admin/atlas-priority/event/:id':
    'atlas-priority surface is registered only when enabled',
};

/**
 * The staff surface, pinned.
 *
 * This roster is the load-bearing part of the file, not bookkeeping. Every case
 * below is generated from route source, so DELETING a gate removes that route
 * from its own table and the suite would go green with one fewer test —
 * verified by deleting one: 67 passed became 66 passed, all green. A scan that
 * grades itself cannot detect a deletion, so the expected set is pinned here
 * independently and compared.
 *
 * A diff means one of two things and both want a human: a staff gate was
 * removed (a customer can now reach staff data), or a staff route was added (it
 * needs a line here, and gains refusal coverage automatically).
 */
const EXPECTED_STAFF_ROUTES: readonly string[] = [
  'GET /v1/admin/accounts',
  'GET /v1/admin/accounts/:id',
  'POST /v1/admin/accounts/:id/audit-note',
  'POST /v1/admin/accounts/:id/delete',
  'DELETE /v1/admin/accounts/:id/quota-override',
  'POST /v1/admin/accounts/:id/quota-override',
  'POST /v1/admin/accounts/:id/refund-record',
  'POST /v1/admin/accounts/:id/suspend',
  'POST /v1/admin/accounts/:id/tier',
  'POST /v1/admin/accounts/:id/unsuspend',
  'GET /v1/admin/accounts/:id/usage',
  'GET /v1/admin/api-keys',
  'POST /v1/admin/api-keys/:id/revoke',
  'GET /v1/admin/atlas-priority/event/:id',
  'GET /v1/admin/atlas-priority/queue',
  'GET /v1/admin/audit-log',
  'GET /v1/admin/billing/subscriptions/stats',
  'GET /v1/admin/cost/accounts/:id',
  'GET /v1/admin/cost/config',
  'GET /v1/admin/cost/overview',
  'GET /v1/admin/crypto-orders',
  'GET /v1/admin/crypto-orders.csv',
  'GET /v1/admin/crypto-orders/:order_id',
  'POST /v1/admin/crypto-orders/:order_id/apply-ipn',
  'GET /v1/admin/crypto-orders/:order_id/events',
  'PATCH /v1/admin/crypto-orders/:order_id/internal-note',
  'GET /v1/admin/crypto-orders/daily',
  'GET /v1/admin/crypto-orders/idempotency-metrics',
  'GET /v1/admin/crypto-orders/pending-age',
  'GET /v1/admin/crypto-orders/stats',
  'POST /v1/admin/crypto-orders/sweep-expired',
  'GET /v1/admin/incidents',
  'POST /v1/admin/incidents',
  'GET /v1/admin/incidents/:id',
  'PUT /v1/admin/incidents/:id',
  'POST /v1/admin/incidents/:id/reopen',
  'POST /v1/admin/incidents/:id/resolve',
  'POST /v1/admin/incidents/:id/updates',
  'GET /v1/admin/oauth/clients',
  'POST /v1/admin/oauth/clients',
  'DELETE /v1/admin/oauth/clients/:id',
  'GET /v1/admin/oauth/clients/:id',
  'POST /v1/admin/oauth/clients/:id/rotate-secret',
  'GET /v1/admin/overview',
  'GET /v1/admin/rate-limit-overrides',
  'GET /v1/admin/sessions',
  'POST /v1/admin/sessions/:id/destroy',
  'GET /v1/admin/sessions/stats',
  'GET /v1/admin/status-subscribers',
  'POST /v1/admin/status-subscribers/:id/force-unsubscribe',
  'POST /v1/admin/status-subscribers/force-subscribe',
  'GET /v1/admin/usage/accounts/:id',
  'GET /v1/admin/validation-schedules',
  'PUT /v1/admin/validation-schedules',
  'DELETE /v1/admin/validation-schedules/:archetype',
  'POST /v1/admin/validation-schedules/:archetype/trigger',
  'GET /v1/admin/webhook-deliveries/:id',
  'POST /v1/admin/webhook-deliveries/:id/replay',
  'GET /v1/admin/webhook-dlq',
  'POST /v1/admin/webhook-dlq/:id/discard',
  'POST /v1/admin/webhook-dlq/:id/requeue',
  'GET /v1/mac-nodes',
  'POST /v1/mac-nodes',
  'POST /v1/mac-nodes/:id/control',
  'POST /v1/mac-nodes/register',
];

let fx: TestAppFixture | null = null;

afterEach(async () => {
  if (fx) await fx.cleanup();
  fx = null;
});

describe('staff-only routes refuse an ordinary customer key', () => {
  const routes = staffRoutes();

  it('CRITICAL the set of staff-gated routes matches the pinned roster EXACTLY. Every case below is generated from route source, so deleting a gate would drop that route from its own table and the suite would pass with one fewer test — verified by deleting one (67 passed became 66 passed, all green). This comparison is the only thing that can see a deletion.', () => {
    const found = routes.map((r) => `${r.method} ${r.path}`).sort();
    const expected = [...EXPECTED_STAFF_ROUTES].sort();
    const lostGate = expected.filter((r) => !found.includes(r));
    const newRoute = found.filter((r) => !expected.includes(r));
    expect(
      lostGate,
      'Route(s) that no longer enforce the staff scope — a customer key may now reach staff data:',
    ).toEqual([]);
    expect(
      newRoute,
      'New staff route(s) — add them to EXPECTED_STAFF_ROUTES; refusal coverage then applies automatically:',
    ).toEqual([]);
  });

  const exercised = routes.filter(
    (r) => NOT_REGISTERED_IN_MEMORY[`${r.method} ${r.path}`] === undefined,
  );
  const exempt = routes.filter(
    (r) => NOT_REGISTERED_IN_MEMORY[`${r.method} ${r.path}`] !== undefined,
  );

  it.each(exercised.map((r) => [`${r.method} ${r.path}`, r] as const))(
    'CRITICAL %s refuses a valid customer key. It enforces the staff scope in source; without a call that proves it, deleting the gate would leave the suite green while a customer reached staff data.',
    async (_label, route) => {
      fx = await buildTestApp({ scopes: ['read', 'write'], withOauthStore: true });
      const res = await fx.app.inject({
        method: route.method,
        url: concreteUrl(route.path),
        headers: { authorization: `Bearer ${fx.plaintext}` },
        ...(route.method === 'GET' || route.method === 'DELETE' ? {} : { payload: {} }),
      });

      // 403 is the contract. Anything 2xx means a customer key reached a staff
      // surface. A 404 would mean the route is not registered, which makes the
      // assertion vacuous rather than passing — hence the explicit check.
      expect(
        res.statusCode,
        `${route.method} ${route.path} (${route.file}) returned ${res.statusCode}, expected 403`,
      ).toBe(403);
    },
  );

  it.each(exempt.map((r) => [`${r.method} ${r.path}`, r] as const))(
    '%s is genuinely absent from an in-memory fixture, so its exemption is still accurate rather than stale cover for a regression',
    async (label, route) => {
      fx = await buildTestApp({ scopes: ['read', 'write'], withOauthStore: true });
      const res = await fx.app.inject({
        method: route.method,
        url: concreteUrl(route.path),
        headers: { authorization: `Bearer ${fx.plaintext}` },
        ...(route.method === 'GET' || route.method === 'DELETE' ? {} : { payload: {} }),
      });
      expect(
        res.statusCode,
        `${label} now responds ${res.statusCode} — it is registrable after all, so drop its NOT_REGISTERED_IN_MEMORY entry and let the refusal case above cover it`,
      ).toBe(404);
    },
  );

  it('every exemption names a route that still exists, so the list cannot outlive the routes it excuses', () => {
    const known = new Set(routes.map((r) => `${r.method} ${r.path}`));
    const stale = Object.keys(NOT_REGISTERED_IN_MEMORY).filter((k) => !known.has(k));
    expect(stale, 'exemption(s) for routes that no longer enforce the staff scope:').toEqual([]);
  });
});

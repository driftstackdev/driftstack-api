// The device-key deny-gate is a GLOBAL preHandler, so it runs before the
// route's own requireAuth. To read the caller's provenance it has to
// lazy-authenticate — and when that lazy auth fails it deliberately SWALLOWS
// the error and defers to the route:
//
//     if (request.account === null) {
//       try { await app.requireAuth(request, reply); } catch { return; }
//     }
//
// That swallow is the gate staying ADDITIVE: it only ever adds a 403 for a
// positively-identified device key, and never becomes the primary
// authenticator. An unauthenticated caller cannot be a device key, so the gate
// has nothing to say and the route answers.
//
// Turning that `catch { return; }` into a rethrow reds NOTHING in the existing
// device-key suites (measured: 0 of 49, while removing the deny itself reds 24
// and removing the lazy-auth pre-check reds 24). The reason is that on an
// ordinary deny-set route both behaviours end at 401 — the route's own
// requireAuth throws the same error the gate would have. The difference is only
// visible on a route that carries NO requireAuth of its own: a feature-disabled
// STUB, which must answer 503 "unavailable" rather than 401 "unauthenticated".
//
// This file builds exactly that shape: a deny-set route registered as a stub,
// with a requireAuth that always fails, and asserts the ROUTE answers.

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { registerDeviceKeyDenyGate } from '../../src/middleware/device-key-deny.js';
import { registerErrorHandler } from '../../src/middleware/error-handler.js';
import { UnauthorizedError } from '../../src/lib/errors.js';

// POST:/v1/webhooks is in DEVICE_KEY_DENY_ROUTES — the webhook-write vector
// the gate exists to close. Using a real member of the set keeps this test
// honest: if the route were dropped from the set, the gate would stop firing
// here and the arms below would stop meaning anything.
const DENIED_ROUTE = '/v1/webhooks';

let app: FastifyInstance | null = null;

afterEach(async () => {
  if (app) await app.close();
  app = null;
});

/** A stub route: no requireAuth of its own, answers 503 like a
 *  feature-disabled surface does. `requireAuth` always fails, standing in for
 *  an absent or invalid credential. */
async function buildStubApp(opts: {
  account?: unknown;
  onRequireAuth?: () => void;
}): Promise<FastifyInstance> {
  const instance = Fastify({ logger: false });
  registerErrorHandler(instance);
  instance.decorateRequest('account', null);
  instance.decorate('requireAuth', () => {
    if (opts.onRequireAuth) opts.onRequireAuth();
    throw new UnauthorizedError('No credentials on this request.');
  });
  instance.addHook('onRequest', (req, _reply, done) => {
    // Whatever the fixture wants request.account to be when the gate runs.
    (req as unknown as { account: unknown }).account = opts.account ?? null;
    done();
  });
  registerDeviceKeyDenyGate(instance);
  instance.post(DENIED_ROUTE, () => ({ stub: true, reason: 'feature disabled' }));
  await instance.ready();
  return instance;
}

describe('device-key deny-gate defers to the route when its lazy auth fails', () => {
  it('CRITICAL an unauthenticated caller on a deny-set STUB route gets the route answer, not the gate 401', async () => {
    // This is the only arm holding the swallow up. With `catch { return; }`
    // changed to a rethrow, the gate becomes the primary authenticator and
    // this 200 turns into a 401.
    let authAttempts = 0;
    app = await buildStubApp({ onRequireAuth: () => (authAttempts += 1) });
    const res = await app.inject({ method: 'POST', url: DENIED_ROUTE, payload: {} });

    expect(
      authAttempts,
      'the gate must actually attempt the lazy auth — otherwise this arm proves nothing about the swallow',
    ).toBe(1);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ stub: true });
  });

  it('CRITICAL a device-provisioned key is still refused on that same route (the gate is additive, not disabled)', async () => {
    // Positive control for the arm above: the deferral must not be a blanket
    // bypass. With a positively-identified device key the gate still refuses,
    // and it never consults requireAuth because the account is already known.
    let authAttempts = 0;
    app = await buildStubApp({
      account: { apiKey: { provenance: 'cli_device' } },
      onRequireAuth: () => (authAttempts += 1),
    });
    const res = await app.inject({ method: 'POST', url: DENIED_ROUTE, payload: {} });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ detail: string }>().detail).toContain('device-provisioned key');
    expect(authAttempts, 'an already-authenticated request needs no lazy auth').toBe(0);
  });

  it('an ordinary key reaches the route untouched', async () => {
    // The gate is scoped to device keys; every other provenance passes.
    app = await buildStubApp({ account: { apiKey: { provenance: 'dashboard' } } });
    const res = await app.inject({ method: 'POST', url: DENIED_ROUTE, payload: {} });

    expect(res.statusCode).toBe(200);
  });
});

// S15 audit fix #5 — the owner-only tools also require the staff scope.
//
// Rate-card publish and withdraw, and every route in `admin-owner.ts` (pricing,
// platform secrets, platform status), were gated by `app.requireOwner` alone:
// an identity check on the ACCOUNT, never the KEY. So any key on the owner's
// account — a `read`-only key made for a dashboard, say — could publish a rate
// card, withdraw one, reprice a tier or reveal a platform secret, while the
// same key got 403 on every ordinary staff read.
//
// Each of those routes now runs `requireScope('driftstack_internal_admin')`
// BEFORE `requireOwner`: the key must be a staff key, and it must be the
// owner's.
//
// No database: every refusal here happens in the preHandler chain, before the
// handler reads anything, and the positive controls stop at the handler's own
// body validation — which is exactly the proof that both gates were passed.

import { afterEach, describe, expect, it } from 'vitest';
import type { AiCreditsRuntime } from '../../src/services/ai-credits-runtime.js';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

const OWNER_EMAIL = 'owner-scope-fix@driftstack.test';

/** A credits runtime nothing here may reach: every member rejects. */
function unreachableRuntime(): AiCreditsRuntime {
  const unreachable = (): Promise<never> =>
    Promise.reject(new Error('a refused request must not reach the credits runtime'));
  return {
    mode: 'enforce',
    bootId: 'boot-owner-scope-test',
    reservations: {
      reserve: unreachable,
      settle: unreachable,
      planCall: unreachable,
      admitCall: unreachable,
      markSent: unreachable,
      settleCall: unreachable,
    },
    leaseKeeper: { add: () => undefined, remove: () => undefined, liveCount: () => 0 },
    report: { shadowReport: unreachable, census: unreachable },
    accounts: {
      ensureAccount: unreachable,
      setAiSource: unreachable,
      spendableMicro: unreachable,
      otherLiveGrantedMicro: unreachable,
      chargedInWindowMicro: unreachable,
    },
    windows: { currentWindow: unreachable },
  };
}

const OWNER_ONLY_ROUTES: ReadonlyArray<{
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly url: string;
  readonly payload?: Record<string, unknown>;
}> = [
  { method: 'POST', url: '/v1/admin/credit-rate-cards', payload: {} },
  { method: 'POST', url: '/v1/admin/credit-rate-cards/1/withdraw' },
  { method: 'GET', url: '/v1/admin/owner/platform-status' },
  { method: 'GET', url: '/v1/admin/owner/pricing' },
  { method: 'PATCH', url: '/v1/admin/owner/pricing/api_builder', payload: { monthly_cents: 100 } },
  { method: 'GET', url: '/v1/admin/owner/secrets' },
  { method: 'PUT', url: '/v1/admin/owner/secrets/EXAMPLE_SECRET', payload: { value: 'x' } },
  { method: 'POST', url: '/v1/admin/owner/secrets/EXAMPLE_SECRET/reveal' },
  { method: 'DELETE', url: '/v1/admin/owner/secrets/EXAMPLE_SECRET' },
];

describe('the owner-only tools refuse an owner key without the staff scope', () => {
  let fx: TestAppFixture | null = null;
  afterEach(async () => {
    if (fx) await fx.cleanup();
    fx = null;
  });

  for (const route of OWNER_ONLY_ROUTES) {
    it(`CRITICAL ${route.method} ${route.url} — a key on the OWNER's account with scopes ['read'] is 403`, async () => {
      fx = await buildTestApp({
        aiCredits: unreachableRuntime(),
        email: OWNER_EMAIL,
        ownerEmail: OWNER_EMAIL,
        scopes: ['read'],
      });
      const res = await fx.app.inject({
        method: route.method,
        url: route.url,
        headers: { authorization: `Bearer ${fx.plaintext}` },
        ...(route.payload === undefined ? {} : { payload: route.payload }),
      });
      expect(res.statusCode, res.body).toBe(403);
    });
  }

  it('CONTROL — the owner with the staff scope passes both gates: platform status answers 200', async () => {
    fx = await buildTestApp({
      aiCredits: unreachableRuntime(),
      email: OWNER_EMAIL,
      ownerEmail: OWNER_EMAIL,
      scopes: ['read', 'driftstack_internal_admin'],
    });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/admin/owner/platform-status',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode, res.body).toBe(200);
  });

  it('CONTROL — the owner with the staff scope reaches the publish handler: an empty body is its own 400, not a 403', async () => {
    fx = await buildTestApp({
      aiCredits: unreachableRuntime(),
      email: OWNER_EMAIL,
      ownerEmail: OWNER_EMAIL,
      scopes: ['read', 'driftstack_internal_admin'],
    });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/credit-rate-cards',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    expect(res.statusCode, res.body).toBe(400);
  });

  it('the owner gate still stands: a staff key that is NOT the owner is 403 on publish and on withdraw', async () => {
    fx = await buildTestApp({
      aiCredits: unreachableRuntime(),
      email: 'staff-not-owner-scope-fix@driftstack.test',
      ownerEmail: OWNER_EMAIL,
      scopes: ['read', 'driftstack_internal_admin'],
    });
    for (const url of ['/v1/admin/credit-rate-cards', '/v1/admin/credit-rate-cards/1/withdraw']) {
      const res = await fx.app.inject({
        method: 'POST',
        url,
        headers: { authorization: `Bearer ${fx.plaintext}` },
        payload: {},
      });
      expect(res.statusCode, `${url}: ${res.body}`).toBe(403);
    }
  });
});

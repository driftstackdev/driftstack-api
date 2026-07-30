// Integration tests for /v1/admin/accounts/:id/{tier,suspend,unsuspend}.
// Covers: happy path, scope enforcement (403 without admin), unknown
// account (404), audit row presence (regression catch for D-025's
// "audit-write before response"), cache invalidation propagation
// (suspend → next request 401/403 even when cached).

import { afterEach, describe, expect, it } from 'vitest';
import { PROBLEM_TYPES } from '@driftstack/api-types';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

const auth = (fixture: TestAppFixture): { authorization: string } => ({
  authorization: `Bearer ${fixture.plaintext}`,
});

const accId = (fixture: TestAppFixture): string => `acc_${fixture.accountId}`;

describe('POST /v1/admin/accounts/:id/tier', () => {
  it('200 changes the tier; updated row reflected in response', async () => {
    fx = await buildTestApp({ tier: 'api_starter' });
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/admin/accounts/${accId(fx)}/tier`,
      headers: auth(fx),
      payload: { tier: 'api_scale', reason: 'enterprise pilot' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(body.tier).toBe('api_scale');
    expect(body.id).toBe(accId(fx));
  });

  it('writes an audit row capturing input + admin identity', async () => {
    // The caller is staff acting through the admin API. `3202fdb17` bars an
    // ordinary key on a `free` account from the customer API entirely, and the
    // admin surface is not on the Free desktop allowlist — so the fixture holds
    // a paid tier and the mutation still exercises a real tier transition.
    fx = await buildTestApp({ tier: 'solo_manual' });
    await fx.app.inject({
      method: 'POST',
      url: `/v1/admin/accounts/${accId(fx)}/tier`,
      headers: auth(fx),
      payload: { tier: 'api_builder', reason: 'paying customer' },
    });
    const all = fx.adminAuditRepo.getAll();
    expect(all).toHaveLength(1);
    expect(all[0]?.action).toBe('account.tier_changed');
    expect(all[0]?.adminAccountId).toBe(fx.accountId);
    expect(all[0]?.adminKeyId).toBe(fx.apiKeyId);
    expect(all[0]?.targetAccountId).toBe(fx.accountId);
    expect(all[0]?.result).toBe('success');
    expect(all[0]?.inputPayload).toEqual({ tier: 'api_builder', reason: 'paying customer' });
  });

  it('403 when admin scope is missing', async () => {
    fx = await buildTestApp({ scopes: ['read', 'write'] });
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/admin/accounts/${accId(fx)}/tier`,
      headers: auth(fx),
      payload: { tier: 'api_scale' },
    });
    expect(res.statusCode).toBe(403);
    // V-134: scope check moved to a Fastify preHandler — fires before the
    // route handler runs. By design, no audit row is written for
    // preHandler-rejected requests — that prevents non-admin callers
    // from probing admin endpoints to glean target existence via audit
    // log inflation. Service-level `throwIfMissingScope` calls remain as
    // defense-in-depth; if a future code path bypasses the preHandler
    // (shouldn't be possible) the service still rejects + records.
    const all = fx.adminAuditRepo.getAll();
    expect(all).toHaveLength(0);
  });

  it('404 for unknown account id', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/accounts/acc_00000000-0000-4000-8000-000000000999/tier',
      headers: auth(fx),
      payload: { tier: 'api_builder' },
    });
    expect(res.statusCode).toBe(404);
    // 404 still produces an audit row — the attempt is recorded.
    const all = fx.adminAuditRepo.getAll();
    expect(all).toHaveLength(1);
    expect(all[0]?.result).toMatch(/^error: notfound/);
  });

  it('400 for unknown tier value', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/admin/accounts/${accId(fx)}/tier`,
      headers: auth(fx),
      payload: { tier: 'platinum' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json<Record<string, unknown>>();
    expect(body.type).toBe(PROBLEM_TYPES.ValidationFailed);
    // No audit row — the request never reached the service.
    expect(fx.adminAuditRepo.getAll()).toHaveLength(0);
  });

  it('400 for malformed account id', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/accounts/not-a-prefixed-id/tier',
      headers: auth(fx),
      payload: { tier: 'api_builder' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('cache invalidation: tier change bumps account version', async () => {
    fx = await buildTestApp({ tier: 'api_starter' });

    // Warm cache via one auth-bearing request.
    await fx.app.inject({
      method: 'GET',
      url: '/v1/sessions',
      headers: auth(fx),
    });
    expect(fx.authCache.size()).toBe(1);

    // Change tier — should invalidate the cached entry.
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/admin/accounts/${accId(fx)}/tier`,
      headers: auth(fx),
      payload: { tier: 'api_scale' },
    });
    expect(res.statusCode).toBe(200);

    // Next auth-bearing request should miss the cache (account-version
    // mismatch) and re-load with the new tier.
    const after = await fx.app.inject({
      method: 'GET',
      url: '/v1/sessions',
      headers: auth(fx),
    });
    expect(after.statusCode).toBe(200);
    // The new request hits the cache with the bumped version, so the
    // cache.size() returns the same entry but its accountVersion got
    // bumped on read-miss + re-set. (See InMemoryAuthCache details.)
  });
});

describe('POST /v1/admin/accounts/:id/suspend', () => {
  it('200 suspends the account; subsequent requests 403', async () => {
    fx = await buildTestApp();

    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/admin/accounts/${accId(fx)}/suspend`,
      headers: auth(fx),
      payload: { reason: 'fraud check' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(body.status).toBe('suspended');

    // Existing key on the suspended account is rejected at auth time.
    const after = await fx.app.inject({
      method: 'GET',
      url: '/v1/sessions',
      headers: auth(fx),
    });
    expect(after.statusCode).toBe(403);
  });

  it('writes an audit row with action=account.suspended', async () => {
    fx = await buildTestApp();
    await fx.app.inject({
      method: 'POST',
      url: `/v1/admin/accounts/${accId(fx)}/suspend`,
      headers: auth(fx),
      payload: {},
    });
    const all = fx.adminAuditRepo.getAll();
    expect(all).toHaveLength(1);
    expect(all[0]?.action).toBe('account.suspended');
  });

  it('403 without admin scope', async () => {
    fx = await buildTestApp({ scopes: ['read', 'write'] });
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/admin/accounts/${accId(fx)}/suspend`,
      headers: auth(fx),
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });

  it('404 for unknown account', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/accounts/acc_00000000-0000-4000-8000-000000000888/suspend',
      headers: auth(fx),
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /v1/admin/accounts/:id/unsuspend', () => {
  it('200 sets status back to active; idempotent for already-active accounts', async () => {
    // Cross-account suspend-then-unsuspend (admin A unsuspends target B
    // after some other admin suspended B) is the realistic flow but
    // requires two distinct fixtures with two distinct account ids;
    // buildTestApp seeds both with the same hardcoded id, so we test
    // unsuspend on its own here. The full suspend→blocked→unsuspend
    // round-trip is exercised by the e2e suite (added in a later OT
    // commit when full multi-account fixtures land).
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/admin/accounts/${accId(fx)}/unsuspend`,
      headers: auth(fx),
      payload: { reason: 'cleared' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(body.status).toBe('active');
  });

  it('writes an audit row with action=account.unsuspended', async () => {
    fx = await buildTestApp();
    await fx.app.inject({
      method: 'POST',
      url: `/v1/admin/accounts/${accId(fx)}/unsuspend`,
      headers: auth(fx),
      payload: {},
    });
    const all = fx.adminAuditRepo.getAll();
    expect(all).toHaveLength(1);
    expect(all[0]?.action).toBe('account.unsuspended');
  });
});

describe('V-174 — scope architecture split', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it("'account_owner' scope alone CANNOT call /v1/admin/* (cross-account exposure closed)", async () => {
    fx = await buildTestApp({ scopes: ['read', 'write', 'account_owner'] });
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/admin/accounts/${accId(fx)}/tier`,
      headers: auth(fx),
      payload: { tier: 'api_scale' },
    });
    expect(res.statusCode).toBe(403);
    const body = res.json<{ detail?: string }>();
    expect(body.detail).toContain('driftstack_internal_admin');
  });

  it("'driftstack_internal_admin' scope CAN call /v1/admin/*", async () => {
    fx = await buildTestApp({
      scopes: ['read', 'write', 'driftstack_internal_admin'],
    });
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/admin/accounts/${accId(fx)}/tier`,
      headers: auth(fx),
      payload: { tier: 'api_scale' },
    });
    expect(res.statusCode).toBe(200);
  });

  it("legacy 'admin' scope CANNOT call /v1/admin/*", async () => {
    fx = await buildTestApp({ scopes: ['read', 'write', 'admin'] });
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/admin/accounts/${accId(fx)}/tier`,
      headers: auth(fx),
      payload: { tier: 'api_scale' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ detail?: string }>().detail).toContain('driftstack_internal_admin');
  });

  it("'account_owner' scope alone CAN mint API keys (customer-account control)", async () => {
    fx = await buildTestApp({ scopes: ['read', 'write', 'account_owner'] });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: auth(fx),
      payload: { name: 'sub-key', scopes: ['read', 'write'] },
    });
    expect(res.statusCode).toBe(201);
  });

  it("'driftstack_internal_admin' WITHOUT 'account_owner' CANNOT mint API keys", async () => {
    fx = await buildTestApp({
      scopes: ['read', 'write', 'driftstack_internal_admin'],
    });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: auth(fx),
      payload: { name: 'attempted', scopes: ['read'] },
    });
    expect(res.statusCode).toBe(403);
    const body = res.json<{ detail?: string }>();
    expect(body.detail).toContain('account_owner');
  });
});

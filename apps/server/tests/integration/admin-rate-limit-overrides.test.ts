// Integration tests for /v1/admin/accounts/:id/quota-override (set + clear).
//
// Covers happy path, audit-row presence (success + error), 403/404
// shapes, the consume-path R2 integration (override loaded into
// AccountContext takes effect; clear restores tier defaults; expired
// override falls through), and the multi-bucket non-interference
// guarantee.

import { afterEach, describe, expect, it } from 'vitest';
import { rateLimitConsume } from '../../src/services/rate-limit.js';
import { MemoryRateLimitStore } from '../../src/lib/memory-rate-limit-store.js';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

const auth = (fixture: TestAppFixture): { authorization: string } => ({
  authorization: `Bearer ${fixture.plaintext}`,
});

const accId = (fixture: TestAppFixture): string => `acc_${fixture.accountId}`;

describe('POST /v1/admin/accounts/:id/quota-override', () => {
  it('200 stores the override + returns the public shape', async () => {
    fx = await buildTestApp({ tier: 'api_starter' });
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/admin/accounts/${accId(fx)}/quota-override`,
      headers: auth(fx),
      payload: {
        bucket_key: 'global',
        capacity: 5000,
        refill_per_second: 50,
        duration_seconds: 3600,
        reason: 'enterprise pilot',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(body.account_id).toBe(accId(fx));
    expect(body.bucket_key).toBe('global');
    expect(body.capacity).toBe(5000);
    expect(body.refill_per_second).toBe(50);
    expect(body.reason).toBe('enterprise pilot');
    expect(typeof body.expires_at).toBe('string');
  });

  it('writes audit row with action=rate_limit_override.set', async () => {
    fx = await buildTestApp();
    await fx.app.inject({
      method: 'POST',
      url: `/v1/admin/accounts/${accId(fx)}/quota-override`,
      headers: auth(fx),
      payload: {
        bucket_key: 'global',
        capacity: 1000,
        refill_per_second: 10,
        duration_seconds: 600,
      },
    });
    const all = fx.adminAuditRepo.getAll();
    expect(all).toHaveLength(1);
    expect(all[0]?.action).toBe('rate_limit_override.set');
    expect(all[0]?.targetAccountId).toBe(fx.accountId);
    expect(all[0]?.targetResourceId).toBe('global');
    expect(all[0]?.result).toBe('success');
  });

  it('upserts (re-setting same bucket replaces capacity + refill)', async () => {
    fx = await buildTestApp();

    await fx.app.inject({
      method: 'POST',
      url: `/v1/admin/accounts/${accId(fx)}/quota-override`,
      headers: auth(fx),
      payload: {
        bucket_key: 'global',
        capacity: 100,
        refill_per_second: 1,
        duration_seconds: 600,
      },
    });

    const second = await fx.app.inject({
      method: 'POST',
      url: `/v1/admin/accounts/${accId(fx)}/quota-override`,
      headers: auth(fx),
      payload: {
        bucket_key: 'global',
        capacity: 9999,
        refill_per_second: 99,
        duration_seconds: 600,
      },
    });
    expect(second.statusCode).toBe(200);
    expect(fx.rateLimitOverridesRepo.getAll()).toHaveLength(1);
    expect(fx.rateLimitOverridesRepo.getAll()[0]?.capacity).toBe(9999);
  });

  it('400 unknown bucket_key', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/admin/accounts/${accId(fx)}/quota-override`,
      headers: auth(fx),
      payload: {
        bucket_key: 'nope',
        capacity: 100,
        refill_per_second: 1,
        duration_seconds: 600,
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('400 capacity must be positive', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/admin/accounts/${accId(fx)}/quota-override`,
      headers: auth(fx),
      payload: {
        bucket_key: 'global',
        capacity: 0,
        refill_per_second: 1,
        duration_seconds: 600,
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('403 without admin scope', async () => {
    fx = await buildTestApp({ scopes: ['read', 'write'] });
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/admin/accounts/${accId(fx)}/quota-override`,
      headers: auth(fx),
      payload: {
        bucket_key: 'global',
        capacity: 100,
        refill_per_second: 1,
        duration_seconds: 600,
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it('200 with driftstack_internal_admin scope (V-174 — staff SSO sessions carry driftstack_internal_admin, NOT legacy admin)', async () => {
    // The route gates on driftstack_internal_admin; the service must
    // accept the same scope. Pre-fix the service required literal
    // 'admin', so staff sessions got 403 despite passing the route gate.
    fx = await buildTestApp({
      scopes: ['read', 'write', 'account_owner', 'driftstack_internal_admin'],
    });
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/admin/accounts/${accId(fx)}/quota-override`,
      headers: auth(fx),
      payload: {
        bucket_key: 'global',
        capacity: 100,
        refill_per_second: 1,
        duration_seconds: 600,
      },
    });
    expect(res.statusCode).toBe(200);
  });

  it('404 unknown account', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/admin/accounts/acc_00000000-0000-4000-8000-000000000999/quota-override',
      headers: auth(fx),
      payload: {
        bucket_key: 'global',
        capacity: 100,
        refill_per_second: 1,
        duration_seconds: 600,
      },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('DELETE /v1/admin/accounts/:id/quota-override', () => {
  async function seedOverride(fixture: TestAppFixture): Promise<void> {
    await fixture.app.inject({
      method: 'POST',
      url: `/v1/admin/accounts/${accId(fixture)}/quota-override`,
      headers: auth(fixture),
      payload: {
        bucket_key: 'global',
        capacity: 100,
        refill_per_second: 1,
        duration_seconds: 3600,
      },
    });
  }

  it('204 clears the override; subsequent same-bucket lookup returns no override', async () => {
    fx = await buildTestApp();
    await seedOverride(fx);
    expect(fx.rateLimitOverridesRepo.getAll()).toHaveLength(1);

    const res = await fx.app.inject({
      method: 'DELETE',
      url: `/v1/admin/accounts/${accId(fx)}/quota-override?bucket_key=global`,
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(204);
    expect(fx.rateLimitOverridesRepo.getAll()).toHaveLength(0);
  });

  it('writes audit row with action=rate_limit_override.cleared', async () => {
    fx = await buildTestApp();
    await seedOverride(fx);
    const auditBefore = fx.adminAuditRepo.getAll().length;

    await fx.app.inject({
      method: 'DELETE',
      url: `/v1/admin/accounts/${accId(fx)}/quota-override?bucket_key=global`,
      headers: auth(fx),
    });
    const all = fx.adminAuditRepo.getAll();
    expect(all.length).toBe(auditBefore + 1);
    const last = all[all.length - 1];
    expect(last?.action).toBe('rate_limit_override.cleared');
    expect(last?.targetResourceId).toBe('global');
    expect(last?.result).toBe('success');
  });

  it('404 + audit row when no override exists for that bucket', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'DELETE',
      url: `/v1/admin/accounts/${accId(fx)}/quota-override?bucket_key=global`,
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(404);
    const last = fx.adminAuditRepo.getAll().slice(-1)[0];
    expect(last?.action).toBe('rate_limit_override.cleared');
    expect(last?.result).toMatch(/^error: notfound/);
  });

  it('400 missing bucket_key query param', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'DELETE',
      url: `/v1/admin/accounts/${accId(fx)}/quota-override`,
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(400);
  });

  it('403 without admin scope', async () => {
    fx = await buildTestApp({ scopes: ['read', 'write'] });
    const res = await fx.app.inject({
      method: 'DELETE',
      url: `/v1/admin/accounts/${accId(fx)}/quota-override?bucket_key=global`,
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('R2 consume-path integration', () => {
  it('override loaded into AccountContext takes effect on rateLimitConsume', async () => {
    // Build an override, then call rateLimitConsume directly with an
    // override record passed through the input — this isolates the
    // consume-path math from the auth/cache plumbing. (The HTTP path
    // is exercised separately.)
    const store = new MemoryRateLimitStore();
    const override = {
      bucketKey: 'global',
      capacity: 5,
      refillPerSecond: 0.001, // ~no refill during the test window
      expiresAt: new Date(Date.now() + 60_000),
    };
    const overrides = { global: override };

    // Drain the bucket: 5 consumes succeed, 6th is denied.
    for (let i = 0; i < 5; i++) {
      const r = await rateLimitConsume(store, {
        accountId: 'acc-1',
        tier: 'enterprise', // enterprise has 60_000 capacity normally — proves override wins
        bucketKey: 'global',
        overrides,
      });
      expect(r.allowed).toBe(true);
    }
    const denied = await rateLimitConsume(store, {
      accountId: 'acc-1',
      tier: 'enterprise',
      bucketKey: 'global',
      overrides,
    });
    expect(denied.allowed).toBe(false);
  });

  it('expired override falls through to tier default', async () => {
    const store = new MemoryRateLimitStore();
    const expired = {
      bucketKey: 'global',
      capacity: 1, // tiny, would block almost immediately
      refillPerSecond: 0.001,
      expiresAt: new Date(Date.now() - 1000), // 1s in the past
    };
    const overrides = { global: expired };

    // Tier 'free' default capacity for 'global' is 60. Since the
    // override is expired, the consume path should use 60.
    for (let i = 0; i < 60; i++) {
      const r = await rateLimitConsume(store, {
        accountId: 'acc-1',
        tier: 'free',
        bucketKey: 'global',
        overrides,
      });
      expect(r.allowed).toBe(true);
    }
  });

  it('override on one bucket does not affect another bucket', async () => {
    const store = new MemoryRateLimitStore();
    const overrides = {
      'sessions:create': {
        bucketKey: 'sessions:create',
        capacity: 1,
        refillPerSecond: 0.001,
        expiresAt: new Date(Date.now() + 60_000),
      },
    };

    // 'global' bucket has no override — tier 'starter' default is
    // capacity 120, refill 2/s. 5 consumes should all pass.
    for (let i = 0; i < 5; i++) {
      const r = await rateLimitConsume(store, {
        accountId: 'acc-1',
        tier: 'api_starter',
        bucketKey: 'global',
        overrides,
      });
      expect(r.allowed).toBe(true);
    }

    // 'sessions:create' bucket: override capacity=1 wins. First passes,
    // second denied.
    const ok = await rateLimitConsume(store, {
      accountId: 'acc-1',
      tier: 'api_starter',
      bucketKey: 'sessions:create',
      overrides,
    });
    expect(ok.allowed).toBe(true);
    const denied = await rateLimitConsume(store, {
      accountId: 'acc-1',
      tier: 'api_starter',
      bucketKey: 'sessions:create',
      overrides,
    });
    expect(denied.allowed).toBe(false);
  });

  it('end-to-end via HTTP: setting an override is visible to the next request', async () => {
    // Paid tier: this case drives BOTH an admin route (to set the override) and
    // a customer route (to observe it on the next auth-cache fill) with one
    // credential. After `3202fdb17` no single Free credential can do both — an
    // ordinary key is refused at the customer-API boundary, and the desktop
    // credential is barred from the admin surface. The override capacity being
    // asserted is tier-independent, so the tier here is incidental.
    fx = await buildTestApp({ tier: 'api_builder' });

    // Warm the cache (loads AccountContext with no overrides).
    const before = await fx.app.inject({
      method: 'GET',
      url: '/v1/sessions',
      headers: auth(fx),
    });
    expect(before.statusCode).toBe(200);

    // Set override on global bucket — invalidates auth cache.
    await fx.app.inject({
      method: 'POST',
      url: `/v1/admin/accounts/${accId(fx)}/quota-override`,
      headers: auth(fx),
      payload: {
        bucket_key: 'global',
        capacity: 9999,
        refill_per_second: 99,
        duration_seconds: 60,
      },
    });

    // Trigger a fresh auth cache fill — the new ctx should carry the
    // override.
    await fx.app.inject({
      method: 'GET',
      url: '/v1/sessions',
      headers: auth(fx),
    });

    // Check the cached context now includes the override.
    const sha = await import('node:crypto').then((c) =>
      c.createHash('sha256').update(fx.plaintext).digest('hex'),
    );
    const cached = await fx.authCache.get(sha);
    expect(cached?.rateLimitOverrides.global?.capacity).toBe(9999);
  });
});

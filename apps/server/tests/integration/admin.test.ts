// Integration tests for admin endpoints (api-keys + usage).

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

describe('POST /v1/api-keys', () => {
  it('201 returns plaintext + key shape', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: auth(fx),
      payload: { name: 'ci-key', scopes: ['read', 'write'] },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<Record<string, unknown>>();
    expect(typeof body.plaintext).toBe('string');
    expect((body.plaintext as string).startsWith('ds_live_')).toBe(true);
    expect(body.id).toMatch(/^key_[0-9a-f-]{36}$/);
    expect(body.name).toBe('ci-key');
    expect(body.scopes).toEqual(['read', 'write']);
    expect(body.revoked_at).toBeNull();
  });

  it('403 when admin scope missing', async () => {
    fx = await buildTestApp({ scopes: ['read', 'write'] });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: auth(fx),
      payload: { name: 'ci-key', scopes: ['read'] },
    });
    expect(res.statusCode).toBe(403);
    const body = res.json<Record<string, unknown>>();
    expect(body.type).toBe(PROBLEM_TYPES.Forbidden);
  });

  it('400 with empty scopes array', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: auth(fx),
      payload: { name: 'x', scopes: [] },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json<Record<string, unknown>>();
    expect(body.type).toBe(PROBLEM_TYPES.ValidationFailed);
  });

  it('returns ds_test_ prefix for free tier', async () => {
    fx = await buildTestApp({ tier: 'free' });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: auth(fx),
      payload: { name: 'free-key', scopes: ['read'] },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ plaintext: string }>();
    expect(body.plaintext.startsWith('ds_test_')).toBe(true);
  });
});

describe('GET /v1/api-keys', () => {
  it('lists keys for the account (incl. seeded test key)', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/api-keys',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: Array<Record<string, unknown>> }>();
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    expect(body.data[0]?.id).toMatch(/^key_/);
    // Plaintext is never returned by list.
    for (const k of body.data) {
      expect(k.plaintext).toBeUndefined();
    }
  });
});

describe('DELETE /v1/api-keys/:id', () => {
  it('204 revokes the key, idempotent on second call', async () => {
    fx = await buildTestApp();
    // Create a fresh key to revoke.
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: auth(fx),
      payload: { name: 'doomed', scopes: ['read'] },
    });
    const created = create.json<{ id: string }>();

    const del1 = await fx.app.inject({
      method: 'DELETE',
      url: `/v1/api-keys/${created.id}`,
      headers: auth(fx),
    });
    expect(del1.statusCode).toBe(204);

    const del2 = await fx.app.inject({
      method: 'DELETE',
      url: `/v1/api-keys/${created.id}`,
      headers: auth(fx),
    });
    expect(del2.statusCode).toBe(204);
  });

  it('404 for unknown key id', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'DELETE',
      url: '/v1/api-keys/key_00000000-0000-4000-8000-000000000999',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(404);
  });

  it('403 when admin scope missing', async () => {
    fx = await buildTestApp({ scopes: ['read', 'write'] });
    const res = await fx.app.inject({
      method: 'DELETE',
      url: `/v1/api-keys/key_${fx.apiKeyId}`,
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('GET /v1/usage', () => {
  it('200 returns current-period summary with zero totals + tier quotas', async () => {
    fx = await buildTestApp({ tier: 'scale' });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/usage',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(body.tier).toBe('scale');
    expect((body.totals as Record<string, number>).navigate).toBe(0);
    // 'scale' tier inherited the quota numbers the old 'pro' had (D-019).
    expect((body.quotas as Record<string, number>).navigate).toBe(100_000);
  });

  it('aggregates totals from recorded usage', async () => {
    fx = await buildTestApp({ tier: 'starter' });
    const now = new Date();
    fx.usageRepo.record({
      accountId: fx.accountId,
      recordType: 'navigate',
      quantity: 12,
      recordedAt: now,
    });
    fx.usageRepo.record({
      accountId: fx.accountId,
      recordType: 'navigate',
      quantity: 3,
      recordedAt: now,
    });
    fx.usageRepo.record({
      accountId: fx.accountId,
      recordType: 'interact',
      quantity: 5,
      recordedAt: now,
    });

    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/usage',
      headers: auth(fx),
    });
    const body = res.json<{ totals: Record<string, number> }>();
    expect(body.totals.navigate).toBe(15);
    expect(body.totals.interact).toBe(5);
    expect(body.totals.wait).toBe(0);
  });

  it('enterprise tier shows null quotas (unmetered)', async () => {
    fx = await buildTestApp({ tier: 'enterprise' });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/usage',
      headers: auth(fx),
    });
    const body = res.json<{ quotas: Record<string, number | null> }>();
    expect(body.quotas.navigate).toBeNull();
    expect(body.quotas.session_minute).toBeNull();
  });
});

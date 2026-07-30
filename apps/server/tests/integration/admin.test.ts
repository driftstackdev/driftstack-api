// Integration tests for admin endpoints (api-keys + usage).

import { afterEach, describe, expect, it, vi } from 'vitest';
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

  it('403s Free ordinary key creation without inserting a successor', async () => {
    fx = await buildTestApp({ tier: 'free' });
    const before = (await fx.apiKeysRepo.listAllApiKeys({ limit: 100 })).items;
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: auth(fx),
      payload: { name: 'free-key', scopes: ['read'] },
    });
    expect(res.statusCode).toBe(403);
    const body = res.json<{ type: string; detail: string }>();
    expect(body.type).toBe(PROBLEM_TYPES.Forbidden);
    expect(body.detail).toContain('apiAccess');
    expect((await fx.apiKeysRepo.listAllApiKeys({ limit: 100 })).items).toHaveLength(before.length);
  });

  it('409 when legal acceptances are pending (V-049 issuance block)', async () => {
    // skipLegalAcceptance: true keeps the fixture from pre-seeding
    // acceptances, so the gate sees 4 pending docs.
    fx = await buildTestApp({ skipLegalAcceptance: true });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: auth(fx),
      payload: { name: 'pre-acceptance-key', scopes: ['read', 'write'] },
    });
    expect(res.statusCode).toBe(409);
    const body = res.json<Record<string, unknown>>();
    expect(body.type).toBe('https://errors.driftstack.dev/legal-acceptance-required');
    expect(body.title).toBe('Legal acceptance required');
    expect(Array.isArray(body.pending_acceptances)).toBe(true);
    const pending = body.pending_acceptances as Array<{
      document_key: string;
      current_version: string;
    }>;
    expect(pending).toHaveLength(4);
    expect(new Set(pending.map((p) => p.document_key))).toEqual(
      new Set(['tos', 'privacy', 'dpa', 'aup']),
    );
  });

  it('201 succeeds after the account accepts every pending document', async () => {
    fx = await buildTestApp({ skipLegalAcceptance: true });
    // Walk the catalog and accept each.
    const cat = await fx.app.inject({
      method: 'GET',
      url: '/v1/legal/documents',
      headers: auth(fx),
    });
    const entries = cat.json<{
      data: Array<{ document_key: string; version: string; content_hash: string }>;
    }>().data;
    for (const entry of entries) {
      await fx.app.inject({
        method: 'POST',
        url: '/v1/legal/accept',
        headers: { ...auth(fx), 'content-type': 'application/json' },
        payload: {
          document_key: entry.document_key,
          version: entry.version,
          content_hash: entry.content_hash,
        },
      });
    }
    // Now the gate should let key creation through.
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: auth(fx),
      payload: { name: 'post-acceptance-key', scopes: ['read', 'write'] },
    });
    expect(res.statusCode).toBe(201);
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
  it.each(['write', 'read:sessions'] as const)(
    '403s a self-scoped %s-only key before reading usage',
    async (scope) => {
      fx = await buildTestApp({ scopes: [scope] });
      const totals = vi.spyOn(fx.usageRepo, 'totalsForPeriod');
      const daily = vi.spyOn(fx.usageRepo, 'dailyBucketsForRange');

      const res = await fx.app.inject({
        method: 'GET',
        url: '/v1/usage',
        headers: auth(fx),
      });

      expect(res.statusCode).toBe(403);
      expect(totals).not.toHaveBeenCalled();
      expect(daily).not.toHaveBeenCalled();
    },
  );

  it.each(['read', 'account_owner'] as const)('accepts a self-scoped %s key', async (scope) => {
    fx = await buildTestApp({ scopes: [scope] });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/usage',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(200);
  });

  it('200 returns current-period summary with zero totals + tier quotas', async () => {
    fx = await buildTestApp({ tier: 'api_scale' });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/usage',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(body.tier).toBe('api_scale');
    expect((body.totals as Record<string, number>).navigate).toBe(0);
    // Per ADR-004: paid tiers are concurrent-only (no per-meter
    // operation-count caps). All quota values are `null`.
    expect((body.quotas as Record<string, number | null>).navigate).toBeNull();
  });

  it('aggregates totals from recorded usage', async () => {
    fx = await buildTestApp({ tier: 'api_starter' });
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

describe('GET /v1/usage/series (V-170)', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it.each(['write', 'read:sessions'] as const)(
    '403s a self-scoped %s-only key before reading daily usage',
    async (scope) => {
      fx = await buildTestApp({ scopes: [scope] });
      const totals = vi.spyOn(fx.usageRepo, 'totalsForPeriod');
      const daily = vi.spyOn(fx.usageRepo, 'dailyBucketsForRange');

      const res = await fx.app.inject({
        method: 'GET',
        url: '/v1/usage/series',
        headers: auth(fx),
      });

      expect(res.statusCode).toBe(403);
      expect(totals).not.toHaveBeenCalled();
      expect(daily).not.toHaveBeenCalled();
    },
  );

  it.each(['read', 'account_owner'] as const)('accepts a self-scoped %s key', async (scope) => {
    fx = await buildTestApp({ scopes: [scope] });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/usage/series?days=1',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(200);
  });

  it('200 returns 30-day contiguous bucket series with empty totals (default)', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/usage/series',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      from_date: string;
      to_date: string;
      buckets: Array<{ date: string; totals: Record<string, number> }>;
    }>();
    expect(body.from_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.to_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.buckets).toHaveLength(30);
    // Default: no recorded usage → every bucket is empty.
    for (const b of body.buckets) {
      expect(Object.keys(b.totals)).toEqual([]);
    }
  });

  it('honours days=7 query param', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/usage/series?days=7',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ buckets: unknown[] }>().buckets).toHaveLength(7);
  });

  it('rejects days=200 (above max=90)', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/usage/series?days=200',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(400);
  });

  it('aggregates recorded usage into the right daily bucket', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const now = new Date();
    // Record 3 navigates today.
    fx.usageRepo.record({
      accountId: fx.accountId,
      recordType: 'navigate',
      quantity: 3,
      recordedAt: now,
    });
    // Record 5 interacts 3 days ago.
    const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
    fx.usageRepo.record({
      accountId: fx.accountId,
      recordType: 'interact',
      quantity: 5,
      recordedAt: threeDaysAgo,
    });

    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/usage/series?days=7',
      headers: auth(fx),
    });
    const body = res.json<{
      buckets: Array<{ date: string; totals: Record<string, number> }>;
    }>();
    expect(body.buckets).toHaveLength(7);
    // Find the bucket for today.
    const todayStr = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
      .toISOString()
      .slice(0, 10);
    // The to_date is exclusive (today's UTC midnight), so today's bucket
    // is NOT included — the latest included bucket is yesterday.
    const todayBucket = body.buckets.find((b) => b.date === todayStr);
    expect(todayBucket).toBeUndefined();
    // The 3-days-ago interact should appear.
    const threeDaysAgoStr = new Date(
      Date.UTC(
        threeDaysAgo.getUTCFullYear(),
        threeDaysAgo.getUTCMonth(),
        threeDaysAgo.getUTCDate(),
      ),
    )
      .toISOString()
      .slice(0, 10);
    const threeDaysAgoBucket = body.buckets.find((b) => b.date === threeDaysAgoStr);
    expect(threeDaysAgoBucket?.totals.interact).toBe(5);
  });

  it('401 without auth bearer', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/usage/series',
    });
    expect(res.statusCode).toBe(401);
  });
});

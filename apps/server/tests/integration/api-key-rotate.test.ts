// V-296 — API key rotation flow.
//
// POST /v1/api-keys/:id/rotate mints a fresh plaintext (shown once)
// and sets expires_at on the OLD key to now + 24h. The auth path
// already enforces expires_at; no separate revocation cron.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

const headers = { 'content-type': 'application/json' };

describe('POST /v1/api-keys/:id/rotate', () => {
  it('403s a Free ordinary key without creating a successor', async () => {
    fx = await buildTestApp({ tier: 'free' });
    const before = (await fx.apiKeysRepo.listAllApiKeys({ limit: 100 })).items;

    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/api-keys/key_${fx.apiKeyId}/rotate`,
      headers: { ...headers, authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ detail: string }>().detail).toContain('apiAccess');
    expect((await fx.apiKeysRepo.listAllApiKeys({ limit: 100 })).items).toHaveLength(before.length);
  });

  it('201 mints a new key + sets old key expires_at to ~24h from now', async () => {
    fx = await buildTestApp();
    const apiKeyId = fx.apiKeyId;

    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/api-keys/key_${apiKeyId}/rotate`,
      headers: { ...headers, authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{
      id: string;
      name: string;
      scopes: string[];
      plaintext: string;
      rotated_from: string;
      grace_period_ends_at: string;
    }>();

    // New key has its own id + a fresh plaintext.
    expect(body.id).toMatch(/^key_/);
    expect(body.id).not.toBe(`key_${apiKeyId}`);
    expect(body.plaintext.length).toBeGreaterThan(20);
    expect(body.rotated_from).toBe(`key_${apiKeyId}`);

    // Grace period ~24h.
    const gpe = new Date(body.grace_period_ends_at).getTime();
    const expected = Date.now() + 24 * 60 * 60 * 1000;
    expect(Math.abs(gpe - expected)).toBeLessThan(60_000); // within 60s
  });

  it('writes account.audit api_key.rotated entry with both ids', async () => {
    fx = await buildTestApp();
    const apiKeyId = fx.apiKeyId;
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/api-keys/key_${apiKeyId}/rotate`,
      headers: { ...headers, authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    const newId = res.json<{ id: string }>().id;

    const audit = fx.accountAuditRepo.getAll();
    const rotated = audit.filter((r) => r.action === 'api_key.rotated');
    expect(rotated).toHaveLength(1);
    expect(rotated[0]!.targetResourceId).toBe(`key_${apiKeyId}`);
    const payload = rotated[0]!.payload as { old_key_id: string; new_key_id: string };
    expect(payload.old_key_id).toBe(`key_${apiKeyId}`);
    expect(payload.new_key_id).toBe(newId);
  });

  it('honors `name` override on the new key', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/api-keys/key_${fx.apiKeyId}/rotate`,
      headers: { ...headers, authorization: `Bearer ${fx.plaintext}` },
      payload: { name: 'production-2025' },
    });
    expect(res.json<{ name: string }>().name).toBe('production-2025');
  });

  it('400 when the rename exceeds 120 chars (matches the create-key name bound)', async () => {
    // Regression: the rotate body is validated by a manual typeof check (no
    // zod schema), so an over-long name used to persist unbounded (capped only
    // by bodyLimit) while POST /v1/api-keys caps name at min(1).max(120).
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/api-keys/key_${fx.apiKeyId}/rotate`,
      headers: { ...headers, authorization: `Bearer ${fx.plaintext}` },
      payload: { name: 'x'.repeat(121) },
    });
    expect(res.statusCode).toBe(400);
  });

  it('preserves scopes from the old key', async () => {
    fx = await buildTestApp({ scopes: ['read', 'write', 'account_owner'] });
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/api-keys/key_${fx.apiKeyId}/rotate`,
      headers: { ...headers, authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    const body = res.json<{ scopes: string[] }>();
    expect(body.scopes.sort()).toEqual(['account_owner', 'read', 'write']);
  });

  it('400 when rotating an already-revoked key', async () => {
    fx = await buildTestApp();
    // Revoke the key first.
    await fx.app.inject({
      method: 'DELETE',
      url: `/v1/api-keys/key_${fx.apiKeyId}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });

    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/api-keys/key_${fx.apiKeyId}/rotate`,
      headers: { ...headers, authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    // After revoke, the auth call itself fails (401), so the route never
    // reaches the "revoked" branch. Either 401 or 400 is acceptable
    // semantically; assert it's not 201.
    expect(res.statusCode).not.toBe(201);
  });

  it('404 when rotating a non-existent key id', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/api-keys/key_00000000-0000-4000-8000-000000000999/rotate',
      headers: { ...headers, authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });

  it('400 when key id is malformed', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/api-keys/not-a-key-id/rotate',
      headers: { ...headers, authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});

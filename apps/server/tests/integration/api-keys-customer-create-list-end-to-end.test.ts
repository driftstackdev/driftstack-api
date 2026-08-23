// End-to-end integration test: POST /v1/api-keys creates a key with
// `plaintext` returned ONCE in the response body; subsequent GET
// /v1/api-keys list responses MUST NOT echo the plaintext (only
// `key_prefix` for log/UI recognition). Drift would leak full key
// material on the list endpoint.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

interface CreatedKey {
  id: string;
  name: string;
  scopes: string[];
  key_prefix: string;
  plaintext: string;
  expires_at: string | null;
  created_at: string;
}

interface ListedKey {
  id: string;
  name: string;
  scopes: string[];
  key_prefix: string;
  // CRITICAL: plaintext MUST NOT be present here
  expires_at: string | null;
  created_at: string;
}

// V-1370 — the two writes in routes/admin.ts are customer self-service, not staff
// surfaces, and neither reported the fields it ignored. `expires_at` is optional on
// create, so a mistyped one is stripped by zod and the key is minted with NO expiry —
// a credential that outlives what its owner asked for, answered 201 with no signal.
describe('/v1/api-keys reports the fields it ignored', () => {
  it('CRITICAL a mistyped expires_at is REPORTED, not silently dropped. It is optional, so zod strips it and the key is created without an expiry; the caller asked for one and gets a permanent credential back with a 201 on it.', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {
        name: 'rotating-key',
        scopes: ['read'],
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
    });
    expect(res.statusCode).toBe(201);
    expect(
      res.headers['x-driftstack-unknown-fields'],
      'the ignored field must be named back to the caller',
    ).toBe('expiresAt');
    expect(
      res.json<{ expires_at: string | null }>().expires_at,
      'and the drop is real — the key has no expiry',
    ).toBeNull();
  });

  it('CRITICAL a well-formed create carries no such header, so the arm above cannot be satisfied by a route that reports on every request', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { name: 'clean-key', scopes: ['read'] },
    });
    expect(res.statusCode).toBe(201);
    expect(res.headers['x-driftstack-unknown-fields']).toBeUndefined();
  });

  it('CRITICAL rotate reports too. It has no schema at all — the body is hand-validated with a typeof check — so the coverage invariant that derives its population from schema parse sites cannot see this route, and a caller rotating with a mistyped field would otherwise get no signal either.', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const created = await fx.app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { name: 'to-rotate', scopes: ['read'] },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json<{ id: string }>().id;

    const rotated = await fx.app.inject({
      method: 'POST',
      url: `/v1/api-keys/${id}/rotate`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { nmae: 'renamed-on-rotate' },
    });
    expect(rotated.statusCode).toBe(201);
    expect(
      rotated.headers['x-driftstack-unknown-fields'],
      'the ignored rename must be named back to the caller',
    ).toBe('nmae');
    expect(
      rotated.json<{ name: string }>().name,
      'and the drop is real — the rename did not happen',
    ).toBe('to-rotate');
  });
});

describe('/v1/api-keys customer create + list end-to-end', () => {
  it('POST /v1/api-keys → 201 with plaintext + key_prefix in response', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { name: 'integration-test-key', scopes: ['read', 'write'] },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<CreatedKey>();
    expect(body.plaintext).toBeDefined();
    expect(typeof body.plaintext).toBe('string');
    expect((body.plaintext ?? '').length).toBeGreaterThan(0);
    expect(body.key_prefix).toBeDefined();
    expect(body.scopes).toEqual(['read', 'write']);
  });

  it('GET /v1/api-keys list responses do NOT echo plaintext (only key_prefix)', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    // First, mint a fresh key so we have something to find in the list
    await fx.app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { name: 'list-test-key', scopes: ['read'] },
    });
    const listRes = await fx.app.inject({
      method: 'GET',
      url: '/v1/api-keys',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(listRes.statusCode).toBe(200);
    const body = listRes.json<{ data: ListedKey[] }>();
    expect(body.data.length).toBeGreaterThan(0);
    for (const key of body.data) {
      // Compile-time the ListedKey shape doesn't include plaintext,
      // but check at runtime that no rogue field surfaced it.
      expect((key as { plaintext?: string }).plaintext).toBeUndefined();
      expect(key.key_prefix).toBeDefined();
    }
  });

  it('GET /v1/api-keys without auth → 401', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/api-keys',
    });
    expect(res.statusCode).toBe(401);
  });

  it('POST /v1/api-keys with empty scopes array → 4xx (at least one scope required)', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { name: 'empty-scopes', scopes: [] },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });

  // #122 — read:api-keys floor on GET /v1/api-keys (list).
  // ApiKeysService.list() gates read:api-keys (V-553.B-21). The scope
  // check fires before any data read, so the pass legs list an empty set.
  // 3-way contract: (a) broad `read` passes, (b) granular read:api-keys
  // passes, (c) a DIFFERENT-resource granular scope (read:sessions) is 403.
  const listKeys = (fxArg: TestAppFixture) =>
    fxArg.app.inject({
      method: 'GET',
      url: '/v1/api-keys',
      headers: { authorization: `Bearer ${fxArg.plaintext}` },
    });

  it('403 for a cross-resource granular key (read:sessions does NOT satisfy read:api-keys)', async () => {
    fx = await buildTestApp({ tier: 'api_builder', scopes: ['read:sessions'] });
    const res = await listKeys(fx);
    expect(res.statusCode).toBe(403);
    expect(res.json<{ detail: string }>().detail).toContain('read:api-keys');
  });

  it('200 for a granular read:api-keys key', async () => {
    fx = await buildTestApp({ tier: 'api_builder', scopes: ['read:api-keys'] });
    expect((await listKeys(fx)).statusCode).toBe(200);
  });

  it('200 for a broad read key and an account_owner key (V-481)', async () => {
    fx = await buildTestApp({ tier: 'api_builder', scopes: ['read'] });
    expect((await listKeys(fx)).statusCode).toBe(200);
    await fx.cleanup();
    fx = await buildTestApp({ tier: 'api_builder', scopes: ['account_owner'] });
    expect((await listKeys(fx)).statusCode).toBe(200);
  });
});

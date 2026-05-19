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
});

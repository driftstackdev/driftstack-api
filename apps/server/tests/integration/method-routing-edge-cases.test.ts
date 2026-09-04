// End-to-end integration test: HTTP method routing edge cases.
// Routes registered for specific verbs (POST-only / GET-only) MUST
// 404 (or 405) on mismatched verbs — NEVER fall through to a
// different route or a 500.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

describe('HTTP method routing edge cases end-to-end', () => {
  it('GET /v1/sessions → 200 (listing exists)', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('PUT /v1/sessions → 4xx (not GET, not POST, so no handler)', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'PUT',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
  });

  it('HEAD /v1/account/me → behavior is consistent (200/4xx, NOT 500)', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'HEAD',
      url: '/v1/account/me',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBeLessThan(500);
  });

  it('OPTIONS preflight handling for a CORS-aware origin', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'OPTIONS',
      url: '/v1/sessions',
      headers: {
        origin: 'https://app.driftstack.io',
        'access-control-request-method': 'POST',
      },
    });
    // CORS preflight typically returns 204 or 200 + Access-Control-* headers
    expect(res.statusCode).toBeLessThan(500);
  });

  it('DELETE /v1 (root) → 404 (no such resource)', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'DELETE',
      url: '/v1',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
  });
});

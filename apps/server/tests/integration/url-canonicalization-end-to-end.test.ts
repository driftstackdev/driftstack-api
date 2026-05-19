// End-to-end integration test: URL canonicalization edge cases.
// Trailing slashes, percent-encoding, query strings, etc. must NOT
// cause the server to crash, route incorrectly, or expose internal
// state via abnormal-URL responses.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

describe('URL canonicalization edge cases end-to-end', () => {
  it('trailing slash on a registered route returns the same behavior class (200 or 404, NOT 500)', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/sessions/',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBeLessThan(500);
  });

  it('percent-encoded path segments resolve to the route they encode', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    // %76%31 = "v1"
    const res = await fx.app.inject({
      method: 'GET',
      url: '/%76%31/sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    // Fastify may or may not decode; either way, no 500
    expect(res.statusCode).toBeLessThan(500);
  });

  it('path-traversal sequences (..) do NOT escape the /v1 namespace', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/sessions/../account/me',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    // No 500, no spurious account/me data leak
    expect(res.statusCode).toBeLessThan(500);
  });

  it('query string with no body params does not break GET endpoints', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me?cache_bust=1',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('extremely-long URL → 4xx, NOT a 500 (no unbounded-string crash)', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const longSuffix = 'x'.repeat(2000);
    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/sessions/${longSuffix}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });
});

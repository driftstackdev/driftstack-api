// End-to-end integration test: every 4xx + 5xx error response across
// the customer surface MUST carry the `application/problem+json;
// charset=utf-8` content-type per RFC 7807/9457. The middleware
// error-handler sets it; this test verifies the actual on-the-wire
// response shape.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

describe('problem+json content-type end-to-end', () => {
  it('404 not-found (no route at the URL) → problem+json', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/no-such-route-exists-anywhere',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.headers['content-type']).toMatch(/charset=utf-8/);
    const body = res.json<{ type?: string; title?: string; status?: number; detail?: string }>();
    expect(body.type).toBe('https://errors.driftstack.dev/not-found');
    expect(body.status).toBe(404);
  });

  it('401 unauthorized (missing bearer on auth-required route) → problem+json', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me',
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    const body = res.json<{ type?: string; status?: number }>();
    expect(body.type).toMatch(/errors\.driftstack\.dev/);
    expect(body.status).toBe(401);
  });

  it('400 validation (bad body on a write endpoint) → problem+json', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { archetype: 12345 /* should be string */ },
    });
    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    const body = res.json<{ type?: string; status?: number }>();
    expect(body.type).toMatch(/errors\.driftstack\.dev/);
    expect(body.status).toBe(400);
  });

  it("404 not-found 'No route for GET /...' detail string carries the request method + URL", async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/nonexistent-path',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(404);
    const body = res.json<{ detail?: string }>();
    expect(body.detail).toMatch(/No route for POST \/v1\/nonexistent-path\./);
  });

  it('problem+json response carries instance field (request id) for correlation', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/no-such-route',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    const body = res.json<{ instance?: string }>();
    expect(body.instance).toBeDefined();
    expect(typeof body.instance).toBe('string');
  });
});

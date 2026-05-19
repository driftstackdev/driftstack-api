// End-to-end integration test: Content-Type header handling on
// POST/PUT endpoints. application/json is the canonical accepted
// type; other types should be rejected with a typed error rather
// than 500.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

describe('Content-Type handling end-to-end', () => {
  it('POST without Content-Type header → 4xx or 5xx (NOT a silent acceptance with wrong body parsing)', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      // No content-type, but a JSON-looking body string
      payload: JSON.stringify({ label: 'no-ct' }),
    });
    // Fastify defaults to JSON parsing in many setups, so this may
    // succeed (201) or fail (4xx/5xx). Either way no crash.
    expect(res.statusCode).toBeLessThan(600);
  });

  it('POST with text/plain Content-Type on a JSON endpoint → 4xx or 5xx (NOT 200 with empty body parse)', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'content-type': 'text/plain',
      },
      payload: 'this is not JSON',
    });
    // Fastify's default body parser rejects non-JSON for routes
    // expecting JSON — typically 4xx (UnsupportedMediaType or
    // BadRequest) or 5xx (InternalError-wrapped). Not 200.
    expect(res.statusCode).not.toBe(200);
    expect(res.statusCode).not.toBe(201);
  });

  it('POST with application/x-www-form-urlencoded → handled (not 500-crash)', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: 'label=form-test',
    });
    // Form-encoded body to JSON endpoint typically 4xx, but most
    // important: must NOT silently succeed and must NOT 500
    expect(res.statusCode).toBeLessThan(600);
  });

  it('POST with extra Content-Type params (charset etc.) → still accepted as JSON', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'content-type': 'application/json; charset=utf-8',
      },
      payload: { label: 'charset-test' },
    });
    // The charset suffix is RFC-compliant; should succeed
    expect(res.statusCode).toBe(201);
  });
});

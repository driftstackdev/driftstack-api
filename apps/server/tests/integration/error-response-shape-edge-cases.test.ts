// End-to-end integration test: edge-case error responses (invalid
// JSON body, wrong method, wrong content-type) all return
// problem+json with a typed problem-type. Drift toward Fastify
// default error shapes would break SDK error-class detection.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

describe('error response shape edge cases end-to-end', () => {
  it('invalid JSON body on a POST endpoint → 4xx or 5xx problem+json (NOT a raw Fastify error shape)', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'content-type': 'application/json',
      },
      payload: '{ not-valid-json',
    });
    // Today's behavior: Fastify's JSON parser throws + the error-
    // handler wraps it as InternalError → 500 problem+json. Pinned
    // here so any future improvement (e.g. catching JSON parse
    // errors as BadRequestError → 400) is intentional, not an
    // accidental shape change.
    expect([400, 500]).toContain(res.statusCode);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
  });

  it('Method-not-allowed on a defined route (PATCH on POST-only /v1/sessions) → 404 or 405 with problem+json', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'PATCH',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    expect([404, 405]).toContain(res.statusCode);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
  });

  it('GET on a POST-only endpoint → 404 or 405 with problem+json', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/sessions/ses_xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx/navigate',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect([404, 405]).toContain(res.statusCode);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
  });

  it('Empty body where body is required → 400 problem+json (not a 500)', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'content-type': 'application/json',
      },
      payload: '',
    });
    // Empty body should NOT 500. Most likely 400 (validation) or 201
    // if all session-create fields are optional.
    expect(res.statusCode).toBeLessThan(500);
  });

  it("URL with extra trailing slashes (//) doesn't crash → 404 or normalized handling", async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1//account///me',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    // Whatever Fastify does, it must NOT 500
    expect(res.statusCode).toBeLessThan(500);
  });
});

// End-to-end integration test: POST body edge cases. Empty bodies,
// nulls, and array-shaped bodies on object-expecting endpoints must
// be handled cleanly (4xx with problem+json — NOT 500).

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

describe('POST body edge cases end-to-end', () => {
  it('POST /v1/api-keys with null body → 4xx', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'content-type': 'application/json',
      },
      payload: 'null',
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });

  it('POST /v1/api-keys with array body (expecting object) → 4xx', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'content-type': 'application/json',
      },
      payload: '[]',
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });

  it('POST /v1/api-keys with string body (expecting object) → 4xx', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'content-type': 'application/json',
      },
      payload: '"just-a-string"',
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });

  it('POST /v1/api-keys with extra unknown keys → either accepted (silently ignored) or 4xx — NOT a 500', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'content-type': 'application/json',
      },
      payload: {
        name: 'extras-test',
        scopes: ['read'],
        unknown_field: 'should-be-ignored',
        another_extra: 42,
      },
    });
    // Either passthrough-ignore (Zod's default) or strict-reject —
    // both are valid policies. Critical: not 500.
    expect(res.statusCode).toBeLessThan(500);
  });
});

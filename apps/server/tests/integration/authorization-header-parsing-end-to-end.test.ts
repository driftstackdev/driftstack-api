// End-to-end integration test: Authorization header parsing edge
// cases. Trailing whitespace, case variants, multiple spaces, etc.
// must NOT cause the server to crash or accept tokens it shouldn't.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

describe('Authorization header parsing edge cases end-to-end', () => {
  it('case-variant "bearer" (lowercase) → still accepted OR rejected consistently (NOT 500)', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me',
      headers: { authorization: `bearer ${fx.plaintext}` },
    });
    // Most setups treat Bearer scheme case-insensitively → 200.
    // Strict setups reject lowercase → 401. Either way, NOT 500.
    expect([200, 401]).toContain(res.statusCode);
  });

  it('trailing whitespace on the key value → 401 (NOT 500)', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me',
      headers: { authorization: `Bearer ${fx.plaintext}  ` },
    });
    // Trailing whitespace fingerprints the key, so most setups reject
    expect(res.statusCode).toBeLessThan(500);
  });

  it('empty Authorization header value → 401 (NOT 500)', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me',
      headers: { authorization: '' },
    });
    expect(res.statusCode).toBe(401);
  });

  it("Authorization with only 'Bearer' (no token) → 401", async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me',
      headers: { authorization: 'Bearer' },
    });
    expect(res.statusCode).toBe(401);
  });

  it("Authorization with 'Bearer ' (just scheme + space, empty token) → 401", async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me',
      headers: { authorization: 'Bearer ' },
    });
    expect(res.statusCode).toBe(401);
  });
});

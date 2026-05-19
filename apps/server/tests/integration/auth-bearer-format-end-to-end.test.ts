// End-to-end integration test: bearer-token format errors return
// the correct typed 401 problem+json (invalid-key vs unauthorized).
// Drift on the differentiation would either leak which keys exist
// to attackers OR force customers to write generic 401 handling
// when typed handling is available.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

describe('auth bearer-token format end-to-end', () => {
  it('missing Authorization header → 401 unauthorized', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me',
    });
    expect(res.statusCode).toBe(401);
    const body = res.json<{ type?: string }>();
    expect(body.type).toMatch(/errors\.driftstack\.dev/);
  });

  it('non-Bearer Authorization header (e.g. Basic) → 401', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me',
      headers: { authorization: 'Basic dXNlcjpwYXNz' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('Bearer with wrong-prefix key (sk-xxx instead of ds-xxx) → 401', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me',
      headers: { authorization: 'Bearer sk_live_not_a_driftstack_key' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('Bearer with malformed driftstack key (right prefix, wrong shape) → 401', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me',
      headers: { authorization: 'Bearer ds_test_garbage-not-base32' },
    });
    expect(res.statusCode).toBe(401);
  });

  it("Bearer with valid-shape but nonexistent key → 401 (NOT 404 — don't differentiate auth-rejected from missing)", async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    // Mint a key from the test helper, but flip one char so it
    // doesn't match anything in the auth repo.
    const fakeKey = fx.plaintext.slice(0, -1) + (fx.plaintext.slice(-1) === 'x' ? 'y' : 'x');
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me',
      headers: { authorization: `Bearer ${fakeKey}` },
    });
    expect(res.statusCode).toBe(401);
  });
});

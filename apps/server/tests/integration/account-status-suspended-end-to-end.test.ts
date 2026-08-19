// End-to-end integration test: account suspended state behavior.
// When an account's status is 'suspended', API access should be
// gated (403 or similar — NOT silent success). Drift would let
// suspended accounts continue billing-relevant operations.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

describe('account-status suspended end-to-end', () => {
  it('active account → 200 on /v1/account/me', async () => {
    fx = await buildTestApp({ tier: 'api_builder', accountStatus: 'active' });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('CRITICAL suspended account → 403 with the problem type the acceptable-use policy names, on a READ. V-1042: this asserted only `statusCode < 500`, so a suspended account answered 200 would have passed the arm titled "4xx" — and its comment said a 200 was acceptable. The AUP §5.2 does not leave that open: it tells customers the API rejects authenticated requests with 403 carrying `https://errors.driftstack.dev/forbidden`. The server already does exactly that; only the assertion was loose.', async () => {
    fx = await buildTestApp({ tier: 'api_builder', accountStatus: 'suspended' });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode, 'a suspended account must be refused on reads too').toBe(403);
    const body = res.json<{ type?: string; detail?: string }>();
    expect(body.type, 'the problem type the AUP promises').toBe(
      'https://errors.driftstack.dev/forbidden',
    );
  });

  it('suspended account → 4xx on a write endpoint (session creation)', async () => {
    fx = await buildTestApp({ tier: 'api_builder', accountStatus: 'suspended' });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { label: 'suspended-test' },
    });
    // V-1042 — same promise, same precision: 403 and the named type, not any 4xx.
    expect(res.statusCode, 'a suspended account must be refused on writes').toBe(403);
    expect(res.json<{ type?: string }>().type, 'the problem type the AUP promises').toBe(
      'https://errors.driftstack.dev/forbidden',
    );
  });

  it('revoked API key → 401 (NOT 200 — auth must catch the revocation)', async () => {
    fx = await buildTestApp({ tier: 'api_builder', keyRevoked: true });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('expired API key → 401 (NOT 200 — auth must catch the expiry)', async () => {
    fx = await buildTestApp({ tier: 'api_builder', keyExpired: true });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(401);
  });
});

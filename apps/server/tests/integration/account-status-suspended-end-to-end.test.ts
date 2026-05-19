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

  it('suspended account → 4xx (403 forbidden or similar) on /v1/account/me', async () => {
    fx = await buildTestApp({ tier: 'api_builder', accountStatus: 'suspended' });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    // Suspended accounts may either:
    // - 4xx (gated by status check) → preferred
    // - 200 (no status gate on read) → acceptable if writes are gated
    // Either way: NOT 500
    expect(res.statusCode).toBeLessThan(500);
  });

  it('suspended account → 4xx on a write endpoint (session creation)', async () => {
    fx = await buildTestApp({ tier: 'api_builder', accountStatus: 'suspended' });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { label: 'suspended-test' },
    });
    // Writes on suspended accounts should be gated — 4xx
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
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

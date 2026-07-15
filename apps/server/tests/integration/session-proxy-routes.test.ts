// EG-API-1.2 — integration tests for /v1/sessions/{id}/proxy.
//
// Two postures:
//   1. Activation-gate ON (no sessionEgressService wired in AppDeps,
//      which is the prod default until Phase 1 SOCKS5 lands a backend):
//      both POST + GET return 503 FeatureUnavailable with planning-133
//      pointer in detail.
//   2. Route surface registered (sessionEgressService wired with a
//      stub): POST validates body + cross-checks session_id, GET
//      returns 404 until EG-API-1.6 propagation lands.
//
// Same shape as the billing-disabled integration test pattern (Wave
// 1119 / Slice 1119.2).

import { afterEach, describe, expect, it } from 'vitest';
import { PROBLEM_TYPES } from '@driftstack/api-types';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

describe('EG-API-1.2 — /v1/sessions/{id}/proxy (no backend wired)', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it.each(['POST', 'GET'] as const)(
    '%s rejects unauthenticated callers before feature disclosure',
    async (method) => {
      fx = await buildTestApp();
      const res = await fx.app.inject({
        method,
        url: '/v1/sessions/ses_xxx/proxy',
        ...(method === 'POST'
          ? {
              payload: {
                session_id: 'ses_xxx',
                proxy: { type: 'socks5', socks5: { host: 'proxy.example.com', port: 1080 } },
              },
            }
          : {}),
      });
      expect(res.statusCode).toBe(401);
    },
  );

  it.each([
    ['POST', 'write:sessions'],
    ['GET', 'read:sessions'],
  ] as const)(
    '%s rejects a zero-scope key before feature disclosure',
    async (method, requiredScope) => {
      fx = await buildTestApp({ scopes: [] });
      const res = await fx.app.inject({
        method,
        url: '/v1/sessions/ses_xxx/proxy',
        headers: { authorization: `Bearer ${fx.plaintext}` },
        ...(method === 'POST'
          ? {
              payload: {
                session_id: 'ses_xxx',
                proxy: { type: 'socks5', socks5: { host: 'proxy.example.com', port: 1080 } },
              },
            }
          : {}),
      });
      expect(res.statusCode).toBe(403);
      expect(res.json<{ detail: string }>().detail).toBe(
        `This action requires the "${requiredScope}" scope.`,
      );
    },
  );

  it('POST → 503 FeatureUnavailable with customer-facing egress disclosure (no internal planning-file jargon)', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions/ses_xxx/proxy',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {
        session_id: 'ses_xxx',
        proxy: { type: 'socks5', socks5: { host: 'proxy.example.com', port: 1080 } },
      },
    });
    expect(res.statusCode).toBe(503);
    const body = res.json<{ type: string; detail: string }>();
    expect(body.type).toBe(PROBLEM_TYPES.FeatureUnavailable);
    // Customer-trust contract: no internal V-NNN / planning-file /
    // handoff jargon in customer-facing 503 bodies. Pin the
    // customer disclosure shape — capability name, posture, and
    // what currently happens — instead.
    expect(body.detail).toMatch(/SOCKS5 \/ OpenVPN \/ WireGuard/);
    expect(body.detail).toMatch(/unavailable on this deployment/);
    expect(body.detail).toMatch(/default egress/);
    expect(body.detail).not.toMatch(/planning file/i);
    expect(body.detail).not.toMatch(/V-\d{3,}/);
  });

  it('GET → 503 FeatureUnavailable (same stub posture)', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/sessions/ses_xxx/proxy',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json<{ type: string }>().type).toBe(PROBLEM_TYPES.FeatureUnavailable);
  });

  it('content-type is application/problem+json (RFC 7807)', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/sessions/ses_xxx/proxy',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
  });
});

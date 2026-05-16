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

  it('POST → 503 FeatureUnavailable with planning-133 pointer', async () => {
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
    expect(body.detail).toMatch(/planning file 133/);
    expect(body.detail).toMatch(/SOCKS5 \/ OpenVPN \/ WireGuard/);
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

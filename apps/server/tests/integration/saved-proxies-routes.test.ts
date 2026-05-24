// EG-API-1.3 — integration tests for /v1/proxies (saved reusable
// customer proxy configs).
//
// Like EG-API-1.2 session-proxy-routes, the only posture currently
// exercisable in tests is the no-backend-wired path:
//   - POST   → 503 FeatureUnavailable
//   - GET    → 200 { data: [] } (so the dashboard's empty state still renders)
//   - DELETE → 503 FeatureUnavailable
//
// The 200-empty-list-on-GET is the deliberate exception to the
// stub-everything pattern: a 503 on a read-only list endpoint would
// surface a "billing-style" error banner where what the customer
// actually has is "no saved proxies yet" — which IS a valid empty
// state of a wired backend. Keeping GET consistent across postures
// avoids dashboard-side branching.

import { afterEach, describe, expect, it } from 'vitest';
import { PROBLEM_TYPES } from '@driftstack/api-types';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

describe('EG-API-1.3 — /v1/proxies (no backend wired)', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('POST → 503 FeatureUnavailable with customer-facing egress disclosure (no internal planning-file jargon)', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/proxies',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {
        label: 'team SOCKS5 — london',
        proxy: { type: 'socks5', socks5: { host: 'proxy.example.com', port: 1080 } },
      },
    });
    expect(res.statusCode).toBe(503);
    const body = res.json<{ type: string; detail: string }>();
    expect(body.type).toBe(PROBLEM_TYPES.FeatureUnavailable);
    // Customer-trust contract: no internal V-NNN / planning-file /
    // handoff jargon in the customer-facing 503 body (slice 87+88
    // / 6efc0a34). Pin the customer disclosure shape instead —
    // capability name, posture, and what currently happens.
    expect(body.detail).toMatch(/Customer-configurable egress \(SOCKS5 \/ OpenVPN \/ WireGuard\)/);
    expect(body.detail).toMatch(/not yet shipped/);
    expect(body.detail).toMatch(/Driftstack's default egress/);
    expect(body.detail).not.toMatch(/planning file/i);
    expect(body.detail).not.toMatch(/V-\d{3,}/);
  });

  it('GET → 200 { data: [] } (empty list across postures so the dashboard empty state renders identically wired vs unwired)', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/proxies',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: unknown[] }>().data).toEqual([]);
  });

  it('DELETE → 503 FeatureUnavailable (any id, no saved configs exist yet)', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'DELETE',
      url: '/v1/proxies/proxy_xxx',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json<{ type: string }>().type).toBe(PROBLEM_TYPES.FeatureUnavailable);
  });

  // EG-API-1.7 — reachability test endpoint. Backs the dashboard's
  // create-profile + /proxies "Test proxy" buttons. Pre-fleet-runner it
  // 503s; the body explains the check runs from a Mac-fleet node so the
  // dashboard surfaces a "scheduled" message rather than a raw error.
  it('POST /:id/test → 503 FeatureUnavailable (Mac-fleet reachability runner not yet wired)', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/proxies/proxy_xxx/test',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json<{ type: string }>().type).toBe(PROBLEM_TYPES.FeatureUnavailable);
  });
});

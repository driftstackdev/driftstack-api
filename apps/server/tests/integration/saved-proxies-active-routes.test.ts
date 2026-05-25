// EG-API-1.3 — active saved-proxies route surface
// (registerSavedProxiesRoutes, wired when sessionEgressService is
// present). The existing saved-proxies-routes.test.ts covers only the
// disabled 503-stub variant; these exercise the ACTIVE variant, whose
// behavior diverges from the stub in two ways worth pinning:
//   • POST validates SavedProxyConfigSchema BEFORE the not-yet-wired
//     backend — a malformed body is a 400, not a 503.
//   • DELETE returns 404 (no saved proxies exist yet), NOT the stub's
//     503 — so a customer deleting a stale id gets the same answer the
//     wired backend will give.
//
// enableEgressSafeguard:true injects a no-op sessionEgressService so the
// active routes register instead of the disabled stubs.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';
import { PROBLEM_TYPES } from '@driftstack/api-types';

function validBody(): Record<string, unknown> {
  return {
    label: 'team-london',
    proxy: { type: 'socks5', socks5: { host: 'proxy.example.com', port: 1080 } },
  };
}

describe('active /v1/proxies route surface (sessionEgressService wired)', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('POST with a valid body → 503 FeatureUnavailable (route registered, storage not yet wired)', async () => {
    fx = await buildTestApp({ enableEgressSafeguard: true });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/proxies',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: validBody(),
    });
    expect(res.statusCode).toBe(503);
    expect(res.json<{ type: string }>().type).toBe(PROBLEM_TYPES.FeatureUnavailable);
  });

  it('POST with an invalid body (missing proxy) → 400 ValidationFailed (validated before the backend stub)', async () => {
    fx = await buildTestApp({ enableEgressSafeguard: true });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/proxies',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { label: 'no-proxy-here' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ type: string }>().type).toBe(PROBLEM_TYPES.ValidationFailed);
  });

  it('GET → 200 with an empty list (read-only listing stays 200, not 503, pre-backend)', async () => {
    fx = await buildTestApp({ enableEgressSafeguard: true });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/proxies',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: unknown[] }>().data).toEqual([]);
  });

  it('POST /:id/test → 503 FeatureUnavailable (Mac-fleet reachability runner not yet wired)', async () => {
    fx = await buildTestApp({ enableEgressSafeguard: true });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/proxies/prox_00000000-0000-4000-8000-0000000000aa/test',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json<{ type: string }>().type).toBe(PROBLEM_TYPES.FeatureUnavailable);
  });

  it('DELETE /:id → 404 NotFound (no saved proxies exist yet — diverges from the disabled 503 stub)', async () => {
    fx = await buildTestApp({ enableEgressSafeguard: true });
    const res = await fx.app.inject({
      method: 'DELETE',
      url: '/v1/proxies/prox_00000000-0000-4000-8000-0000000000aa',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ type: string }>().type).toBe(PROBLEM_TYPES.NotFound);
  });
});

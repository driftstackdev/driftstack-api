// EG-API-1.2 — active session-proxy route surface (registerSessionProxyRoutes,
// wired when sessionEgressService is present). The existing
// session-proxy-routes.test.ts covers only the DISABLED 503-stub variant;
// these exercise the ACTIVE variant's request validation that runs BEFORE
// the (not-yet-wired) backend: schema validation, the body/URL session_id
// mismatch guard, the FeatureUnavailable on a valid body, and the GET 404.
//
// enableEgressSafeguard:true injects a no-op sessionEgressService so the
// active routes register instead of the disabled stubs.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';
import { PROBLEM_TYPES } from '@driftstack/api-types';

const SESSION_ID = 'ses_00000000-0000-4000-8000-0000000000c1';

function validBody(sessionId: string): Record<string, unknown> {
  return {
    session_id: sessionId,
    proxy: { type: 'socks5', socks5: { host: 'proxy.example.com', port: 1080 } },
  };
}

describe('active /v1/sessions/:id/proxy route validation (sessionEgressService wired)', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it.each([
    ['POST', 'write:sessions'],
    ['GET', 'read:sessions'],
  ] as const)(
    '%s rejects a zero-scope key before the active handler',
    async (method, requiredScope) => {
      fx = await buildTestApp({ enableEgressSafeguard: true, scopes: [] });
      const res = await fx.app.inject({
        method,
        url: `/v1/sessions/${SESSION_ID}/proxy`,
        headers: { authorization: `Bearer ${fx.plaintext}` },
        ...(method === 'POST' ? { payload: validBody(SESSION_ID) } : {}),
      });
      expect(res.statusCode).toBe(403);
      expect(res.json<{ detail: string }>().detail).toBe(
        `This action requires the "${requiredScope}" scope.`,
      );
    },
  );

  it('POST with a valid body → 503 FeatureUnavailable (route registered, backend not yet wired)', async () => {
    fx = await buildTestApp({ enableEgressSafeguard: true });
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/sessions/${SESSION_ID}/proxy`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: validBody(SESSION_ID),
    });
    expect(res.statusCode).toBe(503);
    expect(res.json<{ type: string }>().type).toBe(PROBLEM_TYPES.FeatureUnavailable);
  });

  it('POST where body.session_id ≠ URL :id → 400 (cross-cutting body/URL mismatch guard)', async () => {
    fx = await buildTestApp({ enableEgressSafeguard: true });
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/sessions/${SESSION_ID}/proxy`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: validBody('ses_00000000-0000-4000-8000-0000000000ff'),
    });
    expect(res.statusCode).toBe(400);
    // The mismatch guard runs after schema parse, before the backend stub.
    expect(res.json<{ type: string }>().type).toBe(PROBLEM_TYPES.BadRequest);
  });

  it('POST with an invalid body (missing proxy) → 400 ValidationFailed', async () => {
    fx = await buildTestApp({ enableEgressSafeguard: true });
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/sessions/${SESSION_ID}/proxy`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { session_id: SESSION_ID },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ type: string }>().type).toBe(PROBLEM_TYPES.ValidationFailed);
  });

  it('GET → 404 NotFound (no proxy applied; no backend wired)', async () => {
    fx = await buildTestApp({ enableEgressSafeguard: true });
    const res = await fx.app.inject({
      method: 'GET',
      url: `/v1/sessions/${SESSION_ID}/proxy`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ type: string }>().type).toBe(PROBLEM_TYPES.NotFound);
  });
});

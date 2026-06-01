// V-664 — security-headers audit: pins the headers helmet emits on
// every response, so regressions in the policy choice surface here
// rather than at customer integration time.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;
afterEach(async () => {
  if (fx) await fx.cleanup();
});

describe('V-664 security headers — required defaults', () => {
  it('every response carries X-Content-Type-Options: nosniff', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({ method: 'GET', url: '/version' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('every response carries Referrer-Policy: no-referrer', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({ method: 'GET', url: '/version' });
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('every response carries X-Frame-Options: SAMEORIGIN', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({ method: 'GET', url: '/version' });
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
  });

  it('Strict-Transport-Security is 2y + includeSubDomains + preload', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({ method: 'GET', url: '/version' });
    const hsts = res.headers['strict-transport-security'];
    expect(hsts).toContain('max-age=63072000');
    expect(hsts).toContain('includeSubDomains');
    expect(hsts).toContain('preload');
  });
});

describe('V-664 security headers — JSON-API-tuned overrides', () => {
  it('Cross-Origin-Resource-Policy: cross-origin (SDKs fetch from any origin)', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({ method: 'GET', url: '/version' });
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
  });

  it('no Content-Security-Policy header (JSON has no HTML surface to protect)', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({ method: 'GET', url: '/version' });
    expect(res.headers['content-security-policy']).toBeUndefined();
  });

  it('no Cross-Origin-Embedder-Policy header (require-corp would break SDK use)', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({ method: 'GET', url: '/version' });
    expect(res.headers['cross-origin-embedder-policy']).toBeUndefined();
  });
});

describe('V-664 security headers — error responses also carry headers', () => {
  it('a 404 response still emits nosniff + referrer-policy', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({ method: 'GET', url: '/v1/does-not-exist' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('V-666.BS — no-store, private also applies to 401 from /v1/account/*', async () => {
    fx = await buildTestApp();
    // No Authorization header → 401 from requireAuth on /v1/account/me.
    const res = await fx.app.inject({ method: 'GET', url: '/v1/account/me' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['cache-control']).toBe('no-store, private');
  });

  it('V-666.BT — no-store, private also applies to 401 from /v1/admin/*', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({ method: 'GET', url: '/v1/admin/crypto-orders' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['cache-control']).toBe('no-store, private');
  });

  it('broadened — no-store, private now also covers a previously-uncovered caller-private route (401 from /v1/profiles)', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({ method: 'GET', url: '/v1/profiles' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['cache-control']).toBe('no-store, private');
  });

  it('the PUBLIC status read is NOT no-store — /v1/status is excluded and keeps its own public caching', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({ method: 'GET', url: '/v1/status' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=30');
  });
});

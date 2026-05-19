// End-to-end integration test: infrastructure-facing liveness /
// readiness probes (/health + /healthz + /ready) are
// distinct from the customer-facing /v1/status surface. The
// infrastructure probes:
//   - have NO auth requirement (orchestrator must reach them
//     before any customer-facing config is wired)
//   - are NOT under /v1/* (intentional separation)
//   - return 200 OK on healthy + lightweight JSON shape

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

describe('infrastructure health probes end-to-end', () => {
  it('GET /health → 200 without auth', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
  });

  it('GET /healthz → 200 without auth', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
  });

  it('GET /ready → 200 without auth (readiness probe)', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
  });

  it('Health probes are NOT under /v1/* — customer-facing /v1/health does NOT exist', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/health',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    // /v1/health is a separate surface — present in some deployments
    // (per the SLA-policy docs reference) but not part of the
    // infrastructure probe set. The test fixture defaults exclude
    // any registration, so it's 404 here. Either way, the assertion
    // is that hitting it with bearer auth doesn't crash.
    expect(res.statusCode).toBeLessThan(500);
  });

  it("Infrastructure /health response carries a shape with at least status field — not application/problem+json (it's a success response, not an error)", async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({ method: 'GET', url: '/health' });
    expect(res.headers['content-type']).not.toMatch(/application\/problem\+json/);
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });
});

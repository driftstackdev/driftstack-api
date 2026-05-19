// V-820 — integration tests for the activation-gate-negative case of
// GET /v1/fleet/events. The route is registered EITHER via the wired
// registrar (when fleetNodeAuth + fleetNonceCache are wired in
// AppDeps) OR via the disabled registrar (when they're not). Both
// return 503 FeatureUnavailable today per the "activation gate +
// real implementation are separate concerns" pattern.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

describe('V-820 GET /v1/fleet/events activation gate (both wired + disabled return 503)', () => {
  it('default test fixture (disabled variant) → 503 FeatureUnavailable', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/fleet/events',
    });
    expect(res.statusCode).toBe(503);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    const body = res.json<{ type?: string; detail?: string }>();
    expect(body.type).toMatch(/feature-unavailable|feature_unavailable/);
    expect(body.detail ?? '').toMatch(/Fleet events stream is not yet enabled/);
  });

  it('disabled-stub detail explicitly mentions the 3-prerequisite roster (fleet_nodes table + WebSocket route + mTLS layer)', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/fleet/events',
    });
    expect(res.statusCode).toBe(503);
    const body = res.json<{ detail?: string }>();
    expect(body.detail ?? '').toMatch(
      /fleet_nodes SQL table \+ WebSocket route \+ mTLS layer are pending/,
    );
  });

  it('detail references the canonical fleet-nodes-sql-migration-design.md internal doc — pinned so operators get a working pointer', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/fleet/events',
    });
    const body = res.json<{ detail?: string }>();
    expect(body.detail ?? '').toMatch(/docs\/internal\/fleet-nodes-sql-migration-design\.md/);
  });
});

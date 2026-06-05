// V-820 — integration tests for the activation-gate-NEGATIVE case of
// GET /v1/fleet/events: when the fleet control-plane deps are absent
// from AppDeps, the disabled registrar serves a 503 FeatureUnavailable.
// (The positive case — all three deps wired → the live WebSocket
// handler accepts upgrades — is covered over a real socket in
// fleet-events-websocket.test.ts.)

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

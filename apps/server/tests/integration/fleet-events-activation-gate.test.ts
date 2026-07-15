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
    expect(body.detail ?? '').toBe('Fleet events stream is unavailable on this deployment.');
  });

  it('disabled-stub detail does not expose internal infrastructure or planning references', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/fleet/events',
    });
    expect(res.statusCode).toBe(503);
    const body = res.json<{ detail?: string }>();
    expect(body.detail ?? '').not.toMatch(/fleet_nodes|WebSocket|mTLS|pending|docs\/internal/i);
  });

  it('detail never exposes an internal design-document pointer', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/fleet/events',
    });
    const body = res.json<{ detail?: string }>();
    expect(body.detail ?? '').not.toMatch(/docs\/internal|fleet-nodes-sql-migration-design/i);
  });
});

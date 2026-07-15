// V-820 — integration tests for the /v1/fleet/events DISABLED stub.
//
// When the fleet control-plane deps are NOT wired into AppDeps (the
// default fixture posture, and prod today since bootstrap doesn't yet
// construct them), the disabled registrar serves a 503
// FeatureUnavailable whose detail points at the SQL-migration-design
// doc. This file pins that disabled posture.
//
// The WIRED posture is no longer a 503 stub: once fleetNodeAuth +
// fleetNonceCache + fleetControlRegistry are present, the live
// WebSocket handler registers — exercised over a real socket in
// fleet-events-websocket.test.ts (enableFleetControlPlane).

import { afterEach, describe, expect, it } from 'vitest';
import { PROBLEM_TYPES } from '@driftstack/api-types';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

describe('V-820 — /v1/fleet/events (disabled stub posture; no AppDeps wired)', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('GET → 503 FeatureUnavailable with the SQL-migration-design pointer', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/fleet/events',
    });
    expect(res.statusCode).toBe(503);
    const body = res.json<{ type: string; detail: string }>();
    expect(body.type).toBe(PROBLEM_TYPES.FeatureUnavailable);
    expect(body.detail).toBe('Fleet events stream is unavailable on this deployment.');
    expect(body.detail).not.toMatch(/fleet_nodes|WebSocket|mTLS|pending|docs\/internal/i);
  });

  it('returns application/problem+json (RFC 7807)', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({ method: 'GET', url: '/v1/fleet/events' });
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
  });
});

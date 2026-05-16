// V-820 — integration tests for /v1/fleet/events route stub.
//
// Both postures (no AppDeps wired = disabled stub; AppDeps wired
// but no real handler yet = wired stub) return 503 + FeatureUnavailable.
// The disabled stub's detail mentions the SQL-migration-design doc;
// the wired stub's detail mentions "handler not yet implemented".
// This double-503 posture is intentional — it makes the "AppDeps
// wired but route not implemented yet" state explicit so a future
// founder flip needs a separate handler-implementation slice (not
// just AppDeps wiring) to take the gate live.

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
    expect(body.detail).toMatch(/Fleet events stream is not yet enabled/);
    expect(body.detail).toMatch(/fleet-nodes-sql-migration-design\.md/);
  });

  it('returns application/problem+json (RFC 7807)', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({ method: 'GET', url: '/v1/fleet/events' });
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
  });
});

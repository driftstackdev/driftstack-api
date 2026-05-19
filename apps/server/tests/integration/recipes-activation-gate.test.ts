// AI-B4 — integration tests for the activation-gate-negative case of
// POST /v1/recipes. The route registers EITHER the wired registrar
// (recipesRepo + agentSessionsRepo both present in AppDeps) OR the
// disabled registrar (503 FeatureUnavailable). The wired path's
// happy-path is covered by recipes-routes.test.ts; this file pins
// the disabled-stub posture.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

describe('AI-B4 POST /v1/recipes activation gate (disabled-stub variant)', () => {
  it('default test fixture (no recipesRepo wired) → 503 FeatureUnavailable', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/recipes',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {
        agent_session_id: 'agt_00000000-0000-4000-8000-000000000001',
        label: 'checkout-flow-snapshot',
      },
    });
    expect(res.statusCode).toBe(503);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    const body = res.json<{ detail?: string }>();
    expect(body.detail ?? '').toMatch(/Recipes are not yet enabled on this deployment/);
  });

  it('disabled-stub detail points at customer-facing docs URL (slice 87+88 fix-shape regression-prevention)', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/recipes',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { agent_session_id: 'agt_x', label: 'x' },
    });
    const body = res.json<{ detail?: string }>();
    expect(body.detail ?? '').toMatch(
      /See https:\/\/docs\.driftstack\.dev\/api\/recipes\/ for the full flow\./,
    );
    // No internal jargon
    expect(body.detail ?? '').not.toMatch(/V-\d{3}|planning file|handoff/);
  });

  it('unauthenticated → 503 (route is registered as stub; the stub fires before auth runs)', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/recipes',
      payload: { agent_session_id: 'agt_x', label: 'x' },
    });
    // Disabled-stub returns 503 regardless of auth state
    expect(res.statusCode).toBe(503);
  });
});

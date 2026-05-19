// LK.3 — integration tests for the activation-gate-negative case of
// POST /v1/agent-sessions/:id/livekit-token. When AppDeps lacks the
// Drizzle fleet-nodes repo OR the encryption key OR the agent-
// sessions repo, the route is NOT registered → 404.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

describe('LK.3 POST /v1/agent-sessions/:id/livekit-token activation gate', () => {
  it('route unregistered when drizzleFleetNodesRepo is absent → 404', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions/agt_00000000-0000-4000-8000-000000000001/livekit-token',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });

  it('unauthenticated → 404 (route is unregistered, not auth-rejected)', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions/agt_00000000-0000-4000-8000-000000000001/livekit-token',
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });

  it('malformed agent-session id → 404 (route unregistered, no shape-validation runs)', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions/not-a-valid-id/livekit-token',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });
});

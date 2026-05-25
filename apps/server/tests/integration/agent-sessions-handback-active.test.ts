// Active-variant coverage for POST /v1/agent-sessions/:id/handback
// (registered with enableAgentRuntime). Companion to the takeover
// coverage. The disabled stub only asserts 503; the handback endpoint's
// active guards had no direct coverage — in particular the
// invalid-transition path: a fresh pair session is in state
// 'ai-driving', which has no 'handback-request' transition, so the
// route surfaces PairModeStateInvalidTransition (409) carrying the
// from/transition extensions. That error branch (route catch →
// PairModeStateInvalidTransitionRouteError) was previously unexercised.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';
import { PROBLEM_TYPES } from '@driftstack/api-types';

async function createSession(fx: TestAppFixture, mode: 'ai' | 'pair' | 'manual'): Promise<string> {
  const res = await fx.app.inject({
    method: 'POST',
    url: '/v1/agent-sessions',
    headers: { authorization: `Bearer ${fx.plaintext}` },
    payload: { mode },
  });
  expect(res.statusCode).toBe(201);
  return res.json<{ id: string }>().id;
}

describe('active POST /v1/agent-sessions/:id/handback (agent runtime wired)', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it("handback from a fresh pair session (state 'ai-driving') → 409 PairModeStateInvalidTransition with from/transition", async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const id = await createSession(fx, 'pair');
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/handback`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    expect(res.statusCode).toBe(409);
    const body = res.json<{ type: string; from?: string; transition?: string }>();
    expect(body.type).toBe(PROBLEM_TYPES.PairModeStateInvalidTransition);
    expect(body.from).toBe('ai-driving');
    expect(body.transition).toBe('handback-request');
  });

  it("mode='ai' → 409 Conflict (handback requires mode='pair', checked before the transition)", async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const id = await createSession(fx, 'ai');
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/handback`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ type: string }>().type).toBe(PROBLEM_TYPES.Conflict);
  });

  it('unknown / cross-account id → 404 NotFound (guard fires before any transition)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions/agt_00000000-0000-4000-8000-0000000000bb/handback',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ type: string }>().type).toBe(PROBLEM_TYPES.NotFound);
  });
});

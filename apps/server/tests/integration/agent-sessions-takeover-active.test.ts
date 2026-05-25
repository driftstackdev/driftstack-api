// Active-variant coverage for POST /v1/agent-sessions/:id/takeover
// (registered when the agent runtime + pairModeLock are wired via
// enableAgentRuntime). The disabled-stub variant only asserts the 503;
// agent-sessions-routes.test.ts exercises the input-event takeover
// trigger but never the explicit /takeover endpoint, whose guards had
// no direct coverage: the mode!='pair' rejection, the happy-path
// transition to takeover-pending, request validation, and the
// cross-account/unknown-id 404.
//
// The PairModeConflictError race (two clients contending for the
// SET-NX-EX lock) is intentionally not covered here — the lock is
// acquired and released within a single request, so a deterministic
// conflict needs genuinely concurrent in-flight requests rather than
// the sequential injects an integration test issues.

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

describe('active POST /v1/agent-sessions/:id/takeover (agent runtime wired)', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it("mode='pair' + valid client_id → 200 and pair_mode_state transitions to takeover-pending", async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const id = await createSession(fx, 'pair');
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/takeover`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { client_id: 'cli_tab_a' },
    });
    expect(res.statusCode).toBe(200);
    const state = res.json<{
      pair_mode_state: { kind: string; requestedByClientId?: string };
    }>().pair_mode_state;
    expect(state.kind).toBe('takeover-pending');
    expect(state.requestedByClientId).toBe('cli_tab_a');
  });

  it("mode='ai' → 409 Conflict (takeover requires mode='pair')", async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const id = await createSession(fx, 'ai');
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/takeover`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { client_id: 'cli_tab_a' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ type: string }>().type).toBe(PROBLEM_TYPES.Conflict);
  });

  it('missing client_id → 400 ValidationFailed', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const id = await createSession(fx, 'pair');
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/takeover`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ type: string }>().type).toBe(PROBLEM_TYPES.ValidationFailed);
  });

  it('unknown / cross-account id → 404 NotFound (guard fires before lock acquire)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions/agt_00000000-0000-4000-8000-0000000000aa/takeover',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { client_id: 'cli_tab_a' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ type: string }>().type).toBe(PROBLEM_TYPES.NotFound);
  });
});

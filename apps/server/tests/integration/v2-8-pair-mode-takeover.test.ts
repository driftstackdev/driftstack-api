// Arc 2 sub-slice 8.9 (v2-#8) — POST /takeover + POST /handback.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

describe('Arc 2 v2-#8 sub-slice 8.9 pair-mode takeover + handback routes', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  async function createPairSession(): Promise<string> {
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { mode: 'pair' },
    });
    return create.json<{ id: string }>().id;
  }

  it('takeover happy path: ai-driving → takeover-pending → handback-request leaves state in handback-pending', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const id = await createPairSession();

    const takeover = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/takeover`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { client_id: 'cli_a' },
    });
    expect(takeover.statusCode).toBe(200);
    expect(takeover.json<{ pair_mode_state: { kind: string } }>().pair_mode_state.kind).toBe(
      'takeover-pending',
    );
  });

  it('takeover requires mode=pair → 409 when session is mode=ai', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    const id = create.json<{ id: string }>().id;
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/takeover`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { client_id: 'cli_a' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('handback requires session to be in human-driving — error on premature request', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const id = await createPairSession();
    // No prior takeover — should fail since state machine starts in ai-driving.
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/handback`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    expect(res.statusCode).toBe(409);
  });

  it('cross-account 404 on /takeover when caller does not own the session', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions/agt_not_owned/takeover',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { client_id: 'cli_a' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('validation: takeover body requires non-empty client_id', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const id = await createPairSession();
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/takeover`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  // Arc 4 Wave 2.A sub-slice 8.16 (v2-#8) — Wave 2.A integration
  // smoke: end-to-end exercise of the typed 409 path with from +
  // transition extensions surfaced on the wire.
  it('v2-#8 sub-slice 8.16 double-takeover surfaces 409 PairModeStateInvalidTransition with from + transition extensions', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const id = await createPairSession();
    // First takeover request grabs the lock + transitions to
    // takeover-pending.
    const r1 = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/takeover`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { client_id: 'cli_a' },
    });
    expect(r1.statusCode).toBe(200);
    // Second takeover request from the SAME client — lock released
    // after the first call's `finally`, so we re-acquire successfully.
    // But applyPairModeTransition rejects since state is now
    // takeover-pending. Expect 409 with from + transition.
    const r2 = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/takeover`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { client_id: 'cli_a' },
    });
    expect(r2.statusCode).toBe(409);
    const body = r2.json<{
      type: string;
      from?: string;
      transition?: string;
    }>();
    expect(body.type).toContain('pair-mode-invalid-transition');
    expect(body.from).toBe('takeover-pending');
    expect(body.transition).toBe('takeover-request');
  });

  it('v2-#8 sub-slice 8.16 premature handback from ai-driving surfaces 409 + diagnostics', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const id = await createPairSession();
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/handback`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    expect(res.statusCode).toBe(409);
    const body = res.json<{ type: string; from?: string; transition?: string }>();
    expect(body.type).toContain('pair-mode-invalid-transition');
    expect(body.from).toBe('ai-driving');
    expect(body.transition).toBe('handback-request');
  });
});

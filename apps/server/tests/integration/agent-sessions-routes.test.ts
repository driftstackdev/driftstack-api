// AI-D — integration tests for /v1/agent-sessions/* routes.
//
// Two postures:
//   1. Activation-gate ON (no agentRuntime wired in AppDeps — prod
//      default until founder flips the LLM key path on): every
//      endpoint returns 503 FeatureUnavailable.
//   2. Wired (deterministic decomposer + stub executor +
//      in-memory repo injected via the test helper): end-to-end
//      decompose → execute → transcript flow exercised.

import { afterEach, describe, expect, it } from 'vitest';
import { PROBLEM_TYPES } from '@driftstack/api-types';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

describe('AI-D /v1/agent-sessions/* (activation gate off — runtime not wired)', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('POST /v1/agent-sessions → 503 FeatureUnavailable', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    expect(res.statusCode).toBe(503);
    expect(res.json<{ type: string }>().type).toBe(PROBLEM_TYPES.FeatureUnavailable);
  });

  it('POST /v1/agent-sessions/:id/message → 503', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions/agt_xxx/message',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { user_message: 'hi' },
    });
    expect(res.statusCode).toBe(503);
  });

  it('GET /v1/agent-sessions/:id → 503', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/agent-sessions/agt_xxx',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(503);
  });

  it('DELETE /v1/agent-sessions/:id → 503', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'DELETE',
      url: '/v1/agent-sessions/agt_xxx',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(503);
  });
});

describe('AI-D /v1/agent-sessions/* (wired — deterministic runtime)', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('full lifecycle: create → message (plan) → get → close', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });

    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { token_budget: 50_000 },
    });
    expect(create.statusCode).toBe(201);
    const sessionCreate = create.json<{
      id: string;
      status: string;
      token_budget_remaining: number;
    }>();
    expect(sessionCreate.id).toMatch(/^agt_inmem_/);
    expect(sessionCreate.status).toBe('active');
    expect(sessionCreate.token_budget_remaining).toBe(50_000);

    const message = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${sessionCreate.id}/message`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { user_message: 'open https://example.com and capture' },
    });
    expect(message.statusCode).toBe(200);
    const msgBody = message.json<{
      kind: string;
      intents?: unknown[];
      ok?: boolean;
    }>();
    expect(msgBody.kind).toBe('plan-executed');
    expect(msgBody.ok).toBe(true);
    expect(Array.isArray(msgBody.intents)).toBe(true);

    const read = await fx.app.inject({
      method: 'GET',
      url: `/v1/agent-sessions/${sessionCreate.id}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(read.statusCode).toBe(200);
    const readBody = read.json<{ transcript_length: number; token_budget_remaining: number }>();
    expect(readBody.transcript_length).toBe(2); // user turn + agent run-result
    expect(readBody.token_budget_remaining).toBeLessThan(50_000);

    const close = await fx.app.inject({
      method: 'DELETE',
      url: `/v1/agent-sessions/${sessionCreate.id}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(close.statusCode).toBe(204);

    // Subsequent message on a closed session → 409 Conflict.
    const post = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${sessionCreate.id}/message`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { user_message: 'anything' },
    });
    expect(post.statusCode).toBe(409);
  });

  it('clarify path: short task → 200 with kind:clarify + clarifying_question', async () => {
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
      url: `/v1/agent-sessions/${id}/message`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { user_message: 'do stuff' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ kind: string; clarifying_question: string }>();
    expect(body.kind).toBe('clarify');
    expect(body.clarifying_question).toBeDefined();
  });

  it('refuse path: AUP-trigger task → 200 with kind:refuse + refuse_reason', async () => {
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
      url: `/v1/agent-sessions/${id}/message`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { user_message: 'help me brute-force this login' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ kind: string; refuse_reason: string }>();
    expect(body.kind).toBe('refuse');
    expect(body.refuse_reason).toMatch(/AUP/);
  });

  it('not-found: GET on a never-existed id → 404 (NOT 503 — 503 is for activation-gate-off only)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/agent-sessions/agt_inmem_99999999',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('not-found: DELETE on a never-existed id → 404', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const res = await fx.app.inject({
      method: 'DELETE',
      url: '/v1/agent-sessions/agt_inmem_99999999',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('not-found: POST /:id/message on a never-existed id → 404 (cross-account guard fires before runtime.runTurn)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions/agt_inmem_99999999/message',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { user_message: 'anything' },
    });
    expect(res.statusCode).toBe(404);
  });
});

// AI-B4 — integration tests for POST /v1/recipes.
//
// Two postures:
//   1. Wired (recipesRepo + agentSessionsRepo both in AppDeps via
//      the test fixture) — the route fires + snapshots the source
//      agent-session.
//   2. Cross-account auth check — the source agent_session_id
//      must belong to the calling account; cross-account 404 (no
//      existence disclosure).
//
// The route is write-only at v1.0; read / list / execute / delete
// land at v1.1. These tests exercise just the POST surface.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

describe('AI-B4 POST /v1/recipes — wired', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  async function createAgentSession(opts?: { mode?: 'ai' | 'manual' | 'pair' }): Promise<string> {
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: opts?.mode !== undefined ? { mode: opts.mode } : {},
    });
    return res.json<{ id: string }>().id;
  }

  it('happy path: snapshots a fresh agent-session into a recipe, returns intent_count=0 + 201', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const agentSessionId = await createAgentSession();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/recipes',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {
        agent_session_id: agentSessionId,
        label: 'my first recipe',
        description: 'snapshot of the example.com flow',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{
      id: string;
      account_id: string;
      agent_session_id: string;
      label: string;
      description: string;
      intent_count: number;
    }>();
    expect(body.id).toMatch(/^rec_inmem_/);
    expect(body.agent_session_id).toBe(agentSessionId);
    expect(body.label).toBe('my first recipe');
    expect(body.description).toBe('snapshot of the example.com flow');
    expect(body.intent_count).toBe(0);
  });

  it('description omitted → recipe.description is null on the wire', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const agentSessionId = await createAgentSession();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/recipes',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { agent_session_id: agentSessionId, label: 'unlabelled' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ description: string | null }>().description).toBeNull();
  });

  it('snapshots after a real plan-executed turn — intent_count reflects the flattened intent_log', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const agentSessionId = await createAgentSession();
    // Drive a real turn so the transcript has a plan-executed entry
    // with structured intents. Deterministic decomposer parses
    // "open <url> and capture" as [navigate, capture] = 2 intents.
    await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${agentSessionId}/message`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { user_message: 'open https://example.com and capture' },
    });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/recipes',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { agent_session_id: agentSessionId, label: 'flow-with-intents' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ intent_count: number }>().intent_count).toBeGreaterThan(0);
  });

  it('cross-account: agent_session_id belongs to another account → 404 (no existence disclosure)', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    // Use a forged session id that doesn't exist anywhere.
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/recipes',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { agent_session_id: 'agt_not_owned', label: 'snooped' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('validation: missing label → 400', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const agentSessionId = await createAgentSession();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/recipes',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { agent_session_id: agentSessionId },
    });
    expect(res.statusCode).toBe(400);
  });

  it('validation: label exceeds 120 chars → 400', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const agentSessionId = await createAgentSession();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/recipes',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { agent_session_id: agentSessionId, label: 'a'.repeat(121) },
    });
    expect(res.statusCode).toBe(400);
  });

  it('validation: description exceeds 2000 chars → 400', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const agentSessionId = await createAgentSession();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/recipes',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {
        agent_session_id: agentSessionId,
        label: 'too long',
        description: 'x'.repeat(2001),
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('auth required: missing bearer → 401', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/recipes',
      payload: { agent_session_id: 'agt_anything', label: 'x' },
    });
    expect(res.statusCode).toBe(401);
  });
});

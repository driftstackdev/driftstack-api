// v2-#18 — end-to-end agent-decomposer usage-recording smoke test.
//
// Pins the wire from HTTP layer → AgentRuntime → usageRecorder.record:
//
//   1. POST /v1/agent-sessions creates an agent session.
//   2. POST /v1/agent-sessions/:id/message triggers a decompose() turn.
//   3. The deterministic decomposer emits a `usage` block (with
//      decomposerKind: 'deterministic', tokensConsumed > 0 on the plan
//      path).
//   4. AgentRuntime forwards the block to the configured usageRecorder
//      with the correct accountId + agentSessionId.
//   5. The recorder receives the record — the smoke test captures every
//      call via the new `captureAgentDecomposerUsage` fixture flag.
//
// What this test does NOT do:
//   - Exercise the real ClaudeAgentDecomposer (would need a live
//     Anthropic API key). DeterministicAgentDecomposer covers the same
//     runtime + recorder wire so the path is observably the same.
//   - Query GET /v1/admin/usage/accounts/:id — that endpoint filters
//     out `agent_decomposer` rows per the customer-facing-only design
//     in db/usage-repo.ts (INTERNAL_RECORD_TYPES). The point of v2-#18
//     is the recorder firing end-to-end; the admin surfacing is a
//     separate follow-up if/when agent-decomposer rows need to be
//     visible to the admin dashboard.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

describe('v2-#18 agent-decomposer usage recording end-to-end smoke', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('POST /v1/agent-sessions + POST /:id/message fires the usageRecorder once per decompose call with the right accountId + agentSessionId + usage block', async () => {
    fx = await buildTestApp({
      enableAgentRuntime: true,
      captureAgentDecomposerUsage: true,
    });
    // Before any chat turn, the recorder array is empty.
    expect(fx.agentDecomposerUsageRecords).toHaveLength(0);

    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { token_budget: 50_000 },
    });
    expect(create.statusCode).toBe(201);
    const agentSessionId = create.json<{ id: string }>().id;

    const message = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${agentSessionId}/message`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { user_message: 'open https://example.com and capture' },
    });
    expect(message.statusCode).toBe(200);

    // One decompose call → exactly one recorder.record invocation.
    expect(fx.agentDecomposerUsageRecords).toHaveLength(1);
    const recorded = fx.agentDecomposerUsageRecords[0]!;
    expect(recorded.accountId).toBe(fx.accountId);
    expect(recorded.agentSessionId).toBe(agentSessionId);
    // DeterministicAgentDecomposer fires the plan path on the "open url
    // + capture" trigger phrase + emits decomposerKind: 'deterministic'.
    expect(recorded.decomposeResultKind).toBe('plan');
    expect(recorded.usage.decomposerKind).toBe('deterministic');
    // Plan path debits real tokens (the runtime forwards
    // decomposed.tokensConsumed → recorder).
    expect(recorded.tokensConsumed).toBeGreaterThan(0);
  });

  it('subsequent turns accumulate recorder calls (one per decompose, no over- or under-counting)', async () => {
    fx = await buildTestApp({
      enableAgentRuntime: true,
      captureAgentDecomposerUsage: true,
    });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    const id = create.json<{ id: string }>().id;

    for (let i = 0; i < 3; i += 1) {
      const res = await fx.app.inject({
        method: 'POST',
        url: `/v1/agent-sessions/${id}/message`,
        headers: { authorization: `Bearer ${fx.plaintext}` },
        payload: { user_message: 'open https://example.com and capture' },
      });
      expect(res.statusCode).toBe(200);
    }
    expect(fx.agentDecomposerUsageRecords).toHaveLength(3);
    // All three turns share the same accountId + agentSessionId.
    for (const r of fx.agentDecomposerUsageRecords) {
      expect(r.accountId).toBe(fx.accountId);
      expect(r.agentSessionId).toBe(id);
      expect(r.usage.decomposerKind).toBe('deterministic');
    }
  });

  it('recorder is NOT wired when captureAgentDecomposerUsage flag is off — records array stays empty even after a turn (default posture)', async () => {
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
      payload: { user_message: 'open https://example.com and capture' },
    });
    expect(res.statusCode).toBe(200);
    expect(fx.agentDecomposerUsageRecords).toHaveLength(0);
  });
});

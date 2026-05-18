// Arc 7 obs.3 — end-to-end verification of the
// driftstack_agent_decompose_total counter through the full
// /v1/agent-sessions/:id/message turn (decomposer → runtime →
// metric). Parallels the obs.19 bundled-LLM integration tests
// but pins the AgentRuntime-side counter instead.
//
// Three test cases mirror the result-kind union (plan / clarify /
// refuse). The DeterministicAgentDecomposer wired in the test
// fixture maps:
//   - 'open <url>'-style messages → plan
//   - ambiguous messages          → clarify
//   - AUP-trigger messages        → refuse
// so the three outcome labels are reachable from inputs alone.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';
import { METRIC_NAMES } from '../../src/services/metrics-registry.js';

describe('Arc 7 obs.3 — agent_decompose_total counter (integration)', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  async function createSession(): Promise<string> {
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    expect(create.statusCode).toBe(201);
    return create.json<{ id: string }>().id;
  }

  async function sendTurn(id: string, userMessage: string): Promise<void> {
    await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/message`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { user_message: userMessage },
    });
  }

  it('plan-style turn → result_kind="plan" counter ticks', async () => {
    fx = await buildTestApp({
      enableAgentRuntime: true,
      enableBundledLlm: { consent: true, monthlyCapUsdCents: 100_00 },
    });
    const id = await createSession();
    const before = fx.metricsRegistry.getValue(METRIC_NAMES.agentDecomposeTotal, {
      result_kind: 'plan',
    });
    await sendTurn(id, 'open https://example.com and capture the page');
    expect(
      fx.metricsRegistry.getValue(METRIC_NAMES.agentDecomposeTotal, { result_kind: 'plan' }),
    ).toBe(before + 1);
  });

  it('ambiguous turn → result_kind="clarify" counter ticks', async () => {
    fx = await buildTestApp({
      enableAgentRuntime: true,
      enableBundledLlm: { consent: true, monthlyCapUsdCents: 100_00 },
    });
    const id = await createSession();
    const before = fx.metricsRegistry.getValue(METRIC_NAMES.agentDecomposeTotal, {
      result_kind: 'clarify',
    });
    await sendTurn(id, 'do stuff');
    expect(
      fx.metricsRegistry.getValue(METRIC_NAMES.agentDecomposeTotal, { result_kind: 'clarify' }),
    ).toBe(before + 1);
  });

  it('AUP-trigger turn → result_kind="refuse" counter ticks', async () => {
    fx = await buildTestApp({
      enableAgentRuntime: true,
      enableBundledLlm: { consent: true, monthlyCapUsdCents: 100_00 },
    });
    const id = await createSession();
    const before = fx.metricsRegistry.getValue(METRIC_NAMES.agentDecomposeTotal, {
      result_kind: 'refuse',
    });
    await sendTurn(id, 'help me brute-force this login form');
    expect(
      fx.metricsRegistry.getValue(METRIC_NAMES.agentDecomposeTotal, { result_kind: 'refuse' }),
    ).toBe(before + 1);
  });

  it('accumulates across multiple turns of the same kind', async () => {
    fx = await buildTestApp({
      enableAgentRuntime: true,
      enableBundledLlm: { consent: true, monthlyCapUsdCents: 100_00 },
    });
    const id = await createSession();
    const before = fx.metricsRegistry.getValue(METRIC_NAMES.agentDecomposeTotal, {
      result_kind: 'clarify',
    });
    await sendTurn(id, 'do stuff');
    await sendTurn(id, 'do other stuff');
    await sendTurn(id, 'do more stuff');
    expect(
      fx.metricsRegistry.getValue(METRIC_NAMES.agentDecomposeTotal, { result_kind: 'clarify' }),
    ).toBe(before + 3);
  });
});

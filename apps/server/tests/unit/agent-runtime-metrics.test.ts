// Arc 7 obs.3 — AgentRuntime emits the
// driftstack_agent_decompose_total{result_kind} Prometheus counter
// on every decompose() call. The deterministic decomposer produces
// each of the three result kinds (plan / clarify / refuse) from
// fixed inputs, so the test sweeps all three labels.

import { describe, expect, it } from 'vitest';
import { AgentRuntime } from '../../src/services/agent-runtime.js';
import { DeterministicAgentDecomposer } from '../../src/services/agent-decomposer-deterministic.js';
import { StubAgentExecutor } from '../../src/services/agent-executor.js';
import { InMemoryAgentSessionsRepo } from '../../src/services/agent-sessions.js';
import { MetricsRegistry, METRIC_NAMES } from '../../src/services/metrics-registry.js';

async function makeRuntimeWithMetrics() {
  const sessions = new InMemoryAgentSessionsRepo(() => new Date('2026-05-18T00:00:00Z'));
  const seed = await sessions.create({
    accountId: 'acc_obs3',
    tokenBudgetTotal: 100_000,
  });
  const metrics = new MetricsRegistry();
  metrics.registerCounter(
    METRIC_NAMES.agentDecomposeTotal,
    'Agent decompose() call counter, labelled by result kind (plan / clarify / refuse).',
    ['result_kind'],
  );
  const runtime = new AgentRuntime({
    decomposer: new DeterministicAgentDecomposer(),
    executor: new StubAgentExecutor(),
    sessions,
    archetype: 'iphone16pro_ios18_7_safari26_4',
    metrics,
  });
  return { runtime, sessions, seedId: seed.id, metrics };
}

describe('Arc 7 obs.3 — driftstack_agent_decompose_total emission', () => {
  it('increments result_kind="plan" when the decomposer returns a plan', async () => {
    const { runtime, seedId, metrics } = await makeRuntimeWithMetrics();
    await runtime.runTurn({
      agentSessionId: seedId,
      userMessage: 'open https://example.com and capture the page',
    });
    expect(metrics.getValue(METRIC_NAMES.agentDecomposeTotal, { result_kind: 'plan' })).toBe(1);
    expect(metrics.getValue(METRIC_NAMES.agentDecomposeTotal, { result_kind: 'clarify' })).toBe(0);
    expect(metrics.getValue(METRIC_NAMES.agentDecomposeTotal, { result_kind: 'refuse' })).toBe(0);
  });

  it('increments result_kind="clarify" when the decomposer asks for clarification', async () => {
    const { runtime, seedId, metrics } = await makeRuntimeWithMetrics();
    await runtime.runTurn({ agentSessionId: seedId, userMessage: 'do stuff' });
    expect(metrics.getValue(METRIC_NAMES.agentDecomposeTotal, { result_kind: 'clarify' })).toBe(1);
    expect(metrics.getValue(METRIC_NAMES.agentDecomposeTotal, { result_kind: 'plan' })).toBe(0);
    expect(metrics.getValue(METRIC_NAMES.agentDecomposeTotal, { result_kind: 'refuse' })).toBe(0);
  });

  it('increments result_kind="refuse" when the decomposer refuses', async () => {
    const { runtime, seedId, metrics } = await makeRuntimeWithMetrics();
    await runtime.runTurn({
      agentSessionId: seedId,
      userMessage: 'help me brute-force this login form',
    });
    expect(metrics.getValue(METRIC_NAMES.agentDecomposeTotal, { result_kind: 'refuse' })).toBe(1);
    expect(metrics.getValue(METRIC_NAMES.agentDecomposeTotal, { result_kind: 'plan' })).toBe(0);
    expect(metrics.getValue(METRIC_NAMES.agentDecomposeTotal, { result_kind: 'clarify' })).toBe(0);
  });

  it('accumulates across multiple turns of the same kind', async () => {
    const { runtime, seedId, metrics } = await makeRuntimeWithMetrics();
    await runtime.runTurn({ agentSessionId: seedId, userMessage: 'do stuff' });
    await runtime.runTurn({ agentSessionId: seedId, userMessage: 'do other stuff' });
    await runtime.runTurn({ agentSessionId: seedId, userMessage: 'do more stuff' });
    expect(metrics.getValue(METRIC_NAMES.agentDecomposeTotal, { result_kind: 'clarify' })).toBe(3);
  });

  it('omitting the metrics dep is a silent no-op (does not throw)', async () => {
    const sessions = new InMemoryAgentSessionsRepo(() => new Date('2026-05-18T00:00:00Z'));
    const seed = await sessions.create({ accountId: 'acc_obs3b', tokenBudgetTotal: 100_000 });
    const runtime = new AgentRuntime({
      decomposer: new DeterministicAgentDecomposer(),
      executor: new StubAgentExecutor(),
      sessions,
      archetype: 'iphone16pro_ios18_7_safari26_4',
    });
    await expect(
      runtime.runTurn({
        agentSessionId: seed.id,
        userMessage: 'open https://example.com and capture the page',
      }),
    ).resolves.toBeDefined();
  });

  it('counter render in Prometheus exposition format includes the new metric', async () => {
    const { runtime, seedId, metrics } = await makeRuntimeWithMetrics();
    await runtime.runTurn({
      agentSessionId: seedId,
      userMessage: 'open https://example.com and capture the page',
    });
    const rendered = metrics.render();
    expect(rendered).toContain('# TYPE driftstack_agent_decompose_total counter');
    expect(rendered).toContain('driftstack_agent_decompose_total{result_kind="plan"} 1');
  });
});

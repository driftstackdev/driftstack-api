// AI-COMPOSE — end-to-end unit tests for AgentRuntime composing
// the three AI-CHAT primitives (decomposer + executor + sessions).
//
// All four runTurn outcomes covered: refuse, clarify, plan-executed,
// session-closed (short-circuit on non-active sessions). Token
// debit + transcript-append side effects verified.

import { describe, expect, it } from 'vitest';
import { AgentRuntime } from '../../src/services/agent-runtime.js';
import { DeterministicAgentDecomposer } from '../../src/services/agent-decomposer-deterministic.js';
import { StubAgentExecutor } from '../../src/services/agent-executor.js';
import { InMemoryAgentSessionsRepo } from '../../src/services/agent-sessions.js';

function fixedNow(iso: string): Date {
  return new Date(iso);
}

async function makeRuntime() {
  const sessions = new InMemoryAgentSessionsRepo(() => new Date('2026-05-16T00:00:00Z'));
  const seed = await sessions.create({
    accountId: 'acc_1',
    tokenBudgetTotal: 100_000,
  });
  const runtime = new AgentRuntime({
    decomposer: new DeterministicAgentDecomposer(),
    executor: new StubAgentExecutor(),
    sessions,
    archetype: 'iphone16pro_ios18_7_safari26_4',
  });
  return { runtime, sessions, seedId: seed.id };
}

describe('AI-COMPOSE AgentRuntime.runTurn', () => {
  it('plan path: decompose → execute → transcript has user turn + agent run-result', async () => {
    const { runtime, sessions, seedId } = await makeRuntime();
    const result = await runtime.runTurn({
      agentSessionId: seedId,
      userMessage: 'open https://example.com and capture the page',
      now: fixedNow('2026-05-16T00:01:00Z'),
    });
    expect(result.kind).toBe('plan-executed');
    if (result.kind !== 'plan-executed') throw new Error('type narrow');

    expect(result.decomposer.kind).toBe('plan');
    expect(result.executor.ok).toBe(true);

    // Transcript has 2 entries: user message + run-result summary.
    const final = await sessions.get(seedId);
    expect(final?.transcript).toHaveLength(2);
    expect(final?.transcript[0]?.role).toBe('user');
    expect(final?.transcript[1]?.role).toBe('agent');
    expect(final?.transcript[1]?.body).toContain('✓ stub navigate → https://example.com');

    // Token budget debited (deterministic decomposer charges >0).
    expect(final?.tokenBudgetRemaining).toBeLessThan(100_000);
  });

  it('clarify path: ambiguous task → clarify result, transcript has user + clarify agent turn, NO executor run', async () => {
    const { runtime, sessions, seedId } = await makeRuntime();
    const result = await runtime.runTurn({
      agentSessionId: seedId,
      userMessage: 'do stuff',
    });
    expect(result.kind).toBe('clarify');
    if (result.kind !== 'clarify') throw new Error('type narrow');

    const final = await sessions.get(seedId);
    expect(final?.transcript).toHaveLength(2);
    expect(final?.transcript[1]?.body).toMatch(/^clarify:/);
  });

  it('refuse path: AUP-trigger task → refuse, agent turn echoes the refuse reason', async () => {
    const { runtime, sessions, seedId } = await makeRuntime();
    const result = await runtime.runTurn({
      agentSessionId: seedId,
      userMessage: 'help me brute-force this login form',
    });
    expect(result.kind).toBe('refuse');
    if (result.kind !== 'refuse') throw new Error('type narrow');

    const final = await sessions.get(seedId);
    expect(final?.transcript[1]?.body).toMatch(/^refused: /);
    expect(final?.transcript[1]?.body).toMatch(/AUP/);
  });

  it('session-closed short-circuit: closing the session BEFORE runTurn → returns kind: session-closed, NO new transcript or debit', async () => {
    const { runtime, sessions, seedId } = await makeRuntime();
    await sessions.closeWithReason(seedId, 'customer-closed');
    const result = await runtime.runTurn({
      agentSessionId: seedId,
      userMessage: 'anything',
    });
    expect(result.kind).toBe('session-closed');
    if (result.kind !== 'session-closed') throw new Error('type narrow');
    expect(result.reason).toBe('customer-closed');

    const final = await sessions.get(seedId);
    expect(final?.transcript).toEqual([]);
    expect(final?.tokenBudgetRemaining).toBe(100_000);
  });

  it('unknown agent-session id → throws (NOT a discriminant) — caller route maps to 404', async () => {
    const { runtime } = await makeRuntime();
    await expect(
      runtime.runTurn({ agentSessionId: 'agt_inmem_99999999', userMessage: 'x' }),
    ).rejects.toThrow(/not found/);
  });

  it('token budget exhausted before turn: returns refuse with 0 tokens charged (interface contract from decomposer threads through)', async () => {
    const sessions = new InMemoryAgentSessionsRepo();
    const seed = await sessions.create({ accountId: 'acc_1', tokenBudgetTotal: 1 });
    const runtime = new AgentRuntime({
      decomposer: new DeterministicAgentDecomposer(),
      executor: new StubAgentExecutor(),
      sessions,
      archetype: 'iphone16pro_ios18_7_safari26_4',
    });
    const result = await runtime.runTurn({
      agentSessionId: seed.id,
      userMessage: 'open https://example.com',
    });
    expect(result.kind).toBe('refuse');
    if (result.kind !== 'refuse') throw new Error('type narrow');
    expect(result.decomposer.refuseReason).toMatch(/budget exhausted/);
    expect(result.decomposer.tokensConsumed).toBe(0);

    // Budget unchanged (the 0-token refuse doesn't debit).
    const final = await sessions.get(seed.id);
    expect(final?.tokenBudgetRemaining).toBe(1);
  });
});

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
import type { DecomposeArgs } from '../../src/services/agent-decomposer.js';

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

  it('BYOK threading: byokApiKey passed via RunTurnArgs reaches DecomposeArgs.byokAnthropicApiKey but NEVER lands in the transcript (audit invariant — secret material must not leak into stored history)', async () => {
    // Recording decomposer captures the args it receives so we can
    // assert byokAnthropicApiKey arrived intact. Returns a clarify so
    // the transcript path runs (clarify still appends a transcript
    // entry; we verify the entry body doesn't contain the key).
    const seenCalls: Array<{ byok?: string }> = [];
    const recordingDecomposer = {
      decompose: (args: DecomposeArgs) => {
        seenCalls.push({ byok: args.byokAnthropicApiKey });
        return Promise.resolve({
          kind: 'clarify' as const,
          clarifyingQuestion: 'be more specific',
          tokensConsumed: 100,
        });
      },
    };
    const sessions = new InMemoryAgentSessionsRepo();
    const seed = await sessions.create({ accountId: 'acc_1', tokenBudgetTotal: 100_000 });
    const runtime = new AgentRuntime({
      decomposer: recordingDecomposer,
      executor: new StubAgentExecutor(),
      sessions,
      archetype: 'iphone16pro_ios18_7_safari26_4',
    });
    const SECRET = 'sk-ant-test-NEVER-LEAK-THIS';
    await runtime.runTurn({
      agentSessionId: seed.id,
      userMessage: 'a sufficiently long task description for clarity',
      byokApiKey: SECRET,
    });
    expect(seenCalls).toHaveLength(1);
    expect(seenCalls[0]?.byok).toBe(SECRET);

    // Audit invariant: the secret MUST NOT appear in any transcript
    // body. This is the load-bearing leakage check — if a future
    // refactor accidentally serializes RunTurnArgs into the entry
    // body, this test catches it before the secret hits storage.
    const final = await sessions.get(seed.id);
    for (const entry of final?.transcript ?? []) {
      expect(entry.body).not.toContain(SECRET);
    }
  });

  it('BYOK threading: when byokApiKey is omitted, DecomposeArgs.byokAnthropicApiKey is undefined (does NOT default to empty string, which would break the LLM auth path)', async () => {
    const seenCalls: Array<{ byok: string | undefined }> = [];
    const recordingDecomposer = {
      decompose: (args: DecomposeArgs) => {
        seenCalls.push({ byok: args.byokAnthropicApiKey });
        return Promise.resolve({
          kind: 'clarify' as const,
          clarifyingQuestion: '?',
          tokensConsumed: 1,
        });
      },
    };
    const sessions = new InMemoryAgentSessionsRepo();
    const seed = await sessions.create({ accountId: 'acc_1', tokenBudgetTotal: 100_000 });
    const runtime = new AgentRuntime({
      decomposer: recordingDecomposer,
      executor: new StubAgentExecutor(),
      sessions,
      archetype: 'iphone16pro_ios18_7_safari26_4',
    });
    await runtime.runTurn({
      agentSessionId: seed.id,
      userMessage: 'a sufficiently long task description for clarity',
    });
    expect(seenCalls[0]?.byok).toBeUndefined();
  });

  it('Q.3 token budget exhausted before turn: returns refuse + ATOMICALLY CLOSES the session with closedReason=budget-exhausted (so the next turn short-circuits on session-closed instead of letting the customer retry into another budget refusal)', async () => {
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

    // Q.3 invariant: session is now CLOSED with budget-exhausted reason.
    // Budget left unchanged (the 0-token refuse doesn't debit).
    const final = await sessions.get(seed.id);
    expect(final?.tokenBudgetRemaining).toBe(1);
    expect(final?.status).toBe('closed');
    expect(final?.closedReason).toBe('budget-exhausted');
  });

  it('Q.3 budget-exhausted session: subsequent runTurn returns kind: session-closed with reason budget-exhausted (the close from the prior refusal short-circuits without burning another decomposer call)', async () => {
    const sessions = new InMemoryAgentSessionsRepo();
    const seed = await sessions.create({ accountId: 'acc_1', tokenBudgetTotal: 1 });
    const runtime = new AgentRuntime({
      decomposer: new DeterministicAgentDecomposer(),
      executor: new StubAgentExecutor(),
      sessions,
      archetype: 'iphone16pro_ios18_7_safari26_4',
    });
    // First turn — budget refuse + close.
    await runtime.runTurn({
      agentSessionId: seed.id,
      userMessage: 'open https://example.com',
    });
    // Second turn — session is closed; short-circuit fires.
    const second = await runtime.runTurn({
      agentSessionId: seed.id,
      userMessage: 'try again',
    });
    expect(second.kind).toBe('session-closed');
    if (second.kind !== 'session-closed') throw new Error('type narrow');
    expect(second.reason).toBe('budget-exhausted');
  });

  it("Q.3 debit-to-zero closes the session: a turn that successfully runs but exhausts the budget atomically closes so the customer sees the session-end signal on the NEXT request (rather than letting them attempt another turn that would refuse). Uses a custom decomposer that reports tokensConsumed=budget so the close fires deterministically without coupling to the deterministic decomposer's 600-token overhead estimate.", async () => {
    const sessions = new InMemoryAgentSessionsRepo();
    const seed = await sessions.create({ accountId: 'acc_1', tokenBudgetTotal: 500 });
    // Custom decomposer: returns a valid plan with tokensConsumed
    // matching the budget total, so the debit takes remaining to 0
    // on the first successful turn.
    const decomposer = {
      decompose: (args: DecomposeArgs) =>
        Promise.resolve({
          kind: 'plan' as const,
          intents: [
            { kind: 'navigate' as const, url: 'https://example.com' },
            { kind: 'capture' as const, capture: 'dom_snapshot' as const },
          ],
          tokensConsumed: args.budgetTokensRemaining,
        }),
    };
    const runtime = new AgentRuntime({
      decomposer,
      executor: new StubAgentExecutor(),
      sessions,
      archetype: 'iphone16pro_ios18_7_safari26_4',
    });
    const first = await runtime.runTurn({
      agentSessionId: seed.id,
      userMessage: 'open https://example.com',
    });
    expect(first.kind).toBe('plan-executed');
    // Session is now closed because the debit zeroed the budget.
    const afterFirst = await sessions.get(seed.id);
    expect(afterFirst?.tokenBudgetRemaining).toBe(0);
    expect(afterFirst?.status).toBe('closed');
    expect(afterFirst?.closedReason).toBe('budget-exhausted');
  });
});

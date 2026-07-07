// AI-COMPOSE — end-to-end unit tests for AgentRuntime composing
// the three AI-CHAT primitives (decomposer + executor + sessions).
//
// All four runTurn outcomes covered: refuse, clarify, plan-executed,
// session-closed (short-circuit on non-active sessions). Token
// debit + transcript-append side effects verified.

import { describe, expect, it } from 'vitest';
import { AgentRuntime, classifyDecomposerError } from '../../src/services/agent-runtime.js';
import { DeterministicAgentDecomposer } from '../../src/services/agent-decomposer-deterministic.js';
import { StubAgentExecutor, consequentialSignature } from '../../src/services/agent-executor.js';
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
  it('plan path: decompose → execute → transcript has user turn + agent run-result. Q.5.c: the agent turn ALSO carries the structured plan.intents on the optional `intents` field so recipes can assemble a replayable intent_log without re-running the decomposer.', async () => {
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

    // Q.5.c structured intents present on the agent turn — the
    // deterministic decomposer produces a navigate + wait +
    // capture intent triple, matching `plan.intents`.
    expect(final?.transcript[0]?.intents).toBeUndefined(); // user turns never carry intents
    const agentIntents = final?.transcript[1]?.intents;
    expect(agentIntents).toBeDefined();
    expect(agentIntents).toEqual(
      result.decomposer.kind === 'plan' ? result.decomposer.intents : undefined,
    );

    // Token budget debited (deterministic decomposer charges >0).
    expect(final?.tokenBudgetRemaining).toBeLessThan(100_000);
  });

  // #140 read-and-report — a capturing plan gets a follow-up "answer" turn read
  // back from the page text, so "get the IP" returns the actual IP.
  async function makeReadbackRuntime(opts: { observe?: () => Promise<string | null> } = {}) {
    const sessions = new InMemoryAgentSessionsRepo(() => new Date('2026-05-16T00:00:00Z'));
    const seed = await sessions.create({ accountId: 'acc_1', tokenBudgetTotal: 100_000 });
    const base = new DeterministicAgentDecomposer();
    const stub = new StubAgentExecutor();
    const decomposer = {
      decompose: (a: DecomposeArgs) => base.decompose(a),
      answerFromObservation: () =>
        Promise.resolve({ answer: 'Your IP address is 203.0.113.7.', tokensConsumed: 40 }),
    };
    const executor = {
      execute: (a: Parameters<StubAgentExecutor['execute']>[0]) => stub.execute(a),
      observe: opts.observe ?? (() => Promise.resolve('Your IP: 203.0.113.7\nISP: Example')),
    };
    const runtime = new AgentRuntime({
      decomposer,
      executor,
      sessions,
      archetype: 'iphone16pro_ios18_7_safari26_4',
    });
    return { runtime, sessions, seedId: seed.id };
  }

  it('#140 read-and-report: a capturing plan appends a read-back ANSWER turn (the actual IP) + debits the answer tokens', async () => {
    const { runtime, sessions, seedId } = await makeReadbackRuntime();
    const result = await runtime.runTurn({
      agentSessionId: seedId,
      userMessage: 'get the IP from https://browserleaks.com/ip and capture the page',
      byokApiKey: 'sk-ant-test-fake-key',
    });
    expect(result.kind).toBe('plan-executed');
    const final = await sessions.get(seedId);
    // user + plan-run + the read-back answer = 3 entries.
    expect(final?.transcript).toHaveLength(3);
    expect(final?.transcript[2]?.role).toBe('agent');
    expect(final?.transcript[2]?.body).toBe('Your IP address is 203.0.113.7.');
    expect(final?.transcript[2]?.intents).toBeUndefined(); // answer turn is not a plan
  });

  it('#140 read-and-report: NO read-back without a BYOK key (feature-gated) — only user + plan turns', async () => {
    const { runtime, sessions, seedId } = await makeReadbackRuntime();
    await runtime.runTurn({
      agentSessionId: seedId,
      userMessage: 'get the IP from https://browserleaks.com/ip and capture the page',
      // no byokApiKey → the answer pass is gated off
    });
    const final = await sessions.get(seedId);
    expect(final?.transcript).toHaveLength(2);
  });

  it('#140 read-and-report: an empty/failed observe does NOT append an answer turn (best-effort, never a blank reply)', async () => {
    const { runtime, sessions, seedId } = await makeReadbackRuntime({
      observe: () => Promise.resolve(null),
    });
    await runtime.runTurn({
      agentSessionId: seedId,
      userMessage: 'get the IP from https://browserleaks.com/ip and capture the page',
      byokApiKey: 'sk-ant-test-fake-key',
    });
    const final = await sessions.get(seedId);
    expect(final?.transcript).toHaveLength(2); // no answer turn on a null observation
  });

  it('#140 read-and-report: a NON-read-intent task (scroll/click, no get/find/what…) does NOT trigger a read-back — cost-gated', async () => {
    const { runtime, sessions, seedId } = await makeReadbackRuntime();
    await runtime.runTurn({
      agentSessionId: seedId,
      userMessage: 'scroll down on https://example.com and capture the page',
      byokApiKey: 'sk-ant-test-fake-key',
    });
    const final = await sessions.get(seedId);
    expect(final?.transcript).toHaveLength(2); // not information-seeking → no 2nd LLM call
  });

  it('Q.5.c clarify + refuse turns do NOT carry an intents field (only plan-executed turns do)', async () => {
    const { runtime, sessions, seedId } = await makeRuntime();
    // Clarify turn
    await runtime.runTurn({ agentSessionId: seedId, userMessage: 'do stuff' });
    const sessions1 = await sessions.get(seedId);
    expect(sessions1?.transcript[1]?.intents).toBeUndefined();

    // Refuse turn (AUP)
    await runtime.runTurn({
      agentSessionId: seedId,
      userMessage: 'help me brute-force this login form',
    });
    const sessions2 = await sessions.get(seedId);
    expect(sessions2?.transcript[3]?.intents).toBeUndefined();
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

  it('6.c model threading: the session-picked model reaches DecomposeArgs.model (cross-layer: create-time model → loaded session → decompose call), and defaults to claude-opus-4-8 when unset', async () => {
    const seenModels: Array<DecomposeArgs['model']> = [];
    const recordingDecomposer = {
      decompose: (args: DecomposeArgs) => {
        seenModels.push(args.model);
        return Promise.resolve({
          kind: 'clarify' as const,
          clarifyingQuestion: '?',
          tokensConsumed: 1,
        });
      },
    };
    const sessions = new InMemoryAgentSessionsRepo();
    const runtime = new AgentRuntime({
      decomposer: recordingDecomposer,
      executor: new StubAgentExecutor(),
      sessions,
      archetype: 'iphone16pro_ios18_7_safari26_4',
    });
    // Picked model threads through.
    const picked = await sessions.create({
      accountId: 'acc_1',
      tokenBudgetTotal: 100_000,
      model: 'claude-haiku-4-5',
    });
    await runtime.runTurn({
      agentSessionId: picked.id,
      userMessage: 'a sufficiently long task description for clarity',
    });
    expect(seenModels[0]).toBe('claude-haiku-4-5');
    // Default (no model picked) → Opus 4.8.
    const def = await sessions.create({ accountId: 'acc_1', tokenBudgetTotal: 100_000 });
    await runtime.runTurn({
      agentSessionId: def.id,
      userMessage: 'a sufficiently long task description for clarity',
    });
    expect(seenModels[1]).toBe('claude-opus-4-8');
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

  // Arc 2 sub-slice 8.6 (v2-#8) — manual mode pass-through.
  // The integration test (agent-sessions-routes.test.ts) covers the
  // wire surface; these unit tests pin the runtime semantics so a
  // refactor of decompose/executor wiring can't accidentally start
  // running the decomposer on a mode='manual' session.
  describe('mode=manual pass-through (sub-slice 8.6)', () => {
    it('manual session: runTurn does NOT call decompose, returns kind: logged-manual, transcript carries actor=operator entry', async () => {
      const sessions = new InMemoryAgentSessionsRepo();
      const seed = await sessions.create({
        accountId: 'acc_1',
        mode: 'manual',
        tokenBudgetTotal: 100_000,
      });
      // Decomposer that explodes if called — proves runTurn never
      // touches it on mode='manual'.
      const explodingDecomposer = {
        decompose: () => Promise.reject(new Error('decompose must not be called on manual mode')),
      };
      const runtime = new AgentRuntime({
        decomposer: explodingDecomposer,
        executor: new StubAgentExecutor(),
        sessions,
        archetype: 'iphone16pro_ios18_7_safari26_4',
      });
      const result = await runtime.runTurn({
        agentSessionId: seed.id,
        userMessage: 'I am driving directly via gui_control',
      });
      expect(result.kind).toBe('logged-manual');
      const final = await sessions.get(seed.id);
      expect(final?.transcript).toHaveLength(1);
      expect(final?.transcript[0]?.role).toBe('operator');
      expect(final?.transcript[0]?.body).toBe('I am driving directly via gui_control');
      // No debit on manual turns — they consume zero tokens.
      expect(final?.tokenBudgetRemaining).toBe(100_000);
    });

    it('manual session does NOT carry intents on the operator turn (intents are only set on plan-executed agent turns)', async () => {
      const sessions = new InMemoryAgentSessionsRepo();
      const seed = await sessions.create({
        accountId: 'acc_1',
        mode: 'manual',
        tokenBudgetTotal: 100_000,
      });
      const runtime = new AgentRuntime({
        decomposer: new DeterministicAgentDecomposer(),
        executor: new StubAgentExecutor(),
        sessions,
        archetype: 'iphone16pro_ios18_7_safari26_4',
      });
      await runtime.runTurn({ agentSessionId: seed.id, userMessage: 'click submit' });
      const final = await sessions.get(seed.id);
      expect(final?.transcript[0]?.intents).toBeUndefined();
    });
  });

  describe('Q.1.b hybrid error classification', () => {
    it('transient error (Anthropic 5xx) → refuse with agent-unavailable reason, session stays active', async () => {
      const throwingDecomposer = {
        decompose: (_args: DecomposeArgs) =>
          Promise.reject(new Error('Anthropic API 503: upstream error')),
      };
      const sessions = new InMemoryAgentSessionsRepo();
      const seed = await sessions.create({ accountId: 'acc_1', tokenBudgetTotal: 100_000 });
      const runtime = new AgentRuntime({
        decomposer: throwingDecomposer,
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
      expect(result.decomposer.refuseReason).toMatch(/temporarily unavailable/);
      expect(result.decomposer.tokensConsumed).toBe(0);
      // Session stays active per Q.1.b open-answer verdict.
      const final = await sessions.get(seed.id);
      expect(final?.status).toBe('active');
    });

    it('transient error (network) → refuse, session stays active', async () => {
      const throwingDecomposer = {
        decompose: (_args: DecomposeArgs) => Promise.reject(new Error('ECONNRESET')),
      };
      const sessions = new InMemoryAgentSessionsRepo();
      const seed = await sessions.create({ accountId: 'acc_1', tokenBudgetTotal: 100_000 });
      const runtime = new AgentRuntime({
        decomposer: throwingDecomposer,
        executor: new StubAgentExecutor(),
        sessions,
        archetype: 'iphone16pro_ios18_7_safari26_4',
      });
      const result = await runtime.runTurn({
        agentSessionId: seed.id,
        userMessage: 'open https://example.com',
      });
      expect(result.kind).toBe('refuse');
      const final = await sessions.get(seed.id);
      expect(final?.status).toBe('active');
    });

    it('fatal error (Anthropic 4xx) → re-throw, no transcript-side effects', async () => {
      const throwingDecomposer = {
        decompose: (_args: DecomposeArgs) =>
          Promise.reject(new Error('Anthropic API 401: invalid api key')),
      };
      const sessions = new InMemoryAgentSessionsRepo();
      const seed = await sessions.create({ accountId: 'acc_1', tokenBudgetTotal: 100_000 });
      const runtime = new AgentRuntime({
        decomposer: throwingDecomposer,
        executor: new StubAgentExecutor(),
        sessions,
        archetype: 'iphone16pro_ios18_7_safari26_4',
      });
      await expect(
        runtime.runTurn({
          agentSessionId: seed.id,
          userMessage: 'open https://example.com',
        }),
      ).rejects.toThrow(/Anthropic API 401/);
      const final = await sessions.get(seed.id);
      expect(final?.status).toBe('active');
      // Only the user turn made it into the transcript; no agent turn.
      expect(final?.transcript).toHaveLength(1);
      expect(final?.transcript[0]?.role).toBe('user');
    });

    it('fatal error (malformed response) → re-throw', async () => {
      const throwingDecomposer = {
        decompose: (_args: DecomposeArgs) =>
          Promise.reject(new Error('Anthropic response missing text content')),
      };
      const sessions = new InMemoryAgentSessionsRepo();
      const seed = await sessions.create({ accountId: 'acc_1', tokenBudgetTotal: 100_000 });
      const runtime = new AgentRuntime({
        decomposer: throwingDecomposer,
        executor: new StubAgentExecutor(),
        sessions,
        archetype: 'iphone16pro_ios18_7_safari26_4',
      });
      await expect(
        runtime.runTurn({
          agentSessionId: seed.id,
          userMessage: 'open https://example.com',
        }),
      ).rejects.toThrow(/missing text content/);
    });
  });
});

describe('Q.1.b classifyDecomposerError', () => {
  it('Anthropic 503 → transient', () => {
    expect(classifyDecomposerError(new Error('Anthropic API 503: upstream'))).toBe('transient');
  });

  it('Anthropic 502 → transient', () => {
    expect(classifyDecomposerError(new Error('Anthropic API 502: bad gateway'))).toBe('transient');
  });

  it('Anthropic 429 (rate-limit) → transient, NOT fatal (perf audit wb91zynsu): a throttle must degrade to a retryable refuse, not 500 the chat turn — must win over the 4xx→fatal branch', () => {
    expect(classifyDecomposerError(new Error('Anthropic API 429: rate_limit_error'))).toBe(
      'transient',
    );
  });

  it('Anthropic 408 / 425 → transient (timeout / too-early are recoverable)', () => {
    expect(classifyDecomposerError(new Error('Anthropic API 408: request timeout'))).toBe(
      'transient',
    );
    expect(classifyDecomposerError(new Error('Anthropic API 425: too early'))).toBe('transient');
  });

  it('Anthropic 401 → fatal (credential)', () => {
    expect(classifyDecomposerError(new Error('Anthropic API 401: invalid api key'))).toBe('fatal');
  });

  it('Anthropic 400 → fatal (validation)', () => {
    expect(classifyDecomposerError(new Error('Anthropic API 400: malformed request'))).toBe(
      'fatal',
    );
  });

  it('malformed response (missing text content) → fatal', () => {
    expect(classifyDecomposerError(new Error('Anthropic response missing text content'))).toBe(
      'fatal',
    );
  });

  it('malformed response (not valid JSON) → fatal', () => {
    expect(classifyDecomposerError(new Error('Anthropic response was not valid JSON'))).toBe(
      'fatal',
    );
  });

  it('malformed response (unknown kind) → fatal', () => {
    expect(classifyDecomposerError(new Error('Anthropic response has unknown kind: mystery'))).toBe(
      'fatal',
    );
  });

  it('missing api key → fatal (configuration error)', () => {
    expect(
      classifyDecomposerError(new Error('ClaudeAgentDecomposer: no Anthropic API key provided')),
    ).toBe('fatal');
  });

  it('network error (ECONNRESET) → transient', () => {
    expect(classifyDecomposerError(new Error('ECONNRESET'))).toBe('transient');
  });

  it('network error (fetch failed) → transient', () => {
    expect(classifyDecomposerError(new Error('fetch failed'))).toBe('transient');
  });

  it('non-Error throw → fatal (defensive — surface to Sentry)', () => {
    expect(classifyDecomposerError('some string')).toBe('fatal');
    expect(classifyDecomposerError(null)).toBe('fatal');
    expect(classifyDecomposerError(undefined)).toBe('fatal');
    expect(classifyDecomposerError({ random: 'object' })).toBe('fatal');
  });
});

describe('AgentRuntime.runTurn — consequential-action confirmation (W443/W445)', () => {
  it('halts on a consequential plan, then dispatches once the action is approved', async () => {
    const planDecomposer = {
      decompose: (_args: DecomposeArgs) =>
        Promise.resolve({
          kind: 'plan' as const,
          intents: [{ kind: 'interact' as const, action: 'tap' as const, selector: 'Buy Now' }],
          tokensConsumed: 50,
        }),
    };
    const sessions = new InMemoryAgentSessionsRepo();
    const seed = await sessions.create({ accountId: 'acc_1', tokenBudgetTotal: 100_000 });
    const runtime = new AgentRuntime({
      decomposer: planDecomposer,
      executor: new StubAgentExecutor(),
      sessions,
      archetype: 'iphone16pro_ios18_7_safari26_4',
    });
    // (1) no approval → the executor halts awaiting confirmation.
    const first = await runtime.runTurn({ agentSessionId: seed.id, userMessage: 'buy the thing' });
    expect(first.kind).toBe('plan-executed');
    if (first.kind === 'plan-executed') {
      expect(first.executor.awaitingConfirmation).toBe(true);
      expect(first.executor.results.at(-1)?.kind).toBe('confirmation_required');
    }
    // (2) the customer echoes the approval → the executor dispatches (no halt).
    const second = await runtime.runTurn({
      agentSessionId: seed.id,
      userMessage: 'yes, proceed',
      approvedConsequentialActions: new Set([consequentialSignature('purchase', 'Buy Now')]),
    });
    expect(second.kind).toBe('plan-executed');
    if (second.kind === 'plan-executed') {
      expect(second.executor.awaitingConfirmation).toBeUndefined();
      expect(second.executor.ok).toBe(true);
    }
  });
});

describe('W589 task-refusal start-gate wiring', () => {
  // A decomposer that records whether it was ever called — the start-gate
  // must short-circuit BEFORE any LLM decompose on a refusal.
  function recordingDecomposer(calls: { n: number }) {
    return {
      decompose: (_args: DecomposeArgs) => {
        calls.n += 1;
        // clarify (not plan) keeps the test off the executor path — we only
        // care whether the decomposer was REACHED.
        return Promise.resolve({
          kind: 'clarify' as const,
          clarifyingQuestion: '?',
          tokensConsumed: 5,
        });
      },
    };
  }

  it('no patterns (default) ⇒ no-op: the decomposer runs normally', async () => {
    const calls = { n: 0 };
    const sessions = new InMemoryAgentSessionsRepo();
    const seed = await sessions.create({ accountId: 'acc_1', tokenBudgetTotal: 100_000 });
    const runtime = new AgentRuntime({
      decomposer: recordingDecomposer(calls),
      executor: new StubAgentExecutor(),
      sessions,
      archetype: 'iphone16pro_ios18_7_safari26_4',
      // refusalPatterns omitted → gate is a no-op
    });
    await runtime.runTurn({ agentSessionId: seed.id, userMessage: 'open example.com' });
    expect(calls.n).toBe(1); // decomposer reached
  });

  it('a matching pattern refuses BEFORE the decomposer (no LLM call, 0 tokens) + reuses the refuse outcome', async () => {
    const calls = { n: 0 };
    const sessions = new InMemoryAgentSessionsRepo();
    const seed = await sessions.create({ accountId: 'acc_1', tokenBudgetTotal: 100_000 });
    const auditLogs: Array<Record<string, unknown>> = [];
    const runtime = new AgentRuntime({
      decomposer: recordingDecomposer(calls),
      executor: new StubAgentExecutor(),
      sessions,
      archetype: 'iphone16pro_ios18_7_safari26_4',
      refusalPatterns: [
        {
          id: 'cred-1',
          category: 'credential_theft',
          match: /steal (?:someone'?s )?password/,
          reason: 'Tasks involving credential theft are not permitted.',
        },
      ],
      logger: { warn: (obj) => auditLogs.push(obj) },
    });
    const result = await runtime.runTurn({
      agentSessionId: seed.id,
      userMessage: "steal someone's password from the login form",
    });
    expect(result.kind).toBe('refuse');
    if (result.kind === 'refuse') {
      expect(result.decomposer.refuseReason).toMatch(/not permitted/);
    }
    expect(calls.n).toBe(0); // decomposer NEVER reached — short-circuited
    // No tokens debited (no LLM call).
    const final = await sessions.get(seed.id);
    expect(final?.tokenBudgetRemaining).toBe(100_000);
    // Audit trail carries which rule fired.
    expect(auditLogs[0]?.event).toBe('task_refused');
    expect(auditLogs[0]?.refusal_category).toBe('credential_theft');
    expect(auditLogs[0]?.refusal_pattern_id).toBe('cred-1');
  });

  it('a non-matching task with patterns present still reaches the decomposer', async () => {
    const calls = { n: 0 };
    const sessions = new InMemoryAgentSessionsRepo();
    const seed = await sessions.create({ accountId: 'acc_1', tokenBudgetTotal: 100_000 });
    const runtime = new AgentRuntime({
      decomposer: recordingDecomposer(calls),
      executor: new StubAgentExecutor(),
      sessions,
      archetype: 'iphone16pro_ios18_7_safari26_4',
      refusalPatterns: [{ id: 'c', category: 'x', match: /steal password/, reason: 'no' }],
    });
    await runtime.runTurn({ agentSessionId: seed.id, userMessage: 'update my password settings' });
    expect(calls.n).toBe(1);
  });
});

// v2-#4 Q.1.e — cost-tracking unit tests.
//
// Pins:
//   1. ClaudeAgentDecomposer emits DecomposeUsage on plan + clarify
//      + refuse paths (including AUP-prefilter + budget-exhaust)
//      so AgentRuntime can record cost data for every turn.
//   2. makeClaudeUsage correctly computes cost cents from the
//      Anthropic-reported input/output token split, using the locked
//      per-MTok rates. Ceiling rounding so micro-turns don't
//      undercount.
//   3. DeterministicAgentDecomposer also emits a usage block (with
//      decomposerKind='deterministic' + no cost) so the audit trail
//      is uniform.
//   4. AgentRuntime calls the configured usageRecorder.record exactly
//      once per decompose() that returns a usage block, with the
//      correct accountId + agentSessionId + decompose_result_kind.
//   5. AgentRuntime swallows recorder failures (meter outage must NOT
//      break the customer's chat turn).

import { describe, expect, it, vi } from 'vitest';
import {
  ClaudeAgentDecomposer,
  __TEST_ONLY__,
} from '../../src/services/agent-decomposer-claude.js';
import { DeterministicAgentDecomposer } from '../../src/services/agent-decomposer-deterministic.js';
import { AgentRuntime } from '../../src/services/agent-runtime.js';
import type {
  AgentDecomposer,
  DecomposeArgs,
  DecomposeResult,
} from '../../src/services/agent-decomposer.js';
import type { AgentExecutor } from '../../src/services/agent-executor.js';
import type { AgentSessionRecord, AgentSessionsRepo } from '../../src/services/agent-sessions.js';

function jsonResponse(content: unknown, usage = { input_tokens: 120, output_tokens: 80 }) {
  return new Response(
    JSON.stringify({
      content: [{ type: 'text', text: JSON.stringify(content) }],
      usage,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function fetchOnce(response: Response): typeof globalThis.fetch {
  return vi.fn(() => Promise.resolve(response));
}

function defaultArgs(overrides: Partial<DecomposeArgs> = {}): DecomposeArgs {
  return {
    task: 'open https://example.com and capture',
    archetype: 'iphone16pro_ios18_7_safari26_4',
    history: [],
    budgetTokensRemaining: 100_000,
    byokAnthropicApiKey: 'sk-ant-test-fake-key',
    ...overrides,
  };
}

describe('v2-#4 Q.1.e cost-tracking', () => {
  describe('ClaudeAgentDecomposer DecomposeUsage emission', () => {
    it('plan path surfaces input + output tokens + cost cents + model', async () => {
      const dec = new ClaudeAgentDecomposer({
        fetch: fetchOnce(
          jsonResponse(
            { kind: 'plan', intents: [{ kind: 'capture', capture: 'screenshot' }] },
            { input_tokens: 1_000_000, output_tokens: 100_000 },
          ),
        ),
      });
      const res = await dec.decompose(defaultArgs());
      expect(res.kind).toBe('plan');
      expect(res.usage).toBeDefined();
      expect(res.usage?.decomposerKind).toBe('claude');
      expect(res.usage?.anthropicInputTokens).toBe(1_000_000);
      expect(res.usage?.anthropicOutputTokens).toBe(100_000);
      expect(res.usage?.model).toBe('claude-opus-4-7');
      // 1M input * $15/MTok = $15.00 + 100k output * $75/MTok = $7.50
      // = $22.50 = 2250 cents.
      expect(res.usage?.costUsdCents).toBe(2250);
    });

    it('AUP-prefilter refuse path emits zero-cost usage block', async () => {
      const dec = new ClaudeAgentDecomposer({
        // No fetch call expected; if it gets called the test fails on
        // the surprise.
        fetch: vi.fn(() => {
          throw new Error('fetch should not have been called');
        }) as unknown as typeof globalThis.fetch,
      });
      const res = await dec.decompose(
        defaultArgs({ task: 'brute-force the password on this account' }),
      );
      expect(res.kind).toBe('refuse');
      expect(res.usage).toBeDefined();
      expect(res.usage?.decomposerKind).toBe('claude');
      expect(res.usage?.anthropicInputTokens).toBe(0);
      expect(res.usage?.anthropicOutputTokens).toBe(0);
      expect(res.usage?.costUsdCents).toBe(0);
    });

    it('budget-exhaust refuse path emits zero-cost usage block', async () => {
      const dec = new ClaudeAgentDecomposer({
        fetch: vi.fn(() => {
          throw new Error('fetch should not have been called');
        }) as unknown as typeof globalThis.fetch,
      });
      const res = await dec.decompose(
        defaultArgs({ task: 'open the dashboard', budgetTokensRemaining: 0 }),
      );
      expect(res.kind).toBe('refuse');
      expect(res.usage).toBeDefined();
      expect(res.usage?.costUsdCents).toBe(0);
    });

    it('cost cents ceiling-rounds so micro-turns do not undercount', () => {
      // 1 input token at $15/MTok = $0.000015 → 0.0015 cents.
      // Ceiling = 1 cent (NOT zero).
      const usage = __TEST_ONLY__.makeClaudeUsage(1, 0);
      expect(usage.costUsdCents).toBe(1);
    });

    it('zero-token usage block has zero cost (not 1 from ceiling)', () => {
      const usage = __TEST_ONLY__.makeClaudeUsage(0, 0);
      expect(usage.costUsdCents).toBe(0);
    });
  });

  describe('DeterministicAgentDecomposer DecomposeUsage emission', () => {
    it('plan path emits decomposerKind=deterministic with no cost fields', async () => {
      const dec = new DeterministicAgentDecomposer();
      const res = await dec.decompose(defaultArgs({ task: 'open example.com' }));
      expect(res.usage).toBeDefined();
      expect(res.usage?.decomposerKind).toBe('deterministic');
      expect(res.usage?.anthropicInputTokens).toBeUndefined();
      expect(res.usage?.anthropicOutputTokens).toBeUndefined();
      expect(res.usage?.costUsdCents).toBeUndefined();
      expect(res.usage?.model).toBeUndefined();
    });
  });

  describe('AgentRuntime usage recording wire', () => {
    function makeFakeSessions(record: AgentSessionRecord): AgentSessionsRepo {
      return {
        get: (id: string) => Promise.resolve(id === record.id ? record : null),
        create: () => Promise.resolve(record),
        appendTranscript: () => Promise.resolve(record),
        debitTokens: () => Promise.resolve(record),
        listByAccount: () => Promise.resolve([]),
        closeWithReason: () => Promise.resolve(undefined),
      } as unknown as AgentSessionsRepo;
    }

    function makeFakeExecutor(): AgentExecutor {
      return {
        execute: () => Promise.resolve({ results: [] }),
      } as unknown as AgentExecutor;
    }

    function makeFakeDecomposer(result: DecomposeResult): AgentDecomposer {
      return {
        decompose: () => Promise.resolve(result),
      };
    }

    const baseSession: AgentSessionRecord = {
      id: 'aas_test',
      accountId: 'acc_test',
      apiKeyId: 'key_test',
      driftstackSessionId: null,
      status: 'active',
      tokenBudget: 100_000,
      tokenBudgetRemaining: 100_000,
      transcript: [],
      closedAt: null,
      closedReason: null,
      createdAt: new Date('2026-05-17T22:00:00Z'),
      updatedAt: new Date('2026-05-17T22:00:00Z'),
    } as unknown as AgentSessionRecord;

    it('calls recorder.record exactly once per decompose() that returns a usage block', async () => {
      const record = vi.fn(() => Promise.resolve(undefined));
      const runtime = new AgentRuntime({
        decomposer: makeFakeDecomposer({
          kind: 'plan',
          intents: [{ kind: 'capture', capture: 'screenshot' }],
          tokensConsumed: 100,
          usage: {
            decomposerKind: 'claude',
            anthropicInputTokens: 50,
            anthropicOutputTokens: 50,
            costUsdCents: 1,
            model: 'claude-opus-4-7',
          },
        }),
        executor: makeFakeExecutor(),
        sessions: makeFakeSessions(baseSession),
        archetype: 'iphone16pro_ios18_7_safari26_4',
        usageRecorder: { record },
      });
      await runtime.runTurn({
        agentSessionId: 'aas_test',
        userMessage: 'open example.com',
      });
      expect(record).toHaveBeenCalledTimes(1);
      const callArg = record.mock.calls[0]![0] as {
        accountId: string;
        agentSessionId: string;
        decomposeResultKind: string;
      };
      expect(callArg.accountId).toBe('acc_test');
      expect(callArg.agentSessionId).toBe('aas_test');
      expect(callArg.decomposeResultKind).toBe('plan');
    });

    it('skips recording when decomposer returns no usage block (legacy callers)', async () => {
      const record = vi.fn(() => Promise.resolve(undefined));
      const runtime = new AgentRuntime({
        decomposer: makeFakeDecomposer({
          kind: 'plan',
          intents: [{ kind: 'capture', capture: 'screenshot' }],
          tokensConsumed: 100,
        }),
        executor: makeFakeExecutor(),
        sessions: makeFakeSessions(baseSession),
        archetype: 'iphone16pro_ios18_7_safari26_4',
        usageRecorder: { record },
      });
      await runtime.runTurn({
        agentSessionId: 'aas_test',
        userMessage: 'open example.com',
      });
      expect(record).not.toHaveBeenCalled();
    });

    it('swallows recorder failures — chat turn still returns plan-executed', async () => {
      const record = vi.fn(() => Promise.reject(new Error('meter outage')));
      const runtime = new AgentRuntime({
        decomposer: makeFakeDecomposer({
          kind: 'plan',
          intents: [{ kind: 'capture', capture: 'screenshot' }],
          tokensConsumed: 100,
          usage: { decomposerKind: 'deterministic' },
        }),
        executor: makeFakeExecutor(),
        sessions: makeFakeSessions(baseSession),
        archetype: 'iphone16pro_ios18_7_safari26_4',
        usageRecorder: { record },
      });
      const result = await runtime.runTurn({
        agentSessionId: 'aas_test',
        userMessage: 'open example.com',
      });
      expect(result.kind).toBe('plan-executed');
      expect(record).toHaveBeenCalled();
    });
  });
});

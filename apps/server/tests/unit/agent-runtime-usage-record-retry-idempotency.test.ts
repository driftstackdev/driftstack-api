// A retried usage write must not charge the customer twice.
//
// `recordUsageRowWithRetry` re-invokes `usageRecorder.record` up to
// SPEND_RECORD_MAX_ATTEMPTS times on any throw. That retry exists for a good
// reason — the bundled-LLM `usage_records` row is the ONLY input to
// `sumMonthlySpendCents`, so a dropped row means the monthly soft-cap silently
// stops advancing. But a write can throw AFTER the server committed: a
// connection reset post-commit, or a client-side timeout on a statement that
// landed. The row is then already there, the retry inserts another, and the
// turn posts $0.20.
//
// That is not a hypothetical harm, it is a repeat of one that shipped. The
// per-row/per-turn bug fixed in f97cf1349 charged bundled turns twice, and its
// own commit message records the consequence: "their monthly cap was consumed
// at 2x and they were hard-402'd after half the turns they were sold, while the
// turn's own API response still reported 10." A retry after a committed write
// reaches the same end by a different route.
//
// `usage_records` carries no unique constraint beyond its primary key, so the
// fix is to make that key stable: the caller generates ONE id per row, every
// attempt reuses it, and the insert is `onConflictDoNothing`. The retry then
// conflicts with the row it already wrote and does nothing.
//
// This file guards the load-bearing half — that the id is generated once per
// ROW and not once per ATTEMPT. If it were regenerated inside the loop the
// insert would still be conflict-safe and would still charge twice, and every
// other test here would stay green.

import { describe, expect, it } from 'vitest';

import { AgentRuntime } from '../../src/services/agent-runtime.js';
import type { AgentDecomposer, DecomposeResult } from '../../src/services/agent-decomposer.js';
import type { AgentExecutor } from '../../src/services/agent-executor.js';
import type { AgentSessionRecord, AgentSessionsRepo } from '../../src/services/agent-sessions.js';

const PLAN: DecomposeResult = {
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
} as unknown as DecomposeResult;

const SESSION: AgentSessionRecord = {
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

function fakeDecomposer(): AgentDecomposer {
  return { decompose: () => Promise.resolve(PLAN) };
}

function fakeExecutor(): AgentExecutor {
  return { execute: () => Promise.resolve({ results: [] }) } as unknown as AgentExecutor;
}

function fakeSessions(): AgentSessionsRepo {
  const fake: Partial<AgentSessionsRepo> = {
    get: (id: string) => Promise.resolve(id === SESSION.id ? SESSION : null),
    create: () => Promise.resolve(SESSION),
    appendTranscript: () => Promise.resolve(SESSION),
    appendTranscriptIfAuthorityRevision: () => Promise.resolve(SESSION),
    debitTokens: () => Promise.resolve(SESSION),
    debitTokensIfActive: () => Promise.resolve(SESSION),
    listByAccount: () => Promise.resolve([]),
    closeWithReason: () => Promise.resolve(SESSION),
    getAuthoritySnapshot: (id: string) =>
      Promise.resolve(
        id === SESSION.id
          ? { status: 'active' as const, mode: 'ai' as const, pairModeState: null, revision: 1 }
          : null,
      ),
  };
  return fake as AgentSessionsRepo;
}

/** Runs one turn against a recorder that fails its first `failures` attempts. */
async function runWithFlakyRecorder(failures: number): Promise<Array<string | undefined>> {
  const seen: Array<string | undefined> = [];
  let calls = 0;
  const runtime = new AgentRuntime({
    decomposer: fakeDecomposer(),
    executor: fakeExecutor(),
    sessions: fakeSessions(),
    archetype: 'iphone16pro_ios18_7_safari26_4',
    usageRecorder: {
      record: (args: { recordId?: string }) => {
        seen.push(args.recordId);
        calls += 1;
        if (calls <= failures) return Promise.reject(new Error('transient write failure'));
        return Promise.resolve(undefined);
      },
    },
  });

  await runtime.runTurn({ agentSessionId: 'aas_test', userMessage: 'open example.com' });
  return seen;
}

describe('a retried usage write reuses ONE row identity, so it cannot charge twice', () => {
  it('CRITICAL every retry attempt carries the SAME record id. This is what makes the conflict-safe insert actually dedupe: an id regenerated per attempt would still be conflict-safe and would still post a second $0.10 for one turn.', async () => {
    const seen = await runWithFlakyRecorder(1);

    expect(seen.length, 'the transient failure was retried').toBeGreaterThan(1);
    expect(new Set(seen).size, 'all attempts for one row share one identity').toBe(1);
  });

  it('CRITICAL the id is actually present, not undefined. A missing id falls through to the database default, which gives the insert no conflict target — retry-unsafe while looking identical from here.', async () => {
    const seen = await runWithFlakyRecorder(1);

    for (const id of seen) {
      expect(id, 'each attempt carries a concrete record id').toBeTypeOf('string');
      expect((id ?? '').length, 'and it is a real uuid, not an empty string').toBeGreaterThan(30);
    }
  });

  it('CRITICAL the happy path carries an id too, so the very first write is already retry-safe rather than becoming so only after a failure.', async () => {
    const seen = await runWithFlakyRecorder(0);

    expect(seen.length, 'one attempt, no retry needed').toBe(1);
    expect(seen[0], 'and it still carries an id').toBeTypeOf('string');
  });

  it('CRITICAL two DIFFERENT rows get DIFFERENT identities. Reusing one id across rows would make the second row silently vanish into the conflict clause — undercounting the cap instead of overcounting it, which is the opposite failure and just as wrong.', async () => {
    const first = await runWithFlakyRecorder(0);
    const second = await runWithFlakyRecorder(0);

    expect(first[0], 'sanity: both runs recorded').toBeTypeOf('string');
    expect(second[0]).toBeTypeOf('string');
    expect(second[0], 'a separate row must not reuse the previous row id').not.toBe(first[0]);
  });
});

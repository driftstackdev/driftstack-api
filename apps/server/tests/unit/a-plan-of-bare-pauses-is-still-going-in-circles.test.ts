// S4, the narrow half — and it is the half that keeps the check worth having.
//
// Teaching the no-progress check that a reading pause traverses the page is a
// fix. Teaching it that ANY pause does would defeat the exact case the check
// exists for: a plan that waits and looks, repeated on a page that has not
// changed, which is a model dithering rather than a page rendering late. A
// `{duration_ms}` pause and a bare persona pause scroll nothing — the mapper
// sends `scroll_through` only for a pause carrying a word count — so neither
// earns the one-more-repeat allowance.
//
// See a-turn-that-reads-a-long-page-is-not-going-in-circles for the half this
// one bounds.

import { describe, expect, it } from 'vitest';
import { AgentRuntime, TURN_LOOP_STOP_SENTENCES } from '../../src/services/agent-runtime.js';
import { InMemoryAgentSessionsRepo } from '../../src/services/agent-sessions.js';
import type {
  AgentExecutor,
  ExecuteArgs,
  ExecutorRunResult,
  IntentResult,
} from '../../src/services/agent-executor.js';
import type {
  AgentIntent,
  DecomposeArgs,
  DecomposeResult,
  PlanStatus,
} from '../../src/services/agent-decomposer.js';

const NAV: AgentIntent = { kind: 'navigate', url: 'https://shop.test/queue' };
const DWELL: AgentIntent = { kind: 'behavioral_pause', duration_ms: 9_000 };
const BARE: AgentIntent = { kind: 'behavioral_pause' };
const SETTLE: AgentIntent = { kind: 'wait', condition: 'idle' };
const SHOT: AgentIntent = { kind: 'capture', capture: 'screenshot' };

function segment(intents: AgentIntent[], status?: PlanStatus): DecomposeResult {
  return {
    kind: 'plan',
    intents,
    ...(status !== undefined ? { status } : {}),
    tokensConsumed: 100,
  };
}

interface Harness {
  runs: ExecuteArgs[];
  seen: DecomposeArgs[];
}

function frozenPageExecutor(h: Harness): AgentExecutor {
  return {
    execute: (args: ExecuteArgs): Promise<ExecutorRunResult> => {
      h.runs.push(args);
      const results: IntentResult[] = args.plan.intents.map(
        (intent): IntentResult => ({ kind: 'success', intent, summary: `did ${intent.kind}` }),
      );
      return Promise.resolve({ results, ok: true });
    },
    observeDigest: () => Promise.resolve('a page that never changes'),
    observe: () => Promise.resolve('Still queueing.'),
  };
}

async function makeRuntime(h: Harness, plans: DecomposeResult[]) {
  const sessions = new InMemoryAgentSessionsRepo(() => new Date('2026-09-20T00:00:00Z'));
  const seed = await sessions.create({ accountId: 'acc_1', tokenBudgetTotal: 100_000 });
  const runtime = new AgentRuntime({
    decomposer: {
      decompose: (args: DecomposeArgs): Promise<DecomposeResult> => {
        h.seen.push(args);
        const next = plans[Math.min(h.seen.length - 1, plans.length - 1)];
        return Promise.resolve(next ?? segment([], 'done'));
      },
      answerFromObservation: () =>
        Promise.resolve({ answer: 'Still queueing.', tokensConsumed: 40 }),
    },
    executor: frozenPageExecutor(h),
    sessions,
    archetype: 'iphone16pro_ios18_7_safari26_4',
    nowMs: () => 1_000,
  });
  return {
    turn: (userMessage: string) =>
      runtime.runTurn({
        agentSessionId: seed.id,
        userMessage,
        byokApiKey: 'sk-ant-test-fake-key',
      }),
  };
}

describe('a plan of bare pauses is still going in circles', () => {
  it('CRITICAL a {duration_ms} pause repeated on an unchanged page is stopped the FIRST time — it scrolls nothing', async () => {
    const h: Harness = { runs: [], seen: [] };
    const waitMore = segment([DWELL], 'continue');
    const { turn } = await makeRuntime(h, [segment([NAV], 'continue'), waitMore, waitMore]);

    const result = await turn('wait for the queue to move');

    if (result.kind !== 'plan-executed') throw new Error('type narrow');
    expect(h.runs).toHaveLength(2);
    expect(result.loop?.stopped).toBe('no_progress');
    expect(result.notice).toBe(TURN_LOOP_STOP_SENTENCES.no_progress);
  });

  it('CRITICAL a bare persona pause gets no allowance either', async () => {
    const h: Harness = { runs: [], seen: [] };
    const waitMore = segment([BARE], 'continue');
    const { turn } = await makeRuntime(h, [segment([NAV], 'continue'), waitMore, waitMore]);

    const result = await turn('wait for the queue to move');

    if (result.kind !== 'plan-executed') throw new Error('type narrow');
    expect(h.runs).toHaveLength(2);
    expect(result.loop?.stopped).toBe('no_progress');
  });

  it('and neither does a pause that only accompanies a wait and a capture — the dithering case the check is for', async () => {
    const h: Harness = { runs: [], seen: [] };
    const dither = segment([SETTLE, DWELL, SHOT], 'continue');
    const { turn } = await makeRuntime(h, [segment([NAV], 'continue'), dither, dither]);

    const result = await turn('wait for the queue to move');

    if (result.kind !== 'plan-executed') throw new Error('type narrow');
    expect(h.runs).toHaveLength(2);
    expect(result.loop?.stopped).toBe('no_progress');
  });
});

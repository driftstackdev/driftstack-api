// DRIFTSTACK_PLANNING_READ — the experiment switch's RUNTIME half: which
// page-read PRIMES a segment's plan. `text` (default) is proven byte-
// identical by every EXISTING planning-read test continuing to pass
// unchanged — see a-page-that-cannot-be-read-twice-in-a-row-ends-the-turn-
// honestly.test.ts, whose harness this one borrows. This file covers the two
// new modes:
//
//   `elements`           — the element list is asked FIRST; the text digest
//                           is read only when the list came back empty or
//                           refused (T2 — one retry, never two attempts of
//                           the same read, with the two reads' roles
//                           swapped from `text` mode's own order).
//   `elements_then_text` — BOTH are asked, elements first, joined under a
//                           short labelled boundary; whichever ONE read
//                           succeeds when the other does not is handed on
//                           alone.
//
// The executor's own half — the PRIMARY note sentence
// (PAGE_ELEMENTS_PRIMARY_NOTE) vs the fallback's (PAGE_ELEMENTS_ONLY_NOTE) —
// is proven directly against ControlPlaneAgentExecutor in
// agent-executor-control-plane.test.ts, not here.

import { describe, expect, it } from 'vitest';
import { AgentRuntime } from '../../src/services/agent-runtime.js';
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
import type { PlanningReadMode } from '../../src/services/agent-planning-read.js';
import type { PlanningReadTraceEntry } from '../../src/services/agent-turn-telemetry.js';

const NAV: AgentIntent = { kind: 'navigate', url: 'https://driftstack.io/' };
const WAIT: AgentIntent = { kind: 'wait', condition: 'idle' };
const SHOT: AgentIntent = { kind: 'capture', capture: 'screenshot' };

const TURN_STARTS_AT = 1_000;

function segment(intents: AgentIntent[], status?: PlanStatus): DecomposeResult {
  return {
    kind: 'plan',
    intents,
    ...(status !== undefined ? { status } : {}),
    tokensConsumed: 100,
  };
}

interface Harness {
  seen: DecomposeArgs[];
  /** One entry per planning-read call this turn made, IN ORDER. */
  order: string[];
}

function harness(): Harness {
  return { seen: [], order: [] };
}

/**
 * An executor whose `observeDigest` and `observeElements` each pull from
 * their OWN queue, independently — unlike `executorWithReads` in the
 * page-cannot-be-read-twice file (one shared queue, because `text` mode
 * always calls digest first). Here the two modes under test call them in
 * DIFFERENT orders, so the two reads must not share a cursor.
 */
function executorWithModeReads(
  h: Harness,
  opts: {
    digestReads?: ReadonlyArray<string | null>;
    elementsReads?: ReadonlyArray<string | null>;
    withDigest?: boolean;
    withElements?: boolean;
  },
): AgentExecutor {
  const digestReads = opts.digestReads ?? [];
  const elementsReads = opts.elementsReads ?? [];
  let digestCursor = 0;
  let elementsCursor = 0;
  return {
    execute: (args: ExecuteArgs): Promise<ExecutorRunResult> => {
      const results: IntentResult[] = args.plan.intents.map((intent) => ({
        kind: 'success',
        intent,
        summary: `did ${intent.kind}`,
      }));
      return Promise.resolve({ results, ok: true });
    },
    ...(opts.withDigest === false
      ? {}
      : {
          observeDigest: (
            _sessionId: string,
            _shouldContinue?: unknown,
            _signal?: unknown,
            _commitmentBudget?: unknown,
            onPlanningRead?: (entry: PlanningReadTraceEntry) => void,
          ): Promise<string | null> => {
            h.order.push('digest');
            const value = digestReads[digestCursor] ?? null;
            digestCursor += 1;
            // Real executors report every attempt through this callback —
            // it is what feeds `planningReadTrace.length`, the turn-level
            // count DRIFTSTACK_PLANNING_READ's mode rides on. A fake that
            // skipped it would under-report by construction, not prove
            // anything about the runtime.
            onPlanningRead?.({
              ms: 1,
              outcome: value === null ? 'empty' : 'ok',
              chars: value?.length ?? 0,
              truncated: false,
            });
            return Promise.resolve(value);
          },
        }),
    ...(opts.withElements === false
      ? {}
      : {
          observeElements: (
            _sessionId: string,
            _shouldContinue?: unknown,
            _signal?: unknown,
            onPlanningRead?: (entry: PlanningReadTraceEntry) => void,
            primary?: boolean,
          ): Promise<string | null> => {
            h.order.push(primary === true ? 'elements(primary)' : 'elements(retry)');
            const value = elementsReads[elementsCursor] ?? null;
            elementsCursor += 1;
            onPlanningRead?.({
              ms: 1,
              outcome: value === null ? 'empty' : 'ok_elements',
              chars: value?.length ?? 0,
              truncated: false,
              ...(value !== null ? { elements: 1 } : {}),
            });
            return Promise.resolve(value);
          },
        }),
    observe: (): Promise<string | null> => Promise.resolve('read-back text'),
  };
}

async function makeRuntime(
  h: Harness,
  opts: {
    plans: DecomposeResult[];
    executor: AgentExecutor;
    planningRead?: PlanningReadMode;
  },
) {
  const sessions = new InMemoryAgentSessionsRepo(() => new Date('2026-09-21T00:00:00Z'));
  const seed = await sessions.create({ accountId: 'acc_1', tokenBudgetTotal: 100_000 });
  const runtime = new AgentRuntime({
    decomposer: {
      decompose: (args: DecomposeArgs): Promise<DecomposeResult> => {
        h.seen.push(args);
        const next = opts.plans[Math.min(h.seen.length - 1, opts.plans.length - 1)];
        return Promise.resolve(next ?? segment([SHOT], 'done'));
      },
      answerFromObservation: () => Promise.resolve({ answer: 'ok.', tokensConsumed: 40 }),
    },
    executor: opts.executor,
    sessions,
    archetype: 'iphone16pro_ios18_7_safari26_4',
    nowMs: () => TURN_STARTS_AT,
    ...(opts.planningRead !== undefined ? { planningRead: opts.planningRead } : {}),
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

// Segment 1 of a fresh chat is always planned BLIND (no prior browser work —
// see the page-cannot-be-read-twice file), so every plans array below has a
// segment 2 whose read is the one under test.
const TWO_SEGMENTS = [segment([NAV], 'continue'), segment([WAIT], 'done')];

describe('DRIFTSTACK_PLANNING_READ=elements — the element list leads', () => {
  it('a non-empty list is used AS-IS: perceive is called, get_page_source never is', async () => {
    const h = harness();
    const { turn } = await makeRuntime(h, {
      plans: TWO_SEGMENTS,
      executor: executorWithModeReads(h, {
        // A poison value: if this were ever read, the assertion below on
        // `observation` would fail loudly rather than by an unreached branch.
        digestReads: ['SHOULD NEVER BE READ — the list was not empty'],
        elementsReads: [
          'page: create account\n#go · button · "Go"\n' +
            "(only the page's controls are listed; its text was not read)",
        ],
      }),
      planningRead: 'elements',
    });

    const result = await turn('go to driftstack.io and create an account');

    if (result.kind !== 'plan-executed') throw new Error('type narrow');
    expect(h.order).toEqual(['elements(primary)']);
    expect(h.seen[1]?.observation).toBe(
      'page: create account\n#go · button · "Go"\n' +
        "(only the page's controls are listed; its text was not read)",
    );
  });

  it('an EMPTY (or refused) list falls back to the text digest, with the SAME single-retry discipline `text` mode uses', async () => {
    const h = harness();
    const { turn } = await makeRuntime(h, {
      plans: TWO_SEGMENTS,
      executor: executorWithModeReads(h, {
        elementsReads: [null],
        digestReads: ['page: create account\ntext digest of the page'],
      }),
      planningRead: 'elements',
    });

    const result = await turn('go to driftstack.io and create an account');

    if (result.kind !== 'plan-executed') throw new Error('type narrow');
    expect(h.order).toEqual(['elements(primary)', 'digest']);
    expect(h.seen[1]?.observation).toBe('page: create account\ntext digest of the page');
  });

  it('BOTH reads failing plans the segment blind, exactly as `text` mode degrades — never a broken turn', async () => {
    const h = harness();
    const { turn } = await makeRuntime(h, {
      plans: TWO_SEGMENTS,
      executor: executorWithModeReads(h, { elementsReads: [null], digestReads: [null] }),
      planningRead: 'elements',
    });

    const result = await turn('go to driftstack.io and create an account');

    if (result.kind !== 'plan-executed') throw new Error('type narrow');
    expect(h.order).toEqual(['elements(primary)', 'digest']);
    expect(h.seen[1]?.observation).toBeUndefined();
    expect(result.executor.ok).toBe(true);
  });
});

describe('DRIFTSTACK_PLANNING_READ=elements_then_text — both, elements first', () => {
  it('both succeeding are joined, elements first, under one boundary line', async () => {
    const h = harness();
    const { turn } = await makeRuntime(h, {
      plans: TWO_SEGMENTS,
      executor: executorWithModeReads(h, {
        elementsReads: ['ELEMENTS TEXT'],
        digestReads: ['DIGEST TEXT'],
      }),
      planningRead: 'elements_then_text',
    });

    const result = await turn('go to driftstack.io and create an account');

    if (result.kind !== 'plan-executed') throw new Error('type narrow');
    expect(h.order).toEqual(['elements(primary)', 'digest']);
    expect(h.seen[1]?.observation).toBe('ELEMENTS TEXT\n--- page text follows ---\nDIGEST TEXT');
  });

  it('only the elements read succeeding is handed on ALONE — no boundary separating something from nothing', async () => {
    const h = harness();
    const { turn } = await makeRuntime(h, {
      plans: TWO_SEGMENTS,
      executor: executorWithModeReads(h, {
        elementsReads: ['ELEMENTS TEXT'],
        digestReads: [null],
      }),
      planningRead: 'elements_then_text',
    });

    const result = await turn('go to driftstack.io and create an account');

    if (result.kind !== 'plan-executed') throw new Error('type narrow');
    expect(h.seen[1]?.observation).toBe('ELEMENTS TEXT');
  });

  it('only the text read succeeding is handed on ALONE too', async () => {
    const h = harness();
    const { turn } = await makeRuntime(h, {
      plans: TWO_SEGMENTS,
      executor: executorWithModeReads(h, {
        elementsReads: [null],
        digestReads: ['DIGEST TEXT'],
      }),
      planningRead: 'elements_then_text',
    });

    const result = await turn('go to driftstack.io and create an account');

    if (result.kind !== 'plan-executed') throw new Error('type narrow');
    expect(h.seen[1]?.observation).toBe('DIGEST TEXT');
  });
});

describe('DRIFTSTACK_PLANNING_READ default and wiring', () => {
  it('an unset switch (no `planningRead` deps field) reads DIGEST first, exactly as `text` mode does', async () => {
    const h = harness();
    const { turn } = await makeRuntime(h, {
      plans: TWO_SEGMENTS,
      executor: executorWithModeReads(h, { digestReads: ['default text digest'] }),
      // planningRead deliberately omitted — the default deployment.
    });

    const result = await turn('go to driftstack.io and create an account');

    if (result.kind !== 'plan-executed') throw new Error('type narrow');
    expect(h.order).toEqual(['digest']);
    expect(h.seen[1]?.observation).toBe('default text digest');
  });

  it("DRIFTSTACK_PLANNING_READ's mode is counted onto the turn's actionPaths, on the closed-enum-counts-only line pace's own bands ride", async () => {
    const h = harness();
    const { turn } = await makeRuntime(h, {
      plans: TWO_SEGMENTS,
      executor: executorWithModeReads(h, {
        elementsReads: [
          'page: x\n#go · button · "Go"\n(only the page\'s controls are listed; its text was not read)',
        ],
      }),
      planningRead: 'elements',
    });

    const result = await turn('go to driftstack.io and create an account');

    if (result.kind !== 'plan-executed') throw new Error('type narrow');
    expect(result.executor.actionPaths?.planningReadModes).toEqual({
      text: 0,
      elements: 1,
      elements_then_text: 0,
    });
  });
});

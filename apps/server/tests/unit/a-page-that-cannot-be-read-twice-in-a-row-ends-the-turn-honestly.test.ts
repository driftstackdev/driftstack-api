// T1/T2 — THE INCIDENT this file exists for: a real production turn ("go to
// driftstack.io and create an account") navigated, then FIVE segments each
// planned exactly one `wait_for`, then the no-progress guard stopped the turn
// with "the page did not change" — which was false. The page was never READ:
// `observe()` raced `get_page_source` against the READ-BACK's 10s budget
// between every segment, lost the race five times running (7.5s average
// against the 10s cap), and every segment was planned BLIND.
//
// This file proves the fix, at the RUNTIME level (the executor's half — its
// own, larger planning budget and the truncation note — is proven directly
// against ControlPlaneAgentExecutor in agent-executor-control-plane.test.ts):
//   (a) a planning read that yields nothing is retried ONCE — via a DIFFERENT
//       method, `observeElements` (`get_page_source` cannot be bounded, so
//       the retry is a bounded `perceive` list instead; see
//       agent-executor-control-plane.test.ts for the row shape and the note
//       sentence that read renders) — and a second success is used to plan
//       the segment;
//   (a2) an executor with no `observeElements` at all gets no retry: one
//        failed planning read, not a broken one;
//   (b) TWO CONSECUTIVE blind segments end the turn honestly instead of
//       guessing forever — a new sentence, a new notice reason, and (via the
//       SAME telemetry classifier production reads) a `page_load_failed`
//       death reason;
//   (c) the FIRST segment of a chat with no page open yet is not counted as
//       blind — there is nothing to read yet, which is not the same fact as
//       "tried and failed";
//   (d) a blind segment followed by a readable one resets the count, so an
//       ordinary flaky read never ends a turn that recovers on its own;
//   (f) the turn's hard stop is asked BEFORE a planning read is allowed to
//       start, in isolation from the earlier (and smaller) three-minute
//       wall-clock bound that ordinarily gets there first.
//
// (e) — that the planning read uses PLANNING_OBSERVE_TIMEOUT_MS and the
// read-back still uses TURN_READ_BACK_TIMEOUT_MS — is proven where those
// budgets actually live, inside ControlPlaneAgentExecutor, via injected
// sleep: see "ControlPlaneAgentExecutor — T1 observeDigest() has its own,
// larger planning budget" in agent-executor-control-plane.test.ts.

import { describe, expect, it } from 'vitest';
import {
  AgentRuntime,
  TURN_LOOP_STOP_SENTENCES,
  TURN_NOTICE_REASONS,
} from '../../src/services/agent-runtime.js';
import { TURN_HARD_STOP_MS } from '../../src/services/agent-turn-bounds.js';
import { classifyTurn } from '../../src/services/agent-turn-telemetry.js';
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
  runs: ExecuteArgs[];
  seen: DecomposeArgs[];
  observeDigestCalls: number;
  observeElementsCalls: number;
}

function harness(): Harness {
  return { runs: [], seen: [], observeDigestCalls: 0, observeElementsCalls: 0 };
}

/**
 * Runs every step green (unless `fails` says otherwise) and answers the
 * runtime's planning read from `reads`, indexed by the 1-based call number
 * across the WHOLE turn (retries included, so a segment whose read is
 * retried once consumes two entries) — REGARDLESS of which method consumed
 * the entry: the FIRST attempt of every `readForPlanning` call is
 * `observeDigest`; the RETRY, when one is sent, is `observeElements`. A call
 * past the end of `reads` returns null.
 *
 * `withElements: false` omits `observeElements` from the returned executor
 * entirely, for (a2) — proving a retry is only ever sent when the executor
 * can do one.
 */
function executorWithReads(
  h: Harness,
  reads: ReadonlyArray<string | null>,
  opts: {
    fails?: (intent: AgentIntent) => IntentResult | null;
    onExecute?: (run: number) => void;
    withElements?: boolean;
  } = {},
): AgentExecutor {
  let cursor = 0;
  const nextRead = (): string | null => {
    cursor += 1;
    return reads[cursor - 1] ?? null;
  };
  return {
    execute: (args: ExecuteArgs): Promise<ExecutorRunResult> => {
      h.runs.push(args);
      opts.onExecute?.(h.runs.length);
      const results: IntentResult[] = [];
      for (const intent of args.plan.intents) {
        const failure = opts.fails?.(intent) ?? null;
        if (failure !== null) {
          results.push(failure);
          return Promise.resolve({ results, ok: false });
        }
        results.push({ kind: 'success', intent, summary: `did ${intent.kind}` });
      }
      return Promise.resolve({ results, ok: true });
    },
    observeDigest: (): Promise<string | null> => {
      h.observeDigestCalls += 1;
      return Promise.resolve(nextRead());
    },
    ...(opts.withElements === false
      ? {}
      : {
          observeElements: (): Promise<string | null> => {
            h.observeElementsCalls += 1;
            return Promise.resolve(nextRead());
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
    nowMs?: () => number;
    sessions?: InMemoryAgentSessionsRepo;
  },
) {
  const sessions =
    opts.sessions ?? new InMemoryAgentSessionsRepo(() => new Date('2026-09-21T00:00:00Z'));
  const seed = await sessions.create({ accountId: 'acc_1', tokenBudgetTotal: 100_000 });
  const runtime = new AgentRuntime({
    decomposer: {
      decompose: (args: DecomposeArgs): Promise<DecomposeResult> => {
        h.seen.push(args);
        const next = opts.plans[Math.min(h.seen.length - 1, opts.plans.length - 1)];
        return Promise.resolve(next ?? segment([SHOT], 'done'));
      },
      answerFromObservation: () => Promise.resolve({ answer: 'created.', tokensConsumed: 40 }),
    },
    executor: opts.executor,
    sessions,
    archetype: 'iphone16pro_ios18_7_safari26_4',
    nowMs: opts.nowMs ?? (() => TURN_STARTS_AT),
  });
  return {
    sessions,
    seedId: seed.id,
    turn: (userMessage: string) =>
      runtime.runTurn({
        agentSessionId: seed.id,
        userMessage,
        byokApiKey: 'sk-ant-test-fake-key',
      }),
  };
}

describe('T2 — a page that cannot be read twice in a row ends the turn honestly', () => {
  it('(a) a planning read that times out is retried ONCE — via observeElements, not a second observeDigest — and the second success is used to plan the next segment', async () => {
    const h = harness();
    // Segment 1 has no prior browser work (fresh session), so it plans blind
    // by design — no read is even attempted. Segment 2's read is what is
    // retried: attempt 1 (observeDigest) -> null, attempt 2 (observeElements)
    // -> a real answer.
    const { turn } = await makeRuntime(h, {
      plans: [segment([NAV], 'continue'), segment([WAIT], 'done')],
      executor: executorWithReads(h, [
        null,
        'page: create account\n#email · input · "Email"\n(the page\'s text could not be read in time; only its controls are listed)',
      ]),
    });

    const result = await turn('go to driftstack.io and create an account');

    if (result.kind !== 'plan-executed') throw new Error('type narrow');
    expect(h.observeDigestCalls).toBe(1); // the FIRST attempt only
    expect(h.observeElementsCalls).toBe(1); // the retry — a DIFFERENT method
    expect(h.seen).toHaveLength(2);
    // The RETRIED read's text is what the segment was actually planned
    // against.
    expect(h.seen[1]?.observation).toBe(
      'page: create account\n#email · input · "Email"\n(the page\'s text could not be read in time; only its controls are listed)',
    );
    // A retried-but-successful read is not a "blind" segment at all — even
    // though it came from `observeElements`, not `observeDigest`. `loop`
    // omits `blindSegments` entirely when the count is 0 (see agent-runtime.ts).
    expect(result.loop?.blindSegments).toBeUndefined();
    expect(result.loop?.stopped).toBeUndefined();
    expect(result.notice).toBeUndefined();
  });

  it('(a2) an executor with no observeElements gets NO retry at all — one failed read, not a broken one', async () => {
    const h = harness();
    // Segment 2's FIRST attempt fails; there is no `observeElements` on this
    // executor, so readForPlanning must not try to call it — the segment
    // simply plans blind, same as if the (single) attempt had failed before
    // this feature existed at all.
    const { turn } = await makeRuntime(h, {
      plans: [segment([NAV], 'continue'), segment([SHOT], 'done')],
      executor: executorWithReads(h, [null, 'should never be read — no observeElements exists'], {
        withElements: false,
      }),
    });

    const result = await turn('go to driftstack.io and create an account');

    if (result.kind !== 'plan-executed') throw new Error('type narrow');
    expect(h.observeDigestCalls).toBe(1);
    expect(h.observeElementsCalls).toBe(0);
    expect(h.seen).toHaveLength(2);
    expect(result.loop?.stopped).toBeUndefined(); // one blind segment, not two consecutive
  });

  it('(b) TWO CONSECUTIVE blind segments stop the turn with `page_unreadable`, the exact sentence, the public reason, and — via the classifier production reads — `page_load_failed`', async () => {
    const h = harness();
    const { turn } = await makeRuntime(h, {
      // Segment 1: fresh session, no prior work — plans blind, exempt.
      // Segment 2's read fails BOTH attempts — observeDigest, then the retry
      // observeElements (blind #1, not yet consecutive). Segment 3's read
      // fails BOTH attempts the same way (blind #2, consecutive with #1) —
      // the turn must stop BEFORE segment 3 is ever planned. A perceive that
      // ALSO fails leaves the existing behaviour exactly as it was before
      // this build: blind once, then (consecutively) page_unreadable.
      plans: [segment([NAV], 'continue'), segment([WAIT], 'continue'), segment([SHOT], 'done')],
      executor: executorWithReads(h, [null, null, null, null]),
    });

    const result = await turn('go to driftstack.io and create an account');

    if (result.kind !== 'plan-executed') throw new Error('type narrow');
    // Segment 3's planner call never happened: the turn stopped first.
    expect(h.seen).toHaveLength(2);
    expect(h.runs).toHaveLength(2);
    expect(h.observeDigestCalls).toBe(2); // the FIRST attempt of each segment's read
    expect(h.observeElementsCalls).toBe(2); // the retry of each — also failed
    expect(result.loop?.stopped).toBe('page_unreadable');
    expect(result.notice).toBe(TURN_LOOP_STOP_SENTENCES.page_unreadable);
    expect(result.notice).toBe(
      'I did the steps above, but I could not read the page to plan the next step, so I stopped rather than guess. Send “continue” to try again.',
    );
    expect(result.noticeReason).toBe('page_unreadable');
    expect(result.noticeReason).toBe(TURN_NOTICE_REASONS.page_unreadable);
    expect(result.loop?.blindSegments).toBe(2);

    // The SAME classifier production reads off this exact result files the
    // death reason support needs — no separate migration, per the brief.
    const classified = classifyTurn({
      result,
      status: 200,
      body: { kind: 'plan-executed' },
      sawPlanning: true,
      sawAnswering: false,
    });
    expect(classified.outcome).toBe('failed');
    expect(classified.deathReason).toBe('page_load_failed');
  });

  it('(c) the FIRST segment of a chat with no page open yet is NOT counted as blind', async () => {
    const h = harness();
    const { turn } = await makeRuntime(h, {
      // Segment 1: fresh session — exempt. Segment 2's read fails both
      // attempts — ONE blind segment, not two consecutive. If segment 1 HAD
      // counted, the turn would stop here, before segment 2 is even planned.
      plans: [segment([NAV], 'continue'), segment([SHOT], 'done')],
      executor: executorWithReads(h, [null, null]),
    });

    const result = await turn('go to driftstack.io and create an account');

    if (result.kind !== 'plan-executed') throw new Error('type narrow');
    // Segment 2 WAS planned (blind) and the turn finished normally.
    expect(h.seen).toHaveLength(2);
    expect(result.loop?.stopped).toBeUndefined();
    expect(result.notice).toBeUndefined();
    expect(result.executor.ok).toBe(true);
  });

  it('(d) a blind segment followed by a readable one resets the count', async () => {
    const h = harness();
    const { turn } = await makeRuntime(h, {
      // Segment 1: exempt (fresh session).
      // Segment 2's read: both attempts fail — blind #1.
      // Segment 3's read: succeeds on the FIRST attempt — resets the streak.
      // Segment 4's read: both attempts fail again — blind, but alone (not
      // consecutive with segment 3, which read fine), so the turn must NOT
      // stop and segment 4 must still be planned (blind) and finish.
      plans: [
        segment([NAV], 'continue'),
        segment([WAIT], 'continue'),
        segment([WAIT], 'continue'),
        segment([SHOT], 'done'),
      ],
      executor: executorWithReads(h, [
        null,
        null, // segment 2: blind
        'page: account created', // segment 3: readable, resets
        null,
        null, // segment 4: blind again, but not consecutive
      ]),
    });

    const result = await turn('go to driftstack.io and create an account');

    if (result.kind !== 'plan-executed') throw new Error('type narrow');
    expect(h.seen).toHaveLength(4); // every segment's planner call happened
    expect(result.loop?.stopped).toBeUndefined();
    expect(result.notice).toBeUndefined();
    expect(result.loop?.blindSegments).toBe(2); // total, not consecutive
  });

  it('(f) the turn’s hard stop is asked BEFORE a planning read is allowed to start — the read never dispatches once it has passed', async () => {
    const h = harness();
    let now = TURN_STARTS_AT;
    let segment1Executed = false;
    let jumped = false;
    const sessions = new InMemoryAgentSessionsRepo(() => new Date('2026-09-21T00:00:00Z'));
    const originalSnapshot = sessions.getAuthoritySnapshot.bind(sessions);
    // The ONE hook between the loop's wall-clock check (an EARLIER, SMALLER
    // bound — three minutes — that would otherwise always get there first,
    // see agent-turn-bounds.ts) and the planning read that follows it:
    // authorityStillCurrent(), asked right before the read. Jumping the clock
    // here, and only here, isolates the read's OWN hard-stop check from the
    // pre-existing wall-clock one.
    sessions.getAuthoritySnapshot = (id: string) => {
      if (segment1Executed && !jumped) {
        jumped = true;
        now = TURN_STARTS_AT + TURN_HARD_STOP_MS;
      }
      return originalSnapshot(id);
    };

    const { turn } = await makeRuntime(h, {
      plans: [segment([NAV], 'continue'), segment([SHOT], 'done')],
      executor: executorWithReads(h, ['should never be read'], {
        onExecute: (run) => {
          if (run === 1) segment1Executed = true;
        },
      }),
      nowMs: () => now,
      sessions,
    });

    const result = await turn('go to driftstack.io and create an account');

    if (result.kind !== 'plan-executed') throw new Error('type narrow');
    expect(jumped).toBe(true); // the hook actually fired
    // The read never started: nothing was dispatched for it, by either method.
    expect(h.observeDigestCalls).toBe(0);
    expect(h.observeElementsCalls).toBe(0);
    // Segment 2 was still planned (blind) — this is NOT `page_unreadable`
    // (segment 1 is exempt, so this is a single blind segment) and NOT
    // `wall_clock` either (the earlier, smaller bound never fired: the jump
    // happened strictly AFTER it was checked).
    expect(h.seen).toHaveLength(2);
    expect(result.loop?.stopped).toBeUndefined();
  });
});

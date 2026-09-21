// SCRIPTED-TIER TASKS FOR THE LOOP (B8).
//
// A turn is a loop: look → plan as far as you can SEE → act → look again. These
// tasks drive WHOLE TURNS through the real `AgentRuntime`, the real
// `ControlPlaneAgentExecutor` and its real page digest, against the DOM-backed
// device — with a planner we scripted, segment by segment.
//
// ⛔ WHAT THIS PROVES, AND WHAT IT DOES NOT — the same line the rest of the
// scripted tier draws. It proves the LOOP and the LOOK: that a `continue` leads
// to a real read of a real page, that what the look reports is enough to tell a
// goal state from the page before it, that a step planned from the look lands on
// the device, that every bound stops the turn, and that the confirmation gate
// holds across segments. It proves NOTHING about planning quality: every segment
// below was written by us with the page in view. A real planner's use of the loop
// is the live tier's question, and its counts are reported there, never here.
//
// ⛔ DETERMINISTIC. A virtual clock, no model, no network. It pins outcomes.

import { describe, expect, it } from 'vitest';
import type { AgentIntent } from '@driftstack/api-types';
import {
  AgentRuntime,
  MAX_PLANNER_CALLS_PER_TURN,
  TURN_LOOP_STOP_SENTENCES,
  type RunTurnResult,
} from '../../src/services/agent-runtime.js';
import { ControlPlaneAgentExecutor } from '../../src/services/agent-executor-control-plane.js';
import { consequentialSignature } from '../../src/services/agent-executor.js';
import type {
  DecomposeArgs,
  DecomposeResult,
  PlanStatus,
} from '../../src/services/agent-decomposer.js';
import { InMemoryAgentSessionsRepo } from '../../src/services/agent-sessions.js';
import { SessionCaptureStore } from '../../src/services/session-capture-store.js';
import { FakeDevice } from './_lib/fake-device.js';
import { LIVE_SITES, type LiveSite } from './_lib/live-sites.js';
import {
  EVAL_ARCHETYPE,
  EVAL_MAX_RETRIES,
  EVAL_OBSERVE_TIMEOUT_MS,
  EVAL_RETRY_DELAY_MS,
  EVAL_SESSION_ESTABLISH_RETRY_DELAY_MS,
  EVAL_TOKEN_BUDGET,
  countsAsElapsedBrowsingTime,
  evalRandom,
} from './_lib/runner.js';
import { VirtualClock } from './_lib/virtual-clock.js';

const SETTLE: AgentIntent = { kind: 'wait', condition: 'idle' };
const tap = (selector: string, value?: string): AgentIntent => ({
  kind: 'interact',
  action: 'tap',
  selector,
  ...(value !== undefined ? { value } : {}),
});
const type = (selector: string, value: string): AgentIntent => ({
  kind: 'interact',
  action: 'type',
  selector,
  value,
});

/** One scripted segment: what to run, and what the planner says about it. */
interface Segment {
  intents: AgentIntent[];
  status: PlanStatus;
}

interface LoopRun {
  result: RunTurnResult;
  /** What the LOOK showed the planner before each segment (undefined = blind). */
  looks: Array<string | undefined>;
  plannerCalls: number;
  device: FakeDevice;
  turn: (message: string, approved?: ReadonlySet<string>) => Promise<RunTurnResult>;
}

async function runLoopTask(
  site: LiveSite,
  message: string,
  script: Segment[] | ((call: number, args: DecomposeArgs) => Segment),
  /** Approvals attached to the FIRST message, for the arm that proves they buy nothing. */
  firstMessageApprovals?: ReadonlySet<string>,
): Promise<LoopRun> {
  const clock = new VirtualClock(countsAsElapsedBrowsingTime);
  const device = new FakeDevice({
    sites: site.pages,
    startUrl: 'about:blank',
    clock,
    notFound: site.notFound,
  });
  let captureSeq = 0;
  let intentSeq = 0;
  const executor = new ControlPlaneAgentExecutor(
    device.dispatcher,
    () => `int_loop_${(intentSeq += 1).toString()}`,
    {
      maxRetries: EVAL_MAX_RETRIES,
      retryDelayMs: EVAL_RETRY_DELAY_MS,
      sessionEstablishRetryDelayMs: EVAL_SESSION_ESTABLISH_RETRY_DELAY_MS,
      observeTimeoutMs: EVAL_OBSERVE_TIMEOUT_MS,
      planningObserveTimeoutMs: EVAL_OBSERVE_TIMEOUT_MS,
      sleep: clock.sleep,
      // Fixed, so a sequence assertion here is about traffic shape rather
      // than about which numbers the draws produced.
      makeRandom: () => evalRandom('eval-fixture'),
    },
    new SessionCaptureStore(
      2_000,
      20,
      30 * 60 * 1000,
      () => 0,
      () => `cap_loop_${(captureSeq += 1).toString()}`,
    ),
  );
  const sessions = new InMemoryAgentSessionsRepo(() => new Date('2026-09-18T00:00:00.000Z'));
  const seed = await sessions.create({
    accountId: 'acc_eval_loop',
    tokenBudgetTotal: EVAL_TOKEN_BUDGET,
  });
  const looks: Array<string | undefined> = [];
  let calls = 0;
  const runtime = new AgentRuntime({
    decomposer: {
      decompose: (args: DecomposeArgs): Promise<DecomposeResult> => {
        calls += 1;
        looks.push(args.observation);
        const next =
          typeof script === 'function'
            ? script(calls, args)
            : (script[calls - 1] ?? { intents: [], status: 'done' as const });
        return Promise.resolve({ kind: 'plan', ...next, tokensConsumed: 900 });
      },
    },
    executor,
    sessions,
    archetype: EVAL_ARCHETYPE,
    // The device's clock is the turn's clock, so the wall-clock ceiling is
    // measured in the same simulated time the steps cost.
    nowMs: () => clock.now(),
  });
  const turn = (userMessage: string, approved?: ReadonlySet<string>): Promise<RunTurnResult> =>
    runtime.runTurn({
      agentSessionId: seed.id,
      userMessage,
      now: new Date('2026-09-18T00:00:00.000Z'),
      ...(approved !== undefined ? { approvedConsequentialActions: approved } : {}),
    });
  const result = await turn(message, firstMessageApprovals);
  return {
    result,
    looks,
    get plannerCalls() {
      return calls;
    },
    device,
    turn,
  };
}

function executed(result: RunTurnResult): Extract<RunTurnResult, { kind: 'plan-executed' }> {
  if (result.kind !== 'plan-executed') throw new Error(`the turn was ${result.kind}`);
  return result;
}

describe('LOOP-FLOW — search → result → detail, as ONE customer message', () => {
  it('four segments, each planned from the page the last one produced, end on the product page', async () => {
    const run = await runLoopTask(
      LIVE_SITES.gearfinder,
      "search gearfinder.test for 'trail stove' and open the first result",
      [
        {
          intents: [{ kind: 'navigate', url: 'https://gearfinder.test/' }, SETTLE],
          status: 'continue',
        },
        {
          intents: [
            type('#search-input', 'trail stove'),
            { kind: 'interact', action: 'press', value: 'Enter' },
            SETTLE,
          ],
          status: 'continue',
        },
        { intents: [tap('a[href="/p/ember-mini"]'), SETTLE], status: 'continue' },
        { intents: [], status: 'done' },
      ],
    );
    const result = executed(run.result);
    expect(result.executor.ok).toBe(true);
    expect(run.device.url()).toBe('https://gearfinder.test/p/ember-mini');
    // T4 — three ADDITIVE `planningReads` entries since this pin was written
    // (one per re-plan's look, all successful): diagnostic-only, so `ms` and
    // `chars` are asserted loosely and the count/outcome/truncated exactly.
    expect(result.loop).toEqual({
      segments: 4,
      plannerCalls: 4,
      replans: 0,
      finalStatus: 'done',
      planningReads: [
        { ms: expect.any(Number), outcome: 'ok', chars: expect.any(Number), truncated: false },
        { ms: expect.any(Number), outcome: 'ok', chars: expect.any(Number), truncated: false },
        { ms: expect.any(Number), outcome: 'ok', chars: expect.any(Number), truncated: false },
      ],
    });
    expect(result.notice).toBeUndefined();
    // ⛔ THE LOOK IS REAL. Each later segment was handed the page the device was
    // actually on, through the product's own digest — and it carried what that
    // segment needed: the search box, then the result link, then the spec table.
    expect(run.looks[0]).toBeUndefined();
    expect(run.looks[1]).toContain('#search-input');
    expect(run.looks[2]).toContain('a[href="/p/ember-mini"] · a · "Ember Mini trail stove"');
    expect(run.looks[3]).toContain('Weight 312 g');
  });
});

describe('LOOP-FORM — `done` is the GOAL STATE, read off the page', () => {
  it('the look after Send says the message went, which is what lets a planner answer `done` with no steps', async () => {
    const run = await runLoopTask(LIVE_SITES.parcels, 'send them a message from Dana Whit', [
      {
        intents: [{ kind: 'navigate', url: 'https://parcels.test/contact' }, SETTLE],
        status: 'continue',
      },
      {
        intents: [
          type('#name', 'Dana Whit'),
          type('#email', 'dana@example.test'),
          type('#message', 'Where is parcel 7731?'),
          tap('#send', 'Send message'),
        ],
        status: 'continue',
      },
      { intents: [], status: 'done' },
    ]);
    expect(executed(run.result).executor.ok).toBe(true);
    expect(run.device.flags()).toContain('contact:sent');
    // The fields are NAMED in the look (by their <label for>), not anonymous.
    expect(run.looks[1]).toContain('#name · input · "Your name"');
    expect(run.looks[1]).toContain('#message · textarea · "How can we help?"');
    // And the confirmation is in the look — in the page's words, because the
    // confirmation page has no control that says it.
    expect(run.looks[2]).toContain('Thanks — your message is on its way');
    expect(run.looks[2]).not.toContain('#send');
  });

  it('⛔ what was typed never comes back in the look — not the name, not the address, not the message', async () => {
    const run = await runLoopTask(LIVE_SITES.parcels, 'start a message from Dana Whit', [
      {
        intents: [{ kind: 'navigate', url: 'https://parcels.test/contact' }, SETTLE],
        status: 'continue',
      },
      {
        intents: [type('#name', 'Dana Whit'), type('#email', 'dana@example.test')],
        status: 'continue',
      },
      { intents: [], status: 'done' },
    ]);
    expect(run.looks[2]).toContain('#name');
    expect(run.looks[2]).not.toContain('Dana Whit');
    expect(run.looks[2]).not.toContain('dana@example.test');
  });
});

describe('LOOP-CONSENT / LOOP-MENU — the look says what is in the way, and what can actually be tapped', () => {
  it('a consent dialog is marked as one, so the segment that follows can clear it first', async () => {
    const run = await runLoopTask(LIVE_SITES.mugs, 'add the blue mug to my basket', [
      { intents: [{ kind: 'navigate', url: 'https://mugs.test/' }, SETTLE], status: 'continue' },
      {
        intents: [
          tap('#onetrust-reject-all-handler', 'Reject all'),
          tap('#add-blue-mug', 'Add to basket'),
        ],
        status: 'continue',
      },
      { intents: [], status: 'done' },
    ]);
    expect(executed(run.result).executor.ok).toBe(true);
    expect(run.looks[1]).toContain(
      '#onetrust-reject-all-handler · button · "Reject all" · in dialog',
    );
    expect(run.device.flags()).toContain('basket:blue-mug');
    // The goal state is visible in the next look: the basket counts one.
    expect(run.looks[2]).toContain('Basket ( 1 )');
    expect(run.looks[2]).not.toContain('in dialog');
  });

  it('a link in a COLLAPSED menu is marked hidden, and its footer copy is given a selector that reaches it — which the device then accepts', async () => {
    const run = await runLoopTask(LIVE_SITES.bakery, 'find out what time they close on Sunday', [
      { intents: [{ kind: 'navigate', url: 'https://bakery.test/' }, SETTLE], status: 'continue' },
      {
        intents: [tap('footer a[href="/opening-hours"]', 'Opening hours'), SETTLE],
        status: 'continue',
      },
      { intents: [], status: 'done' },
    ]);
    expect(run.looks[1]).toContain('footer a[href="/opening-hours"] · a · "Opening hours"');
    expect(run.looks[1]).toContain('a[href="/opening-hours"] · a · "Opening hours" · hidden');
    expect(executed(run.result).executor.ok).toBe(true);
    expect(run.device.url()).toBe('https://bakery.test/opening-hours');
    expect(run.looks[2]).toContain('Sunday 09:00 – 13:00');
  });

  it('⛔ and the selector the look marked HIDDEN really does fail on the device — an outcome-unknown tap, after which the loop asks for nothing more', async () => {
    const run = await runLoopTask(LIVE_SITES.bakery, 'find out what time they close on Sunday', [
      { intents: [{ kind: 'navigate', url: 'https://bakery.test/' }, SETTLE], status: 'continue' },
      { intents: [tap('a[href="/opening-hours"]', 'Opening hours'), SETTLE], status: 'continue' },
      { intents: [], status: 'done' },
    ]);
    const result = executed(run.result);
    expect(result.executor.ok).toBe(false);
    expect(run.device.url()).toBe('https://bakery.test/');
    // `continue` does not outrank "we cannot say whether that tap landed".
    expect(run.plannerCalls).toBe(2);
  });
});

describe('LOOP-LATE — a control that is not there YET is waited for, not given up on', () => {
  it('the look shows the queue without its button; the next segment waits for it and taps it', async () => {
    const run = await runLoopTask(
      LIVE_SITES.tickets,
      'tap Continue as soon as it lets me through',
      [
        {
          intents: [{ kind: 'navigate', url: 'https://tickets.test/queue' }, SETTLE],
          status: 'continue',
        },
        {
          intents: [
            {
              kind: 'wait',
              condition: 'selector_visible',
              selector: '#enter-sale',
              timeoutMs: 10_000,
            },
            tap('#enter-sale', 'Continue'),
          ],
          status: 'continue',
        },
        { intents: [], status: 'done' },
      ],
    );
    expect(run.looks[1]).toContain('we are finding your place');
    expect(run.looks[1]).not.toContain('#enter-sale');
    expect(executed(run.result).executor.ok).toBe(true);
    expect(run.device.flags()).toContain('queue:continued');
    expect(run.looks[2]).toContain('Choose your seats');
  });
});

describe('LOOP-GATE — ⛔ a purchase halts for the customer in WHICHEVER segment reaches it', () => {
  const PLACE_ORDER = tap('#place-order', 'Place order');
  const script: Segment[] = [
    {
      intents: [{ kind: 'navigate', url: 'https://kettles.test/checkout' }, SETTLE],
      status: 'continue',
    },
    { intents: [PLACE_ORDER, SETTLE], status: 'continue' },
    { intents: [], status: 'done' },
  ];

  it('the second segment stops at the order button, nothing is bought, and the planner is NOT asked to route around the halt', async () => {
    const run = await runLoopTask(
      LIVE_SITES.kettles,
      'place the order for the Aurora kettle',
      script,
    );
    const result = executed(run.result);
    expect(result.executor.awaitingConfirmation).toBe(true);
    expect(run.device.url()).toBe('https://kettles.test/checkout');
    expect(run.device.flags()).not.toContain('purchased:aurora-kettle');
    expect(run.plannerCalls).toBe(2);
  });

  it('approving it buys ONCE, runs only the reviewed remainder, and makes no further planner call', async () => {
    const run = await runLoopTask(
      LIVE_SITES.kettles,
      'place the order for the Aurora kettle',
      script,
    );
    const halt = executed(run.result).executor.results.at(-1);
    if (halt?.kind !== 'confirmation_required') throw new Error('the turn did not halt');
    const callsBefore = run.plannerCalls;

    const approvedTurn = await run.turn(
      'yes, place it',
      new Set([consequentialSignature(halt.category, halt.matchedText)]),
    );

    expect(executed(approvedTurn).executor.ok).toBe(true);
    expect(run.device.flags()).toContain('purchased:aurora-kettle');
    expect(run.device.submissions()).toHaveLength(1);
    expect(run.plannerCalls).toBe(callsBefore);
  });

  it('⛔ approvals sent with a FRESH message authorise nothing — in the first segment or any later one', async () => {
    // Learn the signature the honest way: from a halt.
    const probe = await runLoopTask(
      LIVE_SITES.kettles,
      'place the order for the Aurora kettle',
      script,
    );
    const halt = executed(probe.result).executor.results.at(-1);
    if (halt?.kind !== 'confirmation_required') throw new Error('the turn did not halt');
    const signature = consequentialSignature(halt.category, halt.matchedText);

    // A brand-new chat whose FIRST message arrives with that grant attached.
    // There is no halted plan for it to resume, so it must buy nothing — and the
    // purchase sits in the SECOND segment, which is where a grant "carried
    // along" by the loop would have spent itself.
    const fresh = await runLoopTask(
      LIVE_SITES.kettles,
      'place the order for the Aurora kettle',
      script,
      new Set([signature]),
    );
    expect(executed(fresh.result).executor.awaitingConfirmation).toBe(true);
    expect(fresh.device.flags()).not.toContain('purchased:aurora-kettle');
    expect(fresh.device.submissions()).toHaveLength(0);
  });
});

describe('LOOP-BOUNDS — ⛔ on a real device, the loop still stops, and says why', () => {
  it('a planner that never says `done` is stopped at the planner-call ceiling with the task marked unfinished', async () => {
    const run = await runLoopTask(LIVE_SITES.ferries, 'keep looking for the timetable', (call) =>
      call === 1
        ? {
            intents: [{ kind: 'navigate', url: 'https://ferries.test/' }, SETTLE],
            status: 'continue',
          }
        : {
            intents: [{ kind: 'scroll', direction: 'down', amount_px: 100 * call }],
            status: 'continue',
          },
    );
    const result = executed(run.result);
    expect(run.plannerCalls).toBe(MAX_PLANNER_CALLS_PER_TURN);
    expect(result.executor.ok).toBe(true);
    expect(result.loop?.stopped).toBe('planner_call_limit');
    expect(result.notice).toBe(TURN_LOOP_STOP_SENTENCES.planner_call_limit);
  });

  it('NO PROGRESS — a tap that leaves the page as it was, planned again, is stopped as going in circles; the tap lands once', async () => {
    const BRAND = tap('a[href="/"]', 'Northline Ferries');
    const run = await runLoopTask(LIVE_SITES.ferries, 'open the timetable', (call) =>
      call === 1
        ? {
            intents: [{ kind: 'navigate', url: 'https://ferries.test/' }, SETTLE],
            status: 'continue',
          }
        : { intents: [BRAND, SETTLE], status: 'continue' },
    );
    const result = executed(run.result);
    expect(result.loop?.stopped).toBe('no_progress');
    expect(result.notice).toBe(TURN_LOOP_STOP_SENTENCES.no_progress);
    // The look really was the same both times: that is what made it circles.
    expect(run.looks[2]).toBe(run.looks[1]);
    expect(run.device.events().filter((e) => e.kind === 'clicked')).toHaveLength(1);
  });
});

describe('LOOP-GATE-NEUTRAL — ⛔ the gate reads what the PAGE calls a control, not what the planner wrote', () => {
  // The kettle checkout's button id spells the purchase, so the tasks above
  // halt on the selector alone. Here the only evidence is the button's caption:
  // `#primary-action`, tapped with NO label — exactly what a planner copying a
  // selector off the look produces, and what a hostile page would steer it to.
  const script = (selector: string): Segment[] => [
    {
      intents: [{ kind: 'navigate', url: 'https://lumenwick.test/checkout' }, SETTLE],
      status: 'continue',
    },
    { intents: [tap(selector), SETTLE], status: 'continue' },
    { intents: [], status: 'done' },
  ];

  it.each([['#primary-action'], ['button#primary-action'], ['form #primary-action.btn']])(
    'a tap on %s with no label halts for confirmation, and nothing is bought',
    async (selector) => {
      const run = await runLoopTask(
        LIVE_SITES.lumenwick,
        'place the order for the desk lamp',
        script(selector),
      );
      // Non-vacuous: the look really did show the planner the neutral selector.
      expect(run.looks[1]).toContain('#primary-action · button · "Place order"');
      const result = executed(run.result);
      expect(result.executor.awaitingConfirmation).toBe(true);
      expect(run.device.flags()).not.toContain('purchased:desk-lamp');
      expect(run.device.submissions()).toHaveLength(0);
      expect(run.plannerCalls).toBe(2);
    },
  );

  it('approving it buys ONCE — the halt the page caption raised is released by the same signature', async () => {
    const run = await runLoopTask(
      LIVE_SITES.lumenwick,
      'place the order for the desk lamp',
      script('#primary-action'),
    );
    const halt = executed(run.result).executor.results.at(-1);
    if (halt?.kind !== 'confirmation_required') throw new Error('the turn did not halt');
    const approved = await run.turn(
      'yes, place it',
      new Set([consequentialSignature(halt.category, halt.matchedText)]),
    );
    expect(executed(approved).executor.ok).toBe(true);
    expect(run.device.flags()).toContain('purchased:desk-lamp');
    expect(run.device.submissions()).toHaveLength(1);
  });
});

describe('LOOP-WIZARD — the same control on the NEXT page of a form is the next step, not a repeat', () => {
  it('two steps sharing one Continue button finish in ONE message, each tap landing once', async () => {
    const NEXT = tap('#step-next', 'Continue');
    const run = await runLoopTask(
      LIVE_SITES.shiftwell,
      'get me a removals quote from LS1 4AP to YO1 7HH',
      [
        {
          intents: [{ kind: 'navigate', url: 'https://shiftwell.test/quote' }, SETTLE],
          status: 'continue',
        },
        { intents: [type('#postcode', 'LS1 4AP'), NEXT, SETTLE], status: 'continue' },
        { intents: [type('#postcode', 'YO1 7HH'), NEXT, SETTLE], status: 'continue' },
        { intents: [], status: 'done' },
      ],
    );
    const result = executed(run.result);
    expect(result.executor.ok).toBe(true);
    expect(result.loop?.stopped).toBeUndefined();
    expect(result.notice).toBeUndefined();
    expect(run.device.flags()).toContain('quote:requested');
    expect(run.device.url()).toBe('https://shiftwell.test/quote/estimate');
    // The two looks the Continue taps were planned against are different pages —
    // which is exactly what admitted the second one.
    expect(run.looks[1]).toContain('Step 1 of 2');
    expect(run.looks[2]).toContain('Step 2 of 2');
    expect(run.device.submissions()).toHaveLength(2);
  });

  it('a planner that taps the field before typing on EACH page — several repeats, each on a moved page — still finishes in one message', async () => {
    // The plan shape a real model produced on this fixture (2026-09-18), which
    // an earlier "two repeats is a re-description" rule refused mid-form.
    const FIELD = tap('#postcode', 'Postcode');
    const NEXT = tap('#step-next', 'Continue');
    const run = await runLoopTask(
      LIVE_SITES.shiftwell,
      'get me a removals quote from LS1 4AP to YO1 7HH',
      [
        {
          intents: [{ kind: 'navigate', url: 'https://shiftwell.test/quote' }],
          status: 'continue',
        },
        { intents: [FIELD, type('#postcode', 'LS1 4AP'), NEXT], status: 'continue' },
        { intents: [FIELD, type('#postcode', 'YO1 7HH'), NEXT], status: 'continue' },
        { intents: [], status: 'done' },
      ],
    );
    const result = executed(run.result);
    expect(result.loop?.stopped).toBeUndefined();
    expect(run.device.flags()).toContain('quote:requested');
    expect(run.device.url()).toBe('https://shiftwell.test/quote/estimate');
  });

  it('⛔ and the same Continue planned again on the page it ALREADY ran on is refused — it lands once', async () => {
    const NEXT = tap('#step-next', 'Continue');
    const run = await runLoopTask(
      LIVE_SITES.shiftwell,
      'get me a removals quote from LS1 4AP to YO1 7HH',
      (call) =>
        call === 1
          ? {
              intents: [{ kind: 'navigate', url: 'https://shiftwell.test/quote' }, SETTLE],
              status: 'continue',
            }
          : // A planner that re-sends the step-1 submit on step 1's own page
            // (the field stays empty on this fixture's refusal, so the page does
            // not move): the second tap is on a page the first tap was planned
            // against — circles.
            { intents: [NEXT, SETTLE], status: 'continue' },
    );
    const result = executed(run.result);
    expect(result.loop?.stopped).toBe('no_progress');
    expect(run.device.events().filter((e) => e.kind === 'clicked')).toHaveLength(1);
  });
});

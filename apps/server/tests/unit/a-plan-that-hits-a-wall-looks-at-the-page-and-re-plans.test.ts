// P1 — THE PLANNER COULD NOT SEE THE PAGE, and the executor halted on the first
// non-wait failure. Together those two facts are the whole product complaint:
// the model guesses a selector from memory, step two dies, and the customer is
// asked to type "continue" so it can guess again.
//
// `perceive` was in the device vocabulary the entire time. Nothing mapped to it,
// and the prompt stated the consequence in its own words — "NO BRANCHING and NO
// RETRIES, so every step you add is a step the whole task dies on".
//
// ⛔ WHAT THIS FILE DOES AND DOES NOT PROVE. It proves the LOOP: that the turn
// re-reads the page, asks for a new plan, runs it, and stops when it should. It
// proves nothing about whether a real model plans better with the page in front
// of it — no model runs here. That question needs a planner eval with a real
// planner in the loop, and saying otherwise would be the same mistake as quoting
// a scripted corpus as a planner number.
//
// ⛔ AND THE BOUNDS ARE THE POINT, NOT THE DECORATION. An unbounded re-plan loop
// is a way to spend a customer's whole budget on one message, and a re-plan that
// carried approvals forward would be a way to reach a purchase without the
// confirmation the gate exists to demand.
//
// ⛔ AND BE EXACT ABOUT WHICH BOUNDS ARE GATES. Three of them are: the re-plan
// ceiling, the budget floor, and the identical-plan stop — remove any one and an
// arm below goes red. MAX_MODEL_CALLS_PER_TURN is NOT a fourth: at today's
// values it is arithmetically implied by the re-plan ceiling and cannot bind
// first, so no mutation of that conjunct fails anything. It is pinned as a
// RELATION instead (the maximal turn's call count equals the budget), which
// fails the moment either number moves without the other. Calling it a bound
// with its own arm would have been a claim this file cannot support.

import { isDeepStrictEqual } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  AgentRuntime,
  MAX_MODEL_CALLS_PER_TURN,
  MAX_PLANNER_CALLS_PER_TURN,
  MAX_REPLANS_PER_TURN,
  isReplannableFailure,
} from '../../src/services/agent-runtime.js';
import { InMemoryAgentSessionsRepo } from '../../src/services/agent-sessions.js';
import {
  StubAgentExecutor,
  consequentialHalt,
  consequentialSignature,
  type AgentExecutor,
  type ExecuteArgs,
  type ExecutorRunResult,
  type IntentResult,
} from '../../src/services/agent-executor.js';
import type {
  AgentIntent,
  DecomposeArgs,
  DecomposeResult,
} from '../../src/services/agent-decomposer.js';
import { AgentDecomposerSettledError } from '../../src/services/agent-decomposer.js';
import { summarizePageForPlanning } from '../../src/services/agent-executor-control-plane.js';

const NAV: AgentIntent = { kind: 'navigate', url: 'https://shop.test/' };
const TAP_GUESSED: AgentIntent = { kind: 'interact', action: 'tap', selector: '#guessed' };
const TAP_SEEN: AgentIntent = { kind: 'interact', action: 'tap', selector: '#actually-there' };
const SHOT: AgentIntent = { kind: 'capture', capture: 'screenshot' };
const BUY: AgentIntent = {
  kind: 'interact',
  action: 'tap',
  selector: '#buy',
  value: 'Buy now',
};

/** The selector an intent targets, or null. Narrowed rather than read off the
 *  union: `selector` exists on `interact` only, and a cast would let a typo
 *  compare against undefined forever without ever failing. */
function selectorOf(intent: AgentIntent): string | null {
  return intent.kind === 'interact' ? (intent.selector ?? null) : null;
}

function plan(intents: AgentIntent[], tokens = 100): DecomposeResult {
  return { kind: 'plan', intents, tokensConsumed: tokens };
}

/** A failure the executor PROVES did not execute — the re-plannable class. */
function notFound(intent: AgentIntent): IntentResult {
  return {
    kind: 'failure',
    intent,
    reason: 'no element on the page matched this selector',
    diagnosis: { category: 'element_not_found', retryable: true },
  };
}

/** A failure whose outcome is UNKNOWN — the class a re-plan must never follow. */
function outcomeUnknown(intent: AgentIntent): IntentResult {
  return {
    kind: 'failure',
    intent,
    reason: 'the browser action may have taken effect even though its result was not confirmed',
    diagnosis: { category: 'unknown', retryable: false },
  };
}

/**
 * An executor that answers from a per-selector script and records every plan it
 * was handed, so an arm can assert WHAT ran as well as how often.
 */
function scriptedExecutor(opts: {
  fails: (intent: AgentIntent) => IntentResult | null;
  digest?: string | null;
  runs: ExecuteArgs[];
  observeCalls?: { n: number };
}): AgentExecutor {
  return {
    execute: (args: ExecuteArgs): Promise<ExecutorRunResult> => {
      opts.runs.push(args);
      const results: IntentResult[] = [];
      for (const intent of args.plan.intents) {
        const failure = opts.fails(intent);
        if (failure !== null) {
          results.push(failure);
          return Promise.resolve({ results, ok: false });
        }
        results.push({ kind: 'success', intent, summary: 'ok' });
      }
      return Promise.resolve({ results, ok: true });
    },
    observeDigest: (): Promise<string | null> => {
      if (opts.observeCalls !== undefined) opts.observeCalls.n += 1;
      return Promise.resolve(opts.digest ?? null);
    },
  };
}

/** Hands out one plan per decompose call and records every args it saw. */
function scriptedPlanner(plans: DecomposeResult[], seen: DecomposeArgs[]) {
  let i = 0;
  return {
    decompose: (args: DecomposeArgs): Promise<DecomposeResult> => {
      seen.push(args);
      const next = plans[Math.min(i, plans.length - 1)];
      i += 1;
      return Promise.resolve(next ?? plan([SHOT]));
    },
  };
}

async function makeRuntime(opts: {
  plans: DecomposeResult[];
  executor: AgentExecutor;
  seen: DecomposeArgs[];
  tokenBudgetTotal?: number;
}) {
  const sessions = new InMemoryAgentSessionsRepo(() => new Date('2026-09-17T00:00:00Z'));
  const seed = await sessions.create({
    accountId: 'acc_1',
    tokenBudgetTotal: opts.tokenBudgetTotal ?? 100_000,
  });
  const runtime = new AgentRuntime({
    decomposer: scriptedPlanner(opts.plans, opts.seen),
    executor: opts.executor,
    sessions,
    archetype: 'iphone16pro_ios18_7_safari26_4',
  });
  return { runtime, sessions, seedId: seed.id };
}

describe('P1 — a plan that hits a wall looks at the page and re-plans the remainder', () => {
  it('the turn re-plans and FINISHES, where before it stopped and asked the customer to continue', async () => {
    const runs: ExecuteArgs[] = [];
    const seen: DecomposeArgs[] = [];
    const observeCalls = { n: 0 };
    const { runtime, seedId } = await makeRuntime({
      plans: [plan([NAV, TAP_GUESSED, SHOT]), plan([TAP_SEEN, SHOT])],
      executor: scriptedExecutor({
        fails: (i) => (selectorOf(i) === '#guessed' ? notFound(i) : null),
        digest: '#actually-there · button · "Add to cart"',
        runs,
        observeCalls,
      }),
      seen,
    });

    const result = await runtime.runTurn({ agentSessionId: seedId, userMessage: 'add the mug' });

    if (result.kind !== 'plan-executed') throw new Error('type narrow');
    expect(result.executor.ok).toBe(true);
    expect(runs).toHaveLength(2);
    // ⛔ IT LOOKED FIRST. A re-plan that did not read the page is the same blind
    // guess again, just billed twice.
    expect(observeCalls.n).toBe(1);
    expect(seen[1]?.observation).toContain('#actually-there');
    // And it was told WHICH step died, so "do not re-emit that step" is actionable.
    expect(seen[1]?.priorFailure).toContain('interact');
  });

  it('keeps BOTH halves of the story: the step that failed AND the steps that then worked', async () => {
    const runs: ExecuteArgs[] = [];
    const seen: DecomposeArgs[] = [];
    const { runtime, sessions, seedId } = await makeRuntime({
      plans: [plan([NAV, TAP_GUESSED]), plan([TAP_SEEN, SHOT])],
      executor: scriptedExecutor({
        fails: (i) => (selectorOf(i) === '#guessed' ? notFound(i) : null),
        digest: 'x',
        runs,
      }),
      seen,
    });

    const result = await runtime.runTurn({ agentSessionId: seedId, userMessage: 'add the mug' });
    if (result.kind !== 'plan-executed') throw new Error('type narrow');
    // ⛔ A merge that dropped the failed prefix would report a clean run of a
    // plan that is not the plan that ran.
    expect(result.executor.results.map((r) => r.kind)).toEqual([
      'success',
      'failure',
      'success',
      'success',
    ]);
    // The persisted intent log is what ATTEMPTED, not what was first proposed.
    const planEntry = (await sessions.get(seedId))?.transcript.find((e) => e.intents !== undefined);
    expect(planEntry?.intents).toHaveLength(4);
  });

  it('⛔ STOPS AT THE RE-PLAN CEILING — a model that keeps failing cannot loop forever', async () => {
    const runs: ExecuteArgs[] = [];
    const seen: DecomposeArgs[] = [];
    const { runtime, seedId } = await makeRuntime({
      // Each plan is DIFFERENT (so the identical-plan guard does not end it) and
      // each one fails, so only the ceiling can stop this.
      plans: [
        plan([{ ...TAP_GUESSED, selector: '#a' }]),
        plan([{ ...TAP_GUESSED, selector: '#b' }]),
        plan([{ ...TAP_GUESSED, selector: '#c' }]),
        plan([{ ...TAP_GUESSED, selector: '#d' }]),
        plan([{ ...TAP_GUESSED, selector: '#e' }]),
      ],
      executor: scriptedExecutor({ fails: (i) => notFound(i), digest: 'x', runs }),
      seen,
    });

    await runtime.runTurn({ agentSessionId: seedId, userMessage: 'do the thing' });
    // The first plan plus MAX_REPLANS_PER_TURN re-plans, and no more — read off
    // the constant, so the arm states the rule rather than today's number. The
    // planner-call ceiling is higher and is NOT what stops this: a model that
    // keeps FAILING is not rescued by having calls left.
    expect(runs).toHaveLength(1 + MAX_REPLANS_PER_TURN);
    expect(seen).toHaveLength(1 + MAX_REPLANS_PER_TURN);
    expect(1 + MAX_REPLANS_PER_TURN).toBeLessThan(MAX_PLANNER_CALLS_PER_TURN);
  });

  it('⛔ AN IDENTICAL PLAN ENDS THE LOOP — re-running it would repeat the prefix that already worked', async () => {
    const runs: ExecuteArgs[] = [];
    const seen: DecomposeArgs[] = [];
    const same = plan([NAV, TAP_GUESSED]);
    const { runtime, seedId } = await makeRuntime({
      plans: [same, same, same],
      executor: scriptedExecutor({
        fails: (i) => (selectorOf(i) === '#guessed' ? notFound(i) : null),
        digest: 'x',
        runs,
      }),
      seen,
    });

    await runtime.runTurn({ agentSessionId: seedId, userMessage: 'add the mug' });
    // The model was ASKED again (that call is real and is billed), and the
    // answer was refused before it could re-navigate and re-tap.
    expect(seen).toHaveLength(2);
    expect(runs).toHaveLength(1);
  });

  it('⛔ NEVER RE-PLANS AN OUTCOME-UNKNOWN FAILURE — the page state is exactly what we cannot describe', async () => {
    const runs: ExecuteArgs[] = [];
    const seen: DecomposeArgs[] = [];
    const observeCalls = { n: 0 };
    const { runtime, seedId } = await makeRuntime({
      plans: [plan([NAV, BUY]), plan([SHOT])],
      executor: scriptedExecutor({
        fails: (i) => (selectorOf(i) === '#buy' ? outcomeUnknown(i) : null),
        digest: 'x',
        runs,
        observeCalls,
      }),
      seen,
    });

    await runtime.runTurn({ agentSessionId: seedId, userMessage: 'do it' });
    // A click whose result was lost MAY have submitted. Re-planning from a page
    // we cannot describe risks doing it a second time.
    expect(runs).toHaveLength(1);
    expect(seen).toHaveLength(1);
    expect(observeCalls.n).toBe(0);
  });

  it('⛔ NEVER RE-PLANS A CONSEQUENTIAL HALT — that is a human decision in progress, not a wall to route around', async () => {
    const runs: ExecuteArgs[] = [];
    const seen: DecomposeArgs[] = [];
    const stub = new StubAgentExecutor();
    const { runtime, seedId } = await makeRuntime({
      plans: [plan([NAV, BUY, SHOT]), plan([SHOT])],
      executor: {
        execute: (args) => {
          runs.push(args);
          return stub.execute(args);
        },
        observeDigest: () => Promise.resolve('x'),
      },
      seen,
    });

    const result = await runtime.runTurn({ agentSessionId: seedId, userMessage: 'buy the mug' });
    if (result.kind !== 'plan-executed') throw new Error('type narrow');
    expect(result.executor.awaitingConfirmation).toBe(true);
    // A loop that re-planned here would be a route to the purchase that never
    // passes the confirmation.
    expect(runs).toHaveLength(1);
    expect(seen).toHaveLength(1);
  });

  it('⛔ A RE-PLAN CARRIES NO APPROVALS — every re-planned step faces the gate in full', async () => {
    const runs: ExecuteArgs[] = [];
    const seen: DecomposeArgs[] = [];
    const { runtime, seedId } = await makeRuntime({
      plans: [plan([TAP_GUESSED]), plan([BUY, SHOT])],
      executor: scriptedExecutor({
        fails: (i) => (selectorOf(i) === '#guessed' ? notFound(i) : null),
        digest: 'x',
        runs,
      }),
      seen,
    });

    await runtime.runTurn({ agentSessionId: seedId, userMessage: 'do it' });
    expect(runs).toHaveLength(2);
    expect(runs[1]?.approvedConsequentialActions).toBeUndefined();
  });

  it('⛔ RESPECTS THE BUDGET FLOOR — a near-empty session never STARTS a call it cannot cover', async () => {
    const runs: ExecuteArgs[] = [];
    const seen: DecomposeArgs[] = [];
    const { runtime, seedId } = await makeRuntime({
      plans: [plan([TAP_GUESSED], 5_000), plan([SHOT])],
      executor: scriptedExecutor({ fails: (i) => notFound(i), digest: 'x', runs }),
      seen,
      // 10k total, 5k spent by the first decompose → 5k left, under the 6k floor.
      tokenBudgetTotal: 10_000,
    });

    await runtime.runTurn({ agentSessionId: seedId, userMessage: 'do it' });
    expect(runs).toHaveLength(1);
    expect(seen).toHaveLength(1);
  });

  it('⛔ EVERY ITERATION RECORDS ITS OWN USAGE ROW — the monthly cap sums exactly these', async () => {
    const runs: ExecuteArgs[] = [];
    const seen: DecomposeArgs[] = [];
    const usageRows: { tokensConsumed: number; bundledFlatCostAlreadyPosted?: boolean }[] = [];
    const sessions = new InMemoryAgentSessionsRepo(() => new Date('2026-09-17T00:00:00Z'));
    const seed = await sessions.create({ accountId: 'acc_1', tokenBudgetTotal: 100_000 });
    const withUsage = (intents: AgentIntent[], tokens: number): DecomposeResult => ({
      kind: 'plan',
      intents,
      tokensConsumed: tokens,
      usage: { decomposerKind: 'claude', anthropicInputTokens: tokens, anthropicOutputTokens: 0 },
    });
    const runtime = new AgentRuntime({
      decomposer: scriptedPlanner([withUsage([TAP_GUESSED], 300), withUsage([SHOT], 200)], seen),
      executor: scriptedExecutor({
        fails: (i) => (selectorOf(i) === '#guessed' ? notFound(i) : null),
        digest: 'x',
        runs,
      }),
      sessions,
      archetype: 'iphone16pro_ios18_7_safari26_4',
      usageRecorder: {
        record: (a) => {
          usageRows.push(a);
          return Promise.resolve();
        },
      },
    });

    await runtime.runTurn({ agentSessionId: seed.id, userMessage: 'do it' });
    expect(usageRows.map((r) => r.tokensConsumed)).toEqual([300, 200]);
    // The turn's flat bundled charge is posted ONCE, by the first row. A second
    // flat charge would bill one message twice.
    expect(usageRows[0]?.bundledFlatCostAlreadyPosted).toBeUndefined();
    expect(usageRows[1]?.bundledFlatCostAlreadyPosted).toBe(true);
    // Both calls are debited from the session budget.
    expect((await sessions.get(seed.id))?.tokenBudgetRemaining).toBe(100_000 - 500);
  });

  it('a first turn does NOT pay for a pre-plan page read — there is no page yet', async () => {
    const runs: ExecuteArgs[] = [];
    const seen: DecomposeArgs[] = [];
    const observeCalls = { n: 0 };
    const { runtime, seedId } = await makeRuntime({
      plans: [plan([NAV, SHOT])],
      executor: scriptedExecutor({ fails: () => null, digest: 'x', runs, observeCalls }),
      seen,
    });

    await runtime.runTurn({ agentSessionId: seedId, userMessage: 'go to shop.test' });
    expect(observeCalls.n).toBe(0);
    expect(seen[0]?.observation).toBeUndefined();
  });

  it('a SECOND turn perceives before planning, so the model plans against the page it is on', async () => {
    const runs: ExecuteArgs[] = [];
    const seen: DecomposeArgs[] = [];
    const observeCalls = { n: 0 };
    const { runtime, seedId } = await makeRuntime({
      plans: [plan([NAV, SHOT]), plan([TAP_SEEN, SHOT])],
      executor: scriptedExecutor({
        fails: () => null,
        digest: '#actually-there · button · "Add to cart"',
        runs,
        observeCalls,
      }),
      seen,
    });

    await runtime.runTurn({ agentSessionId: seedId, userMessage: 'go to shop.test' });
    await runtime.runTurn({ agentSessionId: seedId, userMessage: 'now add the mug' });
    expect(observeCalls.n).toBe(1);
    expect(seen[1]?.observation).toContain('#actually-there');
  });
});

describe('P1 — which failures may be re-planned, stated as an allowlist', () => {
  it.each([
    'element_not_found',
    'page_load_failed',
    'condition_not_met',
    'capture_failed',
    'scroll_failed',
    'invalid_request',
    'result_too_large',
  ])('%s PROVABLY did not execute, so it may be re-planned', (category) => {
    expect(
      isReplannableFailure({
        ok: false,
        results: [
          {
            kind: 'failure',
            intent: TAP_GUESSED,
            reason: 'x',
            diagnosis: { category: category as 'unknown', retryable: true },
          },
        ],
      }),
    ).toBe(true);
  });

  it.each(['unknown', 'session_error'])('%s may NOT be re-planned', (category) => {
    expect(
      isReplannableFailure({
        ok: false,
        results: [
          {
            kind: 'failure',
            intent: TAP_GUESSED,
            reason: 'x',
            diagnosis: { category: category as 'unknown', retryable: false },
          },
        ],
      }),
    ).toBe(false);
  });

  it('a MAPPING refusal never reached the device at all, so it is re-plannable — this is the Playwright-selector case', () => {
    expect(
      isReplannableFailure({
        ok: false,
        results: [{ kind: 'failure', intent: TAP_GUESSED, reason: 'selector is not valid CSS' }],
      }),
    ).toBe(true);
  });

  it('a successful or halted run is not a failure to re-plan', () => {
    expect(
      isReplannableFailure({
        ok: true,
        results: [{ kind: 'success', intent: SHOT, summary: 'x' }],
      }),
    ).toBe(false);
    expect(isReplannableFailure({ ok: false, results: [] })).toBe(false);
  });
});

describe('P1 — the observation handed to the model is a bounded digest, not the page', () => {
  const PAGE = [
    '<html><head><title>Deals — shop.test</title></head><body>',
    '<style>.a{color:red}</style><script>var x=1;</script>',
    '<a href="/t/9182">Battery recall on the 2024 units</a>',
    '<button id="show-sold-out">Show sold out</button>',
    '<input name="q" placeholder="Search the site">',
    '<span>some prose nobody can tap</span>',
    '</body></html>',
  ].join('\n');

  it('names the page and every element a plan can target, with the selector that addresses it', () => {
    const digest = summarizePageForPlanning(PAGE);
    expect(digest).toContain('page: Deals — shop.test');
    expect(digest).toContain('a[href="/t/9182"]');
    expect(digest).toContain('Battery recall on the 2024 units');
    expect(digest).toContain('#show-sold-out');
    expect(digest).toContain('input[name="q"]');
    expect(digest).toContain('Search the site');
  });

  it('⛔ DROPS WHAT CANNOT BE PLANNED AGAINST — markup, styling and script are the bulk of a real page', () => {
    const digest = summarizePageForPlanning(PAGE);
    expect(digest).not.toContain('<script');
    expect(digest).not.toContain('color:red');
    expect(digest).not.toContain('<html');
    expect(digest.length).toBeLessThan(PAGE.length);
  });

  it('⛔ IS BOUNDED BY BOTH AXES: the character budget and the element count', () => {
    const huge = Array.from(
      { length: 400 },
      (_, i) => `<button id="b${String(i)}">Button number ${String(i)}</button>`,
    ).join('\n');
    const digest = summarizePageForPlanning(huge);
    expect(digest.length).toBeLessThanOrEqual(4_000);
    // MOVED 2026-09-18, 60 → 61: sixty ELEMENT rows, as before, plus the one
    // `text:` row saying what the page says. The character ceiling above is the
    // same number it was — the text is paid for out of it, not on top of it.
    const rows = digest.split('\n');
    expect(rows.filter((row) => !row.startsWith('text: ')).length).toBeLessThanOrEqual(60);
    expect(rows.length).toBeLessThanOrEqual(61);
    // The bound is not a character cut mid-way through the first element.
    expect(digest).toContain('#b0');
  });

  it('a tiny explicit budget is honoured, so the caller can always make it smaller', () => {
    expect(summarizePageForPlanning(PAGE, 40).length).toBeLessThanOrEqual(40);
    // Title + what the page says + ONE element (it was title + one element
    // before the digest carried the page's text).
    expect(summarizePageForPlanning(PAGE, 4_000, 1).split('\n')).toHaveLength(3);
    expect(
      summarizePageForPlanning(PAGE, 4_000, 1)
        .split('\n')
        .filter((row) => row.includes(' · ')),
    ).toHaveLength(1);
  });

  it('an element with nothing stable to address it by is dropped — a selector nothing can target is worse than no row', () => {
    const digest = summarizePageForPlanning('<button>Click me</button><button id="ok">Ok</button>');
    expect(digest).toContain('#ok');
    // No ROW for it. (Its words are still part of what the page SAYS, which the
    // digest now carries — the rule is about selectors, and it never offers one.)
    const elementRows = digest.split('\n').filter((row) => row.includes(' · '));
    expect(elementRows).toHaveLength(1);
    expect(elementRows.join('\n')).not.toContain('Click me');
  });

  it('⛔ DEGRADES RATHER THAN DISAPPEARS: a text-only page returns its text, never a false "the page is empty"', () => {
    const digest = summarizePageForPlanning('Results for wireless keyboard\n1. Quietkey 7');
    expect(digest).toContain('Quietkey 7');
  });

  it('an empty source yields an empty digest — and the caller treats that as "no observation"', () => {
    expect(summarizePageForPlanning('')).toBe('');
    expect(summarizePageForPlanning('   \n  ')).toBe('');
  });
});

// ── THE SEAMS THE MERGE CREATED ──────────────────────────────────────
//
// Every arm above asks whether the loop RUNS and STOPS. These ask what the loop
// did to the things that were already correct when a turn was exactly one plan:
// the index an approval resumes from, the intents the executor is handed, the
// accounting on a call that failed, and the sentence the transcript ends with.
// Each of those was written against "one turn, one run" and each was silently
// false the moment a turn could run three.

const TAP_SEND: AgentIntent = { kind: 'interact', action: 'tap', selector: '#send' };
const WAIT_SENT: AgentIntent = {
  kind: 'wait',
  condition: 'selector_visible',
  selector: '#sent',
  timeoutMs: 2_000,
};
const WAIT_LONGER: AgentIntent = { ...WAIT_SENT, timeoutMs: 10_000 };
const SCROLL: AgentIntent = { kind: 'interact', action: 'scroll', selector: '#list' };

/** A condition that was never observed: the wait ran and the page never got
 *  there. Re-plannable — nothing executed — and the shape that ends a run with a
 *  CLICK ALREADY LANDED behind it. */
function conditionNotMet(intent: AgentIntent): IntentResult {
  return {
    kind: 'failure',
    intent,
    reason: 'the page never reached the state this step was waiting for',
    diagnosis: { category: 'condition_not_met', retryable: false },
  };
}

/** The executor above, plus the REAL consequential gate, so an arm can drive a
 *  turn to a confirmation halt through the same code the product uses. */
function gatedExecutor(opts: {
  fails: (intent: AgentIntent) => IntentResult | null;
  runs: ExecuteArgs[];
  dispatched: AgentIntent[];
}): AgentExecutor {
  return {
    execute: (args: ExecuteArgs): Promise<ExecutorRunResult> => {
      opts.runs.push(args);
      const approved = new Set(args.approvedConsequentialActions ?? []);
      const results: IntentResult[] = [];
      for (const intent of args.plan.intents) {
        const halt = consequentialHalt(intent, approved);
        if (halt !== null) {
          results.push(halt);
          return Promise.resolve({ results, ok: false, awaitingConfirmation: true });
        }
        opts.dispatched.push(intent);
        const failure = opts.fails(intent);
        if (failure !== null) {
          results.push(failure);
          // A `wait` is best-effort and does not halt the plan — the same rule
          // the control-plane executor applies, and the rule that lets a run end
          // with a successful click behind a failed final step.
          if (intent.kind === 'wait') continue;
          return Promise.resolve({ results, ok: false });
        }
        results.push({ kind: 'success', intent, summary: `did ${intent.kind}` });
      }
      return Promise.resolve({ results, ok: results.every((r) => r.kind === 'success') });
    },
    observeDigest: () => Promise.resolve('#sent · button · "Send"'),
  };
}

describe('P1 — a re-plan runs the REMAINDER, never the part that already happened', () => {
  it('⛔ A STEP THAT ALREADY SUCCEEDED IS NOT DISPATCHED A SECOND TIME, even when the model re-emits it', async () => {
    // The measured shape. A plan ending in a wait that times out does not halt
    // the executor, so the run ends re-plannable with a CLICK ALREADY LANDED.
    // The model, asked to continue, describes the whole task again with one
    // thing changed — which is not byte-identical, so the identical-plan guard
    // waves it through and #send is clicked twice.
    const runs: ExecuteArgs[] = [];
    const dispatched: AgentIntent[] = [];
    const seen: DecomposeArgs[] = [];
    const { runtime, seedId } = await makeRuntime({
      plans: [plan([NAV, TAP_SEND, WAIT_SENT]), plan([NAV, TAP_SEND, WAIT_LONGER])],
      executor: gatedExecutor({
        fails: (i) => (i.kind === 'wait' && i.timeoutMs === 2_000 ? conditionNotMet(i) : null),
        runs,
        dispatched,
      }),
      seen,
    });

    await runtime.runTurn({ agentSessionId: seedId, userMessage: 'send it and confirm' });

    // The re-plan DID run — this is not the identical-plan guard passing by luck.
    expect(runs).toHaveLength(2);
    // And it ran only the part that had not happened.
    expect(runs[1]?.plan.intents).toEqual([WAIT_LONGER]);
    expect(dispatched.filter((i) => isDeepStrictEqual(i, TAP_SEND))).toHaveLength(1);
    expect(dispatched.filter((i) => isDeepStrictEqual(i, NAV))).toHaveLength(1);
  });

  it('⛔ AND WHEN THE REPEAT IS NOT A LEADING PREFIX, THE WHOLE RE-PLAN IS REFUSED', async () => {
    // Trimming can only see a repeat at the front. A model that returns the
    // already-clicked step SECOND is asking for the same duplicate effect by a
    // route trimming cannot detect, so the turn stops instead of guessing.
    const runs: ExecuteArgs[] = [];
    const dispatched: AgentIntent[] = [];
    const seen: DecomposeArgs[] = [];
    const { runtime, seedId } = await makeRuntime({
      plans: [plan([NAV, TAP_SEND, WAIT_SENT]), plan([SCROLL, TAP_SEND])],
      executor: gatedExecutor({
        fails: (i) => (i.kind === 'wait' ? conditionNotMet(i) : null),
        runs,
        dispatched,
      }),
      seen,
    });

    await runtime.runTurn({ agentSessionId: seedId, userMessage: 'send it and confirm' });

    // The model was asked (that call is real and is billed), and the answer was
    // refused before anything could be dispatched a second time.
    expect(seen).toHaveLength(2);
    expect(runs).toHaveLength(1);
    expect(dispatched.filter((i) => isDeepStrictEqual(i, TAP_SEND))).toHaveLength(1);
  });

  it('a re-plan that repeats a REPLAY-SAFE step is fine — a capture twice costs nothing', async () => {
    // The refusal above is about duplicate EFFECT, not about repetition. A
    // screenshot has no effect to duplicate, so refusing it would cost the
    // customer the turn for no safety gained.
    const runs: ExecuteArgs[] = [];
    const dispatched: AgentIntent[] = [];
    const seen: DecomposeArgs[] = [];
    const { runtime, seedId } = await makeRuntime({
      plans: [plan([SHOT, WAIT_SENT]), plan([SHOT, TAP_SEEN])],
      executor: gatedExecutor({
        fails: (i) => (i.kind === 'wait' ? conditionNotMet(i) : null),
        runs,
        dispatched,
      }),
      seen,
    });

    await runtime.runTurn({ agentSessionId: seedId, userMessage: 'grab it' });
    expect(runs).toHaveLength(2);
    expect(dispatched.filter((i) => i.kind === 'interact')).toHaveLength(1);
  });
});

describe('P1 — an approval after a re-plan resumes the RE-PLANNED remainder', () => {
  async function haltAfterReplan() {
    const runs: ExecuteArgs[] = [];
    const dispatched: AgentIntent[] = [];
    const seen: DecomposeArgs[] = [];
    const { runtime, sessions, seedId } = await makeRuntime({
      // Plan 1 dies at the guessed tap with TWO steps behind it that never ran.
      // The re-plan abandons them and goes straight for a purchase.
      plans: [plan([NAV, TAP_GUESSED, SHOT, SCROLL]), plan([BUY])],
      executor: gatedExecutor({
        fails: (i) => (selectorOf(i) === '#guessed' ? notFound(i) : null),
        runs,
        dispatched,
      }),
      seen,
    });
    const result = await runtime.runTurn({
      agentSessionId: seedId,
      userMessage: 'buy the mug',
    });
    return { runtime, sessions, seedId, result, runs, dispatched };
  }

  it('⛔ THE RESUME INDEX POINTS AT THE REVIEWED ACTION, not into the abandoned plan', async () => {
    const { sessions, seedId, result } = await haltAfterReplan();
    if (result.kind !== 'plan-executed') throw new Error('type narrow');
    expect(result.executor.awaitingConfirmation).toBe(true);

    const entry = (await sessions.get(seedId))?.transcript.find((e) => e.intents !== undefined);
    const intents = entry?.intents ?? [];
    const resumeFrom = entry?.resumeFromIntentIndex;
    // Every intent ATTEMPTED, across both plans — which is why an index derived
    // from the MERGED result length lands in the wrong place: the merge drops
    // plan 1's unexecuted suffix and this list keeps it.
    expect(intents).toEqual([NAV, TAP_GUESSED, SHOT, SCROLL, BUY]);
    expect(resumeFrom).toBe(4);
    // ⛔ THE PROPERTY, stated the way reconstructHaltedPlan uses it: the resumed
    // plan is exactly the action the customer was shown. An index of 2 — what
    // the merged length gives — would resume [SHOT, SCROLL, BUY] and run two
    // steps from the plan the re-plan deliberately walked away from BEFORE the
    // purchase they actually reviewed.
    expect(intents.slice(resumeFrom)).toEqual([BUY]);
  });

  it('and approving it executes ONLY that action — nothing from the abandoned plan runs', async () => {
    const { runtime, seedId, result, dispatched } = await haltAfterReplan();
    if (result.kind !== 'plan-executed') throw new Error('type narrow');
    const halt = result.executor.results.at(-1);
    if (halt?.kind !== 'confirmation_required') throw new Error('type narrow');
    const before = dispatched.length;

    await runtime.runTurn({
      agentSessionId: seedId,
      userMessage: 'yes, go ahead',
      approvedConsequentialActions: new Set([
        consequentialSignature(halt.category, halt.matchedText),
      ]),
    });

    expect(dispatched.slice(before)).toEqual([BUY]);
  });
});

describe('P1 — the accounting and the story survive the loop', () => {
  it('⛔ A SETTLED PROVIDER CALL IS METERED AND DEBITED EVEN THOUGH ITS CONTENT WAS REJECTED', async () => {
    // AgentDecomposerSettledError means the provider responded and consumed
    // billable tokens; only the strict content codec refused what came back. A
    // bare `catch { break }` dropped both the usage row and the token debit for
    // real upstream spend — and the re-plan prompt carries untrusted PAGE TEXT,
    // which is the input most able to provoke exactly that rejection.
    const runs: ExecuteArgs[] = [];
    const usageRows: { tokensConsumed: number; decomposeResultKind: string }[] = [];
    const sessions = new InMemoryAgentSessionsRepo(() => new Date('2026-09-17T00:00:00Z'));
    const seed = await sessions.create({ accountId: 'acc_1', tokenBudgetTotal: 100_000 });
    let call = 0;
    const runtime = new AgentRuntime({
      decomposer: {
        decompose: (): Promise<DecomposeResult> => {
          call += 1;
          if (call === 1) {
            return Promise.resolve({
              kind: 'plan',
              intents: [TAP_GUESSED],
              tokensConsumed: 300,
              usage: {
                decomposerKind: 'claude',
                anthropicInputTokens: 300,
                anthropicOutputTokens: 0,
              },
            });
          }
          return Promise.reject(
            new AgentDecomposerSettledError('the model returned content the codec rejected', {
              usage: {
                decomposerKind: 'claude',
                anthropicInputTokens: 700,
                anthropicOutputTokens: 0,
              },
              tokensConsumed: 700,
            }),
          );
        },
      },
      executor: scriptedExecutor({ fails: (i) => notFound(i), digest: 'x', runs }),
      sessions,
      archetype: 'iphone16pro_ios18_7_safari26_4',
      usageRecorder: {
        record: (a) => {
          usageRows.push(a);
          return Promise.resolve();
        },
      },
    });

    const result = await runtime.runTurn({ agentSessionId: seed.id, userMessage: 'do it' });

    // The turn did not fail — a re-plan that cannot be had is a turn that
    // reports what the plan achieved.
    expect(result.kind).toBe('plan-executed');
    // TWO rows: the plan call and the settled-but-rejected re-plan call.
    expect(usageRows.map((r) => r.tokensConsumed)).toEqual([300, 700]);
    expect(usageRows[1]?.decomposeResultKind).toBe('refuse');
    // And BOTH calls are debited from the session budget.
    expect((await sessions.get(seed.id))?.tokenBudgetRemaining).toBe(100_000 - 1_000);
  });

  it('⛔ A TURN THAT RECOVERED DOES NOT TELL THE NEXT TURN IT HALTED', async () => {
    // The transcript is replayed into the next turn's model context as history.
    // "(plan halted on failure)" beside four ✓ lines is both self-contradictory
    // and the exact history that makes a model plan defensively — the thing the
    // prompt edit was made to stop.
    const runs: ExecuteArgs[] = [];
    const seen: DecomposeArgs[] = [];
    const { runtime, sessions, seedId } = await makeRuntime({
      plans: [plan([NAV, TAP_GUESSED]), plan([TAP_SEEN, SHOT])],
      executor: scriptedExecutor({
        fails: (i) => (selectorOf(i) === '#guessed' ? notFound(i) : null),
        digest: 'x',
        runs,
      }),
      seen,
    });

    await runtime.runTurn({ agentSessionId: seedId, userMessage: 'add the mug' });
    const body = (await sessions.get(seedId))?.transcript.find(
      (e) => e.intents !== undefined,
    )?.body;
    expect(body).not.toContain('halted');
    // The failure is still on the record — a recovered turn is not a clean one.
    expect(body).toContain('✗');
    expect(body).toContain('carried on');
  });

  it('a turn that re-planned and STILL failed says halted, exactly as before', async () => {
    const runs: ExecuteArgs[] = [];
    const seen: DecomposeArgs[] = [];
    const { runtime, sessions, seedId } = await makeRuntime({
      plans: [plan([NAV, { ...TAP_GUESSED, selector: '#a' }]), plan([{ ...TAP_GUESSED }])],
      executor: scriptedExecutor({ fails: (i) => notFound(i), digest: 'x', runs }),
      seen,
    });

    await runtime.runTurn({ agentSessionId: seedId, userMessage: 'add the mug' });
    const body = (await sessions.get(seedId))?.transcript.find(
      (e) => e.intents !== undefined,
    )?.body;
    expect(body).toContain('(plan halted on failure)');
  });
});

describe('P1 — the turn-wide ceilings are ceilings over the TURN', () => {
  it('⛔ A MAXIMALLY RE-PLANNING TURN MAKES EXACTLY MAX_MODEL_CALLS_PER_TURN CALLS, read-back included', async () => {
    // The call ceiling used to count only plan calls, which made it the re-plan
    // ceiling wearing a different name — `modelCalls === 1 + replans`, so
    // `modelCalls < MAX - 1` and `replans < MAX_REPLANS_PER_TURN` were the same
    // inequality and nothing could tell them apart. The read-back is a provider
    // call and now counts as one, which is what makes this number a statement
    // about the turn's TOTAL cost rather than about the loop.
    const runs: ExecuteArgs[] = [];
    const seen: DecomposeArgs[] = [];
    let answers = 0;
    const sessions = new InMemoryAgentSessionsRepo(() => new Date('2026-09-17T00:00:00Z'));
    const seed = await sessions.create({ accountId: 'acc_1', tokenBudgetTotal: 100_000 });
    // ⛔ THE PLANS ARE DERIVED FROM THE CEILING, NOT LISTED. A fixed list of
    // three would keep this arm green if MAX_REPLANS_PER_TURN were raised — the
    // planner would simply run out of scripted plans — which is the one drift
    // the arm exists to catch. Instead: fail for exactly as many calls as the
    // re-plan ceiling allows, then succeed WITH a capture, so the turn makes the
    // most calls it is capable of making and then still reaches the read-back.
    //
    // MOVED 2026-09-18 (B1): the turn is a loop now, and the most calls a turn
    // can make is no longer "every re-plan" but "every SEGMENT": a planner that
    // keeps saying `continue`. So the maximal turn is driven that way — a
    // different, succeeding step per segment until the planner-call ceiling —
    // and the relation pinned is planner ceiling + read-back = model-call
    // ceiling. The re-plan ceiling keeps its own arm above.
    const planner = {
      decompose: (a: DecomposeArgs): Promise<DecomposeResult> => {
        seen.push(a);
        return Promise.resolve<DecomposeResult>({
          kind: 'plan',
          intents: [
            { kind: 'scroll', direction: 'down', amount_px: 100 * seen.length },
            ...(seen.length >= MAX_PLANNER_CALLS_PER_TURN ? [SHOT] : []),
          ],
          status: 'continue',
          tokensConsumed: 100,
        });
      },
    };
    const runtime = new AgentRuntime({
      decomposer: {
        ...planner,
        answerFromObservation: () => {
          answers += 1;
          return Promise.resolve({ answer: 'the price is 12', tokensConsumed: 40 });
        },
      },
      executor: {
        ...scriptedExecutor({ fails: () => null, digest: 'x', runs }),
        observe: () => Promise.resolve('Price: 12'),
      },
      sessions,
      archetype: 'iphone16pro_ios18_7_safari26_4',
    });

    const result = await runtime.runTurn({
      agentSessionId: seed.id,
      userMessage: 'open the page and tell me the price',
      byokApiKey: 'sk-ant-test-fake-key',
    });

    if (result.kind !== 'plan-executed') throw new Error('type narrow');
    // MAX_PLANNER_CALLS_PER_TURN plan calls + 1 read-back = MAX_MODEL_CALLS_PER_TURN.
    expect(seen).toHaveLength(MAX_PLANNER_CALLS_PER_TURN);
    // ⛔ THIS IS A FENCE, NOT A GATE. The call ceiling never binds first at
    // today's values, so there is no mutation of the conjunct that fails a test
    // — and saying it is a separately-enforced bound would be false. What this
    // pins is the RELATION: raise the re-plan ceiling, or add a call anywhere in
    // a turn, and this fails until the budget is re-derived against the new
    // worst case.
    expect(seen.length + answers).toBe(MAX_MODEL_CALLS_PER_TURN);
    // And the reserved last call really was the read-back's: the customer asked
    // a question and got an answer, not an apology.
    expect(result.answer).toBe('the price is 12');
    expect(result.readbackUnavailable).toBeUndefined();
  });

  it('⛔ ONE ELEMENT-WAIT CEILING FOR THE TURN — every run is handed the SAME budget object', async () => {
    // A budget built inside execute() is a per-RUN ceiling, and a turn now runs
    // up to three plans, so the documented per-turn patience would silently be
    // three times itself on exactly the turns that are already going badly.
    const runs: ExecuteArgs[] = [];
    const seen: DecomposeArgs[] = [];
    const { runtime, seedId } = await makeRuntime({
      plans: [plan([TAP_GUESSED]), plan([TAP_SEEN, SHOT])],
      executor: scriptedExecutor({
        fails: (i) => (selectorOf(i) === '#guessed' ? notFound(i) : null),
        digest: 'x',
        runs,
      }),
      seen,
    });

    await runtime.runTurn({ agentSessionId: seedId, userMessage: 'add the mug' });
    expect(runs).toHaveLength(2);
    expect(runs[0]?.elementWaitBudget).toBeDefined();
    expect(runs[1]?.elementWaitBudget).toBe(runs[0]?.elementWaitBudget);
  });
});

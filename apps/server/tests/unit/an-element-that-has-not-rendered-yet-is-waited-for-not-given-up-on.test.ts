// P3 — 800ms of patience against a control that renders at 2500ms.
//
// The measured death: `intent_element_not_found` is classified RETRYABLE, so the
// executor re-dispatched the same lookup twice at 400ms and reported "no element
// matched this selector" 1700ms before the element existed. The number is the
// whole finding, and it is not a transport number — it is a claim about how long
// a real page takes to render, made by a constant that was chosen for retrying a
// flaky dispatch.
//
// ⛔ WHY THESE ARMS ARE SHAPED THE WAY THEY ARE. A test that only asserted "the
// tap eventually succeeds" would pass against a fix that simply raised
// `maxRetries` to 50 — which is the wrong fix twice over: it spends 20 seconds on
// a page that will never render the element, and it hammers the device with
// lookups instead of asking it to wait. So every arm below asserts the SHAPE of
// the dispatch traffic as well as the outcome: exactly one wait, on the right
// selector, with the right budget, and nothing at all when the budget is spent.

import { describe, expect, it } from 'vitest';
import {
  ControlPlaneAgentExecutor,
  type IntentDispatcher,
} from '../../src/services/agent-executor-control-plane.js';
import type { AgentIntent } from '../../src/services/agent-decomposer.js';
import type { ElementWaitBudget } from '../../src/services/agent-executor.js';
import {
  decodeWireData,
  encodeWireData,
  parseIntentResult,
  type ParsedIntentResult,
} from '../../src/services/harness-control-codec.js';
import type {
  HarnessErrorCode,
  HarnessIntentName,
  IntentDispatch,
} from '../../src/schemas/harness-control-protocol.js';

interface Seen {
  intentName: HarnessIntentName;
  params: Record<string, unknown>;
}

/**
 * A device that knows exactly one thing: whether `#late` exists yet. It flips
 * when a `wait_for` is dispatched for it, which is what a real device does —
 * the wait returns when the element renders.
 *
 * ⛔ IT NEVER HAND-BUILDS A ParsedIntentResult. Every reply goes through
 * `parseIntentResult`, so a fiction that drifts from the wire contract fails
 * here instead of making an untested path look tested.
 */
function device(opts: {
  /** Selectors the page will NEVER have, whatever anyone waits for. */
  absent?: ReadonlySet<string>;
  seen: Seen[];
}): IntentDispatcher {
  let rendered = false;
  return {
    dispatch: (dispatch: IntentDispatch): Promise<ParsedIntentResult> => {
      const params = decodeWireData(dispatch.inputParams) as Record<string, unknown>;
      opts.seen.push({ intentName: dispatch.intentName, params });
      const fail = (errorCode: HarnessErrorCode): ParsedIntentResult =>
        parseIntentResult(
          {
            type: 'intentResult',
            sessionId: dispatch.sessionId,
            intentId: dispatch.intentId,
            success: false,
            durationMs: 1,
            errorCode,
          },
          dispatch.intentName,
        );
      if (dispatch.intentName === 'wait_for') {
        const predicate = readString(params, 'predicate');
        const forAbsent = [...(opts.absent ?? [])].some((s) => predicate.includes(s));
        if (forAbsent) return Promise.resolve(fail('intent_webdriver_failed'));
        rendered = true;
        return Promise.resolve(
          parseIntentResult(
            {
              type: 'intentResult',
              sessionId: dispatch.sessionId,
              intentId: dispatch.intentId,
              success: true,
              durationMs: 1,
              outputData: encodeWireData({ waited: true, timeout_capped: false }),
            },
            dispatch.intentName,
          ),
        );
      }
      if (dispatch.intentName === 'click') {
        const selector = readString(params, 'value');
        if ((opts.absent ?? new Set()).has(selector) || !rendered) {
          return Promise.resolve(fail('intent_element_not_found'));
        }
        return Promise.resolve(
          parseIntentResult(
            {
              type: 'intentResult',
              sessionId: dispatch.sessionId,
              intentId: dispatch.intentId,
              success: true,
              durationMs: 1,
              outputData: encodeWireData({
                clicked: selector,
                behavioral: true,
                activated: true,
              }),
            },
            dispatch.intentName,
          ),
        );
      }
      return Promise.resolve(fail('intent_not_implemented'));
    },
  };
}

/**
 * A page whose elements each render only once someone WAITS for that specific
 * selector — the realistic late-render shape, and the only shape that can
 * measure a run-wide ceiling.
 *
 * ⛔ WHY NOT `device({absent})`. There, a tap on a never-rendering element fails
 * with a non-wait failure and HALTS the plan, so the run spends exactly one wait
 * no matter what the ceiling is. A ceiling can only be observed on a run that
 * keeps going.
 */
function lateRenderingDevice(opts: { seen: Seen[] }): IntentDispatcher {
  const rendered = new Set<string>();
  return {
    dispatch: (dispatch: IntentDispatch): Promise<ParsedIntentResult> => {
      const params = decodeWireData(dispatch.inputParams) as Record<string, unknown>;
      opts.seen.push({ intentName: dispatch.intentName, params });
      const reply = (body: Record<string, unknown>): ParsedIntentResult =>
        parseIntentResult(
          {
            type: 'intentResult',
            sessionId: dispatch.sessionId,
            intentId: dispatch.intentId,
            success: true,
            durationMs: 1,
            outputData: encodeWireData(body),
          },
          dispatch.intentName,
        );
      if (dispatch.intentName === 'wait_for') {
        const predicate = readString(params, 'predicate');
        for (const selector of ['#a', '#b', '#c', '#d']) {
          if (predicate.includes(selector)) rendered.add(selector);
        }
        return Promise.resolve(reply({ waited: true, timeout_capped: false }));
      }
      const selector = readString(params, 'value');
      if (!rendered.has(selector)) {
        return Promise.resolve(
          parseIntentResult(
            {
              type: 'intentResult',
              sessionId: dispatch.sessionId,
              intentId: dispatch.intentId,
              success: false,
              durationMs: 1,
              errorCode: 'intent_element_not_found',
            },
            dispatch.intentName,
          ),
        );
      }
      return Promise.resolve(reply({ clicked: selector, behavioral: true, activated: true }));
    },
  };
}

const TAP_LATE: AgentIntent = { kind: 'interact', action: 'tap', selector: '#late' };

function executor(dispatcher: IntentDispatcher, opts: Record<string, unknown> = {}) {
  let n = 0;
  return new ControlPlaneAgentExecutor(dispatcher, () => `int_${String((n += 1))}`, {
    // No real sleeping: the thing under test is the WAIT budget, not wall clock.
    sleep: () => Promise.resolve(),
    ...opts,
  });
}

function run(exec: ControlPlaneAgentExecutor, intents: AgentIntent[]) {
  return exec.execute({
    sessionId: 'ses_1',
    agentSessionId: 'agt_1',
    plan: { kind: 'plan', intents, tokensConsumed: 0 },
  });
}

/**
 * Read a decoded wire param as a string.
 *
 * ⛔ NEVER `String(value)`. Params arrive from a base64 JSON decode, so a wrong
 * shape is possible, and stringifying an object hands the assertion
 * "[object Object]" as a selector or a secret — a confident value for an input
 * that was never valid.
 */
function readString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  return typeof value === 'string' ? value : '';
}

describe('P3 — an element that has not rendered yet is waited for, not given up on', () => {
  it('waits for the element and then succeeds, where the old budget reported it missing', async () => {
    const seen: Seen[] = [];
    const result = await run(executor(device({ seen })), [TAP_LATE]);

    expect(result.ok).toBe(true);
    expect(result.results[0]?.kind).toBe('success');
    // ⛔ THE SHAPE, not just the outcome. One failed lookup, ONE wait, one
    // successful lookup. A fix that just raised the retry count would show a
    // run of clicks here and no wait at all.
    expect(seen.map((s) => s.intentName)).toEqual(['click', 'wait_for', 'click']);
  });

  it('waits for the SELECTOR THAT FAILED, through the product mapper — not a hand-built predicate', async () => {
    const seen: Seen[] = [];
    await run(executor(device({ seen })), [TAP_LATE]);

    const wait = seen.find((s) => s.intentName === 'wait_for');
    expect(wait).toBeDefined();
    // The predicate is generated by `agentIntentToDispatch`, the same code path
    // the plan's own waits use. A second hand-written copy here would drift
    // from the mapper and start testing itself.
    expect(String(wait?.params.predicate)).toContain('#late');
    // 5s, from the LCP thresholds the constant is derived from — not 0, and not
    // the 400ms retry delay this budget must never be confused with.
    expect(wait?.params.timeout_seconds).toBe(5);
  });

  it('⛔ MUTATION ARM: with the element wait disabled, the SAME page fails — so the wait is what passes it', async () => {
    const seen: Seen[] = [];
    // `elementAppearWaitMs: 0` is the pre-P3 executor exactly: retry the lookup
    // on a fixed cadence and give up. If this arm ever passes, the assertion
    // above is being met by something other than the fix.
    const result = await run(executor(device({ seen }), { elementAppearWaitMs: 0 }), [TAP_LATE]);

    expect(result.ok).toBe(false);
    expect(result.results[0]).toMatchObject({
      kind: 'failure',
      diagnosis: { category: 'element_not_found' },
    });
    expect(seen.every((s) => s.intentName === 'click')).toBe(true);
  });

  it('an element that is genuinely absent still fails — and fails as ELEMENT NOT FOUND, not as a wait timeout', async () => {
    const seen: Seen[] = [];
    const result = await run(executor(device({ seen, absent: new Set(['#never']) })), [
      { kind: 'interact', action: 'tap', selector: '#never' },
    ]);

    expect(result.ok).toBe(false);
    // ⛔ THE REASON THE CUSTOMER SEES IS ABOUT THE SELECTOR. The wait is a
    // mechanism; renaming a missing element as "the wait condition was never
    // met" would move the customer's attention off the thing they can fix.
    expect(result.results[0]).toMatchObject({
      kind: 'failure',
      diagnosis: { category: 'element_not_found', retryable: true },
    });
    expect(String((result.results[0] as { reason: string }).reason)).toMatch(/no element/i);
  });

  it('a failed wait ends the step — it does not then spend the general retry budget re-asking', async () => {
    const seen: Seen[] = [];
    await run(executor(device({ seen, absent: new Set(['#never']) })), [
      { kind: 'interact', action: 'tap', selector: '#never' },
    ]);

    // One lookup, one wait, and stop. Re-polling after the page's own wait has
    // already timed out is latency with no possible new answer.
    expect(seen.map((s) => s.intentName)).toEqual(['click', 'wait_for']);
  });

  // ⛔ THE OLD PAIR OF CEILING ARMS COULD NOT FAIL, and the reason is worth
  // keeping: both used plans of taps against elements that NEVER render, so the
  // FIRST tap halted the plan on a non-wait failure and the run spent exactly
  // one wait whatever the ceiling was. Setting the budget to infinity left them
  // green. A ceiling can only be measured on a run that KEEPS GOING, so the
  // arms below use a page where each waited-for element does render: every step
  // then succeeds, the plan continues, and the waits accumulate until the
  // ceiling — and only the ceiling — stops them.
  it('⛔ THE RUN-WIDE CEILING HOLDS: patience does not multiply by plan length', async () => {
    const seen: Seen[] = [];
    // Four steps that each need their own wait. 15_000 / 5_000 = three waits for
    // the whole run, so the fourth step gets none and fails as it would have
    // before P3.
    const result = await run(executor(lateRenderingDevice({ seen })), [
      { kind: 'interact', action: 'tap', selector: '#a' },
      { kind: 'interact', action: 'tap', selector: '#b' },
      { kind: 'interact', action: 'tap', selector: '#c' },
      { kind: 'interact', action: 'tap', selector: '#d' },
    ]);

    expect(seen.filter((s) => s.intentName === 'wait_for')).toHaveLength(3);
    // The first three steps really did succeed — which is what makes the run
    // reach a fourth step at all, and what a halting plan could never show.
    expect(result.results.map((r) => r.kind)).toEqual(['success', 'success', 'success', 'failure']);
    expect(result.ok).toBe(false);
  });

  it('the ceiling is SPENDABLE and then spent — a smaller budget buys proportionally fewer waits', async () => {
    const seen: Seen[] = [];
    // Exactly one wait's worth. The second step gets none and fails, so the
    // number here tracks the CONFIGURED ceiling rather than the plan shape.
    const result = await run(
      executor(lateRenderingDevice({ seen }), { elementWaitRunBudgetMs: 5_000 }),
      [
        { kind: 'interact', action: 'tap', selector: '#a' },
        { kind: 'interact', action: 'tap', selector: '#b' },
      ],
    );

    expect(seen.filter((s) => s.intentName === 'wait_for')).toHaveLength(1);
    expect(result.results.map((r) => r.kind)).toEqual(['success', 'failure']);
  });

  it('⛔ ONE BUDGET SPANS THE WHOLE TURN — a second run does not get a fresh allowance', async () => {
    // P1 made a turn run up to three plans. A ceiling built inside execute()
    // would hand each of them a full 15s, so the documented per-turn number
    // would silently be three times itself. The runtime owns the budget and
    // threads it; this is that contract, at the seam where it is honoured.
    const seen: Seen[] = [];
    const exec = executor(lateRenderingDevice({ seen }));
    const shared: ElementWaitBudget = { remainingMs: null };
    const runWithShared = (selectors: string[]) =>
      exec.execute({
        sessionId: 'ses_1',
        agentSessionId: 'agt_1',
        elementWaitBudget: shared,
        plan: {
          kind: 'plan',
          intents: selectors.map((selector) => ({
            kind: 'interact' as const,
            action: 'tap' as const,
            selector,
          })),
          tokensConsumed: 0,
        },
      });

    await runWithShared(['#a', '#b']);
    // Seeded from the executor's own configured budget on first use — the
    // caller never has to know the number.
    expect(shared.remainingMs).toBe(5_000);
    const second = await runWithShared(['#c', '#d']);

    // Three waits across BOTH runs, not three per run.
    expect(seen.filter((s) => s.intentName === 'wait_for')).toHaveLength(3);
    expect(shared.remainingMs).toBe(0);
    expect(second.results.map((r) => r.kind)).toEqual(['success', 'failure']);
  });

  it('a verb with no selector never pays for a wait — the patience is per intent CLASS', async () => {
    const seen: Seen[] = [];
    // A navigate that fails cannot be fixed by waiting for an element; only
    // `interact` depends on one being present.
    await run(executor(device({ seen })), [{ kind: 'navigate', url: 'https://example.test/' }]);
    expect(seen.some((s) => s.intentName === 'wait_for')).toBe(false);
  });
});

describe('P3 — the ceiling is debited what the device is actually told to spend', () => {
  it('⛔ A SUB-SECOND SETTING DEBITS THE SECOND IT ACTUALLY BUYS, not the number configured', async () => {
    // `wait_for` takes whole SECONDS and the mapper rounds UP, so a 500ms
    // setting asks the device for a FULL second. Debiting the ceiling 500ms for
    // it would let a 15s ceiling buy 30 seconds of real waiting — the ceiling
    // would be a number about the config rather than about the page. Clamping
    // the setting to the smallest expressible wait makes the two agree.
    const seen: Seen[] = [];
    const exec = executor(device({ seen }), { elementAppearWaitMs: 500 });
    const budget: ElementWaitBudget = { remainingMs: null };
    await exec.execute({
      sessionId: 'ses_1',
      agentSessionId: 'agt_1',
      elementWaitBudget: budget,
      plan: { kind: 'plan', intents: [TAP_LATE], tokensConsumed: 0 },
    });

    const wait = seen.find((s) => s.intentName === 'wait_for');
    const secondsAsked = wait?.params.timeout_seconds;
    expect(secondsAsked).toBe(1);
    // ⛔ THE INVARIANT, stated as a relation between two independently-read
    // facts rather than against a literal: what the device was told, and what
    // the ceiling was charged. A test pinned to "500" would agree with the bug.
    expect(15_000 - (budget.remainingMs ?? 0)).toBe(Number(secondsAsked) * 1_000);
  });

  it('and zero still means disabled, not "one second"', async () => {
    const seen: Seen[] = [];
    await run(executor(device({ seen }), { elementAppearWaitMs: 0 }), [TAP_LATE]);
    expect(seen.some((s) => s.intentName === 'wait_for')).toBe(false);
  });
});

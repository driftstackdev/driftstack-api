// The scorer's own controls.
//
// An instrument without a positive control returns a confident number for the
// population it does not fit. `scoreTurn` is pure, so it can be fed synthetic
// turns whose correct verdict is known by construction: a turn that obviously
// succeeded must score `pass`, a turn that obviously died must score `fail` with
// the right `reasonClass`, and the safety halt must score `halt` rather than as
// a completion failure.

import { describe, expect, it } from 'vitest';
import {
  DRAWN_GAP_MAX_FACTOR,
  DRAWN_GAP_MIN_FACTOR,
} from '../../src/services/agent-executor-control-plane.js';
import { STOP_IN_FLIGHT_GRACE_MS } from '../../src/services/agent-executor.js';
import type { AgentIntent, FailureDiagnosis } from '@driftstack/api-types';
import type { IntentResult } from '../../src/services/agent-executor.js';
import { READBACK_MIN_BUDGET_TOKENS, READ_INTENT_RE } from '../../src/services/agent-runtime.js';
import type { DispatchRecord } from './_lib/fake-device.js';
import {
  aggregate,
  checkAnswerIsExtraction,
  misbehavingControls,
  scoreTurn,
  type EvalReport,
  type TaskReport,
  type TurnObservation,
} from './_lib/score.js';
import {
  EVAL_OBSERVE_TIMEOUT_MS,
  EVAL_RETRY_DELAY_MS,
  EVAL_SESSION_ESTABLISH_RETRY_DELAY_MS,
  EVAL_TOKEN_BUDGET,
  countsAsElapsedBrowsingTime,
} from './_lib/runner.js';
import { SCRIPTED_DECOMPOSE_TOKENS, type ObservedAnswerPath } from './_lib/scripted-decomposer.js';
import { answerFromPage } from './_lib/answer-rule.js';
import { EVAL_ANSWERER_CIRCULARITY, EVAL_EXECUTED_PLAN_IS_FIXED } from './_lib/provenance.js';
import type { EvalTask } from './_lib/tasks.js';

const NAVIGATE: AgentIntent = { kind: 'navigate', url: 'https://hello.test/' };
const CAPTURE: AgentIntent = { kind: 'capture', capture: 'screenshot' };
const TAP: AgentIntent = { kind: 'interact', action: 'tap', selector: '#x' };

function task(overrides: Partial<EvalTask> = {}): EvalTask {
  return {
    id: 'T',
    prompt: 'go to hello.test and tell me the greeting',
    pageScriptId: 'hello-test',
    startUrl: 'about:blank',
    expected: 'pass',
    criterion: { kind: 'answer_matches', pattern: /hello/i, label: 'hello' },
    answerRule: { kind: 'line_at', index: 0 },
    plan: [NAVIGATE, CAPTURE],
    rationale: 'synthetic',
    ...overrides,
  };
}

function dispatch(overrides: Partial<DispatchRecord> = {}): DispatchRecord {
  return {
    ordinal: 0,
    intentName: 'navigate',
    params: {},
    success: true,
    deviceMs: 100,
    // R11 — when on the injected clock. A synthetic record needs one too, or a
    // rhythm read off it would be about a timeline nobody set.
    atMs: 0,
    urlBefore: 'about:blank',
    urlAfter: 'https://hello.test/',
    ...overrides,
  };
}

/** The OBSERVED read-back facts. Defaults to "the answer path was never
 *  reached", which is what a synthetic turn with no answer really did. */
function answerPath(overrides: Partial<ObservedAnswerPath> = {}): ObservedAnswerPath {
  return {
    called: false,
    lastObservation: null,
    lastAnswer: null,
    lastRequest: null,
    providerError: null,
    ...overrides,
  };
}

function observation(overrides: Partial<TurnObservation> = {}): TurnObservation {
  const base: TurnObservation = {
    task: task(),
    plannerTier: 'scripted',
    turnKind: 'plan-executed',
    turn: null,
    turnError: null,
    results: [],
    awaitingConfirmation: false,
    executorOk: true,
    answer: null,
    observationText: null,
    dispatches: [],
    stepStartMarks: new Map(),
    stepEndMarks: new Map(),
    deviceFlags: new Set(),
    planIndexForResult: new Map(),
    resultsWithNoStartAnnounced: new Set(),
    indexSpaceAnomalies: [],
    modelCalls: { decompose: 1, answer: 0, decomposeTokens: 900, answerTokens: 0 },
    simulatedDeviceMs: 0,
    wallClockMs: 1,
    retryDelayMs: EVAL_RETRY_DELAY_MS,
    readbackGatesFailed: [],
    observedAnswerPath: answerPath(),
  };
  // `turn` is only read for its presence, so a minimal stand-in keeps these
  // fixtures readable without fabricating a whole session record.
  return { ...base, turn: { kind: 'plan-executed' } as TurnObservation['turn'], ...overrides };
}

const success = (intent: AgentIntent, summary: string): IntentResult => ({
  kind: 'success',
  intent,
  summary,
});

describe('agent eval — the scorer has its own controls', () => {
  it('POSITIVE CONTROL: a turn that obviously succeeded scores pass with no death', () => {
    const report = scoreTurn(
      observation({
        results: [
          success(NAVIGATE, 'navigated to https://hello.test/'),
          success(CAPTURE, 'captured screenshot'),
        ],
        answer: 'From the page: hello there',
        observationText: 'hello there',
        observedAnswerPath: answerPath({
          called: true,
          lastObservation: 'hello there',
          lastAnswer: 'From the page: hello there',
        }),
        dispatches: [dispatch(), dispatch({ ordinal: 1, intentName: 'screenshot' })],
        stepStartMarks: new Map([
          [0, 0],
          [1, 1],
        ]),
        stepEndMarks: new Map([
          [0, 1],
          [1, 2],
        ]),
      }),
    );
    expect(report.outcome).toBe('pass');
    expect(report.matchedExpectation).toBe(true);
    expect(report.diedAt).toBeNull();
    expect(report.criterion.met).toBe(true);
    expect(report.readback).toMatchObject({
      answerCallObserved: true,
      predictedEligible: true,
      crossCheckMismatch: null,
      answered: true,
      grounded: true,
    });
  });

  it('NEGATIVE CONTROL: a turn whose click was never found scores fail at the right step and reason', () => {
    const report = scoreTurn(
      observation({
        task: task({ expected: 'fail', criterion: { kind: 'device_flag', flag: 'never' } }),
        executorOk: false,
        results: [
          success(NAVIGATE, 'navigated to https://hello.test/'),
          {
            kind: 'failure',
            intent: TAP,
            reason: 'no element on the page matched this selector',
            diagnosis: { category: 'element_not_found', retryable: true },
          },
        ],
        dispatches: [
          dispatch(),
          dispatch({
            ordinal: 1,
            intentName: 'click',
            success: false,
            errorCode: 'intent_element_not_found',
            deviceMs: 30,
          }),
          dispatch({
            ordinal: 2,
            intentName: 'click',
            success: false,
            errorCode: 'intent_element_not_found',
            deviceMs: 30,
          }),
          dispatch({
            ordinal: 3,
            intentName: 'click',
            success: false,
            errorCode: 'intent_element_not_found',
            deviceMs: 30,
          }),
        ],
        stepStartMarks: new Map([
          [0, 0],
          [1, 1],
        ]),
        stepEndMarks: new Map([
          [0, 1],
          [1, 4],
        ]),
        readbackGatesFailed: ['executor_not_ok'],
      }),
    );
    expect(report.outcome).toBe('fail');
    expect(report.diedAt).toMatchObject({
      index: 1,
      phase: 'dispatch',
      harnessIntentName: 'click',
      harnessErrorCode: 'intent_element_not_found',
      reasonClass: 'element_never_appeared_in_retry_budget',
    });
    // Three attempts means two backoffs. The retry budget IS the finding, so the
    // number has to be right: 90ms of device work plus 800ms of waiting.
    expect(report.steps[1]).toMatchObject({
      attempts: 3,
      simulatedMs: 90 + 2 * EVAL_RETRY_DELAY_MS,
    });
  });

  it('a safety halt scores halt — never a completion failure', () => {
    const report = scoreTurn(
      observation({
        task: task({
          expected: 'halt',
          criterion: { kind: 'halted_for_confirmation' },
          plan: [NAVIGATE, TAP],
        }),
        executorOk: false,
        awaitingConfirmation: true,
        results: [
          success(NAVIGATE, 'navigated to https://hello.test/'),
          {
            kind: 'confirmation_required',
            intent: TAP,
            category: 'purchase',
            matchedText: 'buy now',
          },
        ],
        dispatches: [dispatch()],
        stepStartMarks: new Map([[0, 0]]),
        stepEndMarks: new Map([
          [0, 1],
          [1, 1],
        ]),
        readbackGatesFailed: ['executor_not_ok'],
      }),
    );
    expect(report.outcome).toBe('halt');
    expect(report.matchedExpectation).toBe(true);
    expect(report.criterion.met).toBe(true);
    expect(report.diedAt?.reasonClass).toBe('halted_for_confirmation');
    expect(report.steps[1]?.attempts).toBe(0);
  });

  it('a halt that dispatched the action anyway is NOT scored as a halt that worked', () => {
    // The gate is only a gate if nothing was sent. If the dispatch count for the
    // halted step is non-zero, the criterion must refuse.
    const report = scoreTurn(
      observation({
        task: task({
          expected: 'halt',
          criterion: { kind: 'halted_for_confirmation' },
          plan: [NAVIGATE, TAP],
        }),
        executorOk: false,
        awaitingConfirmation: true,
        results: [
          success(NAVIGATE, 'navigated'),
          {
            kind: 'confirmation_required',
            intent: TAP,
            category: 'purchase',
            matchedText: 'buy now',
          },
        ],
        dispatches: [dispatch(), dispatch({ ordinal: 1, intentName: 'click' })],
        stepStartMarks: new Map([
          [0, 0],
          [1, 1],
        ]),
        stepEndMarks: new Map([
          [0, 1],
          [1, 2],
        ]),
      }),
    );
    expect(report.criterion.met).toBe(false);
  });

  it('⛔ H3: a halt whose step HAS no start mark is still judged on the dispatch log', () => {
    // THE DISCRIMINATING CASE, AND THE ONE THE OLD CRITERION PASSED. The
    // consequential gate reports its result before announcing the step, so the
    // halted step has no start mark and `attempts` is 0 BY CONSTRUCTION — it
    // reads 0 whatever the device did. Here the device DID receive the click:
    // the dispatch log grew by one after the previous step finished and that
    // dispatch carries the refused target. The old criterion asked the attempt
    // count and saw its construction-zero; this one asks the log.
    const dispatchedAnyway = scoreTurn(
      observation({
        task: task({
          expected: 'halt',
          criterion: { kind: 'halted_for_confirmation' },
          plan: [NAVIGATE, TAP],
        }),
        executorOk: false,
        awaitingConfirmation: true,
        results: [
          success(NAVIGATE, 'navigated'),
          { kind: 'confirmation_required', intent: TAP, category: 'purchase', matchedText: 'buy' },
        ],
        dispatches: [
          dispatch(),
          dispatch({ ordinal: 1, intentName: 'click', params: { selector: '#x' } }),
        ],
        // Exactly what StepMarkTracker writes for a result with no start: start
        // equals end, so the subtraction yields zero.
        resultsWithNoStartAnnounced: new Set([1]),
        stepStartMarks: new Map([
          [0, 0],
          [1, 2],
        ]),
        stepEndMarks: new Map([
          [0, 1],
          [1, 2],
        ]),
      }),
    );
    expect(dispatchedAnyway.steps[1]?.attempts).toBe(0);
    expect(dispatchedAnyway.steps[1]?.startAnnounced).toBe(false);
    expect(
      dispatchedAnyway.criterion.met,
      'the purchase reached the device and the criterion still said the gate held',
    ).toBe(false);
    expect(dispatchedAnyway.criterion.actual).toContain('the dispatch log grew by 1');
    expect(dispatchedAnyway.criterion.actual).toContain('1 dispatches in the whole run carried');

    // POSITIVE TWIN: identical shape, nothing sent. Without it, the check above
    // is also satisfied by a criterion that refuses everything.
    const heldTheLine = scoreTurn(
      observation({
        task: task({
          expected: 'halt',
          criterion: { kind: 'halted_for_confirmation' },
          plan: [NAVIGATE, TAP],
        }),
        executorOk: false,
        awaitingConfirmation: true,
        results: [
          success(NAVIGATE, 'navigated'),
          { kind: 'confirmation_required', intent: TAP, category: 'purchase', matchedText: 'buy' },
        ],
        dispatches: [dispatch()],
        resultsWithNoStartAnnounced: new Set([1]),
        stepStartMarks: new Map([
          [0, 0],
          [1, 1],
        ]),
        stepEndMarks: new Map([
          [0, 1],
          [1, 1],
        ]),
      }),
    );
    expect(heldTheLine.criterion.met).toBe(true);
    expect(heldTheLine.outcome).toBe('halt');
    expect(heldTheLine.criterion.actual).toContain('announced no start for this step');
  });

  it("⛔ the halt's target scan does not filter on the VERB, and says so when it has nothing to read", () => {
    // ⛔ THE BELT-AND-BRACES PAIR DEGRADED TO ONE READING EXACTLY WHEN A MAPPING
    // CHANGE WAS THE THING THAT BROKE THE GATE. The run-wide scan used to
    // require `d.intentName === mappedName`, so a refused selector that went out
    // under ANOTHER verb read as "0 dispatches in the whole run carried its
    // target" — corroboration from a reading that looked in one place. Here the
    // log does not grow around the halt, so the FIRST reading is satisfied and
    // only the second can refuse: under the old filter this scored as a halt
    // that held.
    const wentOutAsAnotherVerb = scoreTurn(
      observation({
        task: task({
          expected: 'halt',
          criterion: { kind: 'halted_for_confirmation' },
          plan: [NAVIGATE, TAP],
        }),
        executorOk: false,
        awaitingConfirmation: true,
        results: [
          success(NAVIGATE, 'navigated'),
          { kind: 'confirmation_required', intent: TAP, category: 'purchase', matchedText: 'buy' },
        ],
        dispatches: [
          dispatch({ intentName: 'send_keys', params: { selector: '#x', value: '\n' } }),
        ],
        resultsWithNoStartAnnounced: new Set([1]),
        stepStartMarks: new Map([
          [0, 0],
          [1, 1],
        ]),
        stepEndMarks: new Map([
          [0, 1],
          [1, 1],
        ]),
      }),
    );
    expect(
      wentOutAsAnotherVerb.criterion.met,
      'the refused selector reached the device under another verb and the criterion said the gate held',
    ).toBe(false);
    // And the verb is REPORTED, which is all it was ever good for.
    expect(wentOutAsAnotherVerb.criterion.actual).toContain('as send_keys');

    // ⛔ AND A HALT WITH NOTHING TO SCAN FOR SAYS SO INSTEAD OF PRINTING A ZERO.
    // `target` is null for any consequential intent that declares no selector,
    // and the old code returned 0 there, which the verdict rendered as "0
    // dispatches in the whole run carried its target (none declared)" — a
    // measurement that measured nothing, reading as corroboration.
    const noTargetToScanFor = scoreTurn(
      observation({
        task: task({
          expected: 'halt',
          criterion: { kind: 'halted_for_confirmation' },
          plan: [NAVIGATE, NAVIGATE],
        }),
        executorOk: false,
        awaitingConfirmation: true,
        results: [
          success(NAVIGATE, 'navigated'),
          {
            kind: 'confirmation_required',
            intent: { kind: 'navigate', url: 'https://shop.test/pay' },
            category: 'purchase',
            matchedText: 'pay',
          },
        ],
        dispatches: [dispatch()],
        resultsWithNoStartAnnounced: new Set([1]),
        stepStartMarks: new Map([
          [0, 0],
          [1, 1],
        ]),
        stepEndMarks: new Map([
          [0, 1],
          [1, 1],
        ]),
      }),
    );
    // The halt still holds on the reading that WAS available — the gate is not
    // at fault for the intent's shape — but the verdict names the missing one.
    expect(noTargetToScanFor.criterion.met).toBe(true);
    expect(noTargetToScanFor.criterion.actual).toContain('second reading was UNAVAILABLE');
    expect(noTargetToScanFor.criterion.actual).not.toContain('0 dispatches in the whole run');
  });

  it('⛔ H2: an answer that is the whole page fails, even though it CONTAINS the wanted text', () => {
    // The criterion is a containment test, so every superset used to pass — an
    // extractor that returned the page verbatim scored as a success, which is
    // the exact failure the read-back exists to prevent. Both halves are checked
    // here: the dump is refused, and an extraction off the SAME page is not.
    const page = [
      'Pricing',
      'Compare plans',
      'Starter — $29 per month',
      'Team — $89 per month',
    ].join('\n');
    const priced = task({
      expected: 'pass',
      criterion: { kind: 'answer_matches', pattern: /\$29/, label: '$29' },
    });
    const dumped = scoreTurn(
      observation({
        task: priced,
        results: [success(NAVIGATE, 'navigated'), success(CAPTURE, 'captured screenshot')],
        answer: page,
        observationText: page,
        observedAnswerPath: answerPath({ called: true, lastObservation: page, lastAnswer: page }),
        dispatches: [dispatch(), dispatch({ ordinal: 1, intentName: 'screenshot' })],
        stepStartMarks: new Map([
          [0, 0],
          [1, 1],
        ]),
        stepEndMarks: new Map([
          [0, 1],
          [1, 2],
        ]),
      }),
    );
    expect(dumped.criterion.met).toBe(false);
    expect(dumped.outcome).toBe('fail');
    expect(dumped.diedAt?.reasonClass).toBe('answer_was_not_an_extraction');
    expect(dumped.answerExtraction?.isExtraction).toBe(false);
    expect(dumped.answerExtraction?.quotedLines).toBe(4);
    // ⛔ AND THE VERDICT SAYS WHICH HALF REFUSED. "no answer" and "the answer was
    // the page" are different findings with different owners.
    expect(dumped.criterion.actual).toContain('REFUSED');

    const extracted = scoreTurn(
      observation({
        task: priced,
        results: [success(NAVIGATE, 'navigated'), success(CAPTURE, 'captured screenshot')],
        answer: 'From the page: Starter — $29 per month',
        observationText: page,
        observedAnswerPath: answerPath({ called: true, lastObservation: page }),
        dispatches: [dispatch(), dispatch({ ordinal: 1, intentName: 'screenshot' })],
        stepStartMarks: new Map([
          [0, 0],
          [1, 1],
        ]),
        stepEndMarks: new Map([
          [0, 1],
          [1, 2],
        ]),
      }),
    );
    expect(extracted.criterion.met).toBe(true);
    expect(extracted.answerExtraction).toMatchObject({
      isExtraction: true,
      quotedLines: 1,
      observationLines: 4,
    });

    // AND THE UNMEASURABLE CASE FAILS RATHER THAN PASSES. An answer with no
    // recorded observation cannot be shown to have come off the page at all, and
    // a quiet `true` there would delete the bound exactly when it matters.
    const noObservation = checkAnswerIsExtraction('From the page: $29', null);
    expect(noObservation.isExtraction).toBe(false);
    expect(noObservation.why).toContain('no observation was recorded');
  });

  it('⛔ H2: a dump that RE-WRAPS the page quotes no line verbatim and is still refused', () => {
    // ⛔ THE SHAPE A REAL MODEL ANSWERER PRODUCES, AND THE ONE VERBATIM
    // CONTAINMENT CANNOT SEE. The first version of this bound refused only a
    // byte-exact dump, and its only control was a control built to be
    // byte-exact — a detector retrodicted over a population of one that was
    // written to satisfy it. Re-wrap the same page and every line containment
    // reading goes to zero while the answer is still the page.
    const page = [
      'Pricing',
      'Compare plans',
      'Starter — $29 per month',
      'Team — $89 per month',
    ].join('\n');
    // Every word of the page, re-wrapped and re-cased: not one observed line
    // appears verbatim inside it, so the containment reading sees nothing.
    const reWrapped =
      'The page lists pricing, a compare plans link, Starter at $29 per month, and Team at $89 per month.';
    const rewrapped = checkAnswerIsExtraction(reWrapped, page);
    expect(rewrapped.quotedLines, 'the verbatim reading must see nothing here').toBe(0);
    expect(
      rewrapped.isExtraction,
      `a re-wrapped page scored as an extraction: ${rewrapped.why}`,
    ).toBe(false);
    expect(rewrapped.why).toContain('whole vocabulary');

    // PAIRED POSITIVE, SAME PAGE: a real extraction must still be accepted, or
    // the reading above is just a refusal that fires on everything.
    const extracted = checkAnswerIsExtraction('From the page: Starter — $29 per month', page);
    expect(extracted.isExtraction, extracted.why).toBe(true);
    expect(extracted.wordShare).toBeLessThan(0.8);
  });

  it('⛔ H2: a nested or duplicated page line does not count twice against the bound', () => {
    // ⛔ THE FALSE-REFUSAL DIRECTION, ON THE CHECK WHOSE WHOLE JOB IS TO BE
    // TRUSTED. Counting raw lines, a page carrying a short label and a longer
    // line containing it scored TWO hits for a single quotation — one more
    // nesting and a correct one-line answer is refused as
    // `answer_was_not_an_extraction`, arriving as a mystery red on a new page
    // fixture. The observation's lines are deduped and nested lines dropped.
    const nested = ['Deals', 'Deals — 40% off everything in stock', 'Deals', 'Cart: empty'].join(
      '\n',
    );
    const oneLine = checkAnswerIsExtraction(
      'From the page: Deals — 40% off everything in stock',
      nested,
    );
    expect(oneLine.observationLines, 'the duplicate and the nested label are one line').toBe(2);
    expect(oneLine.quotedLines).toBe(1);
    expect(oneLine.isExtraction, oneLine.why).toBe(true);
  });

  it('⛔ H2: a ONE-LINE observation is accepted and SAYS it could not discriminate', () => {
    // A deliberate, written-down decision rather than a silent pass. On a
    // one-line page the only possible extraction IS the page, so refusing would
    // block a correct answer for a property of the fixture — and a confident
    // `isExtraction: true` with no caveat is how a detector reports on a
    // population it cannot judge. It reports `discrimination: 'none'` instead,
    // and the suite asserts no task's verdict currently rests on one.
    const single = checkAnswerIsExtraction('From the page: void.test', 'void.test');
    expect(single.isExtraction).toBe(true);
    expect(single.discrimination).toBe('none');
    expect(single.why).toContain('NOT DISCRIMINATED');

    // And a two-line observation says how far it can see, too.
    const twoLine = checkAnswerIsExtraction(
      'From the page: Good morning, traveller',
      'hello.test\nGood morning, traveller',
    );
    expect(twoLine.isExtraction).toBe(true);
    expect(twoLine.discrimination).toBe('reduced');
    // The dump of that same two-line page is what that branch CAN see.
    const twoLineDump = checkAnswerIsExtraction(
      'hello.test\nGood morning, traveller',
      'hello.test\nGood morning, traveller',
    );
    expect(twoLineDump.isExtraction, twoLineDump.why).toBe(false);
  });

  it('a selector the mapper refused dies at MAPPING with zero dispatches', () => {
    const playwright: AgentIntent = {
      kind: 'interact',
      action: 'tap',
      selector: "button:has-text('Sign up')",
    };
    const report = scoreTurn(
      observation({
        task: task({ expected: 'fail', plan: [NAVIGATE, playwright] }),
        executorOk: false,
        results: [
          success(NAVIGATE, 'navigated'),
          {
            kind: 'failure',
            intent: playwright,
            reason: 'interact:tap ":has-text" is not a CSS pseudo-class',
          },
        ],
        dispatches: [dispatch()],
        stepStartMarks: new Map([
          [0, 0],
          [1, 1],
        ]),
        stepEndMarks: new Map([
          [0, 1],
          [1, 1],
        ]),
        readbackGatesFailed: ['executor_not_ok'],
      }),
    );
    expect(report.steps[1]).toMatchObject({
      outcome: 'not_mapped',
      harnessIntentName: null,
      attempts: 0,
    });
    expect(report.diedAt).toMatchObject({
      phase: 'mapping',
      reasonClass: 'selector_rejected_before_dispatch',
    });
  });

  it('distinguishes an honest absence from a blocked read-back — "it did not answer" has different causes', () => {
    const plan = [NAVIGATE, CAPTURE];
    const absent = scoreTurn(
      observation({
        task: task({ expected: 'fail', plan }),
        results: [success(NAVIGATE, 'navigated'), success(CAPTURE, 'captured screenshot')],
        // ⛔ Built by a PAGE RULE, not by the criterion. The rule asks for a line
        // that is not on this page, so the answerer refuses — and the refusal
        // must not satisfy /hello/i.
        answer: answerFromPage(
          { kind: 'line_starting_with', prefix: 'Greeting:' },
          'nothing relevant here',
        ),
        observationText: 'nothing relevant here',
        observedAnswerPath: answerPath({ called: true, lastObservation: 'nothing relevant here' }),
        dispatches: [dispatch(), dispatch({ ordinal: 1, intentName: 'screenshot' })],
        stepStartMarks: new Map([
          [0, 0],
          [1, 1],
        ]),
        stepEndMarks: new Map([
          [0, 1],
          [1, 2],
        ]),
      }),
    );
    expect(absent.diedAt?.reasonClass).toBe('answer_not_grounded');
    expect(absent.readback.grounded).toBe(false);
    expect(absent.criterion.met).toBe(false);

    const gated = scoreTurn(
      observation({
        task: task({ expected: 'fail', plan }),
        results: [success(NAVIGATE, 'navigated'), success(CAPTURE, 'captured screenshot')],
        answer: null,
        dispatches: [dispatch(), dispatch({ ordinal: 1, intentName: 'screenshot' })],
        stepStartMarks: new Map([
          [0, 0],
          [1, 1],
        ]),
        stepEndMarks: new Map([
          [0, 1],
          [1, 2],
        ]),
        readbackGatesFailed: ['not_read_intent'],
      }),
    );
    expect(gated.diedAt?.reasonClass).toBe('readback_gate_blocked');
    expect(gated.readback.predictedGatesFailed).toEqual(['not_read_intent']);
    expect(gated.readback.answerCallObserved).toBe(false);
    expect(gated.readback.crossCheckMismatch).toBeNull();
  });

  it('⛔ a read-back that WAS reached and produced nothing is not filed as a gate', () => {
    // "No answer came back" has two very different causes and the same shape.
    // The observed call is what separates them: a gate stopped the turn before
    // the answer path, or the answer path ran and failed. Filing the second as
    // the first sends whoever reads the report to the wrong code.
    const reachedButSilent = scoreTurn(
      observation({
        task: task({ expected: 'fail' }),
        results: [success(NAVIGATE, 'navigated'), success(CAPTURE, 'captured screenshot')],
        answer: null,
        observationText: 'some page text',
        dispatches: [dispatch(), dispatch({ ordinal: 1, intentName: 'screenshot' })],
        stepStartMarks: new Map([
          [0, 0],
          [1, 1],
        ]),
        stepEndMarks: new Map([
          [0, 1],
          [1, 2],
        ]),
        observedAnswerPath: answerPath({
          called: true,
          lastObservation: 'some page text',
          providerError: 'the answer path threw',
        }),
      }),
    );
    expect(reachedButSilent.diedAt?.reasonClass).toBe('answer_path_failed_after_being_reached');
    expect(reachedButSilent.readback.answerPathError).toBe('the answer path threw');
  });

  it('⛔ the conjunct model and the observed call DISAGREEING is reported, never smoothed over', () => {
    // When two instruments disagree neither is trustworthy until one is shown
    // wrong. The scorer's job here is to say so, not to pick a winner.
    const predictedBlockedButRan = scoreTurn(
      observation({
        results: [success(NAVIGATE, 'navigated'), success(CAPTURE, 'captured screenshot')],
        answer: 'From the page: hello there',
        observationText: 'hello there',
        readbackGatesFailed: ['not_read_intent'],
        observedAnswerPath: answerPath({ called: true, lastObservation: 'hello there' }),
      }),
    );
    expect(predictedBlockedButRan.readback.crossCheckMismatch).toContain(
      'names a gate that is not real',
    );

    const predictedEligibleButSilent = scoreTurn(
      observation({
        results: [success(NAVIGATE, 'navigated'), success(CAPTURE, 'captured screenshot')],
        answer: null,
        readbackGatesFailed: [],
      }),
    );
    expect(predictedEligibleButSilent.readback.crossCheckMismatch).toContain(
      'never called answerFromObservation',
    );
  });

  it('R2: human beats are read off the RUN — a plan that LISTS them but never ran them FAILS', () => {
    // ⛔ THE DISCRIMINATING CASE. `human_beats_present` used to count
    // `obs.task.plan` — the hand-written input — so both conjuncts were
    // constants and the criterion was measuring what we typed. Here the PLAN
    // contains a pause and a scroll, the executor reports ok, and the dispatch
    // log contains neither. The old expression scored this PASS; the corrected
    // one must score it FAIL.
    const PAUSE: AgentIntent = { kind: 'behavioral_pause', reading_word_count: 40 };
    const SCROLL: AgentIntent = { kind: 'scroll', direction: 'down', amount_px: 700 };
    const listedButNotRun = scoreTurn(
      observation({
        task: task({
          expected: 'pass',
          criterion: { kind: 'human_beats_present' },
          plan: [NAVIGATE, PAUSE, SCROLL, CAPTURE],
        }),
        executorOk: true,
        results: [success(NAVIGATE, 'navigated'), success(CAPTURE, 'captured screenshot')],
        dispatches: [dispatch(), dispatch({ ordinal: 1, intentName: 'screenshot' })],
        stepStartMarks: new Map([
          [0, 0],
          [1, 1],
        ]),
        stepEndMarks: new Map([
          [0, 1],
          [1, 2],
        ]),
      }),
    );
    expect(listedButNotRun.criterion.met).toBe(false);
    expect(listedButNotRun.criterion.actual).toContain('dispatched pauses=0');
    expect(listedButNotRun.criterion.actual).toContain('dispatched scrolls=0');

    // POSITIVE TWIN: the same plan, with the beats actually dispatched.
    const actuallyRun = scoreTurn(
      observation({
        task: task({
          expected: 'pass',
          criterion: { kind: 'human_beats_present' },
          plan: [NAVIGATE, PAUSE, SCROLL, CAPTURE],
        }),
        executorOk: true,
        results: [success(NAVIGATE, 'navigated'), success(CAPTURE, 'captured screenshot')],
        dispatches: [
          dispatch(),
          dispatch({ ordinal: 1, intentName: 'behavioral_pause' }),
          dispatch({ ordinal: 2, intentName: 'scroll' }),
          dispatch({ ordinal: 3, intentName: 'screenshot' }),
        ],
        stepStartMarks: new Map([
          [0, 0],
          [1, 1],
        ]),
        stepEndMarks: new Map([
          [0, 1],
          [1, 4],
        ]),
      }),
    );
    expect(actuallyRun.criterion.met).toBe(true);

    // AND A FAILED SCROLL IS NOT A SCROLL. A dispatch the device refused must
    // not count as a human beat the customer got.
    const refusedScroll = scoreTurn(
      observation({
        task: task({
          expected: 'pass',
          criterion: { kind: 'human_beats_present' },
          plan: [NAVIGATE, PAUSE, SCROLL, CAPTURE],
        }),
        executorOk: true,
        results: [success(NAVIGATE, 'navigated'), success(CAPTURE, 'captured screenshot')],
        dispatches: [
          dispatch(),
          dispatch({ ordinal: 1, intentName: 'behavioral_pause' }),
          dispatch({ ordinal: 2, intentName: 'scroll', success: false }),
          dispatch({ ordinal: 3, intentName: 'screenshot' }),
        ],
        stepStartMarks: new Map([
          [0, 0],
          [1, 1],
        ]),
        stepEndMarks: new Map([
          [0, 1],
          [1, 4],
        ]),
      }),
    );
    expect(refusedScroll.criterion.met).toBe(false);
  });

  it('R7: a step whose start mark is missing reports ZERO attempts, never a borrowed count', () => {
    // The old fallback chain read `stepStartMarks.get(i) ?? stepEndMarks.get(i-1)
    // ?? 0`, so a missing start silently borrowed the previous step's end and
    // still produced a confident attempt count — across two different index
    // spaces. A missing mark must now read as nothing measured.
    const missingStart = scoreTurn(
      observation({
        task: task({ expected: 'fail', criterion: { kind: 'device_flag', flag: 'never' } }),
        results: [success(NAVIGATE, 'navigated'), success(CAPTURE, 'captured screenshot')],
        dispatches: [dispatch(), dispatch({ ordinal: 1, intentName: 'screenshot' })],
        stepStartMarks: new Map([[0, 0]]),
        stepEndMarks: new Map([
          [0, 1],
          [1, 2],
        ]),
      }),
    );
    expect(missingStart.steps[1]?.attempts).toBe(0);
    expect(missingStart.steps[1]?.simulatedMs).toBe(0);
  });

  it('⛔ the honest-absence sentence never satisfies the criterion it is refusing', () => {
    // MEASURED, NOT ASSUMED. The first version of the answerer said "I could not
    // find 65% off on the page" — which CONTAINS "65% off", so the criterion's
    // own pattern matched the refusal and the task scored PASS while the agent
    // had correctly reported the information as missing. An instrument that
    // reads its own words back returns a confident number for the population it
    // does not fit, so every answer-shaped criterion is checked here.
    for (const criterion of [
      { kind: 'answer_matches' as const, pattern: /65%\s?off/i, label: '65% off' },
      { kind: 'answer_matches' as const, pattern: /\$29/, label: '$29' },
      { kind: 'answer_matches' as const, pattern: /\b4\b/, label: '4 unread' },
      { kind: 'answer_matches' as const, pattern: /2024 units/i, label: 'only the 2024 units' },
      { kind: 'answer_matches' as const, pattern: /Quietkey 7/i, label: 'Quietkey 7 …' },
    ]) {
      const refusal = answerFromPage(
        { kind: 'line_starting_with', prefix: 'A line this page does not have' },
        'an unrelated page',
      );
      expect(
        criterion.pattern.test(refusal),
        `"${refusal}" matched ${String(criterion.pattern)}`,
      ).toBe(false);
    }
  });

  it('a green navigate onto a page that never loaded is NOT scored as progress', () => {
    const report = scoreTurn(
      observation({
        task: task({ expected: 'fail', criterion: { kind: 'device_flag', flag: 'never' } }),
        results: [
          success(NAVIGATE, 'navigated to https://hang.test/ (page never finished loading)'),
          success(CAPTURE, 'captured screenshot'),
        ],
        dispatches: [dispatch(), dispatch({ ordinal: 1, intentName: 'screenshot' })],
        stepStartMarks: new Map([
          [0, 0],
          [1, 1],
        ]),
        stepEndMarks: new Map([
          [0, 1],
          [1, 2],
        ]),
      }),
    );
    expect(report.outcome).toBe('fail');
    expect(report.diedAt?.reasonClass).toBe('navigated_but_page_never_loaded');
  });

  it('the completion rate excludes halts from its denominator', () => {
    const pass = scoreTurn(
      observation({
        results: [success(NAVIGATE, 'navigated'), success(CAPTURE, 'captured screenshot')],
        answer: 'hello',
        observationText: 'hello',
        observedAnswerPath: answerPath({ called: true, lastObservation: 'hello' }),
      }),
    );
    const halt = scoreTurn(
      observation({
        task: task({ id: 'H', expected: 'halt', criterion: { kind: 'halted_for_confirmation' } }),
        awaitingConfirmation: true,
        executorOk: false,
        results: [
          {
            kind: 'confirmation_required',
            intent: TAP,
            category: 'purchase',
            matchedText: 'buy now',
          },
        ],
      }),
    );
    const report = aggregate({
      runId: 'r',
      startedAt: 'now',
      gitSha: 'x',
      provenance: {
        headline: 'a synthetic scorer control, not a measurement of anything',
        measures: 'nothing — this is a scorer control',
        cannotMeasure: 'anything about the agent, the planner or the answerer',
        executedPlanIsFixed: EVAL_EXECUTED_PLAN_IS_FIXED,
        answererCircularity: EVAL_ANSWERER_CIRCULARITY,
        answerQualityMeasured: false,
        plannerMode: 'scripted',
        plannerDescription: 'synthetic',
        answererMode: 'page_rule_via_product_answer_path',
        answererDescription: 'synthetic',
        decomposeSystemPromptSha256: null,
        decomposeSystemPromptNote: 'synthetic turn; no request is built',
        answerSystemPromptSha256: null,
      },
      corpus: [pass, halt],
      controls: [],
      wallClockMs: 1,
    });
    // One pass, one halt: the rate is 1/1, not 1/2. Scoring a safety halt as a
    // miss would create pressure to weaken the gate.
    expect(report.totals.scriptedPlanCompletionRate).toBe(1);
    expect(report.totals.halted).toBe(1);
  });

  it('⛔ a control that fails for the WRONG REASON is reported as misbehaving', () => {
    // ⛔ THE RUN-LEVEL HEALTH LINE USED TO COMPARE OUTCOMES ONLY, so a negative
    // control that stopped controlling for its own defect still rendered green
    // in the banner. Not hypothetical: C-NEG's death moved from
    // `element_never_appeared_in_retry_budget` to `element_click_intercepted` —
    // a page with NO elements at all reporting an intercepted click — and the
    // controls line stayed healthy while only a per-task baseline arm caught it.
    // "It still failed" is not the same fact as "it failed because the element
    // was absent", and the second is the one the control exists for.
    const negativeTask = task({
      id: 'C-NEG',
      control: 'negative',
      expected: 'fail',
      criterion: { kind: 'device_flag', flag: 'never' },
      plan: [NAVIGATE, TAP],
    });
    const scoredWith = (
      diagnosis: FailureDiagnosis,
      errorCode: 'intent_element_not_found' | 'intent_webdriver_failed',
    ): TaskReport =>
      scoreTurn(
        observation({
          task: negativeTask,
          executorOk: false,
          results: [
            success(NAVIGATE, 'navigated'),
            {
              kind: 'failure',
              intent: TAP,
              reason: 'the click did not land',
              diagnosis,
            },
          ],
          dispatches: [
            dispatch(),
            dispatch({ ordinal: 1, intentName: 'click', success: false, errorCode }),
          ],
          stepStartMarks: new Map([
            [0, 0],
            [1, 1],
          ]),
          stepEndMarks: new Map([
            [0, 1],
            [1, 2],
          ]),
          readbackGatesFailed: ['executor_not_ok'],
        }),
      );
    const provenance = {
      headline: 'a synthetic scorer control, not a measurement of anything',
      measures: 'nothing — this is a scorer control',
      cannotMeasure: 'anything about the agent, the planner or the answerer',
      executedPlanIsFixed: EVAL_EXECUTED_PLAN_IS_FIXED,
      answererCircularity: EVAL_ANSWERER_CIRCULARITY,
      answerQualityMeasured: false as const,
      plannerMode: 'scripted' as const,
      plannerDescription: 'synthetic',
      answererMode: 'page_rule_via_product_answer_path' as const,
      answererDescription: 'synthetic',
      decomposeSystemPromptSha256: null,
      decomposeSystemPromptNote: 'synthetic turn; no request is built',
      answerSystemPromptSha256: null,
    };
    const aggregateWith = (control: TaskReport): EvalReport =>
      aggregate({
        runId: 'r',
        startedAt: 'now',
        gitSha: 'x',
        provenance,
        corpus: [],
        controls: [control],
        wallClockMs: 1,
      });

    // FOR THE RIGHT REASON: the control is healthy, and the only thing that can
    // be said about the run's other numbers is said.
    const rightReason = aggregateWith(
      scoredWith({ category: 'element_not_found', retryable: true }, 'intent_element_not_found'),
    );
    expect(rightReason.controls.negative).toBe('fail');
    expect(misbehavingControls(rightReason).filter((m) => m.startsWith('negative:'))).toEqual([]);

    // FOR THE WRONG REASON: same outcome, different fact, and it must be named.
    const wrongReason = aggregateWith(
      scoredWith({ category: 'unknown', retryable: false }, 'intent_webdriver_failed'),
    );
    expect(wrongReason.controls.negative, 'the outcome is unchanged — that is the point').toBe(
      'fail',
    );
    const complaints = misbehavingControls(wrongReason).filter((m) => m.startsWith('negative:'));
    expect(complaints.length, 'a control that stopped controlling must not read as healthy').toBe(
      1,
    );
    expect(complaints[0]).toContain('WRONG REASON');
    expect(complaints[0]).toContain('element_click_intercepted');
  });

  it('R9 the clock classifies sleeps by EXCLUSION now, because a drawn gap has no exact value', () => {
    // ⛔ THIS ARM USED TO GUARD THE OPPOSITE PROPERTY, and the property it
    // guarded stopped existing. The clock used to count a sleep when its
    // duration was one of two exact constants, which was sound only while the
    // three configured budgets differed — so this asserted they did. R9 draws
    // the retry gaps, so NO exact value identifies one, and an inclusion list
    // would have matched nothing while continuing to report a number. The
    // classification is an exclusion now, and this is its test.
    //
    // A drawn retry gap counts, at both ends of its band and in between.
    for (const gap of [
      Math.round(EVAL_RETRY_DELAY_MS * DRAWN_GAP_MIN_FACTOR),
      EVAL_RETRY_DELAY_MS,
      Math.round(EVAL_RETRY_DELAY_MS * DRAWN_GAP_MAX_FACTOR),
      Math.round(EVAL_SESSION_ESTABLISH_RETRY_DELAY_MS * DRAWN_GAP_MIN_FACTOR),
      Math.round(EVAL_SESSION_ESTABLISH_RETRY_DELAY_MS * DRAWN_GAP_MAX_FACTOR),
    ]) {
      expect(countsAsElapsedBrowsingTime(gap), `${String(gap)}ms is real elapsed time`).toBe(true);
    }
    // The two race timers do not: they measure how long we are willing to wait.
    expect(countsAsElapsedBrowsingTime(EVAL_OBSERVE_TIMEOUT_MS)).toBe(false);
    expect(countsAsElapsedBrowsingTime(STOP_IN_FLIGHT_GRACE_MS)).toBe(false);
    // ⛔ AND THE EXCLUSION IS STILL ONLY SOUND WHILE NO DRAWN GAP CAN LAND ON
    // ONE OF THOSE TWO VALUES. That is the residual the old arm was really
    // about, restated against the new mechanism.
    for (const base of [EVAL_RETRY_DELAY_MS, EVAL_SESSION_ESTABLISH_RETRY_DELAY_MS]) {
      expect(Math.round(base * DRAWN_GAP_MAX_FACTOR)).toBeLessThan(STOP_IN_FLIGHT_GRACE_MS);
      expect(Math.round(base * DRAWN_GAP_MAX_FACTOR)).toBeLessThan(EVAL_OBSERVE_TIMEOUT_MS);
    }
  });

  it('the read-back gate constants are IMPORTED from the runtime, not copied here', () => {
    // If these ever drift, the report names the wrong gate while looking healthy.
    expect(READBACK_MIN_BUDGET_TOKENS).toBe(6_000);
    expect(EVAL_TOKEN_BUDGET - SCRIPTED_DECOMPOSE_TOKENS).toBeGreaterThan(
      READBACK_MIN_BUDGET_TOKENS,
    );
    expect(READ_INTENT_RE.test('tell me the price')).toBe(true);
    expect(READ_INTENT_RE.test('take a screenshot')).toBe(false);
  });
});

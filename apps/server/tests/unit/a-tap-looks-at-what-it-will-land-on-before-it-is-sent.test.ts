// THE LOOK BEFORE A TAP.
//
// A native tap activates WHATEVER IS UNDER THE TAP POINT. When a cookie banner,
// a dialog or a sticky bar covers the control a plan named, the tap lands on the
// cover — not on what the plan asked for — and nothing about the selector says
// so. So before every tap the executor asks the device (one read-only
// `perceive` for the tap's own selector) what the selector resolves to and what
// its hit test finds at the tap point, and:
//
//   · covered              → the tap is NOT sent; the step fails `element_covered`
//                            in the page's own words, and may be re-planned
//   · nothing resolves     → the element wait runs first (a late control is
//                            waited for); if it gives up, the step fails
//                            not-found, unsent. With no wait to spend, the tap
//                            goes ahead so the click's own retries still apply
//   · outside the viewport → the tap goes ahead (the click scrolls first); never
//                            called "covered"
//   · no usable answer     → the tap goes ahead exactly as before the look
//                            existed: an error, a timeout (once the abandoned look
//                            has left the device), an older device (asked once
//                            per session), a hit test that found nothing
//   · typing               → looked at the same way: it begins with a tap on the
//                            field; the look carries the locator, never the text
//   · the gate             → also reads what the device calls the element and
//                            what is at its tap point; it can only ADD halts, and
//                            an approval for one kind never releases another
//   · the repeat guard     → is handed the device's canonical selector
//
// Every branch here is written so that removing the behaviour fails it.

import { describe, expect, it } from 'vitest';
import type { AgentIntent } from '@driftstack/api-types';
import {
  ControlPlaneAgentExecutor,
  type AutoRetryOptions,
  type IntentDispatcher,
} from '../../src/services/agent-executor-control-plane.js';
import type { ExecuteArgs, ExecutorRunResult } from '../../src/services/agent-executor.js';
import {
  elementCoveredReason,
  intentResultToCustomer,
  LEGACY_ELEMENT_COVERED_MESSAGE_PREFIX,
} from '../../src/services/agent-intent-result.js';
import {
  decodeWireData,
  encodeWireData,
  parseIntentResult,
  type ParsedIntentResult,
} from '../../src/services/harness-control-codec.js';
import {
  HARNESS_ERROR_CODES,
  HARNESS_INTENT_PARAM_SCHEMAS,
  HARNESS_INTENT_RESULT_SCHEMAS,
  type IntentDispatch,
} from '../../src/schemas/harness-control-protocol.js';
import { MetricsRegistry, METRIC_NAMES } from '../../src/services/metrics-registry.js';
import {
  classifyStepFailure,
  PRE_TAP_LOOK_DURATION_BUCKETS_SECONDS,
  PRE_TAP_LOOK_OUTCOMES,
} from '../../src/services/agent-turn-telemetry.js';
import {
  isReplannableFailure,
  repeatRefusedAtTarget,
  sameSiteEffect,
} from '../../src/services/agent-runtime.js';

// ── a device that answers the look however a test says ─────────────────

interface ElementShape {
  type?: string;
  label?: string;
  selector?: string;
  visible?: boolean;
  width?: number;
  occluded?: boolean;
  occlusion_reason?: string | null;
  hit?: { type: string; label: string; selector: string } | null;
}

/** A perceive-by-selector answer, as a device that knows the new fields sends it. */
function lookAnswer(element: ElementShape | null): Record<string, unknown> {
  const bounds = { x: 10, y: 100, width: element?.width ?? 120, height: 40 };
  return {
    value: {
      url: 'https://shop.test/',
      title: 'Shop',
      elements:
        element === null
          ? []
          : [
              {
                id: 0,
                type: element.type ?? 'button',
                label: element.label ?? 'Continue',
                selector: element.selector ?? '#go',
                bounds,
                state: { visible: element.visible ?? true, enabled: true, focused: false },
                position_summary: 'in view',
                tap_point: { x: 70, y: 120 },
                hit:
                  element.hit === undefined
                    ? {
                        type: element.type ?? 'button',
                        label: element.label ?? 'Continue',
                        selector: element.selector ?? '#go',
                        bounds,
                      }
                    : element.hit === null
                      ? null
                      : { ...element.hit, bounds },
                occluded: element.occluded ?? false,
                occlusion_reason: element.occlusion_reason ?? null,
              },
            ],
      truncated: false,
      total_matched: element === null ? 0 : 1,
      resolved_by: 'script',
    },
  };
}

/** What a device from before the look answers: its page listing, no new fields. */
const OLDER_DEVICE_LISTING = {
  value: {
    url: 'https://shop.test/',
    title: 'Shop',
    elements: [
      {
        id: 0,
        type: 'button',
        label: 'Continue',
        selector: '#go',
        bounds: { x: 0, y: 0, width: 10, height: 10 },
        state: { visible: true, enabled: true, focused: false },
        position_summary: 'in view',
      },
    ],
    truncated: false,
    total_matched: 1,
  },
};

type PerceiveReply =
  | { kind: 'answer'; output: Record<string, unknown>; durationMs?: number }
  | { kind: 'error'; code: (typeof HARNESS_ERROR_CODES)[number] }
  /** Never answers — only Stop can end the wait for it. */
  | { kind: 'hang' }
  /** Answers when the test calls `releaseLateLooks()` — a look slower than
   *  its deadline, which (like every dispatch) settles in the end. */
  | { kind: 'late'; output: Record<string, unknown> };

/**
 * Every frame goes through the REAL codec (`parseIntentResult`), so an answer
 * shape the protocol schema would refuse fails here too — the test cannot hand
 * the executor something the wire never could.
 *
 * ⛔ ONE INTENT AT A TIME, as the device runs them: a dispatch that arrives
 * while an earlier one is still running is refused `session_intent_in_flight`
 * (the device's HarnessCoordinator does exactly this). A device that accepted
 * two at once could not show what an abandoned look does to the tap after it.
 */
function scriptedDevice(
  perceive: (params: Record<string, unknown>, call: number) => PerceiveReply,
  opts: { waitFor?: 'appears' | 'never'; clickNotFoundTimes?: number } = {},
): {
  dispatcher: IntentDispatcher;
  sent: Array<{ name: string; params: Record<string, unknown> }>;
  refusedInFlight: () => number;
  releaseLateLooks: () => void;
} {
  const sent: Array<{ name: string; params: Record<string, unknown> }> = [];
  let perceives = 0;
  let clicks = 0;
  let running = 0;
  let refused = 0;
  const lateLooks: Array<() => void> = [];
  const frame = (d: IntentDispatch, output: unknown, durationMs = 7): ParsedIntentResult =>
    parseIntentResult(
      {
        type: 'intentResult',
        sessionId: d.sessionId,
        intentId: d.intentId,
        success: true,
        durationMs,
        outputData: encodeWireData(output),
      },
      d.intentName,
    );
  const failure = (d: IntentDispatch, code: string, message?: string): ParsedIntentResult =>
    parseIntentResult(
      {
        type: 'intentResult',
        sessionId: d.sessionId,
        intentId: d.intentId,
        success: false,
        durationMs: 5,
        errorCode: code,
        ...(message !== undefined ? { errorMessage: message } : {}),
      },
      d.intentName,
    );
  const answer = (
    d: IntentDispatch,
    params: Record<string, unknown>,
  ): Promise<ParsedIntentResult> => {
    switch (d.intentName) {
      case 'perceive': {
        perceives += 1;
        const reply = perceive(params, perceives);
        if (reply.kind === 'hang') return new Promise<ParsedIntentResult>(() => undefined);
        if (reply.kind === 'late') {
          return new Promise<ParsedIntentResult>((resolve) => {
            lateLooks.push(() => resolve(frame(d, reply.output)));
          });
        }
        if (reply.kind === 'error') return Promise.resolve(failure(d, reply.code));
        return Promise.resolve(frame(d, reply.output, reply.durationMs));
      }
      case 'click':
        clicks += 1;
        if (clicks <= (opts.clickNotFoundTimes ?? 0)) {
          return Promise.resolve(failure(d, 'intent_element_not_found'));
        }
        return Promise.resolve(
          frame(d, { clicked: String(params.value), behavioral: true, activated: true }),
        );
      case 'send_keys':
        return Promise.resolve(
          frame(d, {
            typed_into: String(params.value),
            length: String(params.text).length,
            truncated: false,
            behavioral: true,
          }),
        );
      case 'wait_for':
        return Promise.resolve(
          opts.waitFor === 'appears'
            ? frame(d, { waited: true, timeout_capped: false })
            : failure(d, 'intent_webdriver_failed', '#late never became visible'),
        );
      case 'navigate':
        return Promise.resolve(frame(d, { url: String(params.url) }));
      default:
        return Promise.resolve(failure(d, 'intent_not_implemented'));
    }
  };
  return {
    sent,
    refusedInFlight: () => refused,
    releaseLateLooks: () => {
      for (const release of lateLooks.splice(0)) release();
    },
    dispatcher: {
      dispatch: (d: IntentDispatch): Promise<ParsedIntentResult> => {
        const params = decodeWireData(d.inputParams) as Record<string, unknown>;
        sent.push({ name: d.intentName, params });
        if (running > 0) {
          refused += 1;
          return Promise.resolve(failure(d, 'session_intent_in_flight'));
        }
        running += 1;
        return answer(d, params).finally(() => {
          running -= 1;
        });
      },
    },
  };
}

/** A deadline the test fires by hand, so "timed out" is a decision, not a race. */
function manualDeadline(): {
  deadline: NonNullable<AutoRetryOptions['deadline']>;
  fire: () => void;
  cancelled: () => number;
} {
  const pending: Array<() => void> = [];
  let cancels = 0;
  return {
    deadline: () => {
      let resolve: () => void = () => undefined;
      const elapsed = new Promise<void>((r) => {
        resolve = r;
      });
      pending.push(resolve);
      return {
        elapsed,
        cancel: () => {
          cancels += 1;
        },
      };
    },
    fire: () => {
      for (const resolve of pending.splice(0)) resolve();
    },
    cancelled: () => cancels,
  };
}

const TAP: AgentIntent = { kind: 'interact', action: 'tap', selector: '#go' };

function executor(dispatcher: IntentDispatcher, opts: AutoRetryOptions = {}) {
  let n = 0;
  return new ControlPlaneAgentExecutor(dispatcher, () => `int_${String((n += 1))}`, {
    sleep: () => Promise.resolve(),
    ...opts,
  });
}

function run(
  exec: ControlPlaneAgentExecutor,
  intents: AgentIntent[],
  extra: Partial<ExecuteArgs> = {},
): Promise<ExecutorRunResult> {
  return exec.execute({
    sessionId: 'ses_look',
    plan: { kind: 'plan', intents, tokensConsumed: 0 },
    ...extra,
  });
}

function names(sent: Array<{ name: string }>): string[] {
  return sent.map((s) => s.name);
}

/** Words a customer must never read in a step's reason. */
const INTERNAL_WORDS = /occlu|perceive|elementfrompoint|hit test|harness|vantage|observer|fleet/i;

// ── the verdicts ──────────────────────────────────────────────────────

describe('the look before a tap — what it sends', () => {
  it('asks about exactly the selector the click will carry, in perceive’s strategy words, then taps', async () => {
    const device = scriptedDevice(() => ({ kind: 'answer', output: lookAnswer({}) }));
    const res = await run(executor(device.dispatcher), [TAP]);
    expect(res.ok).toBe(true);
    expect(names(device.sent)).toEqual(['perceive', 'click']);
    const [look, click] = device.sent;
    // The same locator the click receives — so both resolve the same element.
    // `max_elements: 1` is ignored by a device that resolves the selector; it
    // caps the page listing an older device answers with instead.
    expect(look?.params).toEqual({ selector: '#go', strategy: 'css', max_elements: 1 });
    expect(click?.params).toEqual({ strategy: 'css selector', value: '#go' });
    expect(look?.params.selector).toBe(click?.params.value);
  });

  it('⛔ never sends a typed value — a tap whose label is a saved credential looks with its selector only', async () => {
    const SECRET = 'hunter2-correct-horse';
    const device = scriptedDevice(() => ({ kind: 'answer', output: lookAnswer({}) }));
    await run(
      executor(device.dispatcher),
      [{ kind: 'interact', action: 'tap', selector: '#go', value: '{{credential:password}}' }],
      { credentials: { username: 'a@b.test', password: SECRET } },
    );
    const look = device.sent.find((s) => s.name === 'perceive');
    expect(look).toBeDefined();
    expect(Object.keys(look?.params ?? {}).sort()).toEqual([
      'max_elements',
      'selector',
      'strategy',
    ]);
    expect(JSON.stringify(look?.params)).not.toContain(SECRET);
    expect(JSON.stringify(look?.params)).not.toContain('credential');
  });

  it('TYPING is looked at too — its first act on the device is a tap on the field — with the locator only', async () => {
    const SECRET = 'hunter2-correct-horse';
    const device = scriptedDevice(() => ({
      kind: 'answer',
      output: lookAnswer({ type: 'input', label: 'Password', selector: '#password' }),
    }));
    const res = await run(
      executor(device.dispatcher),
      [
        {
          kind: 'interact',
          action: 'type',
          selector: '#password',
          value: '{{credential:password}}',
        },
      ],
      { credentials: { username: 'a@b.test', password: SECRET } },
    );
    expect(res.ok).toBe(true);
    expect(names(device.sent)).toEqual(['perceive', 'send_keys']);
    const [look, typed] = device.sent;
    expect(look?.params).toEqual({ selector: '#password', strategy: 'css', max_elements: 1 });
    expect(look?.params.selector).toBe(typed?.params.value);
    // The text rides on send_keys alone.
    expect(JSON.stringify(look?.params)).not.toContain(SECRET);
    expect(typed?.params.text).toBe(SECRET);
  });

  it('a COVERED field is neither tapped nor typed into — a saved password included', async () => {
    const SECRET = 'hunter2-correct-horse';
    const device = scriptedDevice(() => ({
      kind: 'answer',
      output: lookAnswer({
        type: 'input',
        label: 'Password',
        selector: '#password',
        occluded: true,
        occlusion_reason: 'hit_is_not_target_or_descendant',
        hit: { type: 'button', label: 'Accept all cookies', selector: '#consent-accept' },
      }),
    }));
    const res = await run(
      executor(device.dispatcher),
      [
        {
          kind: 'interact',
          action: 'type',
          selector: '#password',
          value: '{{credential:password}}',
        },
      ],
      { credentials: { username: 'a@b.test', password: SECRET } },
    );
    expect(names(device.sent)).toEqual(['perceive']);
    expect(JSON.stringify(device.sent)).not.toContain(SECRET);
    const step = res.results[0];
    if (step?.kind !== 'failure') throw new Error('expected a failure');
    expect(step.diagnosis).toEqual({ category: 'element_covered', retryable: false });
    expect(step.reason).toBe(
      '“Accept all cookies” is covering this field, so nothing was typed — it may need to be closed or dismissed first',
    );
    expect(JSON.stringify(step)).not.toContain(SECRET);
  });

  it('is sent only for a TAP — typing, pressing and scrolling are not looked at', async () => {
    const device = scriptedDevice(() => ({ kind: 'answer', output: lookAnswer({}) }));
    await run(executor(device.dispatcher), [{ kind: 'interact', action: 'press', value: 'Enter' }]);
    expect(names(device.sent)).not.toContain('perceive');
  });

  it('can be turned off (0), which restores exactly the old wire', async () => {
    const device = scriptedDevice(() => ({ kind: 'answer', output: lookAnswer({}) }));
    await run(executor(device.dispatcher, { preTapLookTimeoutMs: 0 }), [TAP]);
    expect(names(device.sent)).toEqual(['click']);
  });
});

describe('the look before a tap — clear, covered, not found', () => {
  it('CLEAR: the tap point is on the control → the tap is sent', async () => {
    const device = scriptedDevice(() => ({ kind: 'answer', output: lookAnswer({}) }));
    const res = await run(executor(device.dispatcher), [TAP]);
    expect(res.results[0]?.kind).toBe('success');
    expect(names(device.sent)).toContain('click');
  });

  it('COVERED, with a name: NOT tapped; fails element_covered naming what is on top', async () => {
    const device = scriptedDevice(() => ({
      kind: 'answer',
      output: lookAnswer({
        occluded: true,
        occlusion_reason: 'hit_is_not_target_or_descendant',
        hit: { type: 'other', label: 'We use cookies. Accept all', selector: '#cookie-banner' },
      }),
    }));
    const res = await run(executor(device.dispatcher), [
      TAP,
      { kind: 'capture', capture: 'screenshot' },
    ]);
    expect(names(device.sent)).toEqual(['perceive']);
    const step = res.results[0];
    expect(step?.kind).toBe('failure');
    if (step?.kind !== 'failure') throw new Error('narrow');
    expect(step.diagnosis).toEqual({ category: 'element_covered', retryable: false });
    expect(step.reason).toContain('“We use cookies. Accept all” is covering this button');
    expect(step.reason).toContain('nothing was tapped');
    expect(step.reason).not.toMatch(INTERNAL_WORDS);
    // The plan halts there — the screenshot after it never ran.
    expect(res.results).toHaveLength(1);
    expect(res.ok).toBe(false);
  });

  it('COVERED, with no name: still not tapped, and says so without inventing one', async () => {
    const device = scriptedDevice(() => ({
      kind: 'answer',
      output: lookAnswer({
        occluded: true,
        occlusion_reason: 'covered_at_enclosing_shadow_level',
        hit: { type: 'other', label: '', selector: 'div:nth-of-type(9)' },
      }),
    }));
    const res = await run(executor(device.dispatcher), [TAP]);
    expect(names(device.sent)).toEqual(['perceive']);
    const step = res.results[0];
    if (step?.kind !== 'failure') throw new Error('expected a failure');
    expect(step.diagnosis?.category).toBe('element_covered');
    expect(step.reason).toBe(
      'something on the page is covering this button, so nothing was tapped — it may need to be closed or dismissed first',
    );
  });

  it('COVERED is re-plannable (nothing happened), where a coarse click failure is not', () => {
    const covered: ExecutorRunResult = {
      ok: false,
      results: [
        {
          kind: 'failure',
          intent: TAP,
          reason: elementCoveredReason('Accept all'),
          diagnosis: { category: 'element_covered', retryable: false },
        },
      ],
    };
    expect(isReplannableFailure(covered)).toBe(true);
    const outcomeUnknown: ExecutorRunResult = {
      ok: false,
      results: [
        {
          kind: 'failure',
          intent: TAP,
          reason: 'x',
          diagnosis: { category: 'unknown', retryable: false },
        },
      ],
    };
    expect(isReplannableFailure(outcomeUnknown)).toBe(false);
  });

  it('a covered step is filed under the death class the device’s own "intercepted" used', () => {
    expect(
      classifyStepFailure({
        kind: 'failure',
        intent: TAP,
        reason: elementCoveredReason(),
        diagnosis: { category: 'element_covered', retryable: false },
      }),
    ).toBe('element_click_intercepted');
  });

  it('NOTHING RESOLVES: the element wait runs first, then the step fails not-found with no tap', async () => {
    const device = scriptedDevice(() => ({ kind: 'answer', output: lookAnswer(null) }), {
      waitFor: 'never',
    });
    const res = await run(executor(device.dispatcher), [TAP]);
    // Looked, waited for it once, gave up — and never sent the click.
    expect(names(device.sent)).toEqual(['perceive', 'wait_for']);
    const step = res.results[0];
    if (step?.kind !== 'failure') throw new Error('expected a failure');
    expect(step.diagnosis).toEqual({ category: 'element_not_found', retryable: true });
    expect(step.reason).toBe('no element on the page matched this selector');
  });

  it('NOTHING RESOLVES YET: a control that renders late is waited for, looked at again, and tapped', async () => {
    const device = scriptedDevice(
      (_params, call) =>
        call === 1
          ? { kind: 'answer', output: lookAnswer(null) }
          : { kind: 'answer', output: lookAnswer({}) },
      { waitFor: 'appears' },
    );
    const res = await run(executor(device.dispatcher), [TAP]);
    expect(res.ok).toBe(true);
    expect(names(device.sent)).toEqual(['perceive', 'wait_for', 'perceive', 'click']);
  });

  it('NOTHING RESOLVES and no wait is left in the turn’s budget: the tap goes ahead, and the click’s own retries still apply', async () => {
    // Before the look, this click came back element-not-found (retryable) and
    // was retried; failing it unsent would take that chance away from a control
    // that is still arriving. Here it arrives in time for the first retry.
    const device = scriptedDevice(() => ({ kind: 'answer', output: lookAnswer(null) }), {
      clickNotFoundTimes: 1,
    });
    const res = await run(executor(device.dispatcher), [TAP], {
      elementWaitBudget: { remainingMs: 0 },
    });
    expect(names(device.sent)).toEqual(['perceive', 'click', 'click']);
    expect(res.ok).toBe(true);
  });

  it('the wait says it APPEARED yet the second look still finds nothing: the tap goes ahead, with no second wait', async () => {
    const device = scriptedDevice(() => ({ kind: 'answer', output: lookAnswer(null) }), {
      waitFor: 'appears',
    });
    const res = await run(executor(device.dispatcher), [TAP]);
    expect(names(device.sent)).toEqual(['perceive', 'wait_for', 'perceive', 'click']);
    expect(res.ok).toBe(true);
  });
});

describe('the look before a tap — the answers that are NOT a reason to withhold a tap', () => {
  it('OUTSIDE THE VIEWPORT: the tap goes ahead (the click scrolls first) and is never called covered', async () => {
    const device = scriptedDevice(() => ({
      kind: 'answer',
      output: lookAnswer({
        occluded: true,
        occlusion_reason: 'tap_point_outside_viewport',
        hit: null,
      }),
    }));
    const res = await run(executor(device.dispatcher), [TAP]);
    expect(names(device.sent)).toEqual(['perceive', 'click']);
    expect(res.results[0]?.kind).toBe('success');
  });

  it('NOTHING HIT: no evidence either way, so the tap goes ahead', async () => {
    const device = scriptedDevice(() => ({
      kind: 'answer',
      output: lookAnswer({ occluded: true, occlusion_reason: 'nothing_hit', hit: null }),
    }));
    const res = await run(executor(device.dispatcher), [TAP]);
    expect(names(device.sent)).toEqual(['perceive', 'click']);
    expect(res.ok).toBe(true);
  });

  it('A HIDDEN CONTROL is not "covered": its empty rect puts the tap point on the page', async () => {
    // The device reads occluded for an element that is not rendered. Called
    // "covered", the customer would be told a banner is in the way of a
    // collapsed menu's link. It goes ahead and fails as it always has.
    const device = scriptedDevice(() => ({
      kind: 'answer',
      output: lookAnswer({
        visible: false,
        width: 0,
        occluded: true,
        occlusion_reason: 'hit_is_not_target_or_descendant',
        hit: { type: 'other', label: 'Big page header', selector: 'body' },
      }),
    }));
    await run(executor(device.dispatcher), [TAP]);
    expect(names(device.sent)).toEqual(['perceive', 'click']);
  });

  it('A HIT ON THE CONTROL’S OWN LABEL is the control: a styled checkbox is tapped through its label', async () => {
    // The input is drawn by its <label>; the tap point lands on the label (or a
    // span inside it), and a tap there toggles the input — as it always did.
    const device = scriptedDevice(() => ({
      kind: 'answer',
      output: lookAnswer({
        type: 'checkbox',
        label: 'I agree to the terms',
        selector: '#terms',
        occluded: true,
        occlusion_reason: 'hit_is_not_target_or_descendant',
        hit: {
          type: 'other',
          label: 'I agree to the terms',
          selector: 'form > label:nth-of-type(1)',
        },
      }),
    }));
    const res = await run(executor(device.dispatcher), [
      { kind: 'interact', action: 'tap', selector: '#terms' },
    ]);
    expect(names(device.sent)).toEqual(['perceive', 'click']);
    expect(res.ok).toBe(true);
  });

  it('…but a CONTROL on top that happens to share the name is still a cover', async () => {
    const device = scriptedDevice(() => ({
      kind: 'answer',
      output: lookAnswer({
        type: 'checkbox',
        label: 'I agree to the terms',
        selector: '#terms',
        occluded: true,
        occlusion_reason: 'hit_is_not_target_or_descendant',
        hit: { type: 'button', label: 'I agree to the terms', selector: '#modal-agree' },
      }),
    }));
    await run(executor(device.dispatcher), [
      { kind: 'interact', action: 'tap', selector: '#terms' },
    ]);
    expect(names(device.sent)).toEqual(['perceive']);
  });

  it('a hit on an ANCESTOR is not quoted as the cover — its name is the whole section’s text', async () => {
    const device = scriptedDevice(() => ({
      kind: 'answer',
      output: lookAnswer({
        label: 'Subscribe',
        selector: 'main > form:nth-of-type(1) > button:nth-of-type(1)',
        occluded: true,
        occlusion_reason: 'hit_is_not_target_or_descendant',
        hit: {
          type: 'other',
          label: 'Sign up for our newsletter Email Subscribe',
          selector: 'main > form:nth-of-type(1)',
        },
      }),
    }));
    const res = await run(executor(device.dispatcher), [
      { kind: 'interact', action: 'tap', selector: 'form button' },
    ]);
    expect(names(device.sent)).toEqual(['perceive']);
    const step = res.results[0];
    if (step?.kind !== 'failure') throw new Error('expected a failure');
    expect(step.reason).toBe(
      'something on the page is covering this button, so nothing was tapped — it may need to be closed or dismissed first',
    );
  });

  it('AN OLDER DEVICE ignores the selector and lists the page: the tap goes ahead as before', async () => {
    const device = scriptedDevice(() => ({ kind: 'answer', output: OLDER_DEVICE_LISTING }));
    const res = await run(executor(device.dispatcher), [TAP]);
    expect(names(device.sent)).toEqual(['perceive', 'click']);
    expect(res.ok).toBe(true);
  });

  it('AN OLDER DEVICE is asked ONCE per session: every later tap there skips the look', async () => {
    const device = scriptedDevice(() => ({ kind: 'answer', output: OLDER_DEVICE_LISTING }));
    const exec = executor(device.dispatcher);
    await run(exec, [TAP, { kind: 'interact', action: 'tap', selector: '#next' }]);
    expect(names(device.sent)).toEqual(['perceive', 'click', 'click']);
    await run(exec, [TAP]);
    expect(names(device.sent)).toEqual(['perceive', 'click', 'click', 'click']);
    // Another session's device is still asked.
    await exec.execute({
      sessionId: 'ses_other',
      plan: { kind: 'plan', intents: [TAP], tokensConsumed: 0 },
    });
    expect(names(device.sent).slice(4)).toEqual(['perceive', 'click']);
  });

  it('a look that merely FAILED is not taken as an older device: the next tap looks again', async () => {
    const device = scriptedDevice(() => ({ kind: 'error', code: 'intent_invalid_parameter' }));
    await run(executor(device.dispatcher), [TAP, TAP]);
    expect(names(device.sent)).toEqual(['perceive', 'click', 'perceive', 'click']);
  });

  it('AN OLDER DEVICE on a page with no controls lists NOTHING — which is not "nothing resolves"', async () => {
    // Without `resolved_by` an empty listing is an answer about the PAGE, not
    // about this selector; read as not-found it would withhold a tap the old
    // device would have made.
    const empty = {
      value: {
        url: 'https://shop.test/',
        title: 'Shop',
        elements: [],
        truncated: false,
        total_matched: 0,
      },
    };
    const device = scriptedDevice(() => ({ kind: 'answer', output: empty }));
    const res = await run(executor(device.dispatcher), [TAP]);
    expect(names(device.sent)).toEqual(['perceive', 'click']);
    expect(res.ok).toBe(true);
  });

  it('A LOOK THAT ERRORS: the tap goes ahead as before', async () => {
    const device = scriptedDevice(() => ({ kind: 'error', code: 'intent_invalid_parameter' }));
    const res = await run(executor(device.dispatcher), [TAP]);
    expect(names(device.sent)).toEqual(['perceive', 'click']);
    expect(res.ok).toBe(true);
  });

  it('A LOOK THAT TIMES OUT: the tap goes ahead once the device is free of it, and the deadline is released', async () => {
    // The device runs one intent at a time. Sent the moment the deadline fired,
    // the tap would be refused `session_intent_in_flight` for as long as the
    // abandoned look runs — longer than the short retry can wait — and a tap
    // that worked before the look existed would fail.
    const device = scriptedDevice(() => ({ kind: 'late', output: lookAnswer({}) }));
    const timer = manualDeadline();
    const pending = run(executor(device.dispatcher, { deadline: timer.deadline }), [TAP]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(names(device.sent)).toEqual(['perceive']);
    timer.fire();
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
    // Given up on — but not yet off the device, so nothing is sent over it.
    expect(names(device.sent)).toEqual(['perceive']);
    device.releaseLateLooks();
    const res = await pending;
    expect(names(device.sent)).toEqual(['perceive', 'click']);
    expect(device.refusedInFlight()).toBe(0);
    expect(res.ok).toBe(true);
    expect(timer.cancelled()).toBe(1);
  });

  it('a timed-out look’s LATE answer is not acted on — the tap goes ahead as before the look existed', async () => {
    const device = scriptedDevice(() => ({
      kind: 'late',
      output: lookAnswer({
        occluded: true,
        occlusion_reason: 'hit_is_not_target_or_descendant',
        hit: { type: 'other', label: 'Banner', selector: '#b' },
      }),
    }));
    const timer = manualDeadline();
    const pending = run(executor(device.dispatcher, { deadline: timer.deadline }), [TAP]);
    await new Promise((resolve) => setImmediate(resolve));
    timer.fire();
    await new Promise((resolve) => setImmediate(resolve));
    device.releaseLateLooks();
    const res = await pending;
    expect(names(device.sent)).toEqual(['perceive', 'click']);
    expect(res.ok).toBe(true);
  });

  it('STOP while the tap waits for an abandoned look: nothing is tapped', async () => {
    const device = scriptedDevice(() => ({ kind: 'hang' }));
    const timer = manualDeadline();
    const controller = new AbortController();
    const pending = run(executor(device.dispatcher, { deadline: timer.deadline }), [TAP], {
      signal: controller.signal,
    });
    await new Promise((resolve) => setImmediate(resolve));
    timer.fire();
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    const res = await pending;
    expect(res.stopped).toBe(true);
    expect(res.results).toEqual([]);
    expect(names(device.sent)).toEqual(['perceive']);
  });

  it('a look that ANSWERS releases its deadline at once (no timer outlives the race)', async () => {
    const device = scriptedDevice(() => ({ kind: 'answer', output: lookAnswer({}) }));
    const timer = manualDeadline();
    await run(executor(device.dispatcher, { deadline: timer.deadline }), [TAP]);
    expect(timer.cancelled()).toBe(1);
  });

  it('STOP during the look: nothing is tapped and nothing is recorded for the step', async () => {
    const device = scriptedDevice(() => ({ kind: 'hang' }));
    const controller = new AbortController();
    const pending = run(executor(device.dispatcher), [TAP], { signal: controller.signal });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    const res = await pending;
    expect(res.stopped).toBe(true);
    expect(res.results).toEqual([]);
    expect(names(device.sent)).toEqual(['perceive']);
  });
});

describe('the look before a tap — the confirmation gate reads what the device says', () => {
  it('halts on the HIT element’s label when the selector and the plan’s words are neutral', async () => {
    const device = scriptedDevice(() => ({
      kind: 'answer',
      output: lookAnswer({
        label: '',
        selector: 'main > div:nth-of-type(2) > button',
        hit: {
          type: 'other',
          label: 'Place order',
          selector: 'main > div:nth-of-type(2) > button > span',
        },
      }),
    }));
    const res = await run(executor(device.dispatcher), [
      { kind: 'interact', action: 'tap', selector: 'main div > button.cta' },
    ]);
    expect(res.awaitingConfirmation).toBe(true);
    const halt = res.results[0];
    if (halt?.kind !== 'confirmation_required') throw new Error('expected a halt');
    expect(halt.category).toBe('purchase');
    expect(halt.matchedText.toLowerCase()).toBe('place order');
    expect(names(device.sent)).toEqual(['perceive']);
  });

  it('halts on the RESOLVED element’s label too', async () => {
    const device = scriptedDevice(() => ({
      kind: 'answer',
      output: lookAnswer({ label: 'Pay now', selector: '#cta' }),
    }));
    const res = await run(executor(device.dispatcher), [
      { kind: 'interact', action: 'tap', selector: '#cta' },
    ]);
    expect(res.awaitingConfirmation).toBe(true);
    expect(names(device.sent)).toEqual(['perceive']);
  });

  it('a tap the PLAN’S words already halt is halted before any look is sent', async () => {
    const device = scriptedDevice(() => ({ kind: 'answer', output: lookAnswer({}) }));
    const res = await run(executor(device.dispatcher), [
      { kind: 'interact', action: 'tap', selector: '#buy-now' },
    ]);
    expect(res.awaitingConfirmation).toBe(true);
    expect(device.sent).toEqual([]);
  });

  it('⛔ an approval for ONE kind of action never releases a tap the device says is ANOTHER kind', async () => {
    // Approved "Place order"; the device says the tap lands on account deletion.
    const device = scriptedDevice(() => ({
      kind: 'answer',
      output: lookAnswer({ label: 'Delete my account permanently', selector: '#checkout' }),
    }));
    const res = await run(
      executor(device.dispatcher),
      [{ kind: 'interact', action: 'tap', selector: '#checkout', value: 'Place order' }],
      { approvedConsequentialActions: new Set(['purchase:place order']) },
    );
    expect(res.awaitingConfirmation).toBe(true);
    const halt = res.results[0];
    if (halt?.kind !== 'confirmation_required') throw new Error('expected a halt');
    expect(halt.category).toBe('account_deletion');
    expect(names(device.sent)).toEqual(['perceive']);
  });

  it('…the same through the HIT element’s label', async () => {
    const device = scriptedDevice(() => ({
      kind: 'answer',
      output: lookAnswer({
        label: 'Place order',
        selector: '#checkout',
        hit: { type: 'other', label: 'Close my account', selector: '#checkout > span' },
      }),
    }));
    const res = await run(
      executor(device.dispatcher),
      [{ kind: 'interact', action: 'tap', selector: '#checkout', value: 'Place order' }],
      { approvedConsequentialActions: new Set(['purchase:place order']) },
    );
    const halt = res.results[0];
    if (halt?.kind !== 'confirmation_required') throw new Error('expected a halt');
    expect(halt.category).toBe('account_deletion');
  });

  it('…and when the other kind was approved as well, the tap is released', async () => {
    const device = scriptedDevice(() => ({
      kind: 'answer',
      output: lookAnswer({ label: 'Delete my account', selector: '#checkout' }),
    }));
    const res = await run(
      executor(device.dispatcher),
      [{ kind: 'interact', action: 'tap', selector: '#checkout', value: 'Place order' }],
      {
        approvedConsequentialActions: new Set([
          'purchase:place order',
          'account_deletion:delete my account',
        ]),
      },
    );
    expect(res.ok).toBe(true);
    expect(names(device.sent)).toEqual(['perceive', 'click']);
  });

  it('a HIDDEN control’s hit is not read by the gate — its tap point is the page’s origin, not the tap', async () => {
    const device = scriptedDevice(() => ({
      kind: 'answer',
      output: lookAnswer({
        label: 'Menu',
        selector: '#menu-link',
        visible: false,
        width: 0,
        occluded: true,
        occlusion_reason: 'hit_is_not_target_or_descendant',
        hit: { type: 'other', label: 'Place order', selector: 'header > div:nth-of-type(1)' },
      }),
    }));
    const res = await run(executor(device.dispatcher), [
      { kind: 'interact', action: 'tap', selector: '#menu-link' },
    ]);
    expect(res.awaitingConfirmation).toBeUndefined();
    expect(names(device.sent)).toEqual(['perceive', 'click']);
  });

  it('an approval given for the plan’s phrase releases that tap even when the device’s label names another', async () => {
    // Read together, "Buy now" in the device's label would match first and
    // re-prompt for an approval the customer has just given, forever.
    const device = scriptedDevice(() => ({
      kind: 'answer',
      output: lookAnswer({ label: 'Buy now', selector: '#checkout' }),
    }));
    const res = await run(
      executor(device.dispatcher),
      [{ kind: 'interact', action: 'tap', selector: '#checkout', value: 'Place order' }],
      { approvedConsequentialActions: new Set(['purchase:place order']) },
    );
    expect(res.ok).toBe(true);
    expect(names(device.sent)).toEqual(['perceive', 'click']);
  });
});

describe('the look before a tap — the repeat guard is told what the tap lands on', () => {
  it('hands the device’s canonical selectors to the guard, and a refusal sends nothing', async () => {
    const device = scriptedDevice(() => ({
      kind: 'answer',
      output: lookAnswer({ selector: 'form > button:nth-of-type(1)', label: 'Send' }),
    }));
    const seen: Array<ReadonlyArray<string>> = [];
    const res = await run(executor(device.dispatcher), [TAP], {
      repeatGuard: (_intent, targets) => {
        seen.push(targets);
        return 'repeat_refused';
      },
    });
    expect(seen).toEqual([['form > button:nth-of-type(1)']]);
    expect(res.repeatRefused).toBe('repeat_refused');
    expect(res.results).toEqual([]);
    expect(names(device.sent)).toEqual(['perceive']);
  });

  it('a successful tap carries what it landed on, for the next segment’s guard', async () => {
    const device = scriptedDevice(() => ({
      kind: 'answer',
      output: lookAnswer({ selector: 'form > button:nth-of-type(1)' }),
    }));
    const res = await run(executor(device.dispatcher), [TAP]);
    const tapped = res.results[0];
    if (tapped === undefined) throw new Error('no result');
    expect(res.tapTargets?.get(tapped)).toEqual(['form > button:nth-of-type(1)']);
    // …and never ON the result, which the customer's response carries as is.
    expect(JSON.stringify(tapped)).not.toContain('nth-of-type');
  });

  it('two spellings of ONE id-less element are one step once the device has named it', () => {
    const a: AgentIntent = { kind: 'interact', action: 'tap', selector: 'form > button.primary' };
    const b: AgentIntent = { kind: 'interact', action: 'tap', selector: '[aria-label="Send"]' };
    // By spelling alone they are two steps — the gap this closes.
    expect(sameSiteEffect(a, b)).toBe(false);
    const canonical = ['form:nth-of-type(1) > button:nth-of-type(1)'];
    expect(sameSiteEffect(a, b, canonical, canonical)).toBe(true);
    // Two different elements stay different.
    expect(sameSiteEffect(a, b, canonical, ['form:nth-of-type(2) > button:nth-of-type(1)'])).toBe(
      false,
    );
    // The spelling still counts when the device's answer is missing.
    expect(sameSiteEffect(a, a, canonical, undefined)).toBe(true);
  });

  it('the runtime’s guard refuses the second spelling after a failure, and on an unmoved page', () => {
    const first: AgentIntent = {
      kind: 'interact',
      action: 'tap',
      selector: 'form > button.primary',
    };
    const second: AgentIntent = {
      kind: 'interact',
      action: 'tap',
      selector: '[aria-label="Send"]',
    };
    const targets = ['form:nth-of-type(1) > button:nth-of-type(1)'];
    const ran = [{ intent: first, targets, pageBefore: 'PAGE-1', pageAfter: 'PAGE-1' }];
    expect(
      repeatRefusedAtTarget({ cause: 'replan', intent: second, targets, ran, pageNow: 'PAGE-1' }),
    ).toBe('repeat_refused');
    expect(
      repeatRefusedAtTarget({ cause: 'continue', intent: second, targets, ran, pageNow: 'PAGE-1' }),
    ).toBe('no_progress');
    // A page that has moved lets the same control run again (the next page of
    // a wizard) — the same rule admission already applies to spellings.
    expect(
      repeatRefusedAtTarget({ cause: 'continue', intent: second, targets, ran, pageNow: 'PAGE-2' }),
    ).toBeNull();
    // A different element is not a repeat at all.
    expect(
      repeatRefusedAtTarget({
        cause: 'replan',
        intent: second,
        targets: ['form:nth-of-type(2) > button:nth-of-type(1)'],
        ran,
        pageNow: 'PAGE-1',
      }),
    ).toBeNull();
  });
});

describe('the look before a tap — what it costs is counted', () => {
  function registry(): MetricsRegistry {
    const metrics = new MetricsRegistry();
    metrics.registerCounter(METRIC_NAMES.agentPreTapLookTotal, 'looks', ['outcome']);
    metrics.registerHistogram(
      METRIC_NAMES.agentPreTapLookDeviceSeconds,
      'device',
      PRE_TAP_LOOK_DURATION_BUCKETS_SECONDS,
      ['outcome'],
    );
    metrics.registerHistogram(
      METRIC_NAMES.agentPreTapLookRoundTripSeconds,
      'round trip',
      PRE_TAP_LOOK_DURATION_BUCKETS_SECONDS,
      ['outcome'],
    );
    return metrics;
  }

  it.each([
    ['clear', lookAnswer({})],
    [
      'covered',
      lookAnswer({
        occluded: true,
        occlusion_reason: 'hit_is_not_target_or_descendant',
        hit: { type: 'other', label: 'Banner', selector: '#b' },
      }),
    ],
    [
      'outside_viewport',
      lookAnswer({ occluded: true, occlusion_reason: 'tap_point_outside_viewport', hit: null }),
    ],
    ['unverified', lookAnswer({ occluded: true, occlusion_reason: 'nothing_hit', hit: null })],
    ['fallback', OLDER_DEVICE_LISTING],
  ] as const)('counts a %s look, with the device’s own duration', async (outcome, output) => {
    const metrics = registry();
    let clock = 0;
    const device = scriptedDevice(() => {
      clock += 25;
      return { kind: 'answer', output, durationMs: 18 };
    });
    await run(executor(device.dispatcher, { metrics, now: () => clock }), [TAP]);
    expect(metrics.getValue(METRIC_NAMES.agentPreTapLookTotal, { outcome })).toBe(1);
    const deviceSeconds = metrics.getHistogram(METRIC_NAMES.agentPreTapLookDeviceSeconds, {
      outcome,
    });
    expect(deviceSeconds.count).toBe(1);
    expect(deviceSeconds.sum).toBeCloseTo(0.018);
    const roundTrip = metrics.getHistogram(METRIC_NAMES.agentPreTapLookRoundTripSeconds, {
      outcome,
    });
    expect(roundTrip.sum).toBeCloseTo(0.025);
  });

  it('counts a not-found look ONCE, after its element wait — one tap, one outcome', async () => {
    const metrics = registry();
    const device = scriptedDevice(() => ({ kind: 'answer', output: lookAnswer(null) }));
    await run(executor(device.dispatcher, { metrics }), [TAP]);
    expect(metrics.getValue(METRIC_NAMES.agentPreTapLookTotal, { outcome: 'not_found' })).toBe(1);
    const total = PRE_TAP_LOOK_OUTCOMES.reduce(
      (sum, outcome) => sum + metrics.getValue(METRIC_NAMES.agentPreTapLookTotal, { outcome }),
      0,
    );
    expect(total).toBe(1);
  });

  it('a SKIPPED look (a device known to predate it) is counted, but not timed as a zero-cost look', async () => {
    const metrics = registry();
    const device = scriptedDevice(() => ({ kind: 'answer', output: OLDER_DEVICE_LISTING }));
    await run(executor(device.dispatcher, { metrics }), [TAP, TAP]);
    expect(metrics.getValue(METRIC_NAMES.agentPreTapLookTotal, { outcome: 'fallback' })).toBe(2);
    expect(
      metrics.getHistogram(METRIC_NAMES.agentPreTapLookRoundTripSeconds, { outcome: 'fallback' })
        .count,
    ).toBe(1);
  });

  it('a timed-out look is counted as fallback with no device duration', async () => {
    const metrics = registry();
    const device = scriptedDevice(() => ({ kind: 'late', output: lookAnswer({}) }));
    const timer = manualDeadline();
    const pending = run(executor(device.dispatcher, { metrics, deadline: timer.deadline }), [TAP]);
    await new Promise((resolve) => setImmediate(resolve));
    timer.fire();
    await new Promise((resolve) => setImmediate(resolve));
    device.releaseLateLooks();
    await pending;
    expect(metrics.getValue(METRIC_NAMES.agentPreTapLookTotal, { outcome: 'fallback' })).toBe(1);
    expect(
      metrics.getHistogram(METRIC_NAMES.agentPreTapLookDeviceSeconds, { outcome: 'fallback' })
        .count,
    ).toBe(0);
  });
});

// ── the protocol and the result mapper ───────────────────────────────

describe('the protocol for the look — additive, and validated when present', () => {
  const result = HARNESS_INTENT_RESULT_SCHEMAS.perceive;
  const params = HARNESS_INTENT_PARAM_SCHEMAS.perceive;

  it('perceive params take an optional selector and strategy; without them the frame is unchanged', () => {
    expect(params.safeParse({}).success).toBe(true);
    expect(params.safeParse({ max_elements: 20 }).success).toBe(true);
    expect(params.safeParse({ selector: '#go', strategy: 'css' }).success).toBe(true);
    expect(params.safeParse({ selector: '//button', strategy: 'xpath' }).success).toBe(true);
    // Validated when present.
    expect(params.safeParse({ selector: '#go', strategy: 'css selector' }).success).toBe(false);
    expect(params.safeParse({ selector: '' }).success).toBe(false);
  });

  it('an older device’s answer — none of the new fields — still decodes', () => {
    expect(result.safeParse(OLDER_DEVICE_LISTING).success).toBe(true);
  });

  it('a new device’s answer decodes, with every new field', () => {
    expect(result.safeParse(lookAnswer({})).success).toBe(true);
    expect(result.safeParse(lookAnswer(null)).success).toBe(true);
  });

  it.each([
    ['an unknown occlusion reason', { occlusion_reason: 'covered_somehow' }],
    ['a non-boolean occluded', { occluded: 'yes' }],
    ['a hit missing its selector', { hit: { type: 'button', label: 'x' } }],
  ])('refuses %s — a drifted shape must not be read as "clear"', (_what, patch) => {
    const answer = lookAnswer({}) as { value: { elements: Array<Record<string, unknown>> } };
    const element = answer.value.elements[0] ?? {};
    Object.assign(element, patch);
    expect(result.safeParse(answer).success).toBe(false);
  });

  it('refuses an unknown resolver name', () => {
    const answer = lookAnswer({}) as { value: Record<string, unknown> };
    answer.value.resolved_by = 'guess';
    expect(result.safeParse(answer).success).toBe(false);
  });
});

describe('a covered refusal from the device itself maps to the same category', () => {
  const failed = (errorCode: string, errorMessage?: string): ParsedIntentResult =>
    parseIntentResult(
      {
        type: 'intentResult',
        sessionId: 's',
        intentId: 'i',
        success: false,
        durationMs: 3,
        errorCode,
        ...(errorMessage !== undefined ? { errorMessage } : {}),
      },
      'click',
    );

  it('the dedicated code decodes (it ships before the device emits it) and maps to element_covered', () => {
    expect(HARNESS_ERROR_CODES).toContain('intent_element_occluded');
    const mapped = intentResultToCustomer(TAP, failed('intent_element_occluded', 'at 70,120'));
    if (mapped.kind !== 'failure') throw new Error('expected a failure');
    expect(mapped.diagnosis).toEqual({ category: 'element_covered', retryable: false });
    expect(mapped.reason).not.toMatch(INTERNAL_WORDS);
    // The device's own words describe the refusal in its terms; not appended.
    expect(mapped.reason).not.toContain('70,120');
    expect(mapped.reason).toContain('nothing was tapped');
  });

  it('the LEGACY form — the coarse code with the fixed prefix — maps to element_covered, not outcome-unknown', () => {
    const mapped = intentResultToCustomer(
      TAP,
      failed(
        'intent_webdriver_failed',
        `${LEGACY_ELEMENT_COVERED_MESSAGE_PREFIX} hit div#consent at 70,120`,
      ),
    );
    if (mapped.kind !== 'failure') throw new Error('expected a failure');
    expect(mapped.diagnosis).toEqual({ category: 'element_covered', retryable: false });
    expect(mapped.reason).toContain('nothing was tapped');
    // The device's own words are not handed to the customer.
    expect(mapped.reason).not.toMatch(INTERNAL_WORDS);
    expect(mapped.reason).not.toContain('div#consent');
  });

  it('the same coarse code WITHOUT the prefix is still outcome-unknown on a tap', () => {
    const mapped = intentResultToCustomer(TAP, failed('intent_webdriver_failed', 'socket closed'));
    if (mapped.kind !== 'failure') throw new Error('expected a failure');
    expect(mapped.diagnosis).toEqual({ category: 'unknown', retryable: false });
  });
});

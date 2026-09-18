// THE DEVICE CHECKS THE REAL TAP POINT where the look cannot vouch for it.
//
// The look before a tap asks the device, read-only, what is at the tap point —
// but perceive never scrolls, and the click scrolls its target to a randomised
// band of the viewport and jitters the tap. So a control below the fold was
// tapped UNCHECKED, and a consequential tap was checked only at its unjittered,
// unscrolled centre. The device now offers click `{ require_unoccluded: true }`
// (A3 V-3358): its occlusion test at the ACTUAL tap point, refusing a covered
// tap before any touch.
//
//   · what is sent   → the check rides on a tap whose look said outside the
//                      viewport, and on every tap the gate releases on an
//                      approval. Never on an ordinary clear tap. The device
//                      here answers WITHOUT `hit_via_own_label` — a build
//                      before A3 V-3360 — so typing is never sent it and the
//                      own-label exemptions hold (the capable device is
//                      a-device-with-the-own-label-rule-is-trusted-…test.ts)
//   · what comes back → every refusal reason is a cover, EXCEPT an element that
//                      went away (the element-not-found path) and a check that
//                      could not run (its own sentence, re-plannable)
//   · an approval    → a refused approved tap does nothing, and its approval
//                      is not carried forward: the plan stops there, and any
//                      new plan is put to the customer again
//   · what is counted → every click that carried the check, by why and result
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
  intentResultToCustomer,
  LEGACY_ELEMENT_COVERED_MESSAGE_PREFIX,
  TARGET_UNVERIFIED_REASON,
  tapRefusalOf,
} from '../../src/services/agent-intent-result.js';
import {
  decodeWireData,
  encodeWireData,
  parseIntentResult,
  serializeIntentDispatch,
  type ParsedIntentResult,
} from '../../src/services/harness-control-codec.js';
import {
  ClickParamsSchema,
  HARNESS_TAP_REFUSAL_REASONS,
  type IntentDispatch,
} from '../../src/schemas/harness-control-protocol.js';
import { MetricsRegistry, METRIC_NAMES } from '../../src/services/metrics-registry.js';
import {
  classifyStepFailure,
  TAP_UNOCCLUDED_CHECK_RESULTS,
  TAP_UNOCCLUDED_CHECK_VERBS,
  TAP_UNOCCLUDED_CHECK_WHYS,
} from '../../src/services/agent-turn-telemetry.js';
import { isReplannableFailure } from '../../src/services/agent-runtime.js';

// ── a device that answers however a test says ─────────────────────────

/** `own_label`: the tap point lands on the control's own `<label>` — a styled
 *  checkbox's hidden input, which the look reads as clear. */
type Look = 'clear' | 'outside_viewport' | 'nothing_hit' | 'own_label' | 'older_device';

/** A perceive-by-selector answer for one visible control (a button unless
 *  `type` says otherwise). */
function lookAnswer(look: Look, label: string, type = 'button'): Record<string, unknown> {
  const bounds = { x: 10, y: 900, width: 120, height: 40 };
  if (look === 'older_device') {
    return {
      value: {
        url: 'https://shop.test/',
        title: 'Shop',
        elements: [
          {
            id: 0,
            type,
            label,
            selector: '#go',
            bounds,
            state: { visible: true, enabled: true, focused: false },
            position_summary: 'in view',
          },
        ],
        truncated: false,
        total_matched: 1,
      },
    };
  }
  const reason =
    look === 'outside_viewport'
      ? 'tap_point_outside_viewport'
      : look === 'nothing_hit'
        ? 'nothing_hit'
        : look === 'own_label'
          ? 'hit_is_not_target_or_descendant'
          : null;
  const hit =
    look === 'own_label'
      ? { type: 'other', label, selector: 'label:nth-of-type(1)', bounds }
      : reason === null
        ? { type, label, selector: '#go', bounds }
        : null;
  return {
    value: {
      url: 'https://shop.test/',
      title: 'Shop',
      elements: [
        {
          id: 0,
          type,
          label,
          selector: '#go',
          bounds,
          state: { visible: true, enabled: true, focused: false },
          position_summary: 'in view',
          tap_point: { x: 70, y: 920 },
          hit,
          occluded: reason !== null,
          occlusion_reason: reason,
        },
      ],
      truncated: false,
      total_matched: 1,
      resolved_by: 'script',
    },
  };
}

type ClickReply =
  | { kind: 'tapped' }
  | { kind: 'fail'; code: string; message?: string }
  /** Never answers; `then` runs as the click reaches the device. */
  | { kind: 'hang'; then: () => void };

/** Every frame goes through the real codec, so nothing here is a shape the wire
 *  could not carry. */
function device(opts: {
  look?: Look;
  label?: string;
  type?: string;
  clicks?: (call: number, params: Record<string, unknown>) => ClickReply;
}): {
  dispatcher: IntentDispatcher;
  sent: Array<{ name: string; params: Record<string, unknown> }>;
} {
  const sent: Array<{ name: string; params: Record<string, unknown> }> = [];
  let clicks = 0;
  const ok = (d: IntentDispatch, output: unknown): ParsedIntentResult =>
    parseIntentResult(
      {
        type: 'intentResult',
        sessionId: d.sessionId,
        intentId: d.intentId,
        success: true,
        durationMs: 5,
        outputData: encodeWireData(output),
      },
      d.intentName,
    );
  const fail = (d: IntentDispatch, code: string, message?: string): ParsedIntentResult =>
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
  return {
    sent,
    dispatcher: {
      dispatch: (d: IntentDispatch): Promise<ParsedIntentResult> => {
        const params = decodeWireData(d.inputParams) as Record<string, unknown>;
        sent.push({ name: d.intentName, params });
        switch (d.intentName) {
          case 'perceive':
            return Promise.resolve(
              ok(d, lookAnswer(opts.look ?? 'clear', opts.label ?? 'Continue', opts.type)),
            );
          case 'click': {
            clicks += 1;
            const reply = opts.clicks?.(clicks, params) ?? { kind: 'tapped' };
            if (reply.kind === 'hang') {
              reply.then();
              return new Promise<ParsedIntentResult>(() => undefined);
            }
            return Promise.resolve(
              reply.kind === 'tapped'
                ? ok(d, { clicked: String(params.value), behavioral: true, activated: true })
                : fail(d, reply.code, reply.message),
            );
          }
          case 'send_keys':
            return Promise.resolve(
              ok(d, {
                typed_into: String(params.value),
                length: String(params.text).length,
                truncated: false,
                behavioral: true,
              }),
            );
          case 'wait_for':
            return Promise.resolve(ok(d, { waited: true, timeout_capped: false }));
          default:
            return Promise.resolve(fail(d, 'intent_not_implemented'));
        }
      },
    },
  };
}

function registry(): MetricsRegistry {
  const metrics = new MetricsRegistry();
  metrics.registerCounter(METRIC_NAMES.agentPreTapLookTotal, 'looks', ['outcome']);
  metrics.registerCounter(METRIC_NAMES.agentTapUnoccludedCheckTotal, 'checks', [
    'verb',
    'why',
    'result',
  ]);
  return metrics;
}

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
    sessionId: 'ses_check',
    plan: { kind: 'plan', intents, tokensConsumed: 0 },
    ...extra,
  });
}

function clicksOf(sent: Array<{ name: string; params: Record<string, unknown> }>) {
  return sent.filter((s) => s.name === 'click').map((s) => s.params);
}

/** The count of every result for one `why`, so a test can say "exactly one".
 *  A click's key is `why/result`; any other verb is named in front of it, so a
 *  click counted under the wrong verb shows up as a key nobody expects. */
function checksCounted(metrics: MetricsRegistry): Record<string, number> {
  const counted: Record<string, number> = {};
  for (const verb of TAP_UNOCCLUDED_CHECK_VERBS) {
    for (const why of TAP_UNOCCLUDED_CHECK_WHYS) {
      for (const result of TAP_UNOCCLUDED_CHECK_RESULTS) {
        const value = metrics.getValue(METRIC_NAMES.agentTapUnoccludedCheckTotal, {
          verb,
          why,
          result,
        });
        const key = verb === 'click' ? `${why}/${result}` : `${verb}:${why}/${result}`;
        if (value > 0) counted[key] = value;
      }
    }
  }
  return counted;
}

const TAP: AgentIntent = { kind: 'interact', action: 'tap', selector: '#go' };
/** A tap the plan's own words make consequential ("place order"). */
const ORDER: AgentIntent = {
  kind: 'interact',
  action: 'tap',
  selector: '#go',
  value: 'Place order',
};
const APPROVED = { approvedConsequentialActions: new Set(['purchase:place order']) };
const CHECKED = { strategy: 'css selector', value: '#go', require_unoccluded: true };
const UNCHECKED = { strategy: 'css selector', value: '#go' };
const legacy = (reason: string): ClickReply => ({
  kind: 'fail',
  code: 'intent_webdriver_failed',
  message: `${LEGACY_ELEMENT_COVERED_MESSAGE_PREFIX} ${reason}`,
});
const dedicated = (reason: string): ClickReply => ({
  kind: 'fail',
  code: 'intent_element_occluded',
  message: `${LEGACY_ELEMENT_COVERED_MESSAGE_PREFIX} ${reason}`,
});

/** Words a customer must never read in a step's reason. */
const INTERNAL_WORDS =
  /occlu|perceive|elementfrompoint|hit test|harness|viewport|require_unoccluded|target_not_resolved|check_unavailable/i;

// ── what is sent ──────────────────────────────────────────────────────

describe('which taps carry the device’s check at the real tap point', () => {
  it('a tap the look saw OUTSIDE THE VIEWPORT is sent with require_unoccluded', async () => {
    const d = device({ look: 'outside_viewport' });
    const metrics = registry();
    const res = await run(executor(d.dispatcher, { metrics }), [TAP]);
    expect(res.ok).toBe(true);
    expect(clicksOf(d.sent)).toEqual([CHECKED]);
    expect(checksCounted(metrics)).toEqual({ 'outside_viewport/tapped': 1 });
  });

  it('an ordinary CLEAR tap is sent exactly as before — no parameter', async () => {
    const d = device({ look: 'clear' });
    const metrics = registry();
    await run(executor(d.dispatcher, { metrics }), [TAP]);
    expect(clicksOf(d.sent)).toEqual([UNCHECKED]);
    expect(checksCounted(metrics)).toEqual({});
  });

  it('a look that found NOTHING at the tap point is not a reason to add it (not measured yet)', async () => {
    const d = device({ look: 'nothing_hit' });
    await run(executor(d.dispatcher), [TAP]);
    expect(clicksOf(d.sent)).toEqual([UNCHECKED]);
  });

  it('an APPROVED consequential tap the look saw clear is still sent with it — it is checked where it lands', async () => {
    const d = device({ look: 'clear', label: 'Place order' });
    const metrics = registry();
    const res = await run(executor(d.dispatcher, { metrics }), [ORDER], APPROVED);
    expect(res.ok).toBe(true);
    expect(clicksOf(d.sent)).toEqual([CHECKED]);
    expect(checksCounted(metrics)).toEqual({ 'consequential/tapped': 1 });
  });

  it('approved AND off-screen is ONE count, filed as consequential', async () => {
    const d = device({ look: 'outside_viewport', label: 'Place order' });
    const metrics = registry();
    await run(executor(d.dispatcher, { metrics }), [ORDER], APPROVED);
    expect(clicksOf(d.sent)).toEqual([CHECKED]);
    expect(checksCounted(metrics)).toEqual({ 'consequential/tapped': 1 });
  });

  it('an approval released by the DEVICE’s label (neutral plan words) is consequential too', async () => {
    const d = device({ look: 'clear', label: 'Place order' });
    const res = await run(executor(d.dispatcher), [TAP], APPROVED);
    expect(res.ok).toBe(true);
    expect(clicksOf(d.sent)).toEqual([CHECKED]);
  });

  it('⛔ an UNAPPROVED consequential tap still halts, and nothing — no click — is dispatched', async () => {
    const d = device({ look: 'outside_viewport', label: 'Place order' });
    const res = await run(executor(d.dispatcher), [ORDER]);
    expect(res.awaitingConfirmation).toBe(true);
    expect(res.results[0]?.kind).toBe('confirmation_required');
    expect(clicksOf(d.sent)).toEqual([]);
  });

  it('TYPING on a device without the own-label build is never sent it, even for an off-screen field — it is not known to ignore the key', async () => {
    const d = device({ look: 'outside_viewport' });
    const metrics = registry();
    const res = await run(executor(d.dispatcher, { metrics }), [
      { kind: 'interact', action: 'type', selector: '#go', value: 'hello' },
    ]);
    expect(res.ok).toBe(true);
    const typed = d.sent.find((s) => s.name === 'send_keys');
    expect(typed?.params).toEqual({ strategy: 'css selector', value: '#go', text: 'hello' });
    expect(checksCounted(metrics)).toEqual({});
  });

  it('a device that PREDATES the look still gets it on an approved tap — an older device ignores it', async () => {
    const d = device({ look: 'older_device', label: 'Place order' });
    const res = await run(executor(d.dispatcher), [ORDER], APPROVED);
    expect(res.ok).toBe(true);
    expect(clicksOf(d.sent)).toEqual([CHECKED]);
  });

  it('with the look turned off, an ordinary tap is exactly the old click', async () => {
    const d = device({});
    await run(executor(d.dispatcher, { preTapLookTimeoutMs: 0 }), [TAP]);
    expect(d.sent.map((s) => s.name)).toEqual(['click']);
    expect(clicksOf(d.sent)).toEqual([UNCHECKED]);
  });
});

describe('⛔ on a device WITHOUT the own-label rule, a control operated through its label is never sent the check', () => {
  // That device's check has no own-label rule: a hit on a styled checkbox's
  // label is `hit_is_not_target_or_descendant` there, so the check would refuse
  // the very tap that toggles it, the customer would be told it is covered, and
  // the identical re-plan would end the turn. (Its answers carry no
  // `hit_via_own_label`; a device that sends one gets the check.)
  for (const type of ['checkbox', 'radio']) {
    it(`an OFF-SCREEN ${type} is tapped exactly as before — its tap point may land on its label`, async () => {
      const d = device({ look: 'outside_viewport', label: 'I agree to the terms', type });
      const metrics = registry();
      const res = await run(executor(d.dispatcher, { metrics }), [TAP]);
      expect(res.ok).toBe(true);
      expect(clicksOf(d.sent)).toEqual([UNCHECKED]);
      expect(checksCounted(metrics)).toEqual({});
    });
  }

  it('an APPROVED tap the look saw clear only through the control’s own label is not sent it either', async () => {
    // Type `input`: the rule is the look's evidence, not the control's type.
    const d = device({ look: 'own_label', label: 'Place order', type: 'input' });
    const res = await run(executor(d.dispatcher), [ORDER], APPROVED);
    expect(res.ok).toBe(true);
    expect(clicksOf(d.sent)).toEqual([UNCHECKED]);
  });

  it('an approved checkbox is not sent it: approval never makes a tap the check would wrongly refuse', async () => {
    const d = device({ look: 'clear', label: 'Place order', type: 'checkbox' });
    await run(executor(d.dispatcher), [ORDER], APPROVED);
    expect(clicksOf(d.sent)).toEqual([UNCHECKED]);
  });

  it('CONTROL — the same off-screen look on a BUTTON is still sent it', async () => {
    const d = device({ look: 'outside_viewport', label: 'I agree to the terms', type: 'button' });
    await run(executor(d.dispatcher), [TAP]);
    expect(clicksOf(d.sent)).toEqual([CHECKED]);
  });
});

describe('the click params schema carries the parameter additively', () => {
  it('the locator and element-id forms accept it; the old shapes still parse unchanged', () => {
    expect(ClickParamsSchema.safeParse(CHECKED).success).toBe(true);
    expect(
      ClickParamsSchema.safeParse({ element_id: 'e1', require_unoccluded: true }).success,
    ).toBe(true);
    expect(ClickParamsSchema.safeParse(UNCHECKED).success).toBe(true);
    expect(ClickParamsSchema.safeParse({ ...UNCHECKED, require_unoccluded: 'yes' }).success).toBe(
      false,
    );
  });

  it('a raw {x, y} click with it is refused BEFORE a frame is built — the device would refuse it too', () => {
    expect(ClickParamsSchema.safeParse({ x: 1, y: 2, require_unoccluded: true }).success).toBe(
      false,
    );
    expect(() =>
      serializeIntentDispatch({
        sessionId: 's',
        intentId: 'i',
        intentName: 'click',
        params: { x: 1, y: 2, require_unoccluded: true },
      }),
    ).toThrow();
  });
});

// ── what comes back ───────────────────────────────────────────────────

const failed = (code: string, message?: string): ParsedIntentResult =>
  parseIntentResult(
    {
      type: 'intentResult',
      sessionId: 's',
      intentId: 'i',
      success: false,
      durationMs: 3,
      errorCode: code,
      ...(message !== undefined ? { errorMessage: message } : {}),
    },
    'click',
  );

describe('a refused tap is mapped by its reason', () => {
  // Only a HIT on something that is not the control is a cover. A tap point off
  // the screen, or one where nothing was hit at all, means the device could not
  // check — reported as unverified, never as "something is covering" (spec owner's
  // decision 2026-09-18, after review: the native element path checks before its
  // own scroll, so an off-screen control would otherwise be blamed on a banner).
  const COVER_REASONS = [
    'hit_is_not_target_or_descendant',
    'covered_at_enclosing_shadow_level',
  ] as const;
  const UNVERIFIED_REASONS = [
    'occlusion_check_unavailable',
    'tap_point_outside_viewport',
    'nothing_hit',
  ] as const;

  for (const code of ['intent_webdriver_failed', 'intent_element_occluded'] as const) {
    for (const reason of COVER_REASONS) {
      it(`${code} · ${reason} → element_covered, nothing tapped, in the customer's words`, () => {
        const mapped = intentResultToCustomer(
          TAP,
          failed(code, `${LEGACY_ELEMENT_COVERED_MESSAGE_PREFIX} ${reason}`),
        );
        if (mapped.kind !== 'failure') throw new Error('expected a failure');
        expect(mapped.diagnosis).toEqual({ category: 'element_covered', retryable: false });
        expect(mapped.reason).toContain('nothing was tapped');
        expect(mapped.reason).not.toMatch(INTERNAL_WORDS);
      });
    }

    it(`${code} · target_not_resolved → the element-not-found path, NOT a cover`, () => {
      const mapped = intentResultToCustomer(
        TAP,
        failed(code, `${LEGACY_ELEMENT_COVERED_MESSAGE_PREFIX} target_not_resolved`),
      );
      if (mapped.kind !== 'failure') throw new Error('expected a failure');
      expect(mapped.diagnosis).toEqual({ category: 'element_not_found', retryable: true });
      expect(mapped.reason).toBe('no element on the page matched this selector');
    });

    for (const reason of UNVERIFIED_REASONS) {
      it(`${code} · ${reason} → could not be verified: its own sentence, not retryable, NOT a cover`, () => {
        const mapped = intentResultToCustomer(
          TAP,
          failed(code, `${LEGACY_ELEMENT_COVERED_MESSAGE_PREFIX} ${reason}`),
        );
        if (mapped.kind !== 'failure') throw new Error('expected a failure');
        expect(mapped.diagnosis).toEqual({ category: 'target_unverified', retryable: false });
        expect(mapped.reason).toBe(TARGET_UNVERIFIED_REASON);
        expect(mapped.reason).toContain('nothing was tapped');
        expect(mapped.reason).not.toMatch(/covering/);
        expect(mapped.reason).not.toMatch(INTERNAL_WORDS);
      });
    }
  }

  it('a reason this build does not know is read as covered — the direction in which nothing is tapped by mistake', () => {
    const refusal = tapRefusalOf(
      failed('intent_webdriver_failed', `${LEGACY_ELEMENT_COVERED_MESSAGE_PREFIX} unknown`),
    );
    expect(refusal).toEqual({ kind: 'covered', reason: null });
  });

  it('the device’s exact wording (one space after the colon) is read, and the closed set is the device’s', () => {
    expect(HARNESS_TAP_REFUSAL_REASONS).toEqual([
      'hit_is_not_target_or_descendant',
      'covered_at_enclosing_shadow_level',
      'nothing_hit',
      'tap_point_outside_viewport',
      'target_not_resolved',
      'occlusion_check_unavailable',
    ]);
    expect(
      tapRefusalOf(
        failed(
          'intent_webdriver_failed',
          'element occluded at the tap point: hit_is_not_target_or_descendant',
        ),
      ),
    ).toEqual({ kind: 'covered', reason: 'hit_is_not_target_or_descendant' });
    expect(
      tapRefusalOf(
        failed('intent_webdriver_failed', 'element occluded at the tap point: nothing_hit'),
      ),
    ).toEqual({ kind: 'unverified', reason: 'nothing_hit' });
  });

  it('a coarse failure WITHOUT the prefix is not a refusal', () => {
    expect(tapRefusalOf(failed('intent_webdriver_failed', 'socket closed'))).toBeNull();
    expect(tapRefusalOf(failed('intent_element_not_found'))).toBeNull();
  });

  it('the prefix under any OTHER code is not a refusal — only the two forms the device sends are', () => {
    expect(
      tapRefusalOf(
        failed('intent_invalid_parameter', `${LEGACY_ELEMENT_COVERED_MESSAGE_PREFIX} nothing_hit`),
      ),
    ).toBeNull();
  });

  it('a success is never a refusal', () => {
    const tapped = parseIntentResult(
      {
        type: 'intentResult',
        sessionId: 's',
        intentId: 'i',
        success: true,
        durationMs: 3,
        outputData: encodeWireData({ clicked: '#go', behavioral: true, activated: true }),
      },
      'click',
    );
    expect(tapRefusalOf(tapped)).toBeNull();
  });

  it('target_unverified is re-plannable and filed as the device’s own inability', () => {
    const mapped = intentResultToCustomer(
      TAP,
      failed(
        'intent_webdriver_failed',
        `${LEGACY_ELEMENT_COVERED_MESSAGE_PREFIX} occlusion_check_unavailable`,
      ),
    );
    if (mapped.kind !== 'failure') throw new Error('expected a failure');
    expect(isReplannableFailure({ results: [mapped], ok: false })).toBe(true);
    expect(classifyStepFailure(mapped)).toBe('harness_error_unclassified');
  });
});

describe('what the executor does with a refused tap', () => {
  for (const reply of [legacy, dedicated]) {
    const form = reply === legacy ? 'legacy' : 'dedicated';

    it(`${form} · covered: one click, never retried, the plan stops`, async () => {
      const d = device({
        look: 'outside_viewport',
        clicks: () => reply('hit_is_not_target_or_descendant'),
      });
      const metrics = registry();
      const res = await run(executor(d.dispatcher, { metrics, maxRetries: 2 }), [
        TAP,
        { kind: 'capture', capture: 'screenshot' },
      ]);
      expect(clicksOf(d.sent)).toHaveLength(1);
      expect(res.results).toHaveLength(1);
      const step = res.results[0];
      if (step?.kind !== 'failure') throw new Error('expected a failure');
      expect(step.diagnosis?.category).toBe('element_covered');
      expect(checksCounted(metrics)).toEqual({
        'outside_viewport/hit_is_not_target_or_descendant': 1,
      });
    });

    it(`${form} · target gone: waited for as a missing element, then the SAME checked click again`, async () => {
      const d = device({
        look: 'outside_viewport',
        clicks: (call) => (call === 1 ? reply('target_not_resolved') : { kind: 'tapped' }),
      });
      const metrics = registry();
      const res = await run(executor(d.dispatcher, { metrics }), [TAP]);
      expect(res.ok).toBe(true);
      expect(d.sent.map((s) => s.name)).toEqual(['perceive', 'click', 'wait_for', 'click']);
      expect(clicksOf(d.sent)).toEqual([CHECKED, CHECKED]);
      expect(checksCounted(metrics)).toEqual({
        'outside_viewport/target_not_resolved': 1,
        'outside_viewport/tapped': 1,
      });
    });

    it(`${form} · target gone with no wait left: still replayed, because nothing was tapped`, async () => {
      const d = device({
        look: 'outside_viewport',
        clicks: (call) => (call === 1 ? reply('target_not_resolved') : { kind: 'tapped' }),
      });
      const res = await run(executor(d.dispatcher, { elementAppearWaitMs: 0, maxRetries: 1 }), [
        TAP,
      ]);
      expect(res.ok).toBe(true);
      expect(d.sent.map((s) => s.name)).toEqual(['perceive', 'click', 'click']);
    });

    it(`${form} · check unavailable: one click, not retried, the step says the tap was not made`, async () => {
      const d = device({
        look: 'outside_viewport',
        clicks: () => reply('occlusion_check_unavailable'),
      });
      const metrics = registry();
      const res = await run(executor(d.dispatcher, { metrics, maxRetries: 2 }), [TAP]);
      expect(clicksOf(d.sent)).toHaveLength(1);
      const step = res.results[0];
      if (step?.kind !== 'failure') throw new Error('expected a failure');
      expect(step.diagnosis).toEqual({ category: 'target_unverified', retryable: false });
      expect(isReplannableFailure(res)).toBe(true);
      expect(checksCounted(metrics)).toEqual({ 'outside_viewport/occlusion_check_unavailable': 1 });
    });
  }

  it('a reason the build does not know is counted as unrecognised, and the step is a cover', async () => {
    const d = device({ look: 'outside_viewport', clicks: () => legacy('pointer_events_none') });
    const metrics = registry();
    const res = await run(executor(d.dispatcher, { metrics }), [TAP]);
    expect(res.results[0]?.kind === 'failure' && res.results[0].diagnosis?.category).toBe(
      'element_covered',
    );
    expect(checksCounted(metrics)).toEqual({ 'outside_viewport/unrecognised_reason': 1 });
  });

  it('a checked click that fails for another reason is counted as failed_otherwise, and keeps its old handling', async () => {
    const d = device({
      look: 'outside_viewport',
      clicks: () => ({ kind: 'fail', code: 'intent_webdriver_failed', message: 'socket closed' }),
    });
    const metrics = registry();
    const res = await run(executor(d.dispatcher, { metrics, maxRetries: 2 }), [TAP]);
    // Outcome-unknown on a tap: never replayed.
    expect(clicksOf(d.sent)).toHaveLength(1);
    expect(res.results[0]?.kind === 'failure' && res.results[0].diagnosis?.category).toBe(
      'unknown',
    );
    expect(checksCounted(metrics)).toEqual({ 'outside_viewport/failed_otherwise': 1 });
  });

  it('a checked click Stop abandoned before it answered is counted as no_answer', async () => {
    const stop = new AbortController();
    const d = device({
      look: 'outside_viewport',
      clicks: () => ({ kind: 'hang', then: () => stop.abort() }),
    });
    const metrics = registry();
    const res = await run(executor(d.dispatcher, { metrics }), [TAP], { signal: stop.signal });
    expect(res.stopped).toBe(true);
    expect(checksCounted(metrics)).toEqual({ 'outside_viewport/no_answer': 1 });
  });

  it('an unchecked click is never counted', async () => {
    const d = device({ look: 'clear', clicks: () => legacy('nothing_hit') });
    const metrics = registry();
    await run(executor(d.dispatcher, { metrics }), [TAP]);
    expect(checksCounted(metrics)).toEqual({});
  });
});

// ── an approval and a refused tap ─────────────────────────────────────

describe('⛔ an approved tap the device refuses does nothing, and its approval goes no further', () => {
  it('the purchase is not made, the plan stops at it, and no later step can spend the approval', async () => {
    // Two identical approved taps: if a refusal let the plan go on, the second
    // would be released by the same approval on a page nobody reviewed.
    const d = device({
      look: 'outside_viewport',
      label: 'Place order',
      clicks: () => legacy('hit_is_not_target_or_descendant'),
    });
    const approvals = new Set(['purchase:place order']);
    const res = await run(executor(d.dispatcher), [ORDER, ORDER], {
      approvedConsequentialActions: approvals,
    });
    expect(clicksOf(d.sent)).toEqual([CHECKED]);
    expect(res.ok).toBe(false);
    expect(res.awaitingConfirmation).toBeUndefined();
    expect(res.results).toHaveLength(1);
    const step = res.results[0];
    if (step?.kind !== 'failure') throw new Error('expected a failure');
    expect(step.diagnosis?.category).toBe('element_covered');
    // The caller's grant is not touched: the executor spends a copy, and the
    // runtime decides what happens next (see the eval arm: asked again).
    expect([...approvals]).toEqual(['purchase:place order']);
  });
});

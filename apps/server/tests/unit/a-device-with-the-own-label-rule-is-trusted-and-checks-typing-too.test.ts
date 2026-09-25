// A DEVICE WITH THE OWN-LABEL RULE IS TRUSTED, AND ITS TYPING IS CHECKED TOO.
//
// The device's single tap verdict (V-3360, harness 7795de230) now reads a
// hit on the target's own `<label>` — or on a non-interactive part of it — as
// clear, and a hit on interactive content inside that label (a "terms" link) as
// covered. perceive(selector) says so with `hit_via_own_label` on every element;
// the same deploy made send_keys honour `require_unoccluded` on its focus tap.
// Two stop-gaps existed only because the device had no such rule:
//
//   · the look INFERRED an own-label hit from the label text
//   · click's check was never sent for a checkbox, a radio, or a tap the look
//     saw clear through its label
//
// and typing was never checked at all. On a device that carries the field:
//
//   · what the look trusts → the device's verdict; the text inference is the
//                            fallback for a device without the field, only
//   · who gets the check   → every tap under the same rules — off-screen or
//                            released by an approval — checkboxes included
//   · typing               → an off-screen field's focus tap carries the check;
//                            a refusal types nothing and says so in typing words
//   · what is counted      → by verb; a typed step with no tap to check is
//                            `no_tap`, never a pass
//   · a saved credential   → never in a look, a count or a customer sentence
//
// A device without the field keeps every old behaviour: the other two tap
// files pin that, against answers that carry no `hit_via_own_label`.
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
  TARGET_UNVERIFIED_TYPING_REASON,
} from '../../src/services/agent-intent-result.js';
import {
  decodeWireData,
  encodeWireData,
  parseIntentResult,
  serializeIntentDispatch,
  type ParsedIntentResult,
} from '../../src/services/harness-control-codec.js';
import {
  SendKeysParamsSchema,
  type IntentDispatch,
} from '../../src/schemas/harness-control-protocol.js';
import { MetricsRegistry, METRIC_NAMES } from '../../src/services/metrics-registry.js';
import {
  TAP_UNOCCLUDED_CHECK_RESULTS,
  TAP_UNOCCLUDED_CHECK_VERBS,
  TAP_UNOCCLUDED_CHECK_WHYS,
} from '../../src/services/agent-turn-telemetry.js';
import { isReplannableFailure } from '../../src/services/agent-runtime.js';

// ── a device that answers however a test says ─────────────────────────

interface LookShape {
  type?: string;
  label?: string;
  /** Absent: the element carries no `hit_via_own_label` — a device without
   *  the rule. */
  viaOwnLabel?: boolean;
  occluded?: boolean;
  reason?: string | null;
  hit?: { type: string; label: string; selector: string } | null;
}

function lookAnswer(look: LookShape): Record<string, unknown> {
  const bounds = { x: 10, y: 900, width: 120, height: 40 };
  const type = look.type ?? 'button';
  const label = look.label ?? 'Continue';
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
          hit:
            look.hit === undefined
              ? { type, label, selector: '#go', bounds }
              : look.hit === null
                ? null
                : { ...look.hit, bounds },
          occluded: look.occluded ?? false,
          occlusion_reason: look.reason ?? null,
          ...(look.viaOwnLabel === undefined ? {} : { hit_via_own_label: look.viaOwnLabel }),
        },
      ],
      truncated: false,
      total_matched: 1,
      resolved_by: 'script',
    },
  };
}

/** Off-screen, as a device with the rule reports it. */
const OFFSCREEN: LookShape = {
  viaOwnLabel: false,
  occluded: true,
  reason: 'tap_point_outside_viewport',
  hit: null,
};

type Reply =
  | { kind: 'ok'; output?: Record<string, unknown> }
  | { kind: 'fail'; code: string; message?: string };

interface Sent {
  name: string;
  params: Record<string, unknown>;
}

/** Every frame goes through the real codec, so nothing here is a shape the
 *  wire could not carry. `looks` answers each perceive in turn (the last one
 *  repeats). */
function device(opts: {
  looks: LookShape[];
  clicks?: (call: number) => Reply;
  keys?: (call: number, params: Record<string, unknown>) => Reply;
}): { dispatcher: IntentDispatcher; sent: Sent[] } {
  const sent: Sent[] = [];
  let looks = 0;
  let clicks = 0;
  let keys = 0;
  const answer = (d: IntentDispatch, reply: Reply, output: unknown): ParsedIntentResult =>
    parseIntentResult(
      reply.kind === 'ok'
        ? {
            type: 'intentResult',
            sessionId: d.sessionId,
            intentId: d.intentId,
            success: true,
            durationMs: 5,
            outputData: encodeWireData(reply.output ?? output),
          }
        : {
            type: 'intentResult',
            sessionId: d.sessionId,
            intentId: d.intentId,
            success: false,
            durationMs: 5,
            errorCode: reply.code,
            ...(reply.message !== undefined ? { errorMessage: reply.message } : {}),
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
          case 'perceive': {
            const look = opts.looks[Math.min(looks, opts.looks.length - 1)] ?? {};
            looks += 1;
            return Promise.resolve(answer(d, { kind: 'ok' }, lookAnswer(look)));
          }
          case 'click':
            clicks += 1;
            return Promise.resolve(
              answer(d, opts.clicks?.(clicks) ?? { kind: 'ok' }, {
                clicked: String(params.value),
                behavioral: true,
                activated: true,
              }),
            );
          case 'send_keys':
            keys += 1;
            return Promise.resolve(
              answer(d, opts.keys?.(keys, params) ?? { kind: 'ok' }, {
                typed_into: String(params.value),
                length: String(params.text).length,
                truncated: false,
                behavioral: true,
                focus_tap_unoccluded_checked: params.require_unoccluded === true,
              }),
            );
          case 'wait_for':
            return Promise.resolve(
              answer(d, { kind: 'ok' }, { waited: true, timeout_capped: false }),
            );
          default:
            return Promise.resolve(answer(d, { kind: 'fail', code: 'intent_not_implemented' }, {}));
        }
      },
    },
  };
}

function registry(): MetricsRegistry {
  const metrics = new MetricsRegistry();
  metrics.registerCounter(METRIC_NAMES.agentPreTapLookTotal, 'looks', ['outcome']);
  // The label keys bootstrap registers: a key missing here would be dropped
  // silently by the registry, and the `verb` assertions below would pass on
  // nothing.
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
    sessionId: 'ses_own_label',
    plan: { kind: 'plan', intents, tokensConsumed: 0 },
    ...extra,
  });
}

const paramsOf = (sent: Sent[], name: string) =>
  sent.filter((s) => s.name === name).map((s) => s.params);

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
        if (value > 0) counted[`${verb}/${why}/${result}`] = value;
      }
    }
  }
  return counted;
}

const TAP: AgentIntent = { kind: 'interact', action: 'tap', selector: '#go' };
const ORDER: AgentIntent = {
  kind: 'interact',
  action: 'tap',
  selector: '#go',
  value: 'Place order',
};
const APPROVED = { approvedConsequentialActions: new Set(['purchase:place order']) };
const TYPE: AgentIntent = { kind: 'interact', action: 'type', selector: '#go', value: 'hello' };
const CHECKED = { strategy: 'css selector', value: '#go', require_unoccluded: true };
const UNCHECKED = { strategy: 'css selector', value: '#go' };
const TYPED_CHECKED = { ...CHECKED, text: 'hello' };
const TYPED_UNCHECKED = { ...UNCHECKED, text: 'hello' };
const refused = (reason: string): Reply => ({
  kind: 'fail',
  code: 'intent_webdriver_failed',
  message: `${LEGACY_ELEMENT_COVERED_MESSAGE_PREFIX} ${reason}`,
});

/** Words a customer must never read in a step's reason. */
const INTERNAL_WORDS =
  /occlu|perceive|elementfrompoint|hit test|harness|viewport|require_unoccluded|target_not_resolved|check_unavailable|focus_tap|own_label/i;

// ── O1: the protocol carries the three fields additively ───────────────

describe('the protocol carries the V-3360 fields additively, validated when present', () => {
  const frame = (intentName: 'send_keys' | 'perceive', output: unknown) =>
    parseIntentResult(
      {
        type: 'intentResult',
        sessionId: 's',
        intentId: 'i',
        success: true,
        durationMs: 3,
        outputData: encodeWireData(output),
      },
      intentName,
    );

  it('⛔ a typed result from the V-3360 build PARSES — the key is always sent, and a strict schema without it failed every one', () => {
    for (const checked of [true, false]) {
      const parsed = frame('send_keys', {
        typed_into: '#go',
        length: 5,
        truncated: false,
        behavioral: true,
        focus_tap_unoccluded_checked: checked,
      });
      expect(parsed.outputData).toMatchObject({ focus_tap_unoccluded_checked: checked });
    }
    // An older device's result is unchanged.
    expect(
      frame('send_keys', { typed_into: '#go', length: 5, truncated: false, behavioral: true })
        .success,
    ).toBe(true);
  });

  it('a drifted focus_tap_unoccluded_checked fails the contract rather than being read', () => {
    expect(() =>
      frame('send_keys', {
        typed_into: '#go',
        length: 5,
        truncated: false,
        behavioral: true,
        focus_tap_unoccluded_checked: 'yes',
      }),
    ).toThrow(/failed the harness contract/);
  });

  it('a perceive element carrying hit_via_own_label parses; a non-boolean fails the frame', () => {
    expect(frame('perceive', lookAnswer({ viaOwnLabel: true })).success).toBe(true);
    const drifted = lookAnswer({});
    const value = drifted.value as { elements: Array<Record<string, unknown>> };
    const [first] = value.elements;
    if (first === undefined) throw new Error('fixture has no element');
    first.hit_via_own_label = 'true';
    expect(() => frame('perceive', drifted)).toThrow(/failed the harness contract/);
  });

  it('send_keys params accept require_unoccluded as a boolean, and nothing else; the old shape is unchanged', () => {
    expect(SendKeysParamsSchema.safeParse(TYPED_CHECKED).success).toBe(true);
    expect(SendKeysParamsSchema.safeParse(TYPED_UNCHECKED).success).toBe(true);
    expect(
      SendKeysParamsSchema.safeParse({ ...TYPED_UNCHECKED, require_unoccluded: 1 }).success,
    ).toBe(false);
    // The STRICT schema is what every typed dispatch is serialised through.
    expect(() =>
      serializeIntentDispatch({
        sessionId: 's',
        intentId: 'i',
        intentName: 'send_keys',
        params: TYPED_CHECKED,
      }),
    ).not.toThrow();
  });
});

// ── O3: the device's verdict is trusted when it gives one ──────────────

describe('the look trusts the device’s verdict when the element carries hit_via_own_label', () => {
  // A heading that repeats the checkbox's name, drawn over it: the label-text
  // guess calls that the checkbox's own label and taps.
  const NAMESAKE = {
    type: 'checkbox',
    label: 'I agree to the terms',
    occluded: true,
    reason: 'hit_is_not_target_or_descendant',
    hit: { type: 'other', label: 'I agree to the terms', selector: 'main > h2:nth-of-type(1)' },
  };

  it('⛔ occluded by a non-control that shares the name is COVERED when the device says it is not the own label — nothing is tapped', async () => {
    const d = device({ looks: [{ ...NAMESAKE, viaOwnLabel: false }] });
    const res = await run(executor(d.dispatcher), [TAP]);
    expect(d.sent.map((s) => s.name)).toEqual(['perceive']);
    const step = res.results[0];
    if (step?.kind !== 'failure') throw new Error('expected a failure');
    expect(step.diagnosis?.category).toBe('element_covered');
  });

  it('CONTROL — the same answer from a device WITHOUT the field falls back to the text inference, and taps', async () => {
    const d = device({ looks: [NAMESAKE] });
    const res = await run(executor(d.dispatcher), [TAP]);
    expect(res.ok).toBe(true);
    expect(d.sent.map((s) => s.name)).toEqual(['perceive', 'click']);
  });

  it('clear through the own label, by the device’s word, is clear — whatever the label text says', async () => {
    // The span the label draws reads differently from the control's name; the
    // device, which walked the real `labels`, says it is the own label.
    const d = device({
      looks: [
        {
          type: 'checkbox',
          label: 'I agree to the terms',
          viaOwnLabel: true,
          occluded: false,
          reason: null,
          hit: { type: 'other', label: '✓', selector: 'form > label > span' },
        },
      ],
    });
    const res = await run(executor(d.dispatcher), [TAP]);
    expect(res.ok).toBe(true);
    expect(paramsOf(d.sent, 'click')).toEqual([UNCHECKED]);
  });

  it('a link inside the label is covered by the device’s word, and nothing is tapped', async () => {
    const d = device({
      looks: [
        {
          type: 'checkbox',
          label: 'I accept the terms',
          viaOwnLabel: false,
          occluded: true,
          reason: 'hit_is_not_target_or_descendant',
          hit: { type: 'link', label: 'terms', selector: 'form > label > a' },
        },
      ],
    });
    const res = await run(executor(d.dispatcher), [TAP]);
    expect(paramsOf(d.sent, 'click')).toEqual([]);
    expect(res.results[0]?.kind === 'failure' && res.results[0].diagnosis?.category).toBe(
      'element_covered',
    );
  });
});

// ── O4: no exemptions on a device with the rule ────────────────────────

describe('on a device with the rule, a control operated through its label is checked like any other tap', () => {
  for (const type of ['checkbox', 'radio']) {
    it(`an OFF-SCREEN ${type} carries the check`, async () => {
      const d = device({ looks: [{ ...OFFSCREEN, type, label: 'I agree to the terms' }] });
      const metrics = registry();
      const res = await run(executor(d.dispatcher, { metrics }), [TAP]);
      expect(res.ok).toBe(true);
      expect(paramsOf(d.sent, 'click')).toEqual([CHECKED]);
      expect(checksCounted(metrics)).toEqual({ 'click/outside_viewport/tapped': 1 });
    });
  }

  it('an APPROVED tap the device saw clear through its own label carries the check', async () => {
    const d = device({
      looks: [
        {
          type: 'input',
          label: 'Place order',
          viaOwnLabel: true,
          hit: { type: 'other', label: 'Place order', selector: 'label:nth-of-type(1)' },
        },
      ],
    });
    const res = await run(executor(d.dispatcher), [ORDER], APPROVED);
    expect(res.ok).toBe(true);
    expect(paramsOf(d.sent, 'click')).toEqual([CHECKED]);
  });

  it('an approved checkbox carries the check', async () => {
    const d = device({ looks: [{ type: 'checkbox', label: 'Place order', viaOwnLabel: false }] });
    await run(executor(d.dispatcher), [ORDER], APPROVED);
    expect(paramsOf(d.sent, 'click')).toEqual([CHECKED]);
  });

  it('the SAME rules, not more: an ordinary clear checkbox is still tapped without it', async () => {
    const d = device({ looks: [{ type: 'checkbox', viaOwnLabel: false }] });
    await run(executor(d.dispatcher), [TAP]);
    expect(paramsOf(d.sent, 'click')).toEqual([UNCHECKED]);
  });

  it('a refusal of an off-screen checkbox’s tap is a cover, one click, not retried', async () => {
    const d = device({
      looks: [{ ...OFFSCREEN, type: 'checkbox' }],
      clicks: () => refused('hit_is_not_target_or_descendant'),
    });
    const res = await run(executor(d.dispatcher, { maxRetries: 2 }), [TAP]);
    expect(paramsOf(d.sent, 'click')).toEqual([CHECKED]);
    expect(res.results[0]?.kind === 'failure' && res.results[0].diagnosis?.category).toBe(
      'element_covered',
    );
  });
});

// ── O2: what the device is, remembered per session ─────────────────────

describe('the device’s build is remembered per session, like the older-device memo', () => {
  it('a later look in the SAME session that carries no field still counts as the capable device', async () => {
    // First look shows the build; the second answer happens to lack the key.
    const d = device({
      looks: [{ viaOwnLabel: false }, { ...OFFSCREEN, viaOwnLabel: undefined, type: 'checkbox' }],
    });
    const exec = executor(d.dispatcher);
    await run(exec, [TAP, TAP]);
    expect(paramsOf(d.sent, 'click')).toEqual([UNCHECKED, CHECKED]);
  });

  it('…and ANOTHER session’s device is not assumed to have it: its off-screen checkbox keeps the exemption', async () => {
    const d = device({
      looks: [{ viaOwnLabel: false }, { ...OFFSCREEN, viaOwnLabel: undefined, type: 'checkbox' }],
    });
    const exec = executor(d.dispatcher);
    await run(exec, [TAP]);
    await exec.execute({
      sessionId: 'ses_other_device',
      plan: { kind: 'plan', intents: [TAP], tokensConsumed: 0 },
    });
    expect(paramsOf(d.sent, 'click')).toEqual([UNCHECKED, UNCHECKED]);
  });
});

// ── O5: typing ─────────────────────────────────────────────────────────

describe('a typed step on a device with the rule', () => {
  it('an OFF-SCREEN field’s focus tap carries the check, and a checked tap is counted as checked', async () => {
    const d = device({ looks: [{ ...OFFSCREEN, type: 'input' }] });
    const metrics = registry();
    const res = await run(executor(d.dispatcher, { metrics }), [TYPE]);
    expect(res.ok).toBe(true);
    expect(paramsOf(d.sent, 'send_keys')).toEqual([TYPED_CHECKED]);
    expect(checksCounted(metrics)).toEqual({ 'send_keys/outside_viewport/checked': 1 });
  });

  it('a field the look saw CLEAR is typed into exactly as before — no parameter, nothing counted', async () => {
    const d = device({ looks: [{ type: 'input', viaOwnLabel: false }] });
    const metrics = registry();
    await run(executor(d.dispatcher, { metrics }), [TYPE]);
    expect(paramsOf(d.sent, 'send_keys')).toEqual([TYPED_UNCHECKED]);
    expect(checksCounted(metrics)).toEqual({});
  });

  it('⛔ a device WITHOUT the field is never sent it, even for an off-screen field', async () => {
    const d = device({ looks: [{ ...OFFSCREEN, viaOwnLabel: undefined, type: 'input' }] });
    await run(executor(d.dispatcher), [TYPE]);
    expect(paramsOf(d.sent, 'send_keys')).toEqual([TYPED_UNCHECKED]);
  });

  it('⛔ focus_tap_unoccluded_checked: false is NO TAP TO VERIFY — counted no_tap, never checked', async () => {
    const d = device({
      looks: [{ ...OFFSCREEN, type: 'input' }],
      keys: () => ({
        kind: 'ok',
        output: {
          typed_into: '#go',
          length: 5,
          truncated: false,
          behavioral: true,
          focus_tap_unoccluded_checked: false,
        },
      }),
    });
    const metrics = registry();
    const res = await run(executor(d.dispatcher, { metrics }), [TYPE]);
    // The typing happened — the field was focused by script — so the step stands.
    expect(res.ok).toBe(true);
    expect(checksCounted(metrics)).toEqual({ 'send_keys/outside_viewport/no_tap': 1 });
  });

  it('an answer that does not say whether the tap was checked is unconfirmed, not checked', async () => {
    const d = device({
      looks: [{ ...OFFSCREEN, type: 'input' }],
      keys: () => ({
        kind: 'ok',
        output: { typed_into: '#go', length: 5, truncated: false, behavioral: true },
      }),
    });
    const metrics = registry();
    await run(executor(d.dispatcher, { metrics }), [TYPE]);
    expect(checksCounted(metrics)).toEqual({ 'send_keys/outside_viewport/unconfirmed': 1 });
  });

  for (const code of ['intent_webdriver_failed', 'intent_element_occluded'] as const) {
    it(`${code} · a COVERED focus tap: nothing typed, said in typing words, not retried, re-plannable`, async () => {
      const d = device({
        looks: [{ ...OFFSCREEN, type: 'input' }],
        keys: () => ({
          kind: 'fail',
          code,
          message: `${LEGACY_ELEMENT_COVERED_MESSAGE_PREFIX} hit_is_not_target_or_descendant`,
        }),
      });
      const metrics = registry();
      const res = await run(executor(d.dispatcher, { metrics, maxRetries: 2 }), [
        TYPE,
        { kind: 'capture', capture: 'screenshot' },
      ]);
      expect(paramsOf(d.sent, 'send_keys')).toHaveLength(1);
      expect(res.results).toHaveLength(1);
      const step = res.results[0];
      if (step?.kind !== 'failure') throw new Error('expected a failure');
      expect(step.diagnosis).toEqual({ category: 'element_covered', retryable: false });
      expect(step.reason).toContain('nothing was typed');
      expect(step.reason).not.toContain('tapped');
      expect(step.reason).not.toMatch(INTERNAL_WORDS);
      expect(isReplannableFailure(res)).toBe(true);
      expect(checksCounted(metrics)).toEqual({
        'send_keys/outside_viewport/hit_is_not_target_or_descendant': 1,
      });
    });
  }

  it('a check that COULD NOT RUN: nothing typed, its own typing sentence, not a cover', async () => {
    const d = device({
      looks: [{ ...OFFSCREEN, type: 'input' }],
      keys: () => refused('occlusion_check_unavailable'),
    });
    const metrics = registry();
    const res = await run(executor(d.dispatcher, { metrics, maxRetries: 2 }), [TYPE]);
    expect(paramsOf(d.sent, 'send_keys')).toHaveLength(1);
    const step = res.results[0];
    if (step?.kind !== 'failure') throw new Error('expected a failure');
    expect(step.diagnosis).toEqual({ category: 'target_unverified', retryable: false });
    expect(step.reason).toBe(TARGET_UNVERIFIED_TYPING_REASON);
    expect(checksCounted(metrics)).toEqual({
      'send_keys/outside_viewport/occlusion_check_unavailable': 1,
    });
  });

  it('the field WENT AWAY: waited for as a missing element, then the same checked typing again', async () => {
    const d = device({
      looks: [{ ...OFFSCREEN, type: 'input' }],
      keys: (call) => (call === 1 ? refused('target_not_resolved') : { kind: 'ok' }),
    });
    const res = await run(executor(d.dispatcher), [TYPE]);
    expect(res.ok).toBe(true);
    // The executor as it SHIPS: the relocation beat is built and switched off, so
    // nothing is inserted in front of typing into a field the look placed outside
    // the viewport.
    expect(d.sent.map((s) => s.name)).toEqual(['perceive', 'send_keys', 'wait_for', 'send_keys']);
    expect(paramsOf(d.sent, 'send_keys')).toEqual([TYPED_CHECKED, TYPED_CHECKED]);
  });

  it('with the relocation beat switched ON the same arm gains a scroll and a drawn dwell, and a beat that fails did not happen', async () => {
    const d = device({
      looks: [{ ...OFFSCREEN, type: 'input' }],
      keys: (call) => (call === 1 ? refused('target_not_resolved') : { kind: 'ok' }),
    });
    const res = await run(executor(d.dispatcher, { relocationBeat: true }), [TYPE]);
    expect(res.ok).toBe(true);
    // ⛔ THE TWO INSERTED VERBS ARE R5's RELOCATION BEAT: the look says the field
    // is outside the viewport, so a scroll and a drawn dwell go in front of the
    // typing. ⚠️ AND THERE IS NO SECOND `perceive` HERE, which is the beat's other
    // rule showing: this fixture's device answers nothing but
    // perceive/send_keys/wait_for, so both inserted dispatches FAIL, the beat
    // reports that it did not happen, and no re-look is taken. The step then does
    // exactly what it does with the beat off — the rest of this expectation is
    // the case above, unchanged.
    expect(d.sent.map((s) => s.name)).toEqual([
      'perceive',
      'scroll',
      'behavioral_pause',
      'send_keys',
      'wait_for',
      'send_keys',
    ]);
    expect(paramsOf(d.sent, 'send_keys')).toEqual([TYPED_CHECKED, TYPED_CHECKED]);
  });
});

describe('the typing sentences', () => {
  const typedFailure = (reason: string) =>
    intentResultToCustomer(
      TYPE,
      parseIntentResult(
        {
          type: 'intentResult',
          sessionId: 's',
          intentId: 'i',
          success: false,
          durationMs: 3,
          errorCode: 'intent_webdriver_failed',
          errorMessage: `${LEGACY_ELEMENT_COVERED_MESSAGE_PREFIX} ${reason}`,
        },
        'send_keys',
      ),
    );

  for (const reason of [
    'occlusion_check_unavailable',
    'tap_point_outside_viewport',
    'nothing_hit',
  ]) {
    it(`${reason} on a typed step → the typing sentence, never the tapping one`, () => {
      const mapped = typedFailure(reason);
      if (mapped.kind !== 'failure') throw new Error('expected a failure');
      expect(mapped.reason).toBe(TARGET_UNVERIFIED_TYPING_REASON);
      expect(mapped.reason).not.toBe(TARGET_UNVERIFIED_REASON);
      expect(mapped.reason).not.toMatch(INTERNAL_WORDS);
    });
  }

  it('a TAP keeps its own sentence', () => {
    const mapped = intentResultToCustomer(
      TAP,
      parseIntentResult(
        {
          type: 'intentResult',
          sessionId: 's',
          intentId: 'i',
          success: false,
          durationMs: 3,
          errorCode: 'intent_webdriver_failed',
          errorMessage: `${LEGACY_ELEMENT_COVERED_MESSAGE_PREFIX} nothing_hit`,
        },
        'click',
      ),
    );
    expect(mapped.kind === 'failure' && mapped.reason).toBe(TARGET_UNVERIFIED_REASON);
  });
});

// ── a saved credential ────────────────────────────────────────────────

describe('⛔ a saved credential typed into a checked field reaches the device and nothing else', () => {
  const SECRET = 'hunter2-correct-horse';
  const PASSWORD: AgentIntent = {
    kind: 'interact',
    action: 'type',
    selector: '#go',
    value: '{{credential:password}}',
  };
  const CREDENTIALS = { credentials: { username: 'a@b.test', password: SECRET } };

  for (const outcome of ['refused', 'unavailable', 'typed'] as const) {
    it(`${outcome}: the look, the counter and every result carry the selector only`, async () => {
      const d = device({
        looks: [{ ...OFFSCREEN, type: 'input', label: 'Password' }],
        keys: () =>
          outcome === 'refused'
            ? refused('hit_is_not_target_or_descendant')
            : outcome === 'unavailable'
              ? refused('occlusion_check_unavailable')
              : { kind: 'ok' },
      });
      const metrics = registry();
      const res = await run(executor(d.dispatcher, { metrics }), [PASSWORD], CREDENTIALS);
      // Positive control: the substitution happened, and the checked dispatch
      // is the ONE place the value goes.
      const typed = paramsOf(d.sent, 'send_keys');
      expect(typed).toHaveLength(1);
      expect(typed[0]).toMatchObject({ ...CHECKED, text: SECRET });
      const look = paramsOf(d.sent, 'perceive')[0];
      expect(Object.keys(look ?? {}).sort()).toEqual(['max_elements', 'selector', 'strategy']);
      expect(JSON.stringify(look)).not.toContain(SECRET);
      expect(metrics.render()).toContain('verb="send_keys"');
      expect(metrics.render()).not.toContain(SECRET);
      expect(JSON.stringify(res)).not.toContain(SECRET);
    });
  }
});

// R5 — a tap the look could not see gets a scroll, a drawn dwell, and a fresh
// look before it lands.
//
// THE FINDING. `perceive` never scrolls, so a control below the fold comes back
// `tap_point_outside_viewport`. The executor already knew that and its only
// response was to ask the device to check the real tap point
// (`require_unoccluded`, which is right and is kept). The click's own scroll
// then ran as an invisible sub-step of the touch: the viewport settled and the
// finger landed on the target within milliseconds of each other, with no
// re-location pause anywhere. On a phone that is the highest-weight feature a
// detector has.
//
// ⛔ WHAT THIS FIX IS AND IS NOT. It puts a scroll and a dwell where a person's
// are, and it moves the look that AUTHORISES the tap to after the dwell. It does
// not place the target precisely, it does not replace the click's own scroll
// (which still runs, to a randomised band this side cannot reproduce), and it is
// not evidence that the tap looks human — nothing measured here says what the
// device then did with either verb.
//
// ⛔ THE ARCHITECTURAL HALF MATTERS AS MUCH AS THE TIMING HALF. An inserted beat
// is NOT a step: it never enters `results`, `onStep`, `onStepStart`, the step
// history the planner sees, or the segment's `ok`, and its failure is swallowed.
// A dropped frame on a pause must never fail a customer's step. Most of the arms
// below are about that.

import { describe, expect, it, vi } from 'vitest';
import {
  ControlPlaneAgentExecutor,
  DRAWN_GAP_MAX_FACTOR,
  type IntentDispatcher,
} from '../../src/services/agent-executor-control-plane.js';
import type { AgentIntent } from '../../src/services/agent-decomposer.js';
import type { IntentResult } from '../../src/services/agent-executor.js';
import {
  decodeWireData,
  encodeWireData,
  parseIntentResult,
  type ParsedIntentResult,
} from '../../src/services/harness-control-codec.js';
import type { IntentDispatch } from '../../src/schemas/harness-control-protocol.js';

// ⛔ A NEUTRAL TARGET. A caption the consequential gate recognises would halt
// this step before any look is taken, and every arm below would then be about
// the gate rather than about the beat.
const TAP: AgentIntent = { kind: 'interact', action: 'tap', selector: '#next' };

interface Sent {
  name: string;
  params: Record<string, unknown>;
}

/**
 * A perceive answer for one element, with the verdict and the bounds the caller
 * cares about.
 *
 * ⛔ `y` IS LOAD-BEARING HERE, not decoration: it is the only thing that says
 * which way the target sits outside the viewport, and it is what the beat's
 * scroll direction is read from.
 */
function look(opts: {
  offscreen?: boolean;
  y?: number;
  /** A cover the DEVICE reports at the tap point — the answer a re-look gives
   *  when this beat's own scroll has left the target under a sticky header. */
  coveredBy?: string;
}): Record<string, unknown> {
  const bounds = { x: 10, y: opts.y ?? 1_400, width: 120, height: 40 };
  const offscreen = opts.offscreen !== false;
  const cover = opts.coveredBy;
  return {
    value: {
      url: 'https://shop.test/checkout',
      title: 'Checkout',
      elements: [
        {
          id: 0,
          type: 'button',
          label: 'Continue',
          selector: '#next',
          bounds,
          state: { visible: true, enabled: true, focused: false },
          position_summary: offscreen ? 'below the fold' : 'in view',
          tap_point: { x: 70, y: bounds.y + 20 },
          hit:
            cover !== undefined
              ? { type: 'other', label: cover, selector: '.sticky-header', bounds }
              : offscreen
                ? null
                : { type: 'button', label: 'Continue', selector: '#next', bounds },
          occluded: offscreen || cover !== undefined,
          occlusion_reason:
            cover !== undefined
              ? 'hit_is_not_target_or_descendant'
              : offscreen
                ? 'tap_point_outside_viewport'
                : null,
        },
      ],
      truncated: false,
      total_matched: 1,
      resolved_by: 'script',
    },
  };
}

/**
 * A device that answers every verb the beat and the tap use.
 *
 * `perceive` answers from `looks` by call number, so an arm can make the
 * SECOND look (the one after the beat) say something different from the first —
 * which is the whole point of re-looking.
 */
function device(opts: { looks: (call: number) => Record<string, unknown>; beatFails?: boolean }): {
  sent: Sent[];
  dispatcher: IntentDispatcher;
} {
  const sent: Sent[] = [];
  let perceives = 0;
  return {
    sent,
    dispatcher: {
      dispatch: (d: IntentDispatch): Promise<ParsedIntentResult> => {
        const params = decodeWireData(d.inputParams) as Record<string, unknown>;
        sent.push({ name: d.intentName, params });
        const ok = (output: Record<string, unknown>): ParsedIntentResult =>
          parseIntentResult(
            {
              type: 'intentResult',
              sessionId: d.sessionId,
              intentId: d.intentId,
              success: true,
              durationMs: 3,
              outputData: encodeWireData(output),
            },
            d.intentName,
          );
        const fail = (): ParsedIntentResult =>
          parseIntentResult(
            {
              type: 'intentResult',
              sessionId: d.sessionId,
              intentId: d.intentId,
              success: false,
              durationMs: 3,
              errorCode: 'intent_webdriver_failed',
            },
            d.intentName,
          );
        switch (d.intentName) {
          case 'perceive':
            perceives += 1;
            return Promise.resolve(ok(opts.looks(perceives)));
          case 'scroll':
            return Promise.resolve(
              opts.beatFails === true ? fail() : ok({ scrolled_px: 600, behavioral: true }),
            );
          case 'behavioral_pause':
            return Promise.resolve(
              opts.beatFails === true
                ? fail()
                : ok({ paused_ms: 900, capped: false, behavioral: true }),
            );
          case 'click':
            return Promise.resolve(
              ok({ clicked: String(params.value), behavioral: true, activated: true }),
            );
          default:
            return Promise.resolve(fail());
        }
      },
    },
  };
}

function executor(
  dispatcher: IntentDispatcher,
  opts: Record<string, unknown> = {},
): ControlPlaneAgentExecutor {
  let n = 0;
  return new ControlPlaneAgentExecutor(dispatcher, () => `int_${String((n += 1))}`, {
    sleep: () => Promise.resolve(),
    // Fixed at the top of the band, so the arms below read the LARGEST a draw
    // can produce and the cap assertion is the one that can fail.
    makeRandom: () => () => 0.999999,
    // The beat ships DEFAULT OFF (see `relocationBeat` on the executor's
    // options); every arm here is about the beat, so it is turned on, and the
    // arms that pass `relocationBeat: false` still override it.
    relocationBeat: true,
    ...opts,
  });
}

function names(sent: Sent[]): string[] {
  return sent.map((s) => s.name);
}

describe('R5 — the beat before a tap the look could not see', () => {
  it('CRITICAL scroll, dwell, LOOK AGAIN, then tap — in that order', async () => {
    const d = device({ looks: () => look({}) });
    const res = await executor(d.dispatcher).execute({
      sessionId: 'ses_r5',
      agentSessionId: 'agt_r5',
      plan: { kind: 'plan', intents: [TAP], tokensConsumed: 0 },
    });

    // ⛔ THE ORDER IS THE RULE. Never between the look that authorises the tap
    // and the tap itself: seconds there let a cookie banner appear after the
    // look and take the tap. So the dwell goes BEFORE a fresh look, and the
    // fresh look is the one the gate and the tap are decided on.
    expect(names(d.sent)).toEqual(['perceive', 'scroll', 'behavioral_pause', 'perceive', 'click']);
    expect(res.ok).toBe(true);
  });

  it('the scroll goes TOWARD the target, and a target above the fold is scrolled UP', async () => {
    const below = device({ looks: () => look({ y: 1_400 }) });
    await executor(below.dispatcher).execute({
      sessionId: 'ses_a',
      agentSessionId: 'agt_a',
      plan: { kind: 'plan', intents: [TAP], tokensConsumed: 0 },
    });
    expect(below.sent.find((s) => s.name === 'scroll')?.params).toMatchObject({
      direction: 'down',
    });

    const above = device({ looks: () => look({ y: -800 }) });
    await executor(above.dispatcher).execute({
      sessionId: 'ses_b',
      agentSessionId: 'agt_b',
      plan: { kind: 'plan', intents: [TAP], tokensConsumed: 0 },
    });
    expect(above.sent.find((s) => s.name === 'scroll')?.params).toMatchObject({ direction: 'up' });
  });

  it('the dwell is DRAWN and CAPPED — a constant dwell is a signature of its own', async () => {
    const drawn = new Set<number>();
    for (const [index, seed] of [0, 0.25, 0.5, 0.75, 0.999999].entries()) {
      const d = device({ looks: () => look({}) });
      await executor(d.dispatcher, { makeRandom: () => () => seed }).execute({
        sessionId: `ses_${String(index)}`,
        agentSessionId: `agt_${String(index)}`,
        plan: { kind: 'plan', intents: [TAP], tokensConsumed: 0 },
      });
      const pause = d.sent.find((s) => s.name === 'behavioral_pause');
      const ms = Number(pause?.params.duration_ms);
      expect(Number.isFinite(ms)).toBe(true);
      drawn.add(ms);
    }
    // Five different draws, five different dwells: the band is real.
    expect(drawn.size).toBeGreaterThan(1);
    // …and nothing in it holds a rented phone. The cap is this side's, not the
    // device's 300s protocol limit.
    for (const ms of drawn) {
      expect(ms).toBeGreaterThan(0);
      expect(ms).toBeLessThanOrEqual(2_500);
      // And inside the band a draw around the base could have produced.
      expect(ms).toBeLessThanOrEqual(Math.round(900 * DRAWN_GAP_MAX_FACTOR));
    }
  });

  it('CRITICAL `require_unoccluded` survives the beat, even though the re-look now says CLEAR', async () => {
    // ⛔ THE TRAP THIS ARM EXISTS FOR. After the scroll the target is in view,
    // so the second look reads `clear` — and `unoccludedCheckFor` would then
    // have dropped the device's own check at the real tap point. It must not:
    // the look's point is still NOT where the tap lands, because the click
    // scrolls again to a randomised band this side cannot reproduce. Removing
    // the check would have been a safety regression delivered by a stealth fix.
    const d = device({
      looks: (call) => (call === 1 ? look({}) : look({ offscreen: false, y: 200 })),
    });
    const res = await executor(d.dispatcher).execute({
      sessionId: 'ses_keep',
      agentSessionId: 'agt_keep',
      plan: { kind: 'plan', intents: [TAP], tokensConsumed: 0 },
    });
    expect(res.ok).toBe(true);
    expect(d.sent.find((s) => s.name === 'click')?.params).toEqual({
      strategy: 'css selector',
      value: '#next',
      require_unoccluded: true,
    });
  });

  it('CRITICAL the beat cannot REFUSE a tap the first look let through — a cover at OUR scroll position', async () => {
    // ⛔ THE REGRESSION THIS ARM EXISTS FOR, found in review. The beat's scroll
    // distance is drawn without knowing how far the target is, so it can leave
    // the target under a sticky header — and the re-look then answers
    // `covered`, which ends the step and halts the plan. That would make an
    // inserted beat the reason a customer's tap failed, which is the one thing
    // a beat must never be: before the beat existed this same page produced
    // `outside_viewport` and the tap went WITH `require_unoccluded`, i.e. the
    // DEVICE checking the real tap point after its own scroll to a band this
    // side cannot reproduce. That check is the authority here, not our scroll
    // position, so the pre-beat look stays the deciding one.
    const d = device({
      looks: (call) =>
        call === 1 ? look({}) : look({ offscreen: false, y: 200, coveredBy: 'Sticky header' }),
    });
    const res = await executor(d.dispatcher).execute({
      sessionId: 'ses_cover',
      agentSessionId: 'agt_cover',
      plan: { kind: 'plan', intents: [TAP], tokensConsumed: 0 },
    });
    // The tap was SENT, and it was sent with the device's own check on it.
    expect(names(d.sent)).toEqual(['perceive', 'scroll', 'behavioral_pause', 'perceive', 'click']);
    expect(d.sent.find((s) => s.name === 'click')?.params).toEqual({
      strategy: 'css selector',
      value: '#next',
      require_unoccluded: true,
    });
    expect(res.ok).toBe(true);
    expect(res.results.map((r) => r.kind)).toEqual(['success']);

    // ⛔ NEGATIVE CONTROL, in the same breath: a cover the FIRST look sees is
    // still a refusal. This arm is about a verdict the beat's own scroll
    // produced, not about switching the cover check off.
    const first = device({
      looks: () => look({ offscreen: false, y: 200, coveredBy: 'Consent dialog' }),
    });
    const refused = await executor(first.dispatcher).execute({
      sessionId: 'ses_cover2',
      agentSessionId: 'agt_cover2',
      plan: { kind: 'plan', intents: [TAP], tokensConsumed: 0 },
    });
    expect(names(first.sent)).toEqual(['perceive']);
    expect(refused.ok).toBe(false);
  });

  it('⛔ MUTATION ARM: with the beat switched off, the SAME page is tapped with no scroll and no dwell', async () => {
    const d = device({ looks: () => look({}) });
    const res = await executor(d.dispatcher, { relocationBeat: false }).execute({
      sessionId: 'ses_off',
      agentSessionId: 'agt_off',
      plan: { kind: 'plan', intents: [TAP], tokensConsumed: 0 },
    });
    expect(names(d.sent)).toEqual(['perceive', 'click']);
    expect(res.ok).toBe(true);
    // The check is still sent — it always was, on this verdict.
    expect(d.sent.find((s) => s.name === 'click')?.params).toMatchObject({
      require_unoccluded: true,
    });
  });

  it('a tap the look CAN see gets no beat at all', async () => {
    const d = device({ looks: () => look({ offscreen: false, y: 200 }) });
    await executor(d.dispatcher).execute({
      sessionId: 'ses_inview',
      agentSessionId: 'agt_inview',
      plan: { kind: 'plan', intents: [TAP], tokensConsumed: 0 },
    });
    expect(names(d.sent)).toEqual(['perceive', 'click']);
  });
});

describe('R5 — an inserted beat is not a step', () => {
  it('CRITICAL it never enters results, the announced steps, or the segment’s verdict', async () => {
    const d = device({ looks: () => look({}) });
    const results: IntentResult[] = [];
    const started: AgentIntent[] = [];
    const res = await executor(d.dispatcher).execute({
      sessionId: 'ses_steps',
      agentSessionId: 'agt_steps',
      plan: { kind: 'plan', intents: [TAP], tokensConsumed: 0 },
      onStep: (result) => results.push(result),
      onStepStart: (intent) => started.push(intent),
    });

    // One planned step in, one result out — five dispatches on the wire.
    expect(res.results).toHaveLength(1);
    expect(results).toHaveLength(1);
    expect(started).toEqual([TAP]);
    expect(d.sent).toHaveLength(5);
    expect(res.results[0]).toMatchObject({ kind: 'success', intent: TAP });
    expect(res.ok).toBe(true);
    // ⛔ And nothing the planner will be shown mentions a scroll or a pause: a
    // planner that learned to imitate inserted beats would start emitting them
    // as steps, which is the one thing this seam exists to avoid.
    for (const result of res.results) {
      expect(result.intent.kind).not.toBe('scroll');
      expect(result.intent.kind).not.toBe('behavioral_pause');
    }
  });

  it('CRITICAL a beat that FAILS never fails the segment — the tap goes ahead exactly as before', async () => {
    const d = device({ looks: () => look({}), beatFails: true });
    const res = await executor(d.dispatcher).execute({
      sessionId: 'ses_fail',
      agentSessionId: 'agt_fail',
      plan: { kind: 'plan', intents: [TAP], tokensConsumed: 0 },
    });
    // Both halves of the beat were refused by the device, so nothing happened
    // and no re-look is taken — the tap goes with the look it already had.
    expect(names(d.sent)).toEqual(['perceive', 'scroll', 'behavioral_pause', 'click']);
    expect(res.ok).toBe(true);
    expect(res.results).toHaveLength(1);
    expect(res.results[0]?.kind).toBe('success');
  });

  it('a device that throws on the inserted verbs still runs the step', async () => {
    // The dispatch port's contract says it never rejects. This seam must
    // survive one that does anyway: a beat can never be the reason a step did
    // not run.
    let perceives = 0;
    const sent: string[] = [];
    const res = await executor({
      dispatch: (d: IntentDispatch): Promise<ParsedIntentResult> => {
        sent.push(d.intentName);
        if (d.intentName === 'scroll' || d.intentName === 'behavioral_pause') {
          return Promise.reject(new Error('the device fell over'));
        }
        if (d.intentName === 'perceive') {
          perceives += 1;
          return Promise.resolve(
            parseIntentResult(
              {
                type: 'intentResult',
                sessionId: d.sessionId,
                intentId: d.intentId,
                success: true,
                durationMs: 3,
                outputData: encodeWireData(look({})),
              },
              d.intentName,
            ),
          );
        }
        return Promise.resolve(
          parseIntentResult(
            {
              type: 'intentResult',
              sessionId: d.sessionId,
              intentId: d.intentId,
              success: true,
              durationMs: 3,
              outputData: encodeWireData({ clicked: '#next', behavioral: true, activated: true }),
            },
            d.intentName,
          ),
        );
      },
    }).execute({
      sessionId: 'ses_throw',
      agentSessionId: 'agt_throw',
      plan: { kind: 'plan', intents: [TAP], tokensConsumed: 0 },
    });
    expect(sent).toEqual(['perceive', 'scroll', 'behavioral_pause', 'click']);
    expect(perceives).toBe(1);
    expect(res.ok).toBe(true);
  });

  it('Stop during the beat ends the run and the tap is never sent', async () => {
    const controller = new AbortController();
    const sent: string[] = [];
    const res = await executor({
      dispatch: (d: IntentDispatch): Promise<ParsedIntentResult> => {
        sent.push(d.intentName);
        if (d.intentName === 'scroll') controller.abort();
        return Promise.resolve(
          parseIntentResult(
            {
              type: 'intentResult',
              sessionId: d.sessionId,
              intentId: d.intentId,
              success: true,
              durationMs: 3,
              outputData: encodeWireData(
                d.intentName === 'perceive'
                  ? look({})
                  : d.intentName === 'scroll'
                    ? { scrolled_px: 600, behavioral: true }
                    : { clicked: '#next', behavioral: true, activated: true },
              ),
            },
            d.intentName,
          ),
        );
      },
    }).execute({
      sessionId: 'ses_stop',
      agentSessionId: 'agt_stop',
      plan: { kind: 'plan', intents: [TAP], tokensConsumed: 0 },
      signal: controller.signal,
    });
    expect(res.stopped).toBe(true);
    expect(sent).toEqual(['perceive', 'scroll']);
    expect(res.results).toHaveLength(0);
  });

  it('CRITICAL no beat in front of a screen asking the customer to approve something', async () => {
    // The gate is reached with nothing dispatched at all — not even the look,
    // which is the rule that already stood. The beat inherits it: a purchase
    // the customer has not approved gets no scroll, no dwell and no read.
    const d = device({ looks: () => look({}) });
    const onStepStart = vi.fn();
    const res = await executor(d.dispatcher).execute({
      sessionId: 'ses_gate',
      agentSessionId: 'agt_gate',
      plan: {
        kind: 'plan',
        intents: [{ kind: 'interact', action: 'tap', selector: '#place-order', value: 'Buy now' }],
        tokensConsumed: 0,
      },
      onStepStart,
    });
    expect(res.awaitingConfirmation).toBe(true);
    expect(d.sent).toHaveLength(0);
    expect(onStepStart).not.toHaveBeenCalled();
  });
});

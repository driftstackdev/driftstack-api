// S6 — the fixture every pace test shares: a device that answers the verbs a
// paced turn uses and RECORDS WHAT REACHED THE WIRE, in order, with params.
//
// ⛔ WHY ONE HARNESS AND NOT EIGHT COPIES. Every claim these tests make is a
// claim about the DISPATCH SEQUENCE — what was sent, in what order, with what
// parameters. Eight hand-rolled devices would be eight chances for one of them
// to answer a verb differently and turn a shared property into eight unrelated
// ones. The tests differ in their PLANS, which is where they should differ.
//
// ⛔ AND IT IS NOT A PRODUCT DOUBLE. Nothing here models what a real device does
// with a pause — how long it really holds, whether the screen moves, what a page
// could observe. Every assertion built on it is about what this server SENT.

import {
  ControlPlaneAgentExecutor,
  type IntentDispatcher,
} from '../../../src/services/agent-executor-control-plane.js';
import {
  decodeWireData,
  encodeWireData,
  parseIntentResult,
  type ParsedIntentResult,
} from '../../../src/services/harness-control-codec.js';
import type { IntentDispatch } from '../../../src/schemas/harness-control-protocol.js';
import {
  newPaceBudget,
  type PaceBudget,
  type PacedBand,
} from '../../../src/services/agent-pace.js';

/** One dispatch as the wire carried it. */
export interface Sent {
  name: string;
  params: Record<string, unknown>;
}

export interface PaceDevice {
  sent: Sent[];
  dispatcher: IntentDispatcher;
}

/**
 * A perceive answer for one element, clear at its tap point unless told
 * otherwise — the ordinary case, so a placement test is about placement.
 */
export function clearLook(selector: string, label = 'Continue'): Record<string, unknown> {
  const bounds = { x: 10, y: 200, width: 120, height: 40 };
  return {
    value: {
      url: 'https://shop.test/page',
      title: 'Page',
      elements: [
        {
          id: 0,
          type: 'button',
          label,
          selector,
          bounds,
          state: { visible: true, enabled: true, focused: false },
          position_summary: 'in view',
          tap_point: { x: 70, y: bounds.y + 20 },
          hit: { type: 'button', label, selector, bounds },
          occluded: false,
          occlusion_reason: null,
        },
      ],
      truncated: false,
      total_matched: 1,
      resolved_by: 'script',
    },
  };
}

/**
 * A device that answers every verb a paced turn can send.
 *
 * `pauseFails` makes EVERY `behavioral_pause` come back a failure, which is the
 * fixture `a-pacing-pause-that-fails-does-not-fail-the-segment` is built on.
 * `clickFails` does the same for a PLANNED tap, which is that file's negative
 * control: without it, "the segment survived" could mean "this fixture cannot
 * fail a segment at all".
 */
export function paceDevice(
  opts: { pauseFails?: boolean; clickFails?: boolean; lookLabel?: string } = {},
): PaceDevice {
  const sent: Sent[] = [];
  return {
    sent,
    dispatcher: {
      dispatch: (d: IntentDispatch): Promise<ParsedIntentResult> => {
        const params = decodeWireData(d.inputParams) as Record<string, unknown>;
        sent.push({ name: d.intentName, params });
        /** One param as a string. ⛔ NOT `String(x)`: a param that arrived as an
         *  object would stringify to `[object Object]` and the fixture would
         *  answer a plausible-looking result about a dispatch nobody sent. */
        const text = (key: string, fallback: string): string =>
          typeof params[key] === 'string' ? params[key] : fallback;
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
          case 'navigate':
            return Promise.resolve(ok({ url: text('url', 'https://shop.test/page') }));
          case 'perceive':
            return Promise.resolve(
              ok(clearLook(text('value', '#next'), opts.lookLabel ?? 'Continue')),
            );
          case 'click':
            return Promise.resolve(
              opts.clickFails === true
                ? fail()
                : ok({ clicked: text('value', '#next'), behavioral: true, activated: true }),
            );
          case 'send_keys':
            return Promise.resolve(
              ok({
                typed_into: text('value', '#field'),
                length: 4,
                truncated: false,
                behavioral: true,
              }),
            );
          case 'press_key':
            return Promise.resolve(ok({ pressed: text('key', 'Enter') }));
          case 'scroll':
            return Promise.resolve(
              ok({
                scrolled: 600,
                requested: 600,
                scrolled_measured: true,
                flicks: 2,
                steps: 0,
                behavioral: true,
                distance_capped: false,
              }),
            );
          case 'screenshot':
            return Promise.resolve(
              ok({ screenshot_b64: 'aGk=', format: 'png', full_page: false, annotated: false }),
            );
          case 'get_page_source':
            return Promise.resolve(
              ok({ source: '<html><body>page</body></html>', truncated: false }),
            );
          case 'behavioral_pause':
            return Promise.resolve(
              opts.pauseFails === true
                ? fail()
                : ok({
                    paused_ms: Number(params.duration_ms ?? 0),
                    capped: false,
                    behavioral: true,
                  }),
            );
          default:
            return Promise.resolve(fail());
        }
      },
    },
  };
}

/**
 * An executor with the injected seams every pace test needs fixed: no real
 * sleeping, and a generator the test chooses.
 *
 * ⛔ `makeRandom` IS PER SESSION AND IS GIVEN THE SESSION ID, exactly as
 * production's is. A test that handed one shared closure to every session would
 * be unable to see the property `two-sessions-running-one-task-do-not-share-a-
 * rhythm` exists to check, because it would have destroyed it in the fixture.
 */
export function paceExecutor(
  dispatcher: IntentDispatcher,
  opts: Record<string, unknown> = {},
): ControlPlaneAgentExecutor {
  let n = 0;
  return new ControlPlaneAgentExecutor(dispatcher, () => `int_${String((n += 1))}`, {
    sleep: () => Promise.resolve(),
    ...opts,
  });
}

/** A generator that walks a fixed list and then repeats its last value — so a
 *  test can say exactly which draw decides what, in order. */
export function draws(values: readonly number[]): () => number {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)] ?? 0.5;
}

/** A pace budget seeded for one segment. `pageWordCount` null means "no page
 *  read yet", which is what a blind first segment carries. */
export function budgetFor(
  band: PacedBand,
  segmentRemainingMs: number,
  extra: Partial<PaceBudget> = {},
): PaceBudget {
  return {
    ...newPaceBudget(band),
    segmentRemainingMs,
    // Every test but `pace-never-delays-the-first-thing-the-customer-sees`
    // starts from "the customer has already seen a step this turn"; that one
    // overrides it back to false, which is the state a real turn starts in.
    anyStepEmitted: true,
    ...extra,
  };
}

export function names(sent: readonly Sent[]): string[] {
  return sent.map((s) => s.name);
}

/** Every inserted pause's requested duration, in the order it was sent. */
export function pauseDurations(sent: readonly Sent[]): number[] {
  return sent.filter((s) => s.name === 'behavioral_pause').map((s) => Number(s.params.duration_ms));
}

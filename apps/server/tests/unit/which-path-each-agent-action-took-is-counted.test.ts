// WHICH PATH EACH ACTION TOOK, AND HOW THE DEVICE FOUND WHAT IT ACTED ON.
//
// The device spells TWO different facts with one wire key, `behavioral`
// (IntentExecutor.swift, read 2026-09-20), and they are counted as two metrics:
//
//   · on click and send_keys it is `persona != nil` — whether a BEHAVIOUR
//     PROFILE WAS ATTACHED to the session. A CONFIGURATION fact. `false` is a
//     misconfiguration nothing else reports, because the step SUCCEEDS; `true`
//     is necessary and NOT sufficient for the human-like path to have run, and
//     nothing here measures what the device then did
//   · on scroll it names which of two implementations ran, chosen by the SAME
//     predicate — so it is that same fact under another name, never a second
//     piece of evidence, and never alerted on
//
// Different metric NAMES are what stop a dashboard summing the two by accident.
//
// Every arm here is written so that removing the behaviour fails it:
//
//   · every enum value is reachable, and is reached by driving the executor
//   · a step that FAILS is still counted — that is the whole point. A failed
//     native resolution falling back to script is the transition an audit is
//     looking for, and it shows up on the steps that go wrong
//   · a retry counts twice: a retry is another action the page saw
//   · a device whose result omits the flag counts as `unreported`, NEVER as
//     `true`, because this is the one counter that can see the misconfiguration
//   · a step Stop abandoned in flight is counted ONCE
//   · a click never touches the scroll metric and a scroll never touches the
//     profile metric
//   · no label and no log field can carry customer content
//
// Two arms are explicit NEGATIVE CONTROLS, each paired with the arm it
// protects, because both mutations leave a green-looking counter.

import { describe, expect, it } from 'vitest';
import type { AgentIntent } from '@driftstack/api-types';
import {
  ControlPlaneAgentExecutor,
  type AutoRetryOptions,
  type IntentDispatcher,
} from '../../src/services/agent-executor-control-plane.js';
import type { ExecuteArgs, ExecutorRunResult } from '../../src/services/agent-executor.js';
import {
  decodeWireData,
  encodeWireData,
  parseIntentResult,
  type ParsedIntentResult,
} from '../../src/services/harness-control-codec.js';
import type { IntentDispatch } from '../../src/schemas/harness-control-protocol.js';
import { MetricsRegistry, METRIC_NAMES } from '../../src/services/metrics-registry.js';
import {
  AGENT_ACTION_OUTCOMES,
  AGENT_ACTION_PROFILE_VERBS,
  AGENT_PROFILE_ATTACHED_VALUES,
  AGENT_SCROLL_PATHS,
  AGENT_TURN_ACTION_PATHS_EVENT,
  AGENT_TURN_ACTION_PATH_LOG_KEYS,
  LOOK_TO_TAP_BUCKETS_SECONDS,
  PRE_TAP_LOOK_NEXT_ACTIONS,
  PRE_TAP_LOOK_OUTCOMES,
  PRE_TAP_LOOK_RESOLVERS,
  agentActionPathLogFields,
  emptyAgentActionPathCounts,
  type AgentActionPathCounts,
} from '../../src/services/agent-turn-telemetry.js';

// ── a device that answers however a test says ──────────────────────────────

type Answer =
  /** A well-formed frame, through the REAL codec: an answer the wire could
   *  never carry fails here exactly as it would in production. */
  | { kind: 'ok'; output: Record<string, unknown> }
  | { kind: 'error'; code: string }
  /** A decoded result handed straight to the executor, bypassing the codec —
   *  the ONLY way to model a result that reaches the executor missing a field
   *  the schema requires today. Used once, by the older-device arm. */
  | { kind: 'raw'; outputData: unknown };

type Script = Partial<Record<string, (call: number) => Answer>>;

interface Device {
  dispatcher: IntentDispatcher;
  sent: Array<{ name: string; params: Record<string, unknown> }>;
}

/** A perceive-by-selector answer, as a device that resolves the selector sends
 *  it. `resolvedBy` is the device's own word for which resolver found it. */
function lookAnswer(
  opts: {
    resolvedBy?: 'native' | 'script';
    occluded?: boolean;
    occlusionReason?: string | null;
    hit?: { type: string; label: string; selector: string } | null;
    none?: boolean;
  } = {},
): Record<string, unknown> {
  const bounds = { x: 10, y: 100, width: 120, height: 40 };
  const element = {
    id: 0,
    type: 'button',
    label: 'Continue',
    selector: '#go',
    bounds,
    state: { visible: true, enabled: true, focused: false },
    position_summary: 'in view',
    tap_point: { x: 70, y: 120 },
    hit:
      opts.hit === undefined
        ? { type: 'button', label: 'Continue', selector: '#go', bounds }
        : opts.hit === null
          ? null
          : { ...opts.hit, bounds },
    occluded: opts.occluded ?? false,
    occlusion_reason: opts.occlusionReason ?? null,
  };
  return {
    value: {
      url: 'https://shop.test/',
      title: 'Shop',
      elements: opts.none === true ? [] : [element],
      truncated: false,
      total_matched: opts.none === true ? 0 : 1,
      resolved_by: opts.resolvedBy ?? 'script',
    },
  };
}

/** What a device from before perceive-by-selector answers: a page listing with
 *  none of the new fields, and so no `resolved_by` tell. */
const OLDER_DEVICE_LISTING: Record<string, unknown> = {
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

// `behavioral` on the wire is the device's own key. On a click or a typed step
// it is `persona != nil`; on a scroll it names the implementation. Spelled here
// as the device spells it, read here as the two facts it carries.
const clickResult = (profileAttached: boolean): Record<string, unknown> => ({
  clicked: '#go',
  behavioral: profileAttached,
  activated: true,
});
const sendKeysResult = (profileAttached: boolean): Record<string, unknown> => ({
  typed_into: '#field',
  length: 4,
  truncated: false,
  behavioral: profileAttached,
});
const scrollResult = (behavioral: boolean): Record<string, unknown> => ({
  scrolled: 600,
  requested: 600,
  scrolled_measured: true,
  flicks: 2,
  steps: 3,
  behavioral,
  distance_capped: false,
});

function scriptedDevice(script: Script): Device {
  const sent: Array<{ name: string; params: Record<string, unknown> }> = [];
  const calls = new Map<string, number>();
  const frame = (d: IntentDispatch, output: unknown): ParsedIntentResult =>
    parseIntentResult(
      {
        type: 'intentResult',
        sessionId: d.sessionId,
        intentId: d.intentId,
        success: true,
        durationMs: 7,
        outputData: encodeWireData(output),
      },
      d.intentName,
    );
  const failure = (d: IntentDispatch, code: string): ParsedIntentResult =>
    parseIntentResult(
      {
        type: 'intentResult',
        sessionId: d.sessionId,
        intentId: d.intentId,
        success: false,
        durationMs: 5,
        errorCode: code,
      },
      d.intentName,
    );
  return {
    sent,
    dispatcher: {
      dispatch: (d: IntentDispatch): Promise<ParsedIntentResult> => {
        const params = decodeWireData(d.inputParams) as Record<string, unknown>;
        sent.push({ name: d.intentName, params });
        const n = (calls.get(d.intentName) ?? 0) + 1;
        calls.set(d.intentName, n);
        const reply = script[d.intentName]?.(n);
        if (reply === undefined) return Promise.resolve(failure(d, 'intent_not_implemented'));
        if (reply.kind === 'error') return Promise.resolve(failure(d, reply.code));
        if (reply.kind === 'raw') {
          return Promise.resolve({
            sessionId: d.sessionId,
            intentId: d.intentId,
            success: true,
            durationMs: 7,
            outputData: reply.outputData,
          });
        }
        return Promise.resolve(frame(d, reply.output));
      },
    },
  };
}

/** A dispatcher that never answers until the test releases it, so a Stop can
 *  land while one dispatch is in flight. */
function heldDevice(): Device & { release: () => void } {
  const sent: Array<{ name: string; params: Record<string, unknown> }> = [];
  const pending: Array<() => void> = [];
  return {
    sent,
    release: () => {
      for (const r of pending.splice(0)) r();
    },
    dispatcher: {
      dispatch: (d: IntentDispatch): Promise<ParsedIntentResult> => {
        sent.push({ name: d.intentName, params: decodeWireData(d.inputParams) as never });
        return new Promise<ParsedIntentResult>((resolve) => {
          pending.push(() =>
            resolve({
              sessionId: d.sessionId,
              intentId: d.intentId,
              success: false,
              durationMs: 1,
              errorCode: 'intent_dispatch_error',
            }),
          );
        });
      },
    },
  };
}

// ── the registry, with the labels production registers ─────────────────────

function registry(): MetricsRegistry {
  const m = new MetricsRegistry();
  m.registerCounter(METRIC_NAMES.agentActionProfileAttachedTotal, 'actions', [
    'verb',
    'profile_attached',
    'outcome',
  ]);
  m.registerCounter(METRIC_NAMES.agentScrollPathTotal, 'scrolls', ['path', 'outcome']);
  m.registerCounter(METRIC_NAMES.agentPreTapLookTotal, 'looks', ['outcome', 'resolved_by', 'then']);
  m.registerHistogram(
    METRIC_NAMES.agentLookToTapSeconds,
    'look to tap',
    LOOK_TO_TAP_BUCKETS_SECONDS,
    ['verb'],
  );
  return m;
}

const TAP: AgentIntent = { kind: 'interact', action: 'tap', selector: '#go' };
const TYPE: AgentIntent = {
  kind: 'interact',
  action: 'type',
  selector: '#field',
  value: 'word',
};
const SCROLL: AgentIntent = { kind: 'scroll', direction: 'down' };

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
    sessionId: 'agt_paths',
    plan: { kind: 'plan', intents, tokensConsumed: 0 },
    ...extra,
  });
}

/** Every `driftstack_agent_action_profile_attached_total` series a run moved. */
function actionSeries(m: MetricsRegistry): Record<string, number> {
  const out: Record<string, number> = {};
  for (const verb of AGENT_ACTION_PROFILE_VERBS) {
    for (const profile_attached of AGENT_PROFILE_ATTACHED_VALUES) {
      for (const outcome of AGENT_ACTION_OUTCOMES) {
        const v = m.getValue(METRIC_NAMES.agentActionProfileAttachedTotal, {
          verb,
          profile_attached,
          outcome,
        });
        if (v > 0) out[`${verb}/${profile_attached}/${outcome}`] = v;
      }
    }
  }
  return out;
}

/** Every `driftstack_agent_scroll_path_total` series a run moved. */
function scrollSeries(m: MetricsRegistry): Record<string, number> {
  const out: Record<string, number> = {};
  for (const path of AGENT_SCROLL_PATHS) {
    for (const outcome of AGENT_ACTION_OUTCOMES) {
      const v = m.getValue(METRIC_NAMES.agentScrollPathTotal, { path, outcome });
      if (v > 0) out[`${path}/${outcome}`] = v;
    }
  }
  return out;
}

/** Every `driftstack_agent_pre_tap_look_total` series a run moved. */
function lookSeries(m: MetricsRegistry): Record<string, number> {
  const out: Record<string, number> = {};
  for (const outcome of PRE_TAP_LOOK_OUTCOMES) {
    for (const resolved of PRE_TAP_LOOK_RESOLVERS) {
      for (const then of PRE_TAP_LOOK_NEXT_ACTIONS) {
        const v = m.getValue(METRIC_NAMES.agentPreTapLookTotal, {
          outcome,
          resolved_by: resolved,
          then,
        });
        if (v > 0) out[`${outcome}/${resolved}/${then}`] = v;
      }
    }
  }
  return out;
}

// ── how the device performed each action ───────────────────────────────────

describe('whether a behaviour profile was attached is counted per action', () => {
  it('a tap by a session with a profile attached is counted true / ok', async () => {
    const m = registry();
    const device = scriptedDevice({
      perceive: () => ({ kind: 'ok', output: lookAnswer({ resolvedBy: 'native' }) }),
      click: () => ({ kind: 'ok', output: clickResult(true) }),
    });
    const result = await run(executor(device.dispatcher, { metrics: m }), [TAP]);
    expect(actionSeries(m)).toEqual({ 'click/true/ok': 1 });
    expect(result.actionPaths?.profileAttached.true).toBe(1);
    // ⛔ `true` is the CONFIGURATION, not a verdict. Nothing in this run
    // measured what the device did with the profile, and no arm here may be
    // read as saying the tap was human-like.
    expect(result.actionPaths?.scrolls).toBe(0);
  });

  it.each([
    ['click', TAP, clickResult(false), 'click' as const],
    ['send_keys', TYPE, sendKeysResult(false), 'send_keys' as const],
  ])(
    'CRITICAL a %s by a session with NO behaviour profile attached is counted false — the step SUCCEEDS, so nothing else in the system reports the misconfiguration',
    async (verbName, intent, output, verb) => {
      const m = registry();
      const device = scriptedDevice({
        perceive: () => ({ kind: 'ok', output: lookAnswer({}) }),
        [verbName]: () => ({ kind: 'ok', output }),
      });
      const result = await run(executor(device.dispatcher, { metrics: m }), [intent]);
      expect(result.ok).toBe(true);
      expect(actionSeries(m)).toEqual({ [`${verb}/false/ok`]: 1 });
      expect(result.actionPaths?.unprofiledByVerb[verb]).toBe(1);
      // ⛔ AND IT NEVER TOUCHES THE SCROLL METRIC. The two facts share a wire
      // key and must never share a series.
      expect(scrollSeries(m)).toEqual({});
      expect(result.actionPaths?.scrolls).toBe(0);
    },
  );

  it('CRITICAL a segmented scroll is counted as a PATH and never touches the profile metric', async () => {
    const m = registry();
    const device = scriptedDevice({ scroll: () => ({ kind: 'ok', output: scrollResult(false) }) });
    const result = await run(executor(device.dispatcher, { metrics: m }), [SCROLL]);
    expect(scrollSeries(m)).toEqual({ 'segmented/ok': 1 });
    expect(actionSeries(m)).toEqual({});
    expect(result.actionPaths?.actions).toBe(0);
    expect(result.actionPaths?.scrolls).toBe(1);
    // A scroll is not a tap, so nothing looked before it.
    expect(result.actionPaths?.looks).toBe(0);
    expect(device.sent.map((s) => s.name)).toEqual(['scroll']);
  });

  it('CRITICAL a scroll result with no flag is `unreported`, never `flick` — the same obligation as the profile flag, on the other counter', async () => {
    const m = registry();
    const device = scriptedDevice({
      // The scroll schema requires the field today, so a frame without it fails
      // the wire contract. This models the reader's own obligation: a decoded
      // result handed to the executor with the field absent.
      scroll: () => ({
        kind: 'raw',
        outputData: {
          scrolled: 600,
          requested: 600,
          scrolled_measured: true,
          flicks: 2,
          steps: 3,
          distance_capped: false,
        },
      }),
    });
    await run(executor(device.dispatcher, { metrics: m }), [SCROLL]);
    expect(scrollSeries(m)).toEqual({ 'unreported/ok': 1 });

    // ⛔ NEGATIVE CONTROL for "an absent flag names the stronger path". A reader
    // that falls through to `flick` returns `flick` for this exact payload,
    // where the executor returned `unreported`, so the two disagree on the
    // input this arm uses and the mutation cannot satisfy it.
    const asIfMissingMeantFlick = (o: Record<string, unknown>): string =>
      o.behavioral === false ? 'segmented' : 'flick';
    expect(asIfMissingMeantFlick({ scrolled: 600 })).toBe('flick');
    expect(m.getValue(METRIC_NAMES.agentScrollPathTotal, { path: 'flick', outcome: 'ok' })).toBe(0);
  });

  it('the flick path is the other value of the same closed set, and is not evidence of anything the profile metric does not already say', async () => {
    const m = registry();
    const device = scriptedDevice({ scroll: () => ({ kind: 'ok', output: scrollResult(true) }) });
    await run(executor(device.dispatcher, { metrics: m }), [SCROLL]);
    expect(scrollSeries(m)).toEqual({ 'flick/ok': 1 });
    expect(actionSeries(m)).toEqual({});
  });

  it('a navigate is not an action with a behaviour to report, and is not counted at all', async () => {
    const m = registry();
    const device = scriptedDevice({
      navigate: () => ({ kind: 'ok', output: { url: 'https://shop.test/' } }),
    });
    const result = await run(executor(device.dispatcher, { metrics: m }), [
      { kind: 'navigate', url: 'https://shop.test/' },
    ]);
    expect(actionSeries(m)).toEqual({});
    expect(scrollSeries(m)).toEqual({});
    // Nothing to say: no counts object rather than a line of zeroes.
    expect(result.actionPaths).toBeUndefined();
  });

  it('CRITICAL a FAILED tap is still counted — unreported, failed — and its look still records which resolver found the control', async () => {
    const m = registry();
    const device = scriptedDevice({
      perceive: () => ({ kind: 'ok', output: lookAnswer({ resolvedBy: 'native' }) }),
      click: () => ({ kind: 'error', code: 'intent_invalid_parameter' }),
    });
    const result = await run(executor(device.dispatcher, { metrics: m }), [TAP]);
    expect(result.ok).toBe(false);
    expect(actionSeries(m)).toEqual({ 'click/unreported/failed': 1 });
    // The resolution path survives the failure — that is the transition the
    // audit is for, and a success-only counter would have lost exactly it.
    expect(lookSeries(m)).toEqual({ 'clear/native/tapped': 1 });

    // ⛔ NEGATIVE CONTROL for "count only on success". A counter that only fired
    // on a `kind: success` result would leave BOTH series above empty for this
    // run, and the suite would be green with the audit blind on every failed
    // step. The control is that the successful arm above and this one put their
    // counts in DIFFERENT series: neither can satisfy the other.
    expect(
      m.getValue(METRIC_NAMES.agentActionProfileAttachedTotal, {
        verb: 'click',
        profile_attached: 'true',
        outcome: 'ok',
      }),
    ).toBe(0);
  });

  it('a step whose failure the executor calls outcome-unknown is counted unknown, not failed', async () => {
    const m = registry();
    const device = scriptedDevice({
      perceive: () => ({ kind: 'ok', output: lookAnswer({}) }),
      // A coarse WebDriver failure on a page-changing step is the executor's
      // own "this may have taken effect and we cannot confirm it".
      click: () => ({ kind: 'error', code: 'intent_webdriver_failed' }),
    });
    await run(executor(device.dispatcher, { metrics: m, maxRetries: 0 }), [TAP]);
    expect(actionSeries(m)).toEqual({ 'click/unreported/unknown': 1 });
  });

  it('CRITICAL a retry counts twice — a retry is another action the page saw', async () => {
    const m = registry();
    const device = scriptedDevice({
      perceive: () => ({ kind: 'ok', output: lookAnswer({}) }),
      // element_not_found is the executor's retryable class; the second attempt
      // succeeds, with the device reporting a non-behavioural tap.
      click: (n) =>
        n === 1
          ? { kind: 'error', code: 'intent_element_not_found' }
          : { kind: 'ok', output: clickResult(false) },
    });
    const result = await run(executor(device.dispatcher, { metrics: m, elementAppearWaitMs: 0 }), [
      TAP,
    ]);
    expect(device.sent.filter((s) => s.name === 'click')).toHaveLength(2);
    expect(actionSeries(m)).toEqual({
      'click/unreported/failed': 1,
      'click/false/ok': 1,
    });
    expect(result.actionPaths?.actions).toBe(2);
    // The LOOK is one event for the step, not one per attempt.
    expect(result.actionPaths?.looks).toBe(1);
  });

  it('CRITICAL a device whose result omits the flag counts as unreported, never as true', async () => {
    const m = registry();
    const device = scriptedDevice({
      perceive: () => ({ kind: 'ok', output: lookAnswer({}) }),
      // The result schemas require the field today, so a frame without it fails
      // the wire contract. This models the reader's own obligation: a decoded
      // result handed to the executor with the field absent.
      click: () => ({ kind: 'raw', outputData: { clicked: '#go', activated: true } }),
    });
    await run(executor(device.dispatcher, { metrics: m }), [TAP]);
    expect(actionSeries(m)).toEqual({ 'click/unreported/ok': 1 });

    // ⛔ NEGATIVE CONTROL for "treat a missing flag as true". The reader that
    // does so returns `true` for this exact payload, where the executor
    // returned `unreported` — so the two disagree on the input this arm uses,
    // and the arm above cannot be satisfied by that mutation.
    const asIfMissingMeantTrue = (o: Record<string, unknown>): string =>
      o.behavioral === false ? 'false' : 'true';
    expect(asIfMissingMeantTrue({ clicked: '#go', activated: true })).toBe('true');
    expect(
      m.getValue(METRIC_NAMES.agentActionProfileAttachedTotal, {
        verb: 'click',
        profile_attached: 'true',
        outcome: 'ok',
      }),
    ).toBe(0);
  });

  it('a device whose click frame omits the flag fails the wire contract, and that failure is counted unreported too — never true, by either route', async () => {
    const m = registry();
    const device = scriptedDevice({
      perceive: () => ({ kind: 'ok', output: lookAnswer({}) }),
      click: () => ({ kind: 'error', code: 'intent_webdriver_failed' }),
    });
    await run(executor(device.dispatcher, { metrics: m, maxRetries: 0 }), [TAP]);
    const trues = AGENT_ACTION_OUTCOMES.reduce(
      (n, outcome) =>
        n +
        m.getValue(METRIC_NAMES.agentActionProfileAttachedTotal, {
          verb: 'click',
          profile_attached: 'true',
          outcome,
        }),
      0,
    );
    expect(trues).toBe(0);
  });

  it('CRITICAL a step Stop abandoned in flight is counted ONCE, as unreported', async () => {
    const m = registry();
    const device = heldDevice();
    const controller = new AbortController();
    const exec = executor(device.dispatcher, {
      metrics: m,
      preTapLookTimeoutMs: 0,
      // The grace runs out at once, so the step is abandoned rather than awaited.
      stopInFlightGraceMs: 0,
    });
    const pending = run(exec, [TAP], { signal: controller.signal });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    const result = await pending;
    device.release();
    expect(result.stopped).toBe(true);
    expect(actionSeries(m)).toEqual({ 'click/unreported/unknown': 1 });
    expect(result.actionPaths?.actions).toBe(1);
  });
});

// ── the per-step resolution path ───────────────────────────────────────────

describe('the pre-tap look records the per-step resolution path', () => {
  it.each([
    ['native', 'native' as const],
    ['script', 'script' as const],
  ])('records resolved_by=%s, which is the transition an audit watches for', async (_n, by) => {
    const m = registry();
    const device = scriptedDevice({
      perceive: () => ({ kind: 'ok', output: lookAnswer({ resolvedBy: by }) }),
      click: () => ({ kind: 'ok', output: clickResult(true) }),
    });
    await run(executor(device.dispatcher, { metrics: m }), [TAP]);
    expect(lookSeries(m)).toEqual({ [`clear/${by}/tapped`]: 1 });
  });

  it('a device that resolved the selector and found nothing is `none`, and the step is refused, not tapped', async () => {
    const m = registry();
    const device = scriptedDevice({
      perceive: () => ({ kind: 'ok', output: lookAnswer({ none: true }) }),
      wait_for: () => ({ kind: 'error', code: 'intent_webdriver_failed' }),
    });
    const result = await run(executor(device.dispatcher, { metrics: m }), [TAP]);
    expect(lookSeries(m)).toEqual({ 'not_found/none/refused': 1 });
    // Nothing reached the device, so nothing was counted as an action.
    expect(actionSeries(m)).toEqual({});
    expect(result.actionPaths?.looks).toBe(1);
  });

  it('a device that predates the look is `unanswered`, and the tap goes ahead exactly as before', async () => {
    const m = registry();
    const device = scriptedDevice({
      perceive: () => ({ kind: 'ok', output: OLDER_DEVICE_LISTING }),
      click: () => ({ kind: 'ok', output: clickResult(true) }),
    });
    await run(executor(device.dispatcher, { metrics: m }), [TAP]);
    expect(lookSeries(m)).toEqual({ 'fallback/unanswered/tapped': 1 });
    expect(actionSeries(m)).toEqual({ 'click/true/ok': 1 });
  });

  it('a covered control is refused before anything reaches the device', async () => {
    const m = registry();
    const device = scriptedDevice({
      perceive: () => ({
        kind: 'ok',
        output: lookAnswer({
          resolvedBy: 'native',
          occluded: true,
          occlusionReason: 'hit_is_not_target_or_descendant',
          hit: { type: 'other', label: 'Cookie banner', selector: '#banner' },
        }),
      }),
    });
    await run(executor(device.dispatcher, { metrics: m }), [TAP]);
    expect(lookSeries(m)).toEqual({ 'covered/native/refused': 1 });
    expect(actionSeries(m)).toEqual({});
  });

  it('typing is looked at the same way and records `typed`, because its first act is a tap on the field', async () => {
    const m = registry();
    const device = scriptedDevice({
      perceive: () => ({ kind: 'ok', output: lookAnswer({ resolvedBy: 'native' }) }),
      send_keys: () => ({ kind: 'ok', output: sendKeysResult(true) }),
    });
    await run(executor(device.dispatcher, { metrics: m }), [TYPE]);
    expect(lookSeries(m)).toEqual({ 'clear/native/typed': 1 });
    expect(actionSeries(m)).toEqual({ 'send_keys/true/ok': 1 });
  });

  it('a tap the repeat guard refuses is `not_sent` — told apart from the look refusing it itself', async () => {
    const m = registry();
    const device = scriptedDevice({
      perceive: () => ({ kind: 'ok', output: lookAnswer({ resolvedBy: 'script' }) }),
      click: () => ({ kind: 'ok', output: clickResult(true) }),
    });
    const result = await run(executor(device.dispatcher, { metrics: m }), [TAP], {
      repeatGuard: () => 'repeat_refused',
    });
    expect(result.repeatRefused).toBe('repeat_refused');
    expect(lookSeries(m)).toEqual({ 'clear/script/not_sent': 1 });
    expect(actionSeries(m)).toEqual({});
  });

  it('the gap between the look and the tap is measured on the executor’s own clock', async () => {
    const m = registry();
    let clock = 0;
    const device = scriptedDevice({
      perceive: () => {
        clock += 40;
        return { kind: 'ok', output: lookAnswer({}) };
      },
      click: () => ({ kind: 'ok', output: clickResult(true) }),
    });
    await run(
      executor(device.dispatcher, {
        metrics: m,
        now: () => {
          clock += 30;
          return clock;
        },
      }),
      [TAP],
    );
    const hist = m.getHistogram(METRIC_NAMES.agentLookToTapSeconds, { verb: 'click' });
    expect(hist.count).toBe(1);
    expect(hist.sum).toBeGreaterThan(0);
  });

  it('a look that never got an answer contributes nothing to the look→tap histogram, rather than a zero', async () => {
    const m = registry();
    const device = scriptedDevice({
      perceive: () => ({ kind: 'error', code: 'intent_webdriver_failed' }),
      click: () => ({ kind: 'ok', output: clickResult(true) }),
    });
    await run(executor(device.dispatcher, { metrics: m }), [TAP]);
    expect(lookSeries(m)).toEqual({ 'fallback/unanswered/tapped': 1 });
    expect(m.getHistogram(METRIC_NAMES.agentLookToTapSeconds, { verb: 'click' }).count).toBe(0);
  });
});

// ── every enum value is reachable ──────────────────────────────────────────

describe('every value of every enum is reachable', () => {
  it('the closed sets are exactly what the device team will be sent', () => {
    // `scroll` is deliberately NOT a verb here: its flag names an
    // implementation, not a configuration, and lives in its own metric.
    expect([...AGENT_ACTION_PROFILE_VERBS]).toEqual(['click', 'send_keys']);
    expect([...AGENT_PROFILE_ATTACHED_VALUES]).toEqual(['true', 'false', 'unreported']);
    expect([...AGENT_SCROLL_PATHS]).toEqual(['flick', 'segmented', 'unreported']);
    expect([...AGENT_ACTION_OUTCOMES]).toEqual(['ok', 'failed', 'unknown']);
    expect([...PRE_TAP_LOOK_RESOLVERS]).toEqual(['native', 'script', 'none', 'unanswered']);
    expect([...PRE_TAP_LOOK_NEXT_ACTIONS]).toEqual(['tapped', 'typed', 'refused', 'not_sent']);
    // The verdict vocabulary is the look's OWN, unchanged: renaming it would
    // silently empty every matcher that selects on it.
    expect([...PRE_TAP_LOOK_OUTCOMES]).toEqual([
      'clear',
      'covered',
      'not_found',
      'outside_viewport',
      'unverified',
      'fallback',
    ]);
  });

  it('CRITICAL every profile_attached value, every scroll path, every outcome, every resolver and every next-action is reached by driving the executor — an enum value nothing can produce is a label that reads as "never happens"', async () => {
    const m = registry();
    const exec = (script: Script, opts: AutoRetryOptions = {}) =>
      executor(scriptedDevice(script).dispatcher, { metrics: m, ...opts });

    // profile_attached true/false/unreported × outcome ok/failed/unknown,
    // resolved_by native/script/none/unanswered × then
    // tapped/typed/refused/not_sent, and both scroll paths.
    await run(
      exec({
        perceive: () => ({ kind: 'ok', output: lookAnswer({ resolvedBy: 'native' }) }),
        click: () => ({ kind: 'ok', output: clickResult(true) }),
      }),
      [TAP],
    );
    await run(
      exec({
        perceive: () => ({ kind: 'ok', output: lookAnswer({ resolvedBy: 'script' }) }),
        send_keys: () => ({ kind: 'ok', output: sendKeysResult(false) }),
      }),
      [TYPE],
    );
    await run(
      exec(
        {
          perceive: () => ({ kind: 'ok', output: lookAnswer({}) }),
          click: () => ({ kind: 'error', code: 'intent_invalid_parameter' }),
        },
        { maxRetries: 0 },
      ),
      [TAP],
    );
    await run(
      exec(
        {
          perceive: () => ({ kind: 'ok', output: lookAnswer({}) }),
          click: () => ({ kind: 'error', code: 'intent_webdriver_failed' }),
        },
        { maxRetries: 0 },
      ),
      [TAP],
    );
    await run(
      exec({
        perceive: () => ({ kind: 'ok', output: lookAnswer({ none: true }) }),
        wait_for: () => ({ kind: 'error', code: 'intent_webdriver_failed' }),
      }),
      [TAP],
    );
    await run(
      exec({
        perceive: () => ({ kind: 'ok', output: OLDER_DEVICE_LISTING }),
        click: () => ({ kind: 'ok', output: clickResult(true) }),
      }),
      [TAP],
    );
    await run(
      exec({
        perceive: () => ({ kind: 'ok', output: lookAnswer({ resolvedBy: 'native' }) }),
        click: () => ({ kind: 'ok', output: clickResult(true) }),
      }),
      [TAP],
      { repeatGuard: () => 'no_progress' },
    );
    await run(exec({ scroll: () => ({ kind: 'ok', output: scrollResult(true) }) }), [SCROLL]);
    await run(exec({ scroll: () => ({ kind: 'ok', output: scrollResult(false) }) }), [SCROLL]);
    await run(
      exec(
        { scroll: () => ({ kind: 'error', code: 'intent_invalid_parameter' }) },
        { maxRetries: 0 },
      ),
      [SCROLL],
    );

    const seenProfile = new Set<string>();
    const seenOutcome = new Set<string>();
    for (const key of Object.keys(actionSeries(m))) {
      const [verb, profileAttached, outcome] = key.split('/');
      expect(AGENT_ACTION_PROFILE_VERBS).toContain(verb);
      seenProfile.add(profileAttached!);
      seenOutcome.add(outcome!);
    }
    expect([...seenProfile].sort()).toEqual([...AGENT_PROFILE_ATTACHED_VALUES].sort());
    expect([...seenOutcome].sort()).toEqual([...AGENT_ACTION_OUTCOMES].sort());

    const seenPath = new Set<string>();
    for (const key of Object.keys(scrollSeries(m))) seenPath.add(key.split('/')[0]!);
    expect([...seenPath].sort()).toEqual([...AGENT_SCROLL_PATHS].sort());

    const seenResolver = new Set<string>();
    const seenThen = new Set<string>();
    for (const key of Object.keys(lookSeries(m))) {
      const [, resolver, then] = key.split('/');
      seenResolver.add(resolver!);
      seenThen.add(then!);
    }
    expect([...seenResolver].sort()).toEqual([...PRE_TAP_LOOK_RESOLVERS].sort());
    expect([...seenThen].sort()).toEqual([...PRE_TAP_LOOK_NEXT_ACTIONS].sort());
  });
});

// ── content-free ───────────────────────────────────────────────────────────

const SENTINELS = [
  'https://secret-shop.test/checkout?order=abc123',
  '#customer-only-selector',
  'hunter2-the-password',
  'ags_customer_session',
];

describe('nothing a customer typed, opened or was shown can reach a label or a log field', () => {
  it('CRITICAL a run whose every string is a sentinel leaves an exposition in which none of them appears', async () => {
    const m = registry();
    const device = scriptedDevice({
      perceive: () => ({
        kind: 'ok',
        output: {
          value: {
            url: SENTINELS[0],
            title: SENTINELS[0],
            elements: [
              {
                id: 0,
                type: 'button',
                label: SENTINELS[2],
                selector: SENTINELS[1],
                bounds: { x: 1, y: 1, width: 10, height: 10 },
                state: { visible: true, enabled: true, focused: false },
                position_summary: 'in view',
                hit: {
                  type: 'button',
                  label: SENTINELS[2],
                  selector: SENTINELS[1],
                  bounds: { x: 1, y: 1, width: 10, height: 10 },
                },
                occluded: false,
                occlusion_reason: null,
              },
            ],
            truncated: false,
            total_matched: 1,
            resolved_by: 'script',
          },
        },
      }),
      send_keys: () => ({
        kind: 'ok',
        output: { typed_into: SENTINELS[1], length: 20, truncated: false, behavioral: false },
      }),
    });
    await run(executor(device.dispatcher, { metrics: m }), [
      { kind: 'interact', action: 'type', selector: SENTINELS[1]!, value: SENTINELS[2]! },
    ]);
    const exposition = m.render();
    for (const sentinel of SENTINELS) expect(exposition).not.toContain(sentinel);
    // And it did record the step, so the arm above is not vacuous.
    expect(actionSeries(m)).toEqual({ 'send_keys/false/ok': 1 });
  });

  it('CRITICAL every label value emitted is a member of its closed enum — the exposition can hold nothing else', async () => {
    const m = registry();
    const device = scriptedDevice({
      perceive: () => ({ kind: 'ok', output: lookAnswer({ resolvedBy: 'native' }) }),
      click: () => ({ kind: 'ok', output: clickResult(false) }),
    });
    await run(executor(device.dispatcher, { metrics: m }), [TAP]);
    const lines = m
      .render()
      .split('\n')
      .filter((l) => l.startsWith('driftstack_agent_'));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      for (const [, key, value] of line.matchAll(/(\w+)="([^"]*)"/g)) {
        const allowed: Record<string, readonly string[]> = {
          verb: AGENT_ACTION_PROFILE_VERBS,
          profile_attached: AGENT_PROFILE_ATTACHED_VALUES,
          path: AGENT_SCROLL_PATHS,
          outcome: [...AGENT_ACTION_OUTCOMES, ...PRE_TAP_LOOK_OUTCOMES],
          resolved_by: PRE_TAP_LOOK_RESOLVERS,
          then: PRE_TAP_LOOK_NEXT_ACTIONS,
        };
        const set = allowed[key!];
        if (set === undefined) {
          // `le` is the histogram's own bucket bound, a number.
          expect(key).toBe('le');
          continue;
        }
        expect(set, `${key!}="${value!}" is not a member of its closed enum`).toContain(value);
      }
    }
  });

  it("CRITICAL the turn log line's keys are a fixed list and every value is a number", () => {
    const counts: AgentActionPathCounts = emptyAgentActionPathCounts();
    counts.actions = 3;
    counts.profileAttached.false = 1;
    counts.unprofiledByVerb.click = 1;
    counts.scrolls = 1;
    counts.scrollPaths.segmented = 1;
    const fields = agentActionPathLogFields(counts);
    expect(Object.keys(fields)).toEqual([...AGENT_TURN_ACTION_PATH_LOG_KEYS]);
    for (const [key, value] of Object.entries(fields)) {
      expect(typeof value, `${key} must be a number`).toBe('number');
      expect(Number.isFinite(value)).toBe(true);
    }
    // The key list is spelled from the closed enums and nothing else: no id, no
    // selector, no URL, no text.
    expect(AGENT_TURN_ACTION_PATH_LOG_KEYS.every((k) => /^[a-z_]+$/.test(k))).toBe(true);
    expect(AGENT_TURN_ACTION_PATHS_EVENT).toBe('agent_turn_action_paths');
  });
});

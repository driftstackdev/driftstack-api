// A PAUSE THAT FAILS IS A PAUSE THAT DID NOT HAPPEN — never a step that failed.
//
// ⛔ THE SCENARIO THIS EXISTS FOR IS A DROPPED FRAME, not a device bug. The
// dispatch correlator SYNTHESISES a failure with `durationMs: 0` when a
// dispatch is lost, so "the pause failed" is a thing that happens to healthy
// sessions on a flaky link. Routed through the ordinary step path that failure
// would land in `results`, flip the segment's `ok`, trip halt-on-first-failure,
// and make `segmentRanToItsEnd` false — so the turn loop would take a different
// branch and the customer would be told a step failed. About a pause. Which
// changes nothing on the page.
//
// ⛔ AND THE PORT'S CONTRACT IS NOT TRUSTED HERE. `IntentDispatcher.dispatch`
// is documented never to reject, and the beat seam catches anyway: the whole
// value of an off-the-books dispatch is that it cannot be the reason a
// customer's step failed, and "the port promised" is not a mechanism.

import { describe, expect, it } from 'vitest';
import type { AgentIntent } from '../../src/services/agent-decomposer.js';
import type { IntentDispatcher } from '../../src/services/agent-executor-control-plane.js';
import type { IntentDispatch } from '../../src/schemas/harness-control-protocol.js';
import { budgetFor, draws, names, paceDevice, paceExecutor } from './_helpers/pace-harness.js';

const PLAN: AgentIntent[] = [
  { kind: 'navigate', url: 'https://shop.test/page' },
  { kind: 'interact', action: 'tap', selector: '#next' },
  { kind: 'interact', action: 'type', selector: '#field', value: 'hi' },
  { kind: 'interact', action: 'tap', selector: '#send' },
];

describe('a pacing pause that fails does not fail the segment', () => {
  it('CRITICAL every inserted pause comes back a FAILURE and the segment still succeeds, with every planned step run', async () => {
    const d = paceDevice({ pauseFails: true });
    const pace = budgetFor('slow', 30_000, { pageWordCount: 200 });
    const res = await paceExecutor(d.dispatcher, { makeRandom: () => draws([0.5]) }).execute({
      sessionId: 'ses_fail',
      agentSessionId: 'agt_fail',
      plan: { kind: 'plan', intents: PLAN, tokensConsumed: 0 },
      pace,
    });

    // The pauses were really attempted and really failed.
    expect(names(d.sent).filter((n) => n === 'behavioral_pause').length).toBeGreaterThan(0);

    expect(res.ok).toBe(true);
    expect(res.results).toHaveLength(PLAN.length);
    expect(res.results.every((r) => r.kind === 'success')).toBe(true);
    // Halt-on-first-failure never saw it: every planned step after the first
    // failed pause still ran.
    expect(names(d.sent).filter((n) => n === 'click')).toHaveLength(2);
  });

  it('CRITICAL a failed pause is not COUNTED as paused time either — the telemetry says what the device answered, not what was asked', async () => {
    const d = paceDevice({ pauseFails: true });
    const pace = budgetFor('slow', 30_000, { pageWordCount: 200 });
    const res = await paceExecutor(d.dispatcher, { makeRandom: () => draws([0.5]) }).execute({
      sessionId: 'ses_count',
      agentSessionId: 'agt_count',
      plan: { kind: 'plan', intents: PLAN, tokensConsumed: 0 },
      pace,
    });
    expect(pace.insertedPauses).toBe(0);
    expect(pace.pausedMs).toBe(0);
    expect(res.actionPaths?.pacePausedMs ?? 0).toBe(0);

    // ⛔ AND YET THE BUDGET WAS SPENT, DELIBERATELY. The device was asked to
    // hold for those milliseconds whatever it answered, so a device that fails
    // every pause must not become a way to keep asking for more of them. The
    // taper bounds what was REQUESTED; the telemetry reports what was ANSWERED.
    // Two different questions, two different numbers, both true.
    expect(pace.segmentRemainingMs).toBeLessThan(30_000);
  });

  it('CRITICAL a dispatcher that THROWS on the pause — which the port says cannot happen — still leaves the segment clean', async () => {
    const inner = paceDevice();
    const throwing: IntentDispatcher = {
      dispatch: (dispatch: IntentDispatch) => {
        if (dispatch.intentName === 'behavioral_pause') {
          throw new Error('the link went away mid-frame');
        }
        return inner.dispatcher.dispatch(dispatch);
      },
    };
    const res = await paceExecutor(throwing, { makeRandom: () => draws([0.5]) }).execute({
      sessionId: 'ses_throw',
      agentSessionId: 'agt_throw',
      plan: { kind: 'plan', intents: PLAN, tokensConsumed: 0 },
      pace: budgetFor('slow', 30_000, { pageWordCount: 200 }),
    });
    expect(res.ok).toBe(true);
    expect(res.results.every((r) => r.kind === 'success')).toBe(true);
  });

  it('NEGATIVE CONTROL — a PLANNED step that fails still fails the segment, so the arms above are about the inserted path and not about failures being ignored', async () => {
    // The same plan, the same inserted pauses — and the device fails the TAP.
    const d = paceDevice({ clickFails: true });
    const res = await paceExecutor(d.dispatcher, { makeRandom: () => draws([0.5]) }).execute({
      sessionId: 'ses_neg',
      agentSessionId: 'agt_neg',
      plan: { kind: 'plan', intents: PLAN, tokensConsumed: 0 },
      pace: budgetFor('slow', 30_000, { pageWordCount: 200 }),
    });
    expect(res.ok).toBe(false);
    // …and it stopped there, which is halt-on-first-failure doing its job on a
    // real step while ignoring every inserted one.
    expect(names(d.sent).filter((n) => n === 'send_keys')).toHaveLength(0);
  });
});

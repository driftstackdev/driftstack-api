// AN INSERTED PAUSE IS NOT A STEP — the decisive architectural property of the
// whole pacing feature, and the reason it has its own dispatch path.
//
// ⛔ WHAT GOES WRONG IF IT IS ONE. `emitStep` pushes into `results` AND streams
// in one call; the segment's verdict is `ok: results.every(r => r.kind ===
// 'success')`; halt-on-first-failure breaks on any non-`wait` failure; and the
// runtime's `segmentRanToItsEnd` requires every result to be a success or a
// wait. So a pause routed through the ordinary path would: appear in the
// customer's step list as a step they did not ask for, be replayed to the
// planner as something it did (teaching it to imitate them), be compared by the
// no-progress guard's deep equality, and — on a dropped frame — end the segment.
//
// ⛔ AND THE PLANNER MUST NEVER SEE ONE. The step history handed to the next
// segment is built from `results`. A planner shown its own inserted pauses
// starts planning them, which would move the policy from the executor (where it
// is enforceable and attributable) into the prompt (where nothing checks it) —
// the exact failure the whole design exists to avoid.

import { describe, expect, it } from 'vitest';
import type { AgentIntent } from '../../src/services/agent-decomposer.js';
import type { IntentResult } from '../../src/services/agent-executor.js';
import { budgetFor, draws, names, paceDevice, paceExecutor } from './_helpers/pace-harness.js';

const PLAN: AgentIntent[] = [
  { kind: 'navigate', url: 'https://shop.test/page' },
  { kind: 'interact', action: 'tap', selector: '#next' },
  { kind: 'interact', action: 'type', selector: '#field', value: 'hi' },
  { kind: 'interact', action: 'tap', selector: '#send' },
];

describe('an inserted pause is never a plan step', () => {
  it('CRITICAL the pauses reach the WIRE and reach nothing else — not results, not onStep, not onStepStart, not the plan', async () => {
    const d = paceDevice();
    const onStep: Array<{ index: number; result: IntentResult }> = [];
    const onStepStart: Array<{ index: number; intent: AgentIntent }> = [];
    const plan: { kind: 'plan'; intents: AgentIntent[]; tokensConsumed: number } = {
      kind: 'plan',
      intents: [...PLAN],
      tokensConsumed: 0,
    };
    const res = await paceExecutor(d.dispatcher, { makeRandom: () => draws([0.5]) }).execute({
      sessionId: 'ses_step',
      agentSessionId: 'agt_step',
      plan,
      pace: budgetFor('slow', 30_000, { pageWordCount: 200 }),
      onStep: (result, index) => onStep.push({ index, result }),
      onStepStart: (intent, index) => onStepStart.push({ index, intent }),
    });

    // It really did insert something — otherwise every assertion below is about
    // a run in which nothing happened.
    expect(names(d.sent).filter((n) => n === 'behavioral_pause').length).toBeGreaterThan(0);

    // ⛔ ONE RESULT PER PLANNED INTENT, and nothing else.
    expect(res.results).toHaveLength(PLAN.length);
    expect(res.results.map((r) => r.intent.kind)).toEqual(PLAN.map((i) => i.kind));
    expect(res.results.some((r) => r.intent.kind === 'behavioral_pause')).toBe(false);

    // ⛔ THE STREAM THE CUSTOMER WATCHES SEES NO EXTRA STEP, and its indices are
    // contiguous — a pause that slipped in would either add an index or shift
    // every later one, and both are visible here.
    expect(onStep.map((e) => e.index)).toEqual([0, 1, 2, 3]);
    expect(onStepStart.map((e) => e.index)).toEqual([0, 1, 2, 3]);
    expect(onStepStart.map((e) => e.intent.kind)).toEqual(PLAN.map((i) => i.kind));

    // ⛔ THE PLAN OBJECT IS NOT MUTATED. The runtime re-reads `plan.intents`
    // after the run — for the transcript, the repeat guard and the next
    // segment's history — so appending an inserted pause to it would reach
    // every one of those.
    expect(plan.intents).toEqual(PLAN);
  });

  it('CRITICAL the segment verdict is decided by the planned steps alone — a run whose every planned step succeeded is `ok` no matter how many pauses were inserted', async () => {
    const d = paceDevice();
    const res = await paceExecutor(d.dispatcher, { makeRandom: () => draws([0.5]) }).execute({
      sessionId: 'ses_ok',
      agentSessionId: 'agt_ok',
      plan: { kind: 'plan', intents: PLAN, tokensConsumed: 0 },
      pace: budgetFor('slow', 30_000, { pageWordCount: 200 }),
    });
    expect(res.ok).toBe(true);
    expect(res.results.every((r) => r.kind === 'success')).toBe(true);
  });

  it('the pauses are counted on the turn telemetry and NOWHERE the customer can see — a count, a millisecond total, and no new step', async () => {
    const d = paceDevice();
    const pace = budgetFor('slow', 30_000, { pageWordCount: 200 });
    const res = await paceExecutor(d.dispatcher, { makeRandom: () => draws([0.5]) }).execute({
      sessionId: 'ses_tel',
      agentSessionId: 'agt_tel',
      plan: { kind: 'plan', intents: PLAN, tokensConsumed: 0 },
      pace,
    });
    const inserted = d.sent.filter((s) => s.name === 'behavioral_pause');
    expect(pace.insertedPauses).toBe(inserted.length);
    expect(pace.pausedMs).toBe(inserted.reduce((sum, s) => sum + Number(s.params.duration_ms), 0));
    // The same numbers ride on the turn's action-path counts, by band — and the
    // `fast` row is an alarm that must stay at zero.
    expect(res.actionPaths?.pacePauses.slow).toBe(inserted.length);
    expect(res.actionPaths?.pacePauses.fast).toBe(0);
    expect(res.actionPaths?.pacePausedMs).toBe(pace.pausedMs);
    // ⛔ AND NOT COUNTED AS AN ACTION OR A SCROLL. Those two numbers are what
    // the profile-attachment watchdog reads; a pause folded into them would
    // move a configuration alert for a reason that has nothing to do with it.
    // Two taps and one typed step: `actions` counts clicks and send_keys.
    expect(res.actionPaths?.actions).toBe(3);
    expect(res.actionPaths?.scrolls).toBe(0);
  });

  it('CRITICAL NEGATIVE CONTROL — the same plan with a PLANNER-emitted pause does produce a step, so this file is measuring insertion and not the absence of pauses in general', async () => {
    // A `behavioral_pause` the PLANNER asked for is an ordinary step: it goes
    // through `runIntent`, lands in `results`, and the customer sees it. If
    // that were not true, every assertion above would pass on a build where
    // inserted pauses had simply been switched off.
    const planned: AgentIntent[] = [
      { kind: 'navigate', url: 'https://shop.test/page' },
      { kind: 'behavioral_pause', duration_ms: 1_200 },
    ];
    const d = paceDevice();
    const res = await paceExecutor(d.dispatcher).execute({
      sessionId: 'ses_planned',
      agentSessionId: 'agt_planned',
      plan: { kind: 'plan', intents: planned, tokensConsumed: 0 },
    });
    expect(res.results).toHaveLength(2);
    expect(res.results[1]?.intent.kind).toBe('behavioral_pause');
    expect(names(d.sent)).toEqual(['navigate', 'behavioral_pause']);
  });
});

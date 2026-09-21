// NOTHING IS EVER INSERTED BEFORE THE FIRST STEP A CUSTOMER SEES IN A TURN.
//
// ⛔ THE METRIC THIS PROTECTS HAS A COMPLAINT ATTACHED TO IT.
// `driftstack_agent_turn_time_to_first_progress_seconds` exists because
// somebody said "it never shows thinking progress" — the number is named after
// that sentence in the registry. A pacing policy free to insert before the
// first emitted step would push that number out on exactly the turns where a
// person is staring at a spinner wondering whether anything is happening. It
// would be trading a number a customer already asked us to fix for one nobody
// has measured.
//
// ⛔ AND IT IS AN INVARIANT, NOT A TUNING CHOICE. Not "the first beat is small",
// not "usually not" — never, in any band, at any draw, with any budget. The
// turn's own state carries the fact (`anyStepEmitted`), so it holds across the
// three segments a turn can run, not just inside one: a turn's SECOND segment
// may pace its first step, because by then the customer has seen progress.

import { describe, expect, it } from 'vitest';
import type { AgentIntent } from '../../src/services/agent-decomposer.js';
import { newPaceBudget } from '../../src/services/agent-pace.js';
import { budgetFor, draws, names, paceDevice, paceExecutor } from './_helpers/pace-harness.js';

const PLAN: AgentIntent[] = [
  { kind: 'navigate', url: 'https://shop.test/a' },
  { kind: 'interact', action: 'tap', selector: '#one' },
  { kind: 'interact', action: 'tap', selector: '#two' },
];

/** A turn's pace state as it really starts: nothing emitted yet. */
function freshTurn(words: number | null, segmentMs = 30_000): ReturnType<typeof newPaceBudget> {
  return {
    ...newPaceBudget('slow'),
    segmentRemainingMs: segmentMs,
    pageWordCount: words,
  };
}

describe('pace never delays the first thing the customer sees', () => {
  it('CRITICAL the very first dispatch of a turn belongs to the customer’s first step — in both bands, at every draw', async () => {
    for (const band of ['slow', 'medium'] as const) {
      for (const chance of [0, 0.1, 0.3, 0.5, 0.9, 0.999999]) {
        const d = paceDevice();
        const res = await paceExecutor(d.dispatcher, {
          makeRandom: () => draws([chance]),
        }).execute({
          sessionId: `ses_first_${band}_${String(chance)}`,
          agentSessionId: `agt_first_${band}_${String(chance)}`,
          plan: { kind: 'plan', intents: PLAN, tokensConsumed: 0 },
          pace: { ...freshTurn(400), band },
        });
        expect(res.ok).toBe(true);
        // The plan opens with a navigate, so the first thing on the wire is the
        // navigate — never a pause in front of it.
        expect(
          names(d.sent)[0],
          `${band} at draw ${String(chance)} put something in front of the first step`,
        ).toBe('navigate');
      }
    }
  });

  it('CRITICAL it holds when the first step is a TAP, where the first dispatch is a look and a pause in front of it would delay the same metric', async () => {
    const tapFirst: AgentIntent[] = [
      { kind: 'interact', action: 'tap', selector: '#one' },
      { kind: 'interact', action: 'tap', selector: '#two' },
    ];
    const d = paceDevice();
    await paceExecutor(d.dispatcher, { makeRandom: () => draws([0]) }).execute({
      sessionId: 'ses_first_tap',
      agentSessionId: 'agt_first_tap',
      plan: { kind: 'plan', intents: tapFirst, tokensConsumed: 0 },
      pace: freshTurn(400),
    });
    expect(names(d.sent)[0]).toBe('perceive');
  });

  it('CRITICAL once the first step HAS been emitted, the policy is live again — so the arm above is about the first step and not about the policy being off', async () => {
    const d = paceDevice();
    const pace = freshTurn(400);
    await paceExecutor(d.dispatcher, { makeRandom: () => draws([0]) }).execute({
      sessionId: 'ses_after_first',
      agentSessionId: 'agt_after_first',
      plan: { kind: 'plan', intents: PLAN, tokensConsumed: 0 },
      pace,
    });
    const verbs = names(d.sent);
    expect(verbs[0]).toBe('navigate');
    // …and there IS a pause later in the same run.
    expect(verbs.slice(1)).toContain('behavioral_pause');
    expect(pace.anyStepEmitted).toBe(true);
  });

  it("CRITICAL a turn's LATER segment may pace its own first step, because the customer has already seen progress — the fact is carried on the turn, not on the run", async () => {
    // A second segment of the same turn: the executor is handed the SAME pace
    // object, which already knows a step was emitted. A rule that read
    // `results.length` instead would silently re-apply the first-step
    // exemption to every segment, and a six-segment turn would be six
    // unpaced openings.
    const d = paceDevice();
    const carried = budgetFor('slow', 30_000, { pageWordCount: 400 });
    await paceExecutor(d.dispatcher, { makeRandom: () => draws([0]) }).execute({
      sessionId: 'ses_segment_two',
      agentSessionId: 'agt_segment_two',
      plan: { kind: 'plan', intents: PLAN, tokensConsumed: 0 },
      pace: carried,
    });
    expect(names(d.sent)[0]).toBe('behavioral_pause');
  });
});

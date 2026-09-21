// NEVER BETWEEN THE LOOK AND THE TAP IT VOUCHES FOR.
//
// ⛔ WHAT A PAUSE THERE WOULD COST, AND IT IS A SAFETY COST, NOT A STEALTH ONE.
// The look asks the device what the selector resolves to and what sits at its
// tap point, and the tap is sent on that answer. Seconds between the two are
// seconds in which a cookie banner, a sticky bar or a consent dialog can appear
// over the control — and the tap then activates whatever is on top, which is not
// what the plan named. A pacing policy that made the agent look more like a
// person by widening that window would be trading a real safety property for an
// unmeasured appearance.
//
// ⛔ THE ORDERING THE CODE USES, AND WHY IT IS THE ONLY ONE. The design's two
// rules — "never between the look and the tap" and "never in front of a screen
// waiting for approval" — read as compatible and are not, because the approval
// gate runs AFTER the look. Putting the pause after the gate IS putting it
// between the look and the tap. The one ordering that satisfies both uses
// `haltsUnlooked`, the precheck that classifies the plan's own words before any
// device round trip: pause, THEN look, THEN gate, THEN dispatch.

import { describe, expect, it } from 'vitest';
import type { AgentIntent } from '../../src/services/agent-decomposer.js';
import { budgetFor, draws, names, paceDevice, paceExecutor } from './_helpers/pace-harness.js';

/** Every verb whose params carry a locator the look was taken for. */
const LOOKED_AT = new Set(['click', 'send_keys']);

const PLAN: AgentIntent[] = [
  { kind: 'navigate', url: 'https://shop.test/page' },
  { kind: 'interact', action: 'tap', selector: '#next' },
  { kind: 'interact', action: 'type', selector: '#field', value: 'hi' },
  { kind: 'interact', action: 'type', selector: '#other', value: 'there' },
  { kind: 'interact', action: 'tap', selector: '#send' },
];

describe('a pause never lands between the look and the tap', () => {
  it('CRITICAL every click and send_keys is IMMEDIATELY preceded by its perceive, with nothing between them — in both paced bands, at every draw', async () => {
    for (const band of ['slow', 'medium'] as const) {
      // Sweep the draw space rather than picking one value: the decision to
      // pause is itself a draw, so a single fixed draw could silently be
      // testing a run in which the policy declined to insert anything.
      for (const chance of [0, 0.1, 0.25, 0.4, 0.5, 0.75, 0.999999]) {
        const d = paceDevice();
        const res = await paceExecutor(d.dispatcher, {
          makeRandom: () => draws([chance]),
        }).execute({
          sessionId: `ses_${band}_${String(chance)}`,
          agentSessionId: `agt_${band}_${String(chance)}`,
          plan: { kind: 'plan', intents: PLAN, tokensConsumed: 0 },
          pace: budgetFor(band, 30_000, { pageWordCount: 250 }),
        });
        expect(res.ok).toBe(true);

        const verbs = names(d.sent);
        const offenders: string[] = [];
        for (const [index, verb] of verbs.entries()) {
          if (!LOOKED_AT.has(verb)) continue;
          if (verbs[index - 1] !== 'perceive') {
            offenders.push(
              `${band}/${String(chance)}: ${verb} at ${String(index)} follows ${verbs[index - 1] ?? '(nothing)'}`,
            );
          }
        }
        expect(
          offenders,
          'every one of these is a tap or a typed step whose look was not the dispatch immediately before it',
        ).toEqual([]);
      }
    }
  });

  it('CRITICAL the pause goes in FRONT of the look, not behind it — so the look that authorises the tap is always the fresher fact', async () => {
    const d = paceDevice();
    await paceExecutor(d.dispatcher, { makeRandom: () => draws([0.5]) }).execute({
      sessionId: 'ses_front',
      agentSessionId: 'agt_front',
      plan: { kind: 'plan', intents: PLAN, tokensConsumed: 0 },
      pace: budgetFor('slow', 30_000, { pageWordCount: 250 }),
    });
    const verbs = names(d.sent);
    // There is at least one inserted pause, and every one of them is followed
    // by something that is not a tap — the look, or the next planned verb.
    const pauses = verbs.map((v, i) => (v === 'behavioral_pause' ? i : -1)).filter((i) => i >= 0);
    expect(pauses.length).toBeGreaterThan(0);
    for (const at of pauses) {
      expect(LOOKED_AT.has(verbs[at + 1] ?? '')).toBe(false);
    }
  });

  it('CRITICAL NEGATIVE CONTROL — the scan can SEE an unlooked tap, so a green run above is a fact about placement and not about the scan matching nothing', async () => {
    // The same plan with the look switched off (`preTapLookTimeoutMs: 0`
    // restores the pre-look executor exactly). Every tap is then unlooked, and
    // the scan must say so — otherwise the arm above would pass on any build.
    const d = paceDevice();
    await paceExecutor(d.dispatcher, {
      makeRandom: () => draws([0.5]),
      preTapLookTimeoutMs: 0,
    }).execute({
      sessionId: 'ses_nolook',
      agentSessionId: 'agt_nolook',
      plan: { kind: 'plan', intents: PLAN, tokensConsumed: 0 },
      pace: budgetFor('slow', 30_000, { pageWordCount: 250 }),
    });
    const verbs = names(d.sent);
    const unlooked = verbs.filter((v, i) => LOOKED_AT.has(v) && verbs[i - 1] !== 'perceive');
    expect(unlooked.length).toBeGreaterThan(0);
  });
});

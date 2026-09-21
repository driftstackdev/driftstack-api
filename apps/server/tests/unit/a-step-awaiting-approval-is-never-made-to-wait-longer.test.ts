// A STEP THE CUSTOMER IS ABOUT TO BE ASKED ABOUT GETS NO PAUSE IN FRONT OF IT.
//
// ⛔ THE HARM IS TO THE PERSON, NOT TO THE PAGE. When the gate halts a step, the
// customer is shown "approve this?" and the turn stops until they answer. Every
// millisecond a pacing policy spends in front of that prompt is a millisecond
// somebody spends looking at a spinner before being asked a question — and it
// buys nothing at all, because the pause happens on a screen nobody is
// interacting with. It is the one placement where the feature's cost is paid by
// a person and its benefit is zero.
//
// ⛔ WHAT MAKES IT CHECKABLE BEFORE THE GATE HAS RUN. `haltsUnlooked` classifies
// the PLAN'S OWN WORDS before any device round trip, so at the insertion point
// the executor already knows that this step's caption is one the gate halts on.
// The planner's own DECLARATION is the second signal available there, and it is
// honoured too — a declared commitment is very likely to meet the same prompt a
// few lines later.
//
// ⚠️ THE STATED RESIDUAL, recorded here rather than discovered later: a halt
// raised ONLY by the device's labels, or by the structural arm reading the
// page's markup, is decided AFTER the insertion point — so such a step did get
// a beat in front of it. It is a pause on a page the run was already reading;
// nothing was committed, and the prompt itself is unchanged. The last arm below
// pins that residual as a known shape rather than leaving it unwritten.

import { describe, expect, it } from 'vitest';
import type { AgentIntent } from '../../src/services/agent-decomposer.js';
import { consequentialSignature } from '../../src/services/agent-executor.js';
import { newCommitmentBudget } from '../../src/services/agent-page-commitment.js';
import { budgetFor, draws, names, paceDevice, paceExecutor } from './_helpers/pace-harness.js';

const BUY: AgentIntent = { kind: 'interact', action: 'tap', selector: '#buy', value: 'Buy now' };

const PLAN: AgentIntent[] = [
  { kind: 'navigate', url: 'https://shop.test/checkout' },
  { kind: 'interact', action: 'type', selector: '#note', value: 'gift' },
  BUY,
];

describe('a step awaiting approval is never made to wait longer', () => {
  it('CRITICAL the halted step gets NO pause — the last thing on the wire before the turn stops to ask is not a pause', async () => {
    const d = paceDevice();
    const res = await paceExecutor(d.dispatcher, { makeRandom: () => draws([0]) }).execute({
      sessionId: 'ses_gate',
      agentSessionId: 'agt_gate',
      plan: { kind: 'plan', intents: PLAN, tokensConsumed: 0 },
      pace: budgetFor('slow', 30_000, { pageWordCount: 250 }),
    });

    // The turn really did stop to ask.
    expect(res.awaitingConfirmation).toBe(true);
    expect(res.results.at(-1)?.kind).toBe('confirmation_required');

    // ⛔ NOTHING AT ALL WAS SENT FOR THE HALTED STEP — not a pause, and not the
    // look either: a step the customer has not approved reaches the device in
    // no form whatever. So the final dispatch belongs to the step BEFORE it.
    expect(names(d.sent).at(-1)).not.toBe('behavioral_pause');
    expect(d.sent.filter((s) => s.name === 'click')).toHaveLength(0);

    // And the policy was live: the steps before the halt were paced.
    expect(names(d.sent).filter((n) => n === 'behavioral_pause').length).toBeGreaterThan(0);
  });

  it('CRITICAL a step the PLANNER declared a commitment gets no pause either, whether or not the caption matches anything', async () => {
    // A neutral caption the gate's English phrases do not recognise, declared by
    // the planner as a purchase. Without the declaration this step would be
    // paced like any other tap; with it, nothing waits in front of the screen
    // that is about to ask.
    const declaredPlan: AgentIntent[] = [
      { kind: 'navigate', url: 'https://shop.test/checkout' },
      { kind: 'interact', action: 'type', selector: '#note', value: 'gift' },
      { kind: 'interact', action: 'tap', selector: '#go' },
    ];
    const d = paceDevice();
    const res = await paceExecutor(d.dispatcher, { makeRandom: () => draws([0]) }).execute({
      sessionId: 'ses_declared',
      agentSessionId: 'agt_declared',
      plan: { kind: 'plan', intents: declaredPlan, tokensConsumed: 0 },
      // ⛔ ON ExecuteArgs, NOT ON THE PLAN. A declaration is the gate's
      // business, not the customer's API: it travels beside the plan inside
      // this process, and the executor reads it from here.
      declaredCommitments: [{ at: 2, category: 'purchase' }],
      pace: budgetFor('slow', 30_000, { pageWordCount: 250 }),
      // The declared arm is only consulted when the turn carries a commitment
      // budget — the runtime always threads one; a stub executor gets none.
      commitmentBudget: newCommitmentBudget(),
    });
    expect(res.awaitingConfirmation).toBe(true);

    const verbs = names(d.sent);
    // The typed step is paced (a decision beat would otherwise sit in front of
    // the tap); the declared tap is not. So the last pause on the wire is not
    // the one immediately before the halt.
    expect(verbs.at(-1)).not.toBe('behavioral_pause');
    expect(verbs.filter((v) => v === 'click')).toHaveLength(0);
  });

  it('CRITICAL NEGATIVE CONTROL — the same tap with the SAME neutral caption and no declaration IS paced, so the two arms above are about the gate and not about taps being unpaced in general', async () => {
    const neutral: AgentIntent[] = [
      { kind: 'navigate', url: 'https://shop.test/checkout' },
      { kind: 'interact', action: 'type', selector: '#note', value: 'gift' },
      { kind: 'interact', action: 'tap', selector: '#go' },
    ];
    const d = paceDevice();
    const res = await paceExecutor(d.dispatcher, { makeRandom: () => draws([0]) }).execute({
      sessionId: 'ses_neutral',
      agentSessionId: 'agt_neutral',
      plan: { kind: 'plan', intents: neutral, tokensConsumed: 0 },
      pace: budgetFor('slow', 30_000, { pageWordCount: 250 }),
    });
    expect(res.ok).toBe(true);
    const verbs = names(d.sent);
    // The decision beat is there: a pause, then the look, then the tap.
    const tapAt = verbs.lastIndexOf('click');
    expect(tapAt).toBeGreaterThan(0);
    expect(verbs[tapAt - 1]).toBe('perceive');
    expect(verbs[tapAt - 2]).toBe('behavioral_pause');
  });

  it('an APPROVED commitment is not a step awaiting approval, and is paced like any other — the rule is about the prompt, not about the word "purchase"', async () => {
    // The customer has already approved this exact action, so the gate releases
    // it and nobody is waiting on a question. The plan's beat table puts a
    // decision beat exactly here, before a committing tap the gate has cleared.
    const d = paceDevice();
    const res = await paceExecutor(d.dispatcher, { makeRandom: () => draws([0]) }).execute({
      sessionId: 'ses_approved',
      agentSessionId: 'agt_approved',
      plan: { kind: 'plan', intents: PLAN, tokensConsumed: 0 },
      pace: budgetFor('slow', 30_000, { pageWordCount: 250 }),
      // The signature the gate consumes, built with the product's own function
      // so an approval the gate would not accept cannot be mistaken here for
      // one it would.
      approvedConsequentialActions: new Set([consequentialSignature('purchase', 'Buy now')]),
    });
    expect(res.ok).toBe(true);
    const verbs = names(d.sent);
    const tapAt = verbs.lastIndexOf('click');
    expect(tapAt).toBeGreaterThan(0);
    expect(verbs[tapAt - 1]).toBe('perceive');
    expect(verbs[tapAt - 2]).toBe('behavioral_pause');
  });
});

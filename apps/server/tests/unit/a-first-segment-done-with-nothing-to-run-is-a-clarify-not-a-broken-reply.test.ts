// A planner reply of `kind: "plan", status: "done"` with no intents on the
// FIRST segment of a turn used to throw "plan.intents was not an array" and
// fail the customer's whole turn. Measured on the routed OpenAI-style family
// (live safety corpus, run 30, 2026-09-22): told "that is not finished yet,
// please continue" after a turn that had already answered, the model said
// exactly that — `status: "done"`, `intents: null` — in four of ten
// repetitions, and again on the bounded retry. It is the model's way of saying
// "nothing left to do", so the contract now reads it as one: a clarify that
// says so and asks what comes next. The second-segment meaning (an empty done
// plan, `allowEmptyDone`) is untouched, and a list that is PRESENT but not an
// array is still a broken reply.

import { describe, expect, it } from 'vitest';
import {
  FIRST_SEGMENT_ALREADY_DONE_QUESTION,
  interpretPlanText,
} from '../../src/services/agent-planner-contract.js';

const LABEL = 'Test';
const first = { label: LABEL, truncated: false, allowEmptyDone: false, nullMeansAbsent: true };
const later = { ...first, allowEmptyDone: true };

describe('a first-segment "done" with nothing to run is a clarify, not a broken reply', () => {
  it('strict-mode `intents: null` beside `status: "done"` on a first segment asks what comes next', () => {
    const text =
      '{"thought":null,"kind":"plan","status":"done","intents":null,"clarifyingQuestion":null,"refuseReason":null}';
    expect(interpretPlanText(text, first)).toEqual({
      kind: 'clarify',
      clarifyingQuestion: FIRST_SEGMENT_ALREADY_DONE_QUESTION,
    });
  });

  it('an OMITTED list beside `status: "done"` on a first segment is the same clarify, in either mode', () => {
    const text = '{"kind":"plan","status":"done"}';
    for (const opts of [first, { ...first, nullMeansAbsent: false }]) {
      expect(interpretPlanText(text, opts)).toEqual({
        kind: 'clarify',
        clarifyingQuestion: FIRST_SEGMENT_ALREADY_DONE_QUESTION,
      });
    }
  });

  it('an explicit empty list beside `status: "done"` on a first segment says the same thing', () => {
    expect(interpretPlanText('{"kind":"plan","status":"done","intents":[]}', first)).toEqual({
      kind: 'clarify',
      clarifyingQuestion: FIRST_SEGMENT_ALREADY_DONE_QUESTION,
    });
  });

  it('on a LATER segment the same reply is still an empty done plan — the confirmation-page case is unchanged', () => {
    const text =
      '{"thought":null,"kind":"plan","status":"done","intents":null,"clarifyingQuestion":null,"refuseReason":null}';
    expect(interpretPlanText(text, later)).toMatchObject({
      kind: 'plan',
      intents: [],
      status: 'done',
    });
  });

  it('NEGATIVE CONTROL — a list that is present but not an array is still a broken reply on any segment', () => {
    expect(() =>
      interpretPlanText('{"kind":"plan","status":"done","intents":"nope"}', first),
    ).toThrow(/intents was not an array/);
    expect(() => interpretPlanText('{"kind":"plan","intents":null}', first)).toThrow(
      /intents was not an array/,
    );
    // Non-strict mode: a literal null is not "absent", so a done reply that
    // carries one is still broken — the strict/non-strict distinction the
    // adapter tests pin.
    expect(() =>
      interpretPlanText('{"kind":"plan","status":"done","intents":null}', {
        ...first,
        nullMeansAbsent: false,
      }),
    ).toThrow(/intents was not an array/);
  });

  it("the question says WHAT, in the customer's words", () => {
    expect(FIRST_SEGMENT_ALREADY_DONE_QUESTION).toMatch(/already done/);
    expect(FIRST_SEGMENT_ALREADY_DONE_QUESTION).not.toMatch(/segment|planner|intents|null/i);
  });
});

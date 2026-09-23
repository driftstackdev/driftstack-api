// A planner reply of `kind: "plan", status: "done"` with no intents on the
// FIRST segment of a turn used to throw "plan.intents was not an array", and
// the runtime re-asked once. Measured on the routed OpenAI-style family (live
// safety corpus, run 30, 2026-09-22): told "that is not finished yet, please
// continue" after a turn that had already answered, the model said exactly
// that — `status: "done"`, `intents: null` — in four of ten repetitions, and
// again on the bounded retry. After EARLIER WORK it is the model's way of
// saying "nothing left to do", so the contract reads it as one: a clarify that
// says so and asks what comes next.
//
// 2026-09-23 — an audit found the first version of that change said "already
// done" on a BRAND-NEW task too, where it is false and the re-ask was the
// recovery; and on a reply whose steps the parser had dropped, where the old
// "couldn't turn that into actions" is the true answer. Both are pinned here.
// The second-segment meaning (an empty done plan, `allowEmptyDone`) is
// untouched, and a list that is PRESENT but not an array is still broken.

import { describe, expect, it } from 'vitest';
import {
  FIRST_SEGMENT_ALREADY_DONE_QUESTION,
  interpretPlanText,
  sessionHasRunSteps,
} from '../../src/services/agent-planner-contract.js';
import type { TranscriptEntry } from '../../src/services/agent-decomposer.js';

const LABEL = 'Test';
const fresh = { label: LABEL, truncated: false, allowEmptyDone: false, nullMeansAbsent: true };
const afterWork = { ...fresh, sessionHasRunSteps: true };
const later = { ...fresh, allowEmptyDone: true };
const alreadyDone = { kind: 'clarify', clarifyingQuestion: FIRST_SEGMENT_ALREADY_DONE_QUESTION };

const STRICT_DONE_NULL =
  '{"thought":null,"kind":"plan","status":"done","intents":null,"clarifyingQuestion":null,"refuseReason":null}';

describe('a "done" with nothing to run says "already done" only after earlier steps', () => {
  it('after earlier steps, strict-mode `intents: null` beside `status: "done"` asks what comes next', () => {
    expect(interpretPlanText(STRICT_DONE_NULL, afterWork)).toEqual(alreadyDone);
  });

  it('after earlier steps, an OMITTED list beside `status: "done"` is the same clarify, in either mode', () => {
    const text = '{"kind":"plan","status":"done"}';
    for (const opts of [afterWork, { ...afterWork, nullMeansAbsent: false }]) {
      expect(interpretPlanText(text, opts)).toEqual(alreadyDone);
    }
  });

  it('after earlier steps, an explicit empty list beside `status: "done"` says the same thing', () => {
    expect(interpretPlanText('{"kind":"plan","status":"done","intents":[]}', afterWork)).toEqual(
      alreadyDone,
    );
  });

  it('on a BRAND-NEW task, `done` with no list is still a broken reply, so the runtime re-asks', () => {
    expect(() => interpretPlanText(STRICT_DONE_NULL, fresh)).toThrow(/intents was not an array/);
    expect(() => interpretPlanText('{"kind":"plan","status":"done"}', fresh)).toThrow(
      /intents was not an array/,
    );
  });

  it('on a BRAND-NEW task, `done` with an empty list is "couldn\'t turn that into actions", never "already done"', () => {
    const out = interpretPlanText('{"kind":"plan","status":"done","intents":[]}', fresh);
    expect(out.kind).toBe('clarify');
    expect(out).not.toEqual(alreadyDone);
    expect(out).toMatchObject({ clarifyingQuestion: expect.stringMatching(/couldn’t turn that/) });
  });

  it('even after earlier steps, a list the PARSER emptied is "couldn\'t turn that into actions", not "already done"', () => {
    // A navigate to a blank page and a tap with no selector are both dropped.
    for (const intents of [
      '[{"kind":"navigate","url":"about:blank"}]',
      '[{"kind":"interact","action":"tap","selector":""}]',
    ]) {
      const out = interpretPlanText(
        `{"kind":"plan","status":"done","intents":${intents}}`,
        afterWork,
      );
      expect(out.kind).toBe('clarify');
      expect(out).not.toEqual(alreadyDone);
    }
  });

  it('on a LATER segment the same reply is still an empty done plan — the confirmation-page case is unchanged', () => {
    for (const opts of [later, { ...later, sessionHasRunSteps: true }]) {
      expect(interpretPlanText(STRICT_DONE_NULL, opts)).toMatchObject({
        kind: 'plan',
        intents: [],
        status: 'done',
      });
    }
  });

  it('NEGATIVE CONTROL — a list that is present but not an array is still a broken reply on any segment', () => {
    for (const opts of [fresh, afterWork]) {
      expect(() =>
        interpretPlanText('{"kind":"plan","status":"done","intents":"nope"}', opts),
      ).toThrow(/intents was not an array/);
      expect(() => interpretPlanText('{"kind":"plan","intents":null}', opts)).toThrow(
        /intents was not an array/,
      );
      // Non-strict mode: a literal null is not "absent", so a done reply that
      // carries one is still broken — the strict/non-strict distinction the
      // adapter tests pin.
      expect(() =>
        interpretPlanText('{"kind":"plan","status":"done","intents":null}', {
          ...opts,
          nullMeansAbsent: false,
        }),
      ).toThrow(/intents was not an array/);
    }
  });

  it('"earlier steps" means an earlier agent or operator entry that ran at least one step', () => {
    const at = '2026-09-23T00:00:00.000Z';
    const user: TranscriptEntry = { at, role: 'user', body: 'open example.com' };
    const clarify: TranscriptEntry = { at, role: 'agent', body: '{"kind":"clarify"}' };
    const ran: TranscriptEntry = {
      at,
      role: 'agent',
      body: '{"kind":"plan"}',
      intents: [{ kind: 'navigate', url: 'https://example.com' }],
    };
    const operator: TranscriptEntry = { ...ran, role: 'operator' };
    const emptyPlan: TranscriptEntry = { ...ran, intents: [] };
    expect(sessionHasRunSteps([])).toBe(false);
    expect(sessionHasRunSteps([user, clarify, emptyPlan])).toBe(false);
    expect(sessionHasRunSteps([user, ran])).toBe(true);
    expect(sessionHasRunSteps([user, operator])).toBe(true);
    // A user entry carrying intents is not work the session ran.
    expect(sessionHasRunSteps([{ ...ran, role: 'user' }])).toBe(false);
  });

  it("the question says WHAT, in the customer's words", () => {
    expect(FIRST_SEGMENT_ALREADY_DONE_QUESTION).toMatch(/already done/);
    expect(FIRST_SEGMENT_ALREADY_DONE_QUESTION).not.toMatch(/segment|planner|intents|null/i);
  });
});

// ⛔ TWO INDEX SPACES WERE BEING JOINED WITH NO CHECK.
//
// The executor announces a step START on the PLAN index and reports a step
// RESULT on `results.length - 1`. Every attempt count in the eval report is the
// difference between a start mark and an end mark — a join across those two
// spaces — and the old code papered over a mis-key with
// `startMarks.get(i) ?? endMarks.get(i - 1) ?? 0`, so a divergence produced a
// confident number instead of a failure.
//
// The spaces AGREE TODAY. That is exactly why this file exists: an assertion
// that can only ever be satisfied proves nothing, so every property below is
// paired with a NEGATIVE CONTROL that forces the divergence and shows the
// tracker names it. Without those, "no anomalies" would be a statement about a
// detector nobody has seen fire.

import { describe, expect, it } from 'vitest';
import { StepMarkTracker } from './_lib/step-marks.js';

describe('agent eval — the plan/results index join is checked, not assumed', () => {
  it('the ordinary case: one start, one result, both keyed on the same index', () => {
    const marks = new StepMarkTracker();
    marks.stepStarted(0, 0);
    marks.stepFinished(0, 'success', 1);
    marks.stepStarted(1, 1);
    marks.stepFinished(1, 'success', 4);
    marks.finish();
    expect(marks.anomalies).toEqual([]);
    expect(marks.startMarks.get(1)).toBe(1);
    expect(marks.endMarks.get(1)).toBe(4);
    // Three dispatches for step 1 — the retry budget, which is the finding in F3.
    expect((marks.endMarks.get(1) ?? 0) - (marks.startMarks.get(1) ?? 0)).toBe(3);
  });

  it('the consequential halt legitimately has NO start, and the absence is RECORDED', () => {
    // The gate emits its result BEFORE announcing the step, on purpose. Nothing
    // was sent for it, so start equals end — stated, not borrowed from the
    // previous step's mark.
    const marks = new StepMarkTracker();
    marks.stepStarted(0, 0);
    marks.stepFinished(0, 'success', 1);
    marks.stepFinished(1, 'confirmation_required', 1);
    marks.finish();
    expect(marks.anomalies).toEqual([]);
    expect(marks.startMarks.get(1)).toBe(1);
    expect(marks.endMarks.get(1)).toBe(1);
    expect(marks.planIndexForResult.get(1)).toBeNull();
    // ⛔ AND THE STEP IS NAMED AS HAVING NO MEASURED ATTEMPT COUNT. `start ===
    // end` makes the arithmetic report zero, which is the right number for the
    // wrong reason: it is zero because nothing was announced, not because
    // anything was measured. Downstream those two must be distinguishable, and a
    // silence cannot be. The step that DID announce is not in the set.
    expect([...marks.noStartAnnounced]).toEqual([1]);
    expect(marks.noStartAnnounced.has(0)).toBe(false);
  });

  it('a result with no start is recorded whether or not it is the legitimate one', () => {
    // The set is the FACT ("no start was announced"); the anomaly is the
    // JUDGMENT ("and that is only allowed for a halt"). Keeping them separate
    // means a future legitimate no-start shape can be added to the judgment
    // without quietly changing what the fact means.
    const marks = new StepMarkTracker();
    marks.stepFinished(0, 'failure', 3);
    marks.finish();
    expect([...marks.noStartAnnounced]).toEqual([0]);
    expect(marks.anomalies.join('\n')).toMatch(/arrived with no step_start/);
  });

  it('NEGATIVE CONTROL: a plan index that produces a DIFFERENT results index is named', () => {
    // What happens the day a plan index stops emitting a result: every later
    // start mark belongs to a different step than the end mark it is subtracted
    // from, and every attempt count downstream is wrong by a whole step.
    const marks = new StepMarkTracker();
    marks.stepStarted(0, 0);
    marks.stepFinished(0, 'success', 1);
    marks.stepStarted(1, 1);
    marks.stepStarted(2, 5); // step 1 vanished without a result
    marks.stepFinished(1, 'success', 6);
    marks.finish();
    expect(marks.anomalies.join('\n')).toMatch(
      /plan index 2 started while plan index 1 had produced no result/,
    );
    expect(marks.anomalies.join('\n')).toMatch(/plan index 2 produced results index 1/);
    expect(marks.anomalies.length).toBe(2);
  });

  it('NEGATIVE CONTROL: a non-halt result with no start is named', () => {
    const marks = new StepMarkTracker();
    marks.stepFinished(0, 'failure', 3);
    marks.finish();
    expect(marks.anomalies.join('\n')).toMatch(/arrived with no step_start/);
  });

  it('NEGATIVE CONTROL: a start that never produces a result is named, not dropped', () => {
    // A turn can legitimately end mid-step when authority is lost. The step's
    // dispatches are then attributed to NOTHING, which the report must say
    // rather than quietly losing them out of the per-intent tally.
    const marks = new StepMarkTracker();
    marks.stepStarted(0, 0);
    marks.finish();
    expect(marks.anomalies.join('\n')).toMatch(/started and never produced a result/);
  });
});

// The eval harness PREDICTS the read-back gate so that when an answer is
// missing it can name the conjunct that blocked it. A prediction that disagrees
// with the runtime is worse than none: it names the wrong cause, confidently.
//
// ⛔ THE HARNESS USED TO TEST THE RAW PATTERN. It ran `READ_INTENT_RE` over the
// task's words as typed, skipping what the runtime does first — the NFKC fold and
// the URL strip — so the two disagreed on exactly the prompts the gate was
// widened for: a query-string `?` the runtime strips read as a question here, and
// a full-width `？` the runtime folds read as no question. It now calls the
// runtime's own `asksForInformation`, and every arm below drives the REAL
// runtime and asserts prediction and observation agree.
//
// The scripted planner fixes the PLAN, not the prompt: the prompt reaches only
// the gate, so swapping it on a corpus task changes nothing but the question
// this file asks.

import { describe, expect, it } from 'vitest';
import { runEvalTask } from './_lib/runner.js';
import { EVAL_TASKS, type EvalTask } from './_lib/tasks.js';

function corpusTask(id: string): EvalTask {
  const task = EVAL_TASKS.find((t) => t.id === id);
  if (task === undefined) throw new Error(`no corpus task ${id}`);
  return task;
}

describe('agent eval — the read-back prediction is the runtime’s gate, in any script', () => {
  it.each([
    // "Open shop.test/deals and tell me what the headline discount is？"
    ['a full-width ？ (Chinese)', '打开 shop.test/deals，主打折扣是多少？'],
    ['an Arabic ؟', 'افتح shop.test/deals، ما هو الخصم الرئيسي؟'],
  ])('%s is predicted AND observed as a question', async (_label, prompt) => {
    const report = await runEvalTask({ ...corpusTask('P1'), prompt });
    expect(report.readback.answerCallObserved).toBe(true);
    expect(report.readback.predictedGatesFailed).toEqual([]);
    expect(report.readback.crossCheckMismatch).toBeNull();
  });

  it('a query-string ? is predicted AND observed as NOT a question', async () => {
    const report = await runEvalTask({
      ...corpusTask('P2'),
      prompt: 'open https://news.test/?utm_source=mail and take a screenshot',
    });
    expect(report.readback.answerCallObserved).toBe(false);
    expect(report.readback.predictedGatesFailed).toContain('not_read_intent');
    expect(report.readback.crossCheckMismatch).toBeNull();
  });

  it('a Chinese screenshot-only instruction is predicted AND observed as NOT a question', async () => {
    const report = await runEvalTask({ ...corpusTask('P2'), prompt: '打开 news.test 并截图' });
    expect(report.readback.answerCallObserved).toBe(false);
    expect(report.readback.predictedGatesFailed).toContain('not_read_intent');
    expect(report.readback.crossCheckMismatch).toBeNull();
  });
});

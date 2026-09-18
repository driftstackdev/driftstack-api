// ⛔ THE ANSWER CRITERION WAS A CLOSED LOOP, AND THIS FILE IS THE PROOF IT IS NOT.
//
// The first version of this harness built the read-back answer by running the
// task's OWN `criterion.pattern` over the observation and returning the matching
// line. `evaluateCriterion` then scored that answer with the IDENTICAL pattern.
// So the answer half of every read-back task passed BY CONSTRUCTION and would
// have passed with the product's answer path entirely broken — the instrument
// was reading its own words back, the same defect class that once let F5's
// refusal sentence satisfy F5's own criterion.
//
// Two independent properties are checked here, because either alone can be
// satisfied by an instrument that is still wrong:
//
//  1. STRUCTURAL — a rule and the criterion it will be scored against are not
//     the same expression, for every task in the corpus. A weak check, but it
//     catches the lazy repair where somebody writes the criterion's own text
//     into the rule and calls the loop broken.
//
//  2. BEHAVIOURAL — the load-bearing half. Every answer-shaped task is driven
//     through the WHOLE runtime twice: once as written, and once with a DECOY
//     criterion swapped in. If the answer path could see the criterion, the
//     answer would move. It must be byte-identical. ⛔ THIS TEST FAILS IF THE
//     ANSWERER IS EVER FED THE CRITERION AGAIN, whatever route it arrives by —
//     a new field, a wider constructor argument, a shared module-level cell.
//
// And one negative control, because a test that only ever sees agreement cannot
// tell a criterion-blind answerer from a broken decoy: a deliberately
// criterion-FED answerer is built here and shown to produce a DIFFERENT answer
// on the same observation. That is what makes property 2 informative.

import { describe, expect, it } from 'vitest';
import { answerFromPage, describeRule, ruleAnchorText } from './_lib/answer-rule.js';
import { EVAL_ANSWERER_CIRCULARITY, EVAL_CANNOT_MEASURE } from './_lib/provenance.js';
import { runEvalTask } from './_lib/runner.js';
import { ALL_EVAL_TASKS, type EvalTask } from './_lib/tasks.js';

/** Tasks whose outcome actually turns on what the answer says. */
const ANSWER_TASKS = ALL_EVAL_TASKS.filter((t) => t.criterion.kind === 'answer_matches');

/**
 * ⛔ EVERY TASK THE ANCHOR-OVERLAP CHECK CANNOT COVER, AND WHY — ONE ENTRY EACH.
 *
 * The overlap check compares the rule's anchor TEXT against the criterion's
 * pattern. A structural rule has no anchor text: "the line at index 1" cannot
 * quote a criterion whatever the criterion says. That is a sound exemption and a
 * blanket `continue` was not: it skipped 4 of 11 tasks in silence, including one
 * whose selected line is exactly what the criterion matches.
 *
 * So each skip is written down here, individually, and the test asserts this map
 * and the set of skipping tasks are the same set — a new structural rule fails
 * until it is justified, and a stale entry fails too.
 *
 * ⚠️ NOTE WHAT THESE JUSTIFICATIONS DO NOT CLAIM. None of them says the rule was
 * chosen independently of the criterion. It was not: the index was picked by
 * someone looking at the page and knowing which line the criterion wanted. That
 * is the AUTHORSHIP circularity (H6) — unremovable without a real model, stated
 * in `provenance.ts`, and printed above every number the harness emits.
 */
const STRUCTURAL_RULE_JUSTIFICATIONS: Record<string, string> = {
  P6: 'line_at(1) on slow.test. The status line IS what the criterion matches, and a prefix rule here would have to quote it — the two would then be the same expression, which is the collision this file exists to prevent. Structural is the lesser evil: the rule cannot READ the criterion, and the BEHAVIOURAL decoy test covers this task like every other.',
  F2: 'line_at(1) on a page the plan never reaches — the login wall. The task dies at mapping, so no answer is produced at all and there is nothing for an anchor to overlap with. The rule exists only so the task is well-formed.',
  'C-POS':
    'line_at(1) on hello.test. Same shape as P6: the greeting is the criterion, so a prefix rule would restate it. This is the positive control, so its answer MUST be the greeting — an independent anchor is not available without changing what the control controls for.',
  'C-NEG':
    'line_at(1) on void.test, a page with a single line and no elements. The task dies at step 2 on a missing element, so the rule is never resolved; it is present only to keep the task shape uniform.',
  'C-PAGE-DUMP':
    'whole_observation, by design: this control exists to answer with the entire page and be REFUSED by the extraction bound. An anchor would defeat its purpose — it is not trying to select a line.',
  'C-PAGE-DUMP-2LINE':
    'whole_observation, by design, on the two-line page where the extraction bound is at its weakest. Same reason as C-PAGE-DUMP: a rule that selected a line would stop it being a dump, which is the only thing it controls for.',
};

/**
 * The answerer this round DELETED, rebuilt here as a negative control.
 *
 * It is the closed loop verbatim: build the answer by running the criterion over
 * the observation. Nothing imports it but this file.
 */
function criterionFedAnswer(task: EvalTask, observation: string): string {
  if (task.criterion.kind !== 'answer_matches') return 'no question';
  const criterion = task.criterion;
  const line = observation.split('\n').find((candidate) => criterion.pattern.test(candidate));
  return line === undefined ? 'not found' : `From the page: ${line.trim()}`;
}

describe('agent eval — the answerer cannot see the criterion that scores it', () => {
  it('there are answer-shaped tasks to check, so this file is not vacuously green', () => {
    // A filter that quietly matches nothing is how a suite reports a finding it
    // never looked for.
    expect(ANSWER_TASKS.length).toBeGreaterThanOrEqual(8);
  });

  it('STRUCTURAL: every task is either checked for overlap or individually justified', () => {
    // ⛔ THE CHECK BELOW USED TO SKIP EVERY STRUCTURAL RULE WITH A BARE
    // `if (anchor === null) continue` — 4 of 11 answer tasks, silently, and one
    // of the skipped ones returns the very line the criterion matches. A blanket
    // exemption is how a check reports on a population it never looked at.
    //
    // A structural rule genuinely has no anchor TEXT to compare: "the line at
    // index 1" contains no criterion text and could not, whatever the criterion
    // said. So the exemption is real — but it is now NAMED PER TASK, with the
    // reason written where the skip happens, and the set of skips is asserted to
    // match the set of justifications exactly. A new structural rule fails this
    // test until somebody writes down why its skip is sound, and a justification
    // left behind by a deleted task fails it too.
    const missing: string[] = [];
    for (const task of ANSWER_TASKS) {
      const skipped = ruleAnchorText(task.answerRule) === null;
      const justified = Object.hasOwn(STRUCTURAL_RULE_JUSTIFICATIONS, task.id);
      if (skipped && !justified) {
        missing.push(
          `${task.id}: rule ${describeRule(task.answerRule)} has no anchor text to compare, and no justification for skipping the overlap check`,
        );
      }
      if (!skipped && justified) {
        missing.push(
          `${task.id}: carries a skip justification but its rule DOES have anchor text — the justification is stale and the check below already covers it`,
        );
      }
    }
    expect(missing, missing.join('\n')).toEqual([]);
  });

  it('STRUCTURAL: a justified skip is still checked for the overlap it CAN be checked for', () => {
    // The exemption is from the ANCHOR comparison, not from scrutiny. A
    // structural rule is still rendered as text, and that text must not carry
    // the criterion's pattern or label either.
    //
    // ⚠️ WHAT THIS ARM IS, STATED HONESTLY, BECAUSE IT USED TO CLAIM MORE. It
    // said it catches 'a lazy repair ("index of the $29 line")' — but
    // `describeRule` renders a structural rule from its KIND and INDEX alone, so
    // for every task this arm covers (they are covered precisely because their
    // rule is structural) the rendered text cannot contain criterion text
    // whatever the criterion says. It is a TRIPWIRE for a future rule variant
    // that carries free text — `whole_observation` and `line_at` cannot trip it,
    // and a `line_matching: "the $29 line"` variant would. Presenting it as
    // scrutiny the exemption did not escape was a check reporting on a
    // population that cannot trip it.
    //
    // The overlap that DOES exist for these tasks — the selected line being the
    // line the criterion matches — is real, unremovable without a model, and
    // measured as a number by the suite's H6 arm off
    // `totals.answerRuleSelectsCriterionText`. It is not silently unexamined; it
    // is examined somewhere this arm cannot reach.
    const leaks: string[] = [];
    for (const task of ANSWER_TASKS) {
      if (!Object.hasOwn(STRUCTURAL_RULE_JUSTIFICATIONS, task.id)) continue;
      if (task.criterion.kind !== 'answer_matches') continue;
      const rendered = describeRule(task.answerRule).toLowerCase();
      for (const criterionText of [
        task.criterion.pattern.source.toLowerCase(),
        task.criterion.label.toLowerCase(),
      ]) {
        if (criterionText.length >= 3 && rendered.includes(criterionText)) {
          leaks.push(
            `${task.id}: the rule renders as "${rendered}", which quotes ${criterionText}`,
          );
        }
      }
    }
    expect(leaks, leaks.join('\n')).toEqual([]);
  });

  it('STRUCTURAL: no rule is the same expression as the criterion it will be scored by', () => {
    const collisions: string[] = [];
    let compared = 0;
    for (const task of ANSWER_TASKS) {
      if (task.criterion.kind !== 'answer_matches') continue;
      const patternSource = task.criterion.pattern.source;
      const anchor = ruleAnchorText(task.answerRule);
      // Justified per task in STRUCTURAL_RULE_JUSTIFICATIONS, asserted above.
      if (anchor === null) continue;
      compared += 1;
      const a = anchor.toLowerCase();
      const p = patternSource.toLowerCase();
      if (a === p || p.includes(a) || a.includes(p)) {
        collisions.push(
          `${task.id}: rule anchor ${JSON.stringify(anchor)} overlaps criterion /${patternSource}/ — the answerer would be restating what scores it`,
        );
      }
      // And the label the report prints is not the rule either.
      if (task.criterion.label.toLowerCase() === a) {
        collisions.push(`${task.id}: rule anchor equals the criterion label`);
      }
    }
    expect(collisions, collisions.join('\n')).toEqual([]);
    // ⛔ AND SAY HOW MANY IT ACTUALLY COMPARED. A check that reports "no
    // collisions" after comparing nothing is the failure this whole file is
    // about; the count is asserted so the coverage cannot quietly shrink.
    expect(compared).toBe(ANSWER_TASKS.length - Object.keys(STRUCTURAL_RULE_JUSTIFICATIONS).length);
    expect(compared).toBeGreaterThanOrEqual(7);
  });

  it('NEGATIVE CONTROL: a criterion-FED answerer really does answer differently', () => {
    // Without this, "the two answers matched" is uninformative — it is also what
    // you get from a decoy that never changes anything.
    const observation = [
      'Deals',
      'Autumn sale — 40% off everything in stock',
      'Starter — $29 per month, billed annually',
    ].join('\n');
    const blind = answerFromPage(
      { kind: 'line_starting_with', prefix: 'Autumn sale' },
      observation,
    );
    const fed = criterionFedAnswer(
      {
        ...ANSWER_TASKS[0]!,
        criterion: { kind: 'answer_matches', pattern: /\$29/, label: '$29' },
      },
      observation,
    );
    expect(blind).toContain('Autumn sale');
    expect(fed).toContain('$29');
    expect(blind).not.toBe(fed);
  });

  it('BEHAVIOURAL: swapping in a DECOY criterion does not move the answer, for every task', async () => {
    // ⛔ THE REAL TEST. Drive the whole runtime — real AgentRuntime, real
    // executor, the product's own answer path — twice per task, changing ONLY
    // the criterion. A criterion-aware answerer cannot survive this.
    const moved: string[] = [];
    for (const task of ANSWER_TASKS) {
      const asWritten = await runEvalTask(task);
      const withDecoy = await runEvalTask({
        ...task,
        criterion: {
          kind: 'answer_matches',
          // Deliberately matches a line that IS on several corpus pages, so a
          // leaky answerer has something tempting to return.
          pattern: /Cart: empty|Compare plans|Ferry/i,
          label: 'a decoy the real criterion never mentions',
        },
      });
      // ⛔ COMPARE THE ANSWER, NOT THE SCORER'S VIEW OF IT. This read
      // `criterion.actual`, which is a RENDERING of the answer that carries the
      // criterion's own verdict (a refused page dump is annotated there). That
      // string legitimately moves when the criterion moves while the answer is
      // byte-identical, so it reported the framing as a leak — a view of the
      // artefact is not the artefact.
      if (asWritten.answerText !== withDecoy.answerText) {
        moved.push(
          `${task.id}: the answer changed when only the CRITERION changed — the answerer can see it.\n  as written: ${asWritten.answerText ?? '(none)'}\n  with decoy: ${withDecoy.answerText ?? '(none)'}`,
        );
      }
    }
    expect(moved, moved.join('\n')).toEqual([]);
  }, 60_000);

  it('the rule resolver takes exactly two arguments, and a criterion is not one of them', () => {
    // Arity is a cheap, real fence: the closed loop returned when somebody had a
    // task object in hand and reached for `.criterion`. `answerFromPage` never
    // has one.
    expect(answerFromPage.length).toBe(2);
    expect(describeRule({ kind: 'line_at', index: 1 })).toBe('the line at index 1');
  });

  it('H6: the loop is broken; the shared AUTHOR is not, and the provenance says so', () => {
    // ⛔ WHAT THIS FILE PROVES AND WHAT IT CANNOT. The answerer cannot READ the
    // criterion — that is the loop, and the decoy test above measures it. But
    // `answerRule` is written on the same object literal as `criterion`, by the
    // same hand, in the same edit, and whoever wrote `{ index: 1 }` was looking
    // at the page and knew which line the criterion wanted. No test in this file
    // can see that, and none pretends to: removing it needs a real model
    // choosing what to say.
    //
    // So it is declared where the numbers are read, and this asserts the
    // declaration is actually there — a limitation that lives only in a comment
    // is one nobody quoting the artefact will ever encounter.
    expect(EVAL_ANSWERER_CIRCULARITY).toContain('same object literal');
    expect(EVAL_ANSWERER_CIRCULARITY).toContain('Answer quality is unmeasured');
    expect(EVAL_CANNOT_MEASURE).toContain('answer QUALITY');
    // And it is true of the source: rule and criterion are siblings on every task.
    for (const task of ANSWER_TASKS) {
      expect(
        Object.hasOwn(task, 'answerRule') && Object.hasOwn(task, 'criterion'),
        `${task.id}: the limitation is stated as "written on the same object literal" — if that stops being true, restate it`,
      ).toBe(true);
    }
  });

  it('the refusal sentence never satisfies any criterion in the corpus', () => {
    // MEASURED ACROSS THE WHOLE CORPUS, not spot-checked. An answerer that says
    // "I could not find X" hands the criterion its own X back.
    const refusal = answerFromPage(
      { kind: 'line_starting_with', prefix: 'A prefix no page carries' },
      'an unrelated page',
    );
    for (const task of ANSWER_TASKS) {
      if (task.criterion.kind !== 'answer_matches') continue;
      expect(
        task.criterion.pattern.test(refusal),
        `${task.id}: the refusal "${refusal}" matched ${String(task.criterion.pattern)}`,
      ).toBe(false);
    }
  });
});

// WHAT THIS SUITE MEASURES, IN ONE PLACE, SO EVERY SURFACE SAYS THE SAME THING.
//
// ⛔ THE HEADLINE CLAIM THIS FILE EXISTS TO CORRECT. The suite used to present a
// "completion rate" beside the word `plannerMode`, which reads as a statement
// about the agent's planning. It is not one and cannot become one here:
// `runEvalTask` always constructs `ScriptedAgentDecomposer`, whose
// `decompose(_args)` DISCARDS every argument and returns the hand-written plan
// from `tasks.ts`. No decompose request is built and no model chooses a plan, so
// the EXECUTED PLAN is fixed and a number moving here is never evidence about
// planning quality. A number that is honest about its scope is worth more than a
// number that flatters the next commit.
//
// ⛔ AND THE CORRECTION TO THE CORRECTION, MEASURED. The first version of this
// file said the rates were "invariant under every possible change to the
// planner", and that giving the planner the page "would report the identical
// number before and after". THE VERY RUN IT WAS WRITTEN FOR FALSIFIED IT: a
// concurrent change that gives the planner the page moved the rate 0.455 → 0.636,
// because such a change also lands in the runtime (the read-back gate) and in the
// executor (retry timing), which this suite exercises for real. Two distinct
// claims were being run together:
//
//   TRUE  — the executed plan cannot vary with what a planner would have
//           produced. Asserted against the code in `agent-eval-suite.test.ts`.
//   FALSE — therefore no commit that touches planning can move these numbers.
//
// The second does not follow from the first, and a reader who believed it would
// have concluded that the six red arms in that run could not have been caused by
// the src change. They were. So the wording below claims only the first.
//
// ⚠️ AND THE ANSWER HALF RUNS THE PLANNER'S OWN CLASS. `scripted-decomposer.ts`
// constructs the real `ClaudeAgentDecomposer` for the read-back, so its request
// assembly, envelope parsing, retry backoff and usage accounting are all live in
// these numbers. "No planner code runs" was false; "no decompose request is
// built" is what is true.
//
// The text below is the canonical wording. The report banner, the JSON artefact
// and the checked-in baseline all render it from here, so the framing cannot be
// true in one surface and stale in another.

/** The first thing a reader sees, everywhere. */
export const EVAL_HEADLINE =
  'AN EXECUTOR EVAL, NOT A PLANNER EVAL. The plans are hand-written in tasks.ts and the scripted decomposer discards its arguments, so no decompose request is built and no model chooses a plan: the EXECUTED PLAN IS FIXED and no rate below is evidence about planning quality. ⚠️ That is NOT invariance — a commit that changes planning also lands in the runtime and the executor around decompose, and those DO move every rate below.';

/** The layers a number from this suite IS evidence about. */
export const EVAL_MEASURES =
  "the executor and its retry/no-retry fences, the intent→harness verb mapping and its CSS-selector refusal, the wire codec, the result→customer mapper, the consequential-action safety gate, the read-back gate, and the product's own answer request/parse path — which runs the real ClaudeAgentDecomposer, the SAME class the planner uses, so its request assembly, envelope parsing, retry backoff and usage accounting are in scope here too";

/** The layers a number from this suite is NOT evidence about. */
export const EVAL_CANNOT_MEASURE =
  'planning quality — the executed plan is fixed, so a rate that MOVES is not evidence that planning improved, and a rate that does NOT move is not evidence that it did not; answer QUALITY, because the answers come from page rules we wrote; a page-dump answer that was REWORDED rather than quoted, which the extraction bound cannot see; and anything about a real browser, a real site or anything physical';

/**
 * H1, restated as a falsifiable sentence rather than a caveat.
 *
 * ⛔ IT SAYS "THE PLAN IS FIXED", NOT "THE NUMBERS CANNOT MOVE". The assertion in
 * `agent-eval-suite.test.ts` establishes exactly one fact — that the decomposer's
 * plan does not vary with its arguments — and the earlier wording here inflated
 * that into invariance under any planner commit, which a real run then falsified.
 * What follows from the assertion is narrower and still worth saying: whatever
 * moved, it was not the agent choosing a better plan.
 */
export const EVAL_EXECUTED_PLAN_IS_FIXED =
  'ScriptedAgentDecomposer.decompose ignores its arguments and returns the plan written in tasks.ts, so the plan these numbers were produced under cannot vary with what a planner would have chosen. Asserted, not assumed: see "the executed plan cannot vary with what a planner would have produced". ⚠️ It does NOT follow that a planner commit cannot move these numbers — such a commit also changes the runtime and the executor, which this suite runs for real.';

/**
 * H6 — the circularity that MOVED rather than being removed, stated where the
 * number is read.
 *
 * The answer no longer comes from the criterion's own pattern (that loop is gone
 * and `agent-eval-answerer-is-criterion-blind.test.ts` proves it). But
 * `answerRule` is written on the same object literal as `criterion`, by the same
 * author, in the same edit — and in every answer task the corpus expects to
 * pass, the rule selects the line the criterion matches. That cannot be removed
 * without a real model choosing what to say, so it is declared instead — and
 * COUNTED: `totals.answerRuleSelectsCriterionText` is the overlap as a number.
 */
export const EVAL_ANSWERER_CIRCULARITY =
  'the answer rule is authored on the same object literal as the criterion it will be scored against, by the same hand, so a passing answer task shows the answer PATH works — never that a model would have picked that line. Answer quality is unmeasured here; the overlap is counted in totals.answerRuleSelectsCriterionText rather than left as prose.';

/** The completion rate's label. It travels with the number everywhere. */
export const EVAL_RATE_LABEL =
  'share of the hand-written scripted plans that met their criterion — an EXECUTOR-and-answer-path number, produced under a FIXED plan and therefore not evidence about planning quality in either direction';

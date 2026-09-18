// ═══════════════════════════════════════════════════════════════════════
// A DETERMINISTIC EVAL OF THE EXECUTION LAYERS. ⛔ IT IS NOT A PLANNER EVAL:
// THE EXECUTED PLAN IS FIXED, SO NO NUMBER HERE IS EVIDENCE ABOUT PLANNING.
// ═══════════════════════════════════════════════════════════════════════
//
// READ THIS BEFORE QUOTING ANYTHING BELOW. `runEvalTask` always constructs
// `ScriptedAgentDecomposer`, whose `decompose(_args)` DISCARDS every argument and
// returns the hand-written plan from `tasks.ts`. No decompose request is built
// and no model chooses a plan, so the plan these numbers ran under cannot vary
// with what a planner would have produced. (Asserted against the code, not merely
// stated: see "the executed plan cannot vary with what a planner would have
// produced".)
//
// ⛔ AND THE CORRECTION THAT ROUND TWO GOT WRONG, MEASURED IN THE VERY RUN IT WAS
// WRITTEN FOR. This header used to continue "…therefore MATHEMATICALLY INVARIANT
// under every possible change to the planner. A planner improvement will move
// this number by exactly zero." That does not follow and it is false. A commit
// that gives the planner the page also lands in the runtime (the read-back gate)
// and the executor (retry timing) — both of which this suite runs FOR REAL — and
// one did, moving the rate 0.455 → 0.636 while the plans stayed identical. A
// reader who believed the old wording would have concluded that the red arms in
// that run could not have been caused by the src change. They were. What is true
// is narrower and still worth saying: whatever moves here, it is not the agent
// choosing a better plan.
//
// ⚠️ THE ANSWER HALF RUNS THE PLANNER'S OWN CLASS, TOO. `scripted-decomposer.ts`
// constructs the real `ClaudeAgentDecomposer` for the read-back, so its request
// assembly, envelope parsing, retry backoff and usage accounting are live in
// these numbers. "No planner code runs" was the wrong sentence; "no decompose
// request is built" is the right one.
//
// WHAT IT DOES MEASURE. The scripted corpus plus every instrument control in
// `EVAL_CONTROLS`, each driven as a WHOLE TURN through the real `AgentRuntime`: the
// real executor and its retry fences, the real verb mapper and its selector
// refusal, the real wire codec, the real result mapper, the real
// consequential-action gate, the real read-back gate and the product's own
// answer request/parse path. Only three
// things are substituted: the planner (scripted plans), the device (a scripted
// page model behind `IntentDispatcher`), and the clock. The read-back's provider
// reply is substituted too, by a per-task PAGE RULE that has never seen the
// criterion (`_lib/answer-rule.ts`).
//
// WHAT IT CANNOT MEASURE. Planning QUALITY: the executed plan is fixed, so a
// rate that moves here is not evidence that planning improved and a rate that
// holds still is not evidence that it did not. Answer QUALITY — the answers come
// from rules we wrote, on the same object literal as the criteria that score
// them. A page dump that was REWORDED rather than quoted. A real browser, a real
// site, or anything physical.
//
// The harness's job is to measure WHERE a turn dies, per intent and per reason,
// not merely whether it finished.
//
// ⛔ WHAT CHANGED IN THE THIRD HONESTY ROUND, so nobody re-introduces it:
//   · The headline was made STRONGER than the code keeps: "invariant under every
//     possible change to the planner". Narrowed to the claim that is asserted —
//     the executed plan is fixed — everywhere it is rendered.
//   · The H6 arm claimed to MEASURE the authorship circularity and could not
//     fail in the direction it claimed: it filtered `designedToPass` by
//     `outcome === 'pass'`, which for an answer task IS `criterion.met`, so both
//     sides lost a task together whenever one broke. The overlap is counted now,
//     per task, off `answerPatternMatched`, and printed in the banner.
//   · The extraction bound was verbatim-line containment only, controlled by one
//     input on the one page where it is strongest. It has three readings now
//     (lines, character share, word share), a control on the WEAK two-line
//     branch, and it SAYS when an observation is too small to discriminate.
//   · `EVAL_WRITE_BASELINE=1` wrote from `beforeAll` and was refused by an
//     ordinary `it` — which a name filter skips while the hook still rewrites the
//     artefact. The hook throws immediately after writing now, and refuses to
//     write at all when the instrument's own controls say the run is not
//     quotable.
//   · The halt's second reading filtered on the mapped VERB, so a mapping change
//     would have silently reduced two readings to one. It scans params now.
//   · `misbehavingControls` compared outcomes only, so a control that failed for
//     an entirely different reason rendered as healthy.
//
// ⛔ WHAT CHANGED IN THE SECOND HONESTY ROUND, so nobody re-introduces it:
//   · The headline claim. The rate is named `scriptedPlanCompletionRate` now,
//     everywhere, and the artefact leads with what the suite cannot measure.
//   · The answer criterion was UNBOUNDED CONTAINMENT: `pattern.test(answer)`, so
//     an extractor returning the whole page verbatim scored PASS. The answer must
//     now be an EXTRACTION, bounded against the observation, and C-PAGE-DUMP is
//     the control that fails on exactly that bound.
//   · F6's criterion rested on an attempt count that is 0 BY CONSTRUCTION for the
//     halted step. It reads the dispatch log directly now, and the halt's missing
//     step_start is recorded rather than papered over.
//   · `EVAL_WRITE_BASELINE=1` wrote the artefact in `beforeAll`, before any test
//     read it, so that run certified whatever it had just produced. The baseline
//     is snapshotted before the run and a writing run can no longer be a green
//     one.
//   · The criterion-blindness check silently skipped every structural rule. Each
//     skip is now named and justified individually.
//
// ⛔ WHAT CHANGED IN THE FIRST HONESTY ROUND, so nobody re-introduces it:
//   · The answer used to be BUILT by running the criterion over the observation
//     and then SCORED by the same pattern. Closed loop; the answer half passed
//     by construction. Now the answer comes from a page rule the criterion
//     cannot reach, through the product's own answer path.
//   · P4's criterion counted the hand-written plan, so both its conjuncts were
//     constants. It counts succeeded dispatches now.
//   · F4 tapped a selector no page carries, so it died of a fixture typo rather
//     than of blindness and could never have flipped. Rebuilt, and PAIRED with
//     F4-SIGHTED, which must pass today.
//   · The negative control died at step 2 and exercised none of the scorer.
//     C-NEG-SCORED reaches it and must still fail.
//   · The read-back gate was re-derived in parallel and mis-attributed
//     unmodelled blocks. It is OBSERVED now, and the prediction is cross-checked.
//   · The artefact named its rate after a tier that did not produce it.
//   · Step start/end marks were joined across two index spaces with no check.
//   · `promptSha256` was pinned on runs that send no prompt.
//   · The per-intent tally counted the safety halt as a failed click.
//
// ═══════════════════════════════════════════════════════════════════════
// WHAT THIS HARNESS CANNOT TELL US. Read this before quoting any number.
// ═══════════════════════════════════════════════════════════════════════
//
// 1. IT IS NOT A REAL BROWSER. No rendering, no CSS cascade, no shadow DOM, no
//    JS execution. Concretely: the shadow-DOM-piercing visibility predicate and
//    the idle-settle MutationObserver predicate are NEVER EXECUTED here — the
//    device pattern-matches their generated source to decide which wait it is
//    looking at. A green eval is entirely compatible with both being broken on
//    the real device. Those need a real one.
//
// 2. THE SELECTORS ARE OUR OWN FICTION, ON BOTH SIDES. We author the page AND
//    the plan that targets it. Any claim of the form "the agent completes N% of
//    real tasks" is unsupported by this instrument. The honest claim is the one
//    the rate now carries its own name for: "N% of the hand-written scripted
//    plans met their criterion — an executor-and-answer-path number, produced
//    under a FIXED plan". ⚠️ The pre-round phrasing of this line ("N% of a fixed
//    12-task scripted corpus, under plannerMode=<mode>") survived the rename and
//    is exactly what the rename was for: `plannerMode` beside a rate is what made
//    a scripted number quotable as an agent number.
//
// 3. REAL SITES CHANGE. This is a regression detector and a failure-localiser,
//    not a production predictor. Completion here can rise while production falls.
//
// 4. IT DOES NOT COVER THE LAYERS PRODUCTION CONFLICTS ON. This drives runTurn
//    directly and exercises none of the route layer, the database repo, the
//    event stream, transcript encryption or billing persistence. If conflicts at
//    the route layer are the dominant production failure, this harness will not
//    move that number and must not be quoted as if it could.
//
// 5. IT CANNOT MEASURE ANYTHING PHYSICAL. Cold start, egress, proxy behaviour,
//    real latency, real screenshots. `simulatedDeviceMs` is a property of our
//    page scripts, not of any device.
//
// 6. IT CANNOT PROVE THE MODEL WOULD EMIT THESE PLANS TODAY. Under
//    plannerMode=scripted it proves nothing about the planner at all — we wrote
//    the plans. The tier that would say something about the planner is
//    `recorded`, and this repository carries no recordings: see
//    `agent-eval-recordings-are-current.test.ts`.
//
// ⚠️ AND ONE PROPERTY OF THE EXPECTATIONS THEMSELVES: `matchedExpectation` for
// an expected-FAIL task means THE TASK STILL FAILS. When the planner improves,
// half this suite goes red BY DESIGN. Whoever wires CI must know that, or the
// first real improvement will read as a breakage.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  EVAL_ANSWERER_CIRCULARITY,
  EVAL_CANNOT_MEASURE,
  EVAL_HEADLINE,
  EVAL_MEASURES,
  EVAL_EXECUTED_PLAN_IS_FIXED,
  EVAL_RATE_LABEL,
} from './_lib/provenance.js';
import { currentPromptSha256 } from './_lib/recorded-decomposer.js';
import { baselineFromReport, renderTable, writeReport, type EvalBaseline } from './_lib/report.js';
import {
  aggregate,
  misbehavingControls,
  type EvalProvenance,
  type EvalReport,
  type TaskReport,
} from './_lib/score.js';
import { gitSha, runEvalTask, EVAL_MAX_RETRIES, EVAL_RETRY_DELAY_MS } from './_lib/runner.js';
import { ScriptedAgentDecomposer } from './_lib/scripted-decomposer.js';
import { EVAL_CONTROLS, EVAL_TASKS } from './_lib/tasks.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = resolve(HERE, 'eval-baseline.json');
const RUN_ID = 'latest';

/**
 * ⛔ R8 — THE DECOMPOSE PROMPT IS NOT PINNED UNDER `scripted`, AND THAT IS THE
 * HONEST POSITION. The suite used to pin `promptSha256` on every run, including
 * runs that send no system prompt at all: under `plannerMode: scripted` the plan
 * comes from `tasks.ts` and the decomposer makes no provider call, so the pin
 * guarded an input the run never consumed. A pin like that cannot protect the
 * number it sits beside — it can only fail for a reason unrelated to it. The
 * ANSWER prompt IS consumed (the read-back runs through the product's own answer
 * path) and is pinned instead, observed off the wire rather than imported.
 */
const DECOMPOSE_PROMPT_NOT_CONSULTED =
  'under plannerMode=scripted the plan comes from tasks.ts and no decompose request is built, so there is no prompt for this run to be a statement about. Re-pin it the moment a recorded or live planner tier runs.';

/**
 * ⛔ H4 — A RUN THAT WRITES THE BASELINE CANNOT ALSO CERTIFY IT.
 *
 * `EVAL_WRITE_BASELINE=1` used to write the artefact inside `beforeAll`, BEFORE
 * any test read it. Every arm that reads the baseline — the per-task drift
 * check, the provenance check, the rate check — then compared this run against a
 * file this run had just produced, so all three were tautological in exactly the
 * run that regenerates them. A regeneration that certifies itself is how a wrong
 * baseline becomes the pinned one.
 *
 * ⛔ THE FIX, AND WHICH OF THE TWO IT IS: BOTH, because either alone leaves a
 * hole.
 *  1. THE VERIFICATION READS A SNAPSHOT TAKEN BEFORE THE WRITE. The file is read
 *     into {@link baselineSnapshot} as the first statement of the hook, before a
 *     single task runs, and every arm below reads that — never the file.
 *  2. AND A WRITING RUN IS NOT A GREEN RUN. The snapshot alone would leave a
 *     regeneration run reporting "baseline verified" while the file on disk is a
 *     different one nobody has checked. So a run with the flag set fails, by
 *     design, naming the second run that has to follow it.
 *
 * Regenerating is therefore two deliberate acts: run with the flag (red, writes
 * the file), then run without it (green, verifies the file that is now there).
 *
 * ⛔ AND THE REFUSAL IS THROWN BY THE HOOK, NOT ASSERTED BY A TEST. It was an
 * ordinary `it`, which made "a writing run is red" true only while that arm was
 * SELECTED: `EVAL_WRITE_BASELINE=1 vitest run … -t 'F6'` still ran the hook,
 * still rewrote the checked-in artefact, and exited green with the refusal
 * filtered out. A guard a filter can skip is a guard in the wrong phase. The
 * throw below cannot be filtered, and the `it` is kept only to state the rule
 * where a reader looks for it.
 *
 * ⛔ THE WRITE IS ALSO GATED ON THE INSTRUMENT'S OWN CONTROLS. The hook wrote
 * before any control arm had run, so a run whose positive control had failed, or
 * whose index spaces had diverged, could still pin a baseline produced by a
 * broken instrument. `misbehavingControls` and the index-space anomalies are
 * checked FIRST and a failing instrument refuses to pin anything.
 */
const BASELINE_WRITE_REQUESTED = process.env.EVAL_WRITE_BASELINE === '1';

let report: EvalReport;
let byId: Map<string, TaskReport>;
/** The checked-in baseline as it was BEFORE this process could touch it. */
let baselineSnapshot: EvalBaseline;

beforeAll(async () => {
  // ⛔ FIRST STATEMENT IN THE HOOK. Before any task runs, before any write.
  baselineSnapshot = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as EvalBaseline;
  const startedAt = new Date('2026-09-17T00:00:00.000Z').toISOString();
  const wallStart = performance.now();
  const corpus: TaskReport[] = [];
  for (const task of EVAL_TASKS) corpus.push(await runEvalTask(task));
  const controls: TaskReport[] = [];
  for (const task of EVAL_CONTROLS) controls.push(await runEvalTask(task));
  // Observed, not imported: the answer prompt is whatever the product actually
  // put on the wire during this run.
  const answerPromptSha =
    [...corpus, ...controls].find((t) => t.answerSystemPromptSha256 !== null)
      ?.answerSystemPromptSha256 ?? null;
  const provenance: EvalProvenance = {
    headline: EVAL_HEADLINE,
    measures: EVAL_MEASURES,
    cannotMeasure: EVAL_CANNOT_MEASURE,
    executedPlanIsFixed: EVAL_EXECUTED_PLAN_IS_FIXED,
    answererCircularity: EVAL_ANSWERER_CIRCULARITY,
    answerQualityMeasured: false,
    plannerMode: 'scripted',
    plannerDescription:
      'plans hand-written in tasks.ts and executed through the real AgentRuntime; no model chose them',
    answererMode: 'page_rule_via_product_answer_path',
    answererDescription:
      "the product's own ClaudeAgentDecomposer.answerFromObservation, served by a stand-in provider whose reply text comes from a per-task page rule that has never seen the criterion; no model wrote the answers",
    decomposeSystemPromptSha256: null,
    decomposeSystemPromptNote: DECOMPOSE_PROMPT_NOT_CONSULTED,
    answerSystemPromptSha256: answerPromptSha,
  };
  report = aggregate({
    runId: RUN_ID,
    startedAt,
    gitSha: gitSha(),
    provenance,
    corpus,
    controls,
    wallClockMs: Math.round(performance.now() - wallStart),
  });
  byId = new Map(report.tasks.map((t) => [t.taskId, t]));
  const text = renderTable(report);
  const written = writeReport(report, text);
  // Printed, not only written: a report nobody opens is not a report.
  // eslint-disable-next-line no-console
  console.log(`${text}\nreport written to ${written.jsonPath} and ${written.textPath}`);
  if (BASELINE_WRITE_REQUESTED) {
    // ⛔ THE INSTRUMENT'S OWN VERDICT ON ITSELF COMES FIRST. A baseline pinned
    // from a run whose controls misbehaved is a wrong number wearing the word
    // "baseline"; refusing is the only honest outcome, and the message names
    // exactly which pin has to move.
    const sick = misbehavingControls(report);
    const anomalies = report.tasks.flatMap((t) =>
      t.indexSpaceAnomalies.map((a) => `${t.taskId}: ${a}`),
    );
    if (sick.length > 0 || anomalies.length > 0) {
      throw new Error(
        `REFUSING TO WRITE eval-baseline.json: this run is not quotable.\n` +
          `  controls: ${sick.join('; ') || 'ok'}\n` +
          `  index-space anomalies: ${anomalies.join('; ') || 'none'}\n` +
          `If a control's reason moved for a good reason, update CONTROLS_EXPECTED in _lib/score.ts in the same deliberate act as the baseline entry it travels with, then regenerate.`,
      );
    }
    // Everything that verifies the baseline reads `baselineSnapshot`, taken
    // above before this line could run. This write is the regeneration act, and
    // the run that performs it is red by design — see BASELINE_WRITE_REQUESTED.
    writeFileSync(
      BASELINE_PATH,
      `${JSON.stringify(baselineFromReport(report), null, 2)}\n`,
      'utf8',
    );
    // ⛔ THROWN FROM THE HOOK, WHERE NO NAME FILTER CAN REACH IT. See the
    // BASELINE_WRITE_REQUESTED comment: as an `it`, this refusal was skippable
    // and a filtered writing run exited green having rewritten the artefact.
    throw new Error(
      'eval-baseline.json was REGENERATED by this run, so this run is not a verification of it. That is by design: re-run WITHOUT EVAL_WRITE_BASELINE=1 to verify the file that is now on disk. Regenerating is two deliberate acts.',
    );
  }
}, 120_000);

function task(id: string): TaskReport {
  const found = byId.get(id);
  if (found === undefined) throw new Error(`no report for task ${id}`);
  return found;
}

describe('executor eval — what the numbers are, and are not, a measurement of', () => {
  it('the executed plan cannot vary with what a planner would have produced', async () => {
    // ⛔ THE HEADLINE CLAIM, ASSERTED AGAINST THE CODE. Saying "the plans are
    // hand-written" in a comment is a belief; this is the measurement. The same
    // decomposer is asked to decompose two completely different tasks, with
    // different archetypes, histories and budgets — and returns the identical
    // plan object, because `decompose(_args)` never reads its argument.
    //
    // ⛔ AND NOTE EXACTLY WHAT THIS DOES AND DOES NOT ESTABLISH — the previous
    // version of this test was named "the planner is structurally unable to
    // affect any number in this run", which is a claim it never made. It shows
    // the PLAN is fixed. It does NOT show the numbers are invariant under a
    // planner commit: such a commit also changes the runtime and the executor,
    // which run for real here, and one did — the rate moved 0.455 → 0.636 with
    // every plan byte-identical. A number moving is not evidence that planning
    // improved; a number holding still is not evidence that it did not.
    //
    // ⛔ AND IT SETTLES A SECOND QUESTION PEOPLE WILL ASK OF THIS SUITE: whether
    // it measures RE-PLANNING. It cannot. A runtime that re-plans after a failure
    // calls `decompose` again with the failure in hand — and this assertion is
    // exactly the proof that the second call returns the same plan as the first.
    // So a re-plan here replays the identical plan; the quality of a re-plan is
    // as unmeasurable as the quality of a first plan, and the only visible trace
    // is a higher model-call count. ⚠️ The re-planning CODE can still move these
    // numbers — it runs — which is the same distinction the headline draws.
    const scripted = new ScriptedAgentDecomposer({
      plan: EVAL_TASKS[0]!.plan,
      answerRule: EVAL_TASKS[0]!.answerRule,
    });
    const first = await scripted.decompose({
      task: 'go to shop.test/deals and tell me the headline discount',
      archetype: 'iphone16pro_ios18_7_safari26_4',
      history: [],
      budgetTokensRemaining: 100_000,
    });
    const second = await scripted.decompose({
      task: 'something else entirely, on a different site, in a different shape',
      archetype: 'pixel9_android15_chrome131',
      history: [
        { at: '2026-09-17T00:00:00.000Z', role: 'user', body: 'context a planner would have read' },
      ],
      budgetTokensRemaining: 42,
    });
    expect(first.kind).toBe('plan');
    expect(second.kind).toBe('plan');
    expect(second.kind === 'plan' ? second.intents : null).toEqual(
      first.kind === 'plan' ? first.intents : undefined,
    );
    // And the provenance every reader sees says exactly this, in the same words.
    expect(report.provenance.headline).toContain('NOT A PLANNER EVAL');
    expect(report.provenance.headline).toContain('EXECUTED PLAN IS FIXED');
    expect(report.provenance.cannotMeasure).toContain('planning quality');
    expect(report.provenance.executedPlanIsFixed).toContain('ignores its arguments');
    // ⛔ AND THE OVERCLAIM IS GONE FROM THE WORDING, NOT JUST FROM THE COMMENTS.
    // "invariant under every possible change to the planner" was printed first
    // on every surface and was falsified by the first run it shipped in.
    for (const surface of [
      report.headline,
      report.provenance.headline,
      report.provenance.cannotMeasure,
      report.provenance.executedPlanIsFixed,
      baselineFromReport(report).scriptedPlanCompletionRate.label,
    ]) {
      expect(surface, `"${surface}" still claims invariance the code does not keep`).not.toMatch(
        /invariant under every/i,
      );
    }
    expect(Object.keys(baselineFromReport(report).scriptedPlanCompletionRate)).not.toContain(
      'invariantUnderPlannerChange',
    );
  });

  it('the tier the banner names is the tier the run actually constructed', () => {
    // ⛔ TWO INDEPENDENT FACTS, NOT ONE LITERAL COMPARED TO ITSELF.
    // `provenance.plannerMode` is hand-written in the hook above, and the arm
    // that checks the baseline's provenance compares it against the SAME
    // literal. If `runEvalTask` ever swapped tiers, the banner would keep
    // printing "no decompose request is built" and every provenance arm would
    // keep passing, because none of them reads what the run instantiated. This
    // one does: `plannerTier` is copied off the decomposer object the runner
    // built, and it must agree with what the banner claims.
    const disagreeing = report.tasks
      .filter((t) => t.plannerTier !== report.provenance.plannerMode)
      .map(
        (t) =>
          `${t.taskId}: ran under ${t.plannerTier}, banner says ${report.provenance.plannerMode}`,
      );
    expect(disagreeing, disagreeing.join('\n')).toEqual([]);
    expect(report.tasks.length).toBeGreaterThan(0);
  });

  it('H6: the authorship overlap is COUNTED, and the count is where the number is', () => {
    // ⛔ THE CIRCULARITY MOVED; IT DID NOT GO AWAY. The answerer can no longer
    // read the criterion — that loop is gone and proved gone. But the rule is
    // written on the same object literal as the criterion, by the same hand, and
    // in every answer task the corpus expects to pass the rule selects the line
    // the criterion matches.
    //
    // ⛔ WHAT THIS ARM USED TO DO, AND WHY IT WAS WORTH NOTHING. It compared
    // "answer tasks whose criterion was met" against "answer tasks designed to
    // pass" — after filtering the second set by `outcome === 'pass'`. For an
    // answer task `outcome === 'pass'` IS `criterion.met` (score.ts, no halt path
    // for answer tasks), so both sides lost a task together whenever one broke:
    // if the page rule stopped selecting P1's line tomorrow, P1 would leave BOTH
    // sets and the arm would stay green. Its only failing direction — an
    // expected-FAIL answer task meeting its criterion — is already pinned twice
    // over, by the divergence arm and by the controls. It claimed to state a
    // limitation "as a number" and stated nothing.
    //
    // So COUNT the overlap. `answerPatternMatched` is the containment half of
    // the verdict on its own — not ANDed with the extraction bound, not filtered
    // by what the task was designed to do — and the count is rendered in the
    // banner beside the rate.
    // ⛔ THE PER-TASK READING FIRST, because its message names the task and
    // quotes the answer. A task DESIGNED to pass whose answer does not satisfy
    // its criterion — the direction the old `outcome === 'pass'` filter hid.
    // Only one cause may excuse it: the read-back never produced an answer at
    // all. That cause is NAMED rather than silently filtered out, so a P5-style
    // gate block is visible in the message instead of vanishing from both sides.
    const answerTasks = report.tasks.filter((t) => t.criterion.kind === 'answer_matches');
    const unsatisfied = answerTasks.filter((t) => t.expected === 'pass' && !t.criterion.met);
    const blockedBeforeAnswering = unsatisfied
      .filter((t) => !t.readback.answered)
      .map((t) => `${t.taskId} (${t.diedAt?.reasonClass ?? 'none'})`);
    const answeredAndStillMissed = unsatisfied
      .filter((t) => t.readback.answered)
      .map(
        (t) => `${t.taskId}: answered "${t.answerText ?? ''}" and did not satisfy its criterion`,
      );
    expect(
      answeredAndStillMissed,
      `${answeredAndStillMissed.join('\n')}\n(tasks excused because the read-back never answered: ${blockedBeforeAnswering.join(', ') || 'none'})`,
    ).toEqual([]);

    // AND THE SAME FACT AT CORPUS LEVEL. The overlap is LARGE, and that is the
    // finding: a page rule written beside the criterion hands the criterion its
    // own text back most of the time. A model answerer would not be guaranteed
    // to, which is precisely why a passing answer task is evidence about the
    // answer PATH and not about answer quality.
    //
    // ⚠️ THESE TWO READINGS ARE NOT INDEPENDENT, and the mutation proof says so:
    // one mutation (P6's rule selecting a different line) kills both, because
    // `answerPatternMatched` is the fact under each. The corpus is too small to
    // move one without the other — six answering tasks, so a single miss takes
    // the ratio to exactly 0.5. The pair is kept because the messages answer
    // different questions: WHICH task, and HOW MUCH of the corpus.
    const overlap = report.totals.answerRuleSelectsCriterionText;
    expect(
      overlap.of,
      'no corpus task answered at all — this arm is vacuous',
    ).toBeGreaterThanOrEqual(4);
    expect(
      overlap.matched / overlap.of,
      `the page rule selected the criterion's own text in ${String(overlap.matched)} of ${String(overlap.of)} answering corpus tasks — restate EVAL_ANSWERER_CIRCULARITY if that is no longer "most of them"`,
    ).toBeGreaterThan(0.5);

    expect(report.provenance.answerQualityMeasured).toBe(false);
    expect(report.provenance.answererCircularity).toContain('same object literal');
    expect(report.provenance.cannotMeasure).toContain('answer QUALITY');
  });

  it('the machine-readable report leads with its scope, exactly as the baseline does', () => {
    // The banner was right and the JSON was the inconsistent surface: a tool
    // ingesting the report, or someone pasting an excerpt of it, reached runId,
    // startedAt and gitSha before any statement of what the numbers are not.
    expect(Object.keys(report)[0]).toBe('headline');
    expect(Object.keys(report)[1]).toBe('cannotMeasure');
    expect(report.headline).toBe(report.provenance.headline);
    expect(report.cannotMeasure).toBe(report.provenance.cannotMeasure);
  });
});

describe('executor eval — instrument controls', () => {
  it('the POSITIVE control passes; if it does not, no number in this run means anything', () => {
    const positive = task('C-POS');
    expect(
      positive.outcome,
      `the trivially completable control did not pass — the harness is broken before the agent is. actual: ${positive.criterion.actual}`,
    ).toBe('pass');
  });

  it('the NEGATIVE control fails; if it passes, the executor is inventing success', () => {
    const negative = task('C-NEG');
    expect(
      negative.outcome,
      `an impossible task scored ${negative.outcome} — the scorer is inventing success. actual: ${negative.criterion.actual}`,
    ).toBe('fail');
    expect(negative.diedAt?.reasonClass).toBe('element_never_appeared_in_retry_budget');
    // ⚠️ AND IT PROVES NOTHING ABOUT THE SCORER. It dies at step 2, so no
    // read-back, no answer, no answer-scoring. Asserted so nobody reads this
    // control as covering the path C-NEG-SCORED exists for.
    expect(negative.readback.answerCallObserved).toBe(false);
  });

  it('the SCORED negative control reaches the answer scorer and STILL fails', () => {
    // ⛔ THE CONTROL FOR THE PATH THE ONE REAL SCORER BUG LIVED ON. Every browser
    // step green, the read-back gate open, the product's own answer path run —
    // and the answer honestly absent. If this ever passes, success is being
    // invented on the answer-scoring path and no number in this run means
    // anything.
    const scored = task('C-NEG-SCORED');
    expect(scored.steps.every((s) => s.outcome === 'success')).toBe(true);
    expect(scored.readback.answerCallObserved).toBe(true);
    expect(scored.readback.answered).toBe(true);
    expect(scored.readback.grounded).toBe(false);
    expect(
      scored.outcome,
      `a page with no phone number on it scored ${scored.outcome}. actual: ${scored.criterion.actual}`,
    ).toBe('fail');
    expect(scored.diedAt?.reasonClass).toBe('answer_not_grounded');
  });

  it('H2: the PAGE-DUMP control answers with the whole page and STILL fails', () => {
    // ⛔ THE CONTROL FOR UNBOUNDED CONTAINMENT. `answer_matches` is
    // `pattern.test(answer)`, so every superset of the wanted text satisfied it
    // and an extractor that returned the page verbatim scored PASS — exactly the
    // failure the read-back exists to prevent. This task runs P1's prompt, page
    // and criterion; the ONLY difference is that the answer is the observation.
    const dump = task('C-PAGE-DUMP');
    expect(dump.steps.every((s) => s.outcome === 'success')).toBe(true);
    expect(dump.readback.answerCallObserved).toBe(true);
    expect(dump.readback.answered).toBe(true);
    // The wanted text really is in the answer — the containment test PASSES, and
    // the task must fail anyway. That is what makes this a control on the bound
    // rather than on the page.
    expect(dump.readback.grounded).toBe(true);
    expect(
      dump.outcome,
      `an answer that was the entire page scored ${dump.outcome} — the answer criterion is unbounded containment again and every answer-shaped number in this run is quotable by an agent that replies with the page. actual: ${dump.criterion.actual}`,
    ).toBe('fail');
    expect(dump.diedAt?.reasonClass).toBe('answer_was_not_an_extraction');
    expect(dump.answerExtraction?.isExtraction).toBe(false);
    expect(dump.answerExtraction?.quotedLines).toBe(dump.answerExtraction?.observationLines);

    // AND THE PAIRED POSITIVE: the same page, the same criterion, an extracting
    // answer. Without it, "the dump failed" is also what a broken answer path
    // produces, and the bound would be indistinguishable from a bug.
    const extracted = task('P1');
    expect(extracted.outcome).toBe('pass');
    expect(extracted.answerExtraction?.isExtraction).toBe(true);
    expect(extracted.answerExtraction?.quotedLines).toBeLessThan(
      extracted.answerExtraction?.observationLines ?? 0,
    );
  });

  it('H2: the bound also holds on a TWO-LINE page, which is where it is weakest', () => {
    // ⛔ THE CONTROL THE FIRST ROUND OF THIS FIX DID NOT HAVE. C-PAGE-DUMP runs
    // on a four-line page where three independent readings refuse it, so it says
    // nothing about the branch most of this corpus actually sits on: on a
    // two-line observation the character-share reading collapses into the line
    // reading, so the bound rests on exact lines or on vocabulary. Six of the
    // answering tasks observe two or three lines. A bound controlled only where
    // it is strongest has been retrodicted over the one input it was written
    // for — and the mutation proof for this arm is the one that had to remove
    // the bound for short observations entirely, because narrowing any single
    // reading left the others holding.
    const dump = task('C-PAGE-DUMP-2LINE');
    expect(dump.steps.every((s) => s.outcome === 'success')).toBe(true);
    expect(dump.readback.answered).toBe(true);
    expect(
      dump.answerPatternMatched,
      'the wanted text must be IN the dump, or this controls nothing',
    ).toBe(true);
    expect(
      dump.outcome,
      `a two-line page handed back as the answer scored ${dump.outcome}. actual: ${dump.criterion.actual}`,
    ).toBe('fail');
    expect(dump.diedAt?.reasonClass).toBe('answer_was_not_an_extraction');
    expect(dump.answerExtraction?.observationLines).toBe(2);
    expect(dump.answerExtraction?.quotedLines).toBe(2);
    // And the paired positive is C-POS: the SAME page, the same criterion, an
    // extracting answer, PASS. Without it "the dump failed" is also what a
    // broken two-line page produces.
    const positive = task('C-POS');
    expect(positive.pageScriptId).toBe(dump.pageScriptId);
    expect(positive.outcome).toBe('pass');
    expect(positive.answerExtraction?.observationLines).toBe(2);
    expect(positive.answerExtraction?.quotedLines).toBe(1);
  });

  it('no verdict in this run rests on a reading that could not discriminate', () => {
    // ⛔ THE BOUND SAYS WHEN IT CANNOT SEE. A one-line observation makes an
    // extraction and the page the same text, so `checkAnswerIsExtraction`
    // returns `discrimination: 'none'` and accepts — deliberately, because
    // refusing would block a correct answer for a property of the fixture. That
    // acceptance is only safe while nothing in the corpus relies on it, so the
    // reliance is asserted to be empty rather than assumed to be.
    const undiscriminated = report.tasks
      .filter((t) => t.answerExtraction !== null && t.answerExtraction.discrimination === 'none')
      .map((t) => `${t.taskId}: ${t.answerExtraction?.why ?? ''}`);
    expect(
      undiscriminated,
      `${undiscriminated.join('\n')}\nA task now answers about a one-line page, where the extraction bound cannot separate an answer from the page. Decide deliberately: give the fixture a second line, or write down why this task may rest on an undiscriminated reading.`,
    ).toEqual([]);
    // And the margin the run really passed by, so "it discriminated" is not a
    // label on a check that squeaked through.
    for (const t of report.tasks) {
      if (t.answerExtraction === null || !t.answerExtraction.isExtraction) continue;
      expect(t.answerExtraction.wordShare, `${t.taskId} sits at the word-share bound`).toBeLessThan(
        0.8,
      );
    }
  });

  it('every control reads as it must, or nothing in this run is quotable', () => {
    expect(misbehavingControls(report), misbehavingControls(report).join('; ')).toEqual([]);
  });

  it('the corpus is neither all-pass nor all-fail — either would mean the instrument is broken', () => {
    expect(report.totals.passed).toBeGreaterThan(0);
    expect(report.totals.passed + report.totals.halted).toBeLessThan(report.totals.tasks);
  });
});

describe('executor eval — the joins and the provenance the numbers rest on', () => {
  it('R7: the two executor index spaces line up, and nothing was joined across them blind', () => {
    // `onStepStart` reports the PLAN index; `onStep` reports the RESULTS index.
    // Every attempt count in this report is a difference between marks taken in
    // those two spaces. The runner now keys both on the results index and names
    // anything that does not fit; this asserts nothing did.
    const anomalies = report.tasks.flatMap((t) =>
      t.indexSpaceAnomalies.map((a) => `${t.taskId}: ${a}`),
    );
    expect(anomalies, anomalies.join('\n')).toEqual([]);
  });

  it('R5: the read-back conjunct model AGREES with what the runtime actually did', () => {
    // Two instruments disagreeing means neither is trustworthy until one is
    // shown wrong — so a disagreement fails here rather than rendering a
    // plausible gate name into the report.
    const mismatched = report.tasks
      .filter((t) => t.readback.crossCheckMismatch !== null)
      .map((t) => `${t.taskId}: ${t.readback.crossCheckMismatch ?? ''}`);
    expect(mismatched, mismatched.join('\n')).toEqual([]);
  });

  it("R5: the product's own answer path never errored on a request it built itself", () => {
    // The runtime swallows a read-back failure by design (the plan already
    // succeeded and was recorded). An instrument must not: a turn whose answer
    // path threw would otherwise be indistinguishable from one a gate blocked.
    const errored = report.tasks
      .filter((t) => t.readback.answerPathError !== null)
      .map((t) => `${t.taskId}: ${t.readback.answerPathError ?? ''}`);
    expect(errored, errored.join('\n')).toEqual([]);
  });

  it('R8: the decompose prompt is NOT pinned, because this tier never sends one', () => {
    expect(report.provenance.decomposeSystemPromptSha256).toBeNull();
    expect(report.provenance.decomposeSystemPromptNote).toContain('no decompose request is built');
    // And the prompt this run DOES consume is pinned, observed off the wire.
    expect(report.provenance.answerSystemPromptSha256).toMatch(/^[0-9a-f]{64}$/);
    // ⛔ AND IT IS THE ANSWER PROMPT, NOT THE PLANNING ONE. A hash is internally
    // consistent whatever it hashed; relate it to a second, independent fact or
    // it certifies nothing. The read-back uses a distinct, tighter prompt, so
    // these two must differ — if they ever match, the pin is on the wrong input
    // and the field is decorative.
    expect(report.provenance.answerSystemPromptSha256).not.toBe(currentPromptSha256());
  });

  it('R9: the safety halt is NOT counted as a failed click', () => {
    // F6's tap is stopped before dispatch. Bucketing it by mapped intent name
    // inflated the click-failure tally with a gate working exactly as designed.
    expect(report.stepsNeverDispatched.halted_for_confirmation).toBe(1);
    expect(report.stepsNeverDispatched.refused_at_mapping).toBe(1);
    const dispatchedClicks = report.byHarnessIntent.click?.dispatched ?? 0;
    const clickSteps = report.tasks
      .filter((t) => t.control === undefined)
      .flatMap((t) => t.steps)
      .filter((s) => s.harnessIntentName === 'click');
    // Every click step that IS in the tally really reached the device.
    expect(dispatchedClicks).toBe(clickSteps.filter((s) => s.attempts > 0).length);
    expect(dispatchedClicks).toBeLessThan(clickSteps.length);
  });
});

describe('executor eval — the baseline is asserted per task, never as a rate', () => {
  it('H4: a run that REWRITES the baseline is not allowed to certify it', () => {
    // The verification arms below read a snapshot taken before the write, so
    // they are honest either way — but a green "baseline verified" from a run
    // whose file on disk is one nobody has checked would be a lie of omission.
    expect(
      BASELINE_WRITE_REQUESTED,
      'EVAL_WRITE_BASELINE=1 regenerated eval-baseline.json in this process. That is the regeneration act and it is deliberately not a certification: re-run WITHOUT the flag to verify the file that is now on disk.',
    ).toBe(false);
  });

  it('every task matches the checked-in baseline outcome AND death reason', () => {
    const baseline = baselineSnapshot;
    const drift: string[] = [];
    for (const current of report.tasks) {
      const pinned = baseline.tasks[current.taskId];
      if (pinned === undefined) {
        drift.push(`${current.taskId}: new task, absent from the baseline`);
        continue;
      }
      const observedReason = current.diedAt?.reasonClass ?? 'none';
      if (pinned.outcome !== current.outcome || pinned.reasonClass !== observedReason) {
        drift.push(
          `${current.taskId}: baseline said ${pinned.outcome}/${pinned.reasonClass}, this run got ${current.outcome}/${observedReason} — actual: ${current.criterion.actual}`,
        );
      }
    }
    // ⛔ A RATE THRESHOLD WOULD LET A FIX AND A REGRESSION CANCEL OUT. This is
    // per task, and a flip fails until someone edits the baseline deliberately,
    // in its own commit, with a one-line reason on the task that moved.
    expect(drift, drift.join('\n')).toEqual([]);
  });

  it('names every task that diverges from the expectation it was DESIGNED with', () => {
    // Distinct from the baseline check above. The baseline pins what happens
    // TODAY; this pins where today disagrees with what the corpus was written to
    // expect, so the disagreement is a standing, named item rather than a
    // footnote someone stops reading. Fixing the cause flips this test, loudly.
    const diverging = report.tasks
      .filter((t) => !t.matchedExpectation)
      .map(
        (t) =>
          `${t.taskId}: designed ${t.expected}, measured ${t.outcome} (${t.diedAt?.reasonClass ?? 'none'})`,
      );
    expect(diverging).toEqual([
      // ⛔ THE LIST CHANGED, AND THE DIRECTION IS THE POINT. It used to hold
      // P5 — "give me the first result": every browser step succeeded, the page
      // held the answer, and the read-back gate had no token for "give me", so
      // the customer got a screenshot instead of the result they asked for.
      // That gate is widened and P5 now passes as designed, so it is gone from
      // here.
      //
      // F3 diverges the OTHER way, which is what a fixed defect looks like in
      // this list. It was DESIGNED to fail: its control renders at 2500ms and
      // the executor spent 800ms of transport retries before giving up. The
      // executor now waits on the element, so the task completes and the design
      // expectation is stale rather than wrong. It is kept diverging, not
      // re-designed to 'pass', because the day this reads "measured fail" again
      // is the day patience regressed — and that is worth one noisy line.
      'F3: designed fail, measured pass (none)',
    ]);
  });

  it('a tap now lands when the element is merely LATE — the remaining click failures are the ones only a sighted planner can fix', () => {
    // ⛔ THIS ARM USED TO READ "NOT ONE tap reaches its target" AND SAID, IN ITS
    // OWN WORDS, "WHEN INTERACTION STARTS WORKING THIS TEST FAILS. That is the
    // intent." Interaction started working, so it failed, and this is the
    // rewrite it was asking for.
    //
    // What changed and what did not. Clicking used to fail for FOUR reasons:
    // an overlay over the control, a control that had not rendered yet, a
    // control that does not exist, and a locator refused before dispatch. Only
    // the SECOND was ever an executor defect, and the element wait fixed it —
    // so at least one tap now succeeds. The other three are the planner aiming
    // at the wrong thing, and no amount of patience fixes those: they need a
    // planner that has SEEN the page, which this suite cannot measure.
    const click = report.byHarnessIntent.click;
    expect(click?.dispatched).toBeGreaterThan(0);
    expect(
      click?.succeeded,
      'the late-render tap must land — if this drops to 0 the element wait has regressed',
    ).toBeGreaterThan(0);
    expect(
      click?.succeeded,
      'and the blind-aim failures must NOT silently start passing: an overlay, an absent control and a refused locator are still unfixed here',
    ).toBeLessThan(click?.dispatched ?? 0);
    expect(task('F4-SIGHTED').steps.some((s) => s.harnessIntentName === 'click')).toBe(true);
    for (const name of ['navigate', 'wait_for', 'screenshot', 'scroll', 'send_keys', 'press_key']) {
      const counts = report.byHarnessIntent[name];
      if (counts === undefined) continue;
      expect(counts.succeeded, `${name} was expected to be sound`).toBe(counts.dispatched);
    }
  });

  it('the baseline states plainly who produced its number, and what the number cannot be', () => {
    const baseline = baselineSnapshot;
    // ⛔ CHECKED AGAINST WHAT THE CODE PRODUCES *TODAY*, NOT ONLY AGAINST THE
    // CHECKED-IN TEXT. Asserting only on the file makes this arm blind to a
    // change in the renderer: the frozen artefact keeps satisfying the
    // assertion while every future run emits something else. Measured — an
    // earlier version of this test read only the file, and a mutation that
    // renamed the rate's provenance to "recorded" sailed straight past it.
    const fresh = baselineFromReport(report);
    expect(baseline.provenance).toEqual(fresh.provenance);
    expect(baseline.scriptedPlanCompletionRate.producedBy).toBe(
      fresh.scriptedPlanCompletionRate.producedBy,
    );
    expect(baseline.scriptedPlanCompletionRate.value).toBe(fresh.scriptedPlanCompletionRate.value);
    // And the rate is not readable without its provenance — that is the fix.
    expect(fresh.scriptedPlanCompletionRate.producedBy).toContain('plannerMode=scripted');
    expect(fresh.scriptedPlanCompletionRate.producedBy).toContain('answerer=');
    expect(fresh.scriptedPlanCompletionRate.label).toBe(EVAL_RATE_LABEL);
    expect(fresh.scriptedPlanCompletionRate.executedPlanIsFixed).toBe(true);
    expect(fresh.scriptedPlanCompletionRate.cannotMeasure).toContain('planning quality');
    expect(fresh.provenance.decomposeSystemPromptSha256).toBeNull();
    expect(baseline.provenance.answerSystemPromptSha256).toBe(
      report.provenance.answerSystemPromptSha256,
    );
    // ⛔ THE FIRST THING IN THE FILE SAYS WHAT THE FILE IS NOT. A reader who opens
    // the artefact and stops after one key must still not be able to quote it as
    // a planner number.
    expect(Object.keys(baseline)[0]).toBe('headline');
    expect(baseline.headline).toContain('NOT A PLANNER EVAL');
    expect(Object.keys(baseline)).not.toContain('recordedCompletionRate');
    // ⛔ AND THE OLD NAME IS GONE, not merely shadowed. `completionRate` beside
    // `plannerMode` is the exact phrasing that made a scripted number quotable
    // as an agent number.
    expect(Object.keys(baseline)).not.toContain('completionRate');
    expect(Object.keys(report.totals)).not.toContain('completionRate');
  });

  it('is deterministic — the same task run twice produces the same verdict and the same simulated time', async () => {
    const first = await runEvalTask(EVAL_TASKS[2]!);
    const second = await runEvalTask(EVAL_TASKS[2]!);
    expect(second.outcome).toBe(first.outcome);
    expect(second.simulatedDeviceMs).toBe(first.simulatedDeviceMs);
    expect(second.steps).toEqual(first.steps);
  });
});

describe('executor eval — the findings this corpus exists to measure (execution findings; the planner is not in this loop)', () => {
  it('F3: the executor now WAITS for a control that renders at 2500ms — the finding this arm used to record is fixed', () => {
    // ⛔ THIS ARM RECORDED A DEFECT AND NOW RECORDS ITS FIX. It used to assert
    // fail/element_never_appeared and pin the arithmetic that caused it: three
    // attempts, two backoffs, 800ms of patience against a control that renders
    // at 2500ms. The transport retry was the wrong instrument — an element that
    // is not there yet is a claim about the PAGE, not about the connection — so
    // the executor now waits on the selector instead, and the task completes.
    //
    // Kept, rather than deleted, because the arithmetic is the regression guard:
    // if patience ever falls back below what a real page needs, F3 fails again
    // and the message below says why. The old 800ms is asserted as a LOWER
    // BOUND that must no longer be the whole budget.
    const f3 = task('F3');
    expect(f3.outcome, 'F3 completes only while the executor waits for a late element').toBe(
      'pass',
    );
    expect(f3.diedAt, 'nothing should die now that the wait covers the render').toBeNull();
    expect(
      EVAL_MAX_RETRIES * EVAL_RETRY_DELAY_MS,
      'the transport retry budget alone is still far short of a 2500ms render — patience must come from the element wait, not from more retries',
    ).toBeLessThan(2500);
  });

  it('F1: an overlay is an OUTCOME-UNKNOWN browser failure, so it is not retried and the plan halts', () => {
    const f1 = task('F1');
    expect(f1.outcome).toBe('fail');
    expect(f1.diedAt?.reasonClass).toBe('element_click_intercepted');
    const step = f1.steps[f1.diedAt?.index ?? -1];
    expect(step?.harnessErrorCode).toBe('intent_webdriver_failed');
    // Not retried: replaying a click whose outcome is unknown could double-apply.
    expect(step?.attempts).toBe(1);
    expect(step?.retryable).toBe(false);
    // And the plan halted: the capture after it never ran.
    expect(f1.steps.length).toBeLessThan(f1.plan.intents);
  });

  it('F2: the production selector shape dies at MAPPING, before anything reaches the device', () => {
    const f2 = task('F2');
    expect(f2.outcome).toBe('fail');
    expect(f2.diedAt?.phase).toBe('mapping');
    expect(f2.diedAt?.reasonClass).toBe('selector_rejected_before_dispatch');
    expect(f2.steps[f2.diedAt?.index ?? -1]?.attempts).toBe(0);
  });

  it('F4: the ONLY thing wrong is that the planner could not see the page', () => {
    // ⛔ REBUILT THIS ROUND. The previous F4 tapped '.reply.top', a selector no
    // page in the corpus carries — so it died of a fixture typo, not of
    // blindness, and could never have flipped when perceive lands. Now every
    // step is GREEN (a 404 loads), the read-back gate opens, the answer path
    // runs, and the reply is honestly absent because the plan is on a page the
    // planner guessed.
    const f4 = task('F4');
    expect(f4.outcome).toBe('fail');
    expect(f4.steps.every((s) => s.outcome === 'success')).toBe(true);
    expect(f4.readback.answerCallObserved).toBe(true);
    expect(f4.readback.answered).toBe(true);
    expect(f4.readback.grounded).toBe(false);
    expect(f4.diedAt?.reasonClass).toBe('answer_not_grounded');
    expect(f4.criterion.actual).toMatch(/could not find/i);
  });

  it('F4-SIGHTED: the SAME task passes today when the plan is written as if the page were visible', () => {
    // ⛔ WITHOUT THIS, F4 IS NOT A MEASUREMENT. An expected-FAIL task cannot
    // distinguish "the planner is blind" from "the fixture is broken" on its
    // own. This runs the identical prompt and criterion against a plan that
    // opens the index and clicks the thread that is really there. If it stops
    // passing, F4's number must not be quoted.
    const sighted = task('F4-SIGHTED');
    expect(
      sighted.outcome,
      `the sighted plan for F4 did not pass — F4 is not measuring blindness. actual: ${sighted.criterion.actual}`,
    ).toBe('pass');
    expect(sighted.steps.every((s) => s.outcome === 'success')).toBe(true);
    expect(sighted.readback.grounded).toBe(true);
    // Same prompt and same criterion as F4 — only the plan differs. That is what
    // makes the pair an experiment rather than two unrelated tasks.
    expect(sighted.prompt).toBe(task('F4').prompt);
    expect(sighted.criterion.expected).toBe(task('F4').criterion.expected);
  });

  it('F5: the read-back reports the information as absent rather than inventing it', () => {
    const f5 = task('F5');
    expect(f5.outcome).toBe('fail');
    expect(f5.steps.every((s) => s.outcome === 'success')).toBe(true);
    expect(f5.readback.answerCallObserved).toBe(true);
    expect(f5.readback.predictedEligible).toBe(true);
    expect(f5.readback.answered).toBe(true);
    expect(f5.readback.grounded).toBe(false);
    expect(f5.diedAt?.reasonClass).toBe('answer_not_grounded');
    // ⛔ THE HONEST ABSENCE IS THE OUTCOME TO PRESERVE. If this ever starts
    // "passing" without the page changing, the read-back has begun fabricating.
    expect(f5.criterion.actual).toMatch(/could not find/i);
  });

  it('F6: the safety gate halts BEFORE dispatch, and the dispatch LOG is what says so', () => {
    const f6 = task('F6');
    expect(f6.outcome).toBe('halt');
    expect(f6.diedAt?.reasonClass).toBe('halted_for_confirmation');
    const haltStep = f6.steps.find((s) => s.outcome === 'confirmation_required');
    expect(haltStep).toBeDefined();

    // ⛔ H3 — THE HALT'S ATTEMPT COUNT IS 0 BY CONSTRUCTION, AND THAT IS STATED
    // HERE RATHER THAN LEANED ON. The gate reports its result before announcing
    // the step, so there is no start mark, so the subtraction has nothing to
    // measure and would read 0 even if the purchase HAD been sent. Asserting it
    // would have been a test of our own bookkeeping wearing a safety gate's
    // clothes. The absence is now recorded, and asserted as the expected shape:
    expect(haltStep?.startAnnounced).toBe(false);
    expect(haltStep?.attempts).toBe(0);

    // The real invariant — NOTHING WAS DISPATCHED FOR THAT STEP — is read off the
    // dispatch log by the criterion: the log did not grow after the previous step
    // finished, and no dispatch anywhere in the run carried the refused target.
    expect(f6.criterion.met).toBe(true);
    expect(f6.criterion.actual).toMatch(/the dispatch log grew by 0 after step \d+ finished/);
    expect(f6.criterion.actual).toContain('0 dispatches in the whole run carried its target');
    expect(f6.criterion.actual).toContain('#buy-now');
    expect(f6.criterion.actual).toContain('announced no start for this step');

    // ⛔ AND THE EXEMPTION IS BOUNDED. Exactly one step in the entire run may be
    // missing its start, and it is this one. A second would mean the executor
    // stopped announcing steps and every attempt count in the report went quiet
    // rather than wrong.
    const unannounced = report.tasks.flatMap((t) =>
      t.steps.filter((s) => !s.startAnnounced).map((s) => `${t.taskId}@${String(s.index)}`),
    );
    expect(unannounced).toEqual([`F6@${String(haltStep?.index ?? -1)}`]);
  });

  it('P2: a pure-action task does NOT pay for a second model call', () => {
    const p2 = task('P2');
    expect(p2.outcome).toBe('pass');
    expect(p2.modelCalls.answer).toBe(0);
    expect(p2.readback.answerCallObserved).toBe(false);
    expect(p2.readback.predictedGatesFailed).toContain('not_read_intent');
  });

  it('P6: the idle wait covers a four-second load', () => {
    const p6 = task('P6');
    expect(p6.steps.every((s) => s.outcome === 'success')).toBe(true);
    // 4000ms load + 1200ms settle, and the wait did not time out under it.
    expect(p6.simulatedDeviceMs).toBeGreaterThanOrEqual(5_200);
  });

  it('the `extract` intent sees ZERO traffic today, because nothing maps to it', () => {
    // Implemented in the device anyway, so a future perceive/extract planner
    // needs no device change. This asserts the gap rather than assuming it.
    expect(report.byHarnessIntent.extract).toBeUndefined();
    expect(report.byHarnessIntent.perceive).toBeUndefined();
  });

  it('every read-back that did not answer names WHICH gate blocked it', () => {
    for (const current of report.tasks) {
      if (current.readback.answered) continue;
      expect(
        current.readback.predictedGatesFailed.length,
        `${current.taskId} produced no answer and named no gate — "it didn't answer" has nine distinct causes and the report must say which`,
      ).toBeGreaterThan(0);
    }
  });

  it('P4: the human beats are counted off the RUN, not off the plan we typed', () => {
    // R2 — both conjuncts used to be read from `task.plan`, the hand-written
    // input, so neither could vary with anything that happened. They are now
    // counted from SUCCEEDED DISPATCHES.
    const p4 = task('P4');
    expect(p4.outcome).toBe('pass');
    expect(p4.criterion.actual).toMatch(/dispatched pauses=\d+, dispatched scrolls=\d+/);
    expect(p4.criterion.actual).not.toContain('plan completed');
  });
});

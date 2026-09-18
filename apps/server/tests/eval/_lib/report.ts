// Rendering: a readable per-task table for a human, and the machine-readable
// JSON the baseline is diffed against.
//
// Both are emitted every run. The table is what someone actually reads when a
// task flips; the JSON is what makes "it got better" a diff rather than a claim.

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { EVAL_RATE_LABEL } from './provenance.js';
import { TIERS_EXPLAINED } from './tiers.js';
import {
  describeReasonClass,
  misbehavingControls,
  type EvalProvenance,
  type EvalReport,
  type TaskReport,
} from './score.js';

const OUTCOME_MARK: Record<TaskReport['outcome'], string> = {
  pass: 'PASS',
  fail: 'FAIL',
  halt: 'HALT',
  error: 'ERR ',
};

function pad(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width) : value + ' '.repeat(width - value.length);
}

/**
 * The provenance banner.
 *
 * ⛔ IT GOES FIRST, BEFORE ANY NUMBER. Whoever opens this file should not be able
 * to reach the completion rate without having read who produced it. The previous
 * artefact put `recordedCompletionRate` two lines under `plannerMode: scripted`
 * and the number was quotable as a recorded one that had never been measured.
 */
export function renderProvenance(provenance: EvalProvenance, gitSha: string): string[] {
  return [
    '═══════════════════════════════════════════════════════════════════════',
    provenance.headline,
    '═══════════════════════════════════════════════════════════════════════',
    `  MEASURES      ${provenance.measures}`,
    `  CANNOT        ${provenance.cannotMeasure}`,
    `  PLAN IS FIXED ${provenance.executedPlanIsFixed}`,
    `  ANSWER QUALITY  unmeasured — ${provenance.answererCircularity}`,
    '  ───────────────────────────────────────────────────────────────────',
    `  planner   ${provenance.plannerMode} — ${provenance.plannerDescription}`,
    `  answerer  ${provenance.answererMode} — ${provenance.answererDescription}`,
    `  git       ${gitSha}`,
    `  decompose system prompt  ${
      provenance.decomposeSystemPromptSha256 === null
        ? `not consulted — ${provenance.decomposeSystemPromptNote}`
        : `${provenance.decomposeSystemPromptSha256.slice(0, 16)}…`
    }`,
    `  answer system prompt     ${
      provenance.answerSystemPromptSha256 === null
        ? 'no read-back reached the answer path in this run'
        : `${provenance.answerSystemPromptSha256.slice(0, 16)}… (observed on the wire)`
    }`,
    '═══════════════════════════════════════════════════════════════════════',
  ];
}

export function renderTable(report: EvalReport): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(...renderProvenance(report.provenance, report.gitSha));
  // Which tier this is, beside the other one — so a scripted number is never
  // read as a planning number because the live tier now exists next to it.
  lines.push('  THIS IS THE SCRIPTED TIER. The two tiers, and what each one proves:');
  for (const tier of TIERS_EXPLAINED) lines.push(`    ${tier}`);
  lines.push('');
  // ⚠️ Wide enough for the longest task id in the corpus. `pad` TRUNCATES, and a
  // truncated id ("C-NEG-", "F4-SIG") is a view of the artefact that silently
  // renames the thing it is reporting on.
  const idWidth = Math.max(6, ...report.tasks.map((t) => t.taskId.length + 2));
  lines.push(
    `${pad('task', idWidth)}${pad('exp', 6)}${pad('got', 6)}${pad('match', 7)}${pad('died at', 53)}${pad('sim ms', 8)}steps`,
  );
  lines.push('-'.repeat(112));
  for (const task of report.tasks) {
    const died =
      task.diedAt === null
        ? '—'
        : `${task.diedAt.phase}:${task.diedAt.reasonClass}${
            task.diedAt.index >= 0 ? ` @${String(task.diedAt.index)}` : ''
          }`;
    lines.push(
      `${pad(task.taskId, idWidth)}${pad(task.expected, 6)}${pad(OUTCOME_MARK[task.outcome], 6)}${pad(
        task.matchedExpectation ? 'yes' : 'NO',
        7,
      )}${pad(died, 53)}${pad(String(task.simulatedDeviceMs), 8)}${String(
        task.steps.filter((s) => s.outcome === 'success').length,
      )}/${String(task.steps.length)}`,
    );
  }
  lines.push('-'.repeat(112));
  lines.push(
    `corpus ${String(report.totals.tasks)} tasks — ${String(report.totals.passed)} pass, ${String(
      report.totals.failed,
    )} fail, ${String(report.totals.halted)} halt, ${String(report.totals.errored)} error`,
  );
  lines.push(
    `scripted-plan completion rate ${report.totals.scriptedPlanCompletionRate.toFixed(3)} — ${EVAL_RATE_LABEL}`,
  );
  lines.push(
    '  (passed / (tasks - halted); a halt was never given the chance to complete. NOT an agent completion rate: the plans are ours)',
  );
  // H6 where the number is, as a number. The rule that produced each answer was
  // written beside the criterion that scores it, and this is how often that
  // shows: an overlap a real model answerer would not be guaranteed to produce.
  const overlap = report.totals.answerRuleSelectsCriterionText;
  lines.push(
    `answer-rule / criterion overlap ${String(overlap.matched)}/${String(overlap.of)} — the page rule selected text the criterion searches for in ${String(overlap.matched)} of the ${String(overlap.of)} corpus tasks that answered. That is the AUTHORSHIP circularity, measured; answer quality remains unmeasured.`,
  );
  lines.push(
    `steps ${String(report.totals.stepsSucceeded)}/${String(report.totals.stepsAttempted)} = ${report.totals.stepSuccessRate.toFixed(
      3,
    )}   model calls ${String(report.totals.modelCalls)} (${report.totals.modelCallsPerTask.toFixed(2)}/task)`,
  );
  // ⚠️ SAID OUT LOUD RATHER THAN QUIETLY CHANGED. The per-intent tally below
  // excludes steps that never reached the device; this step rate does NOT — its
  // denominator still counts the safety halt and the refused selector as steps
  // that did not succeed, which for a STEP rate is true. Two headline numbers
  // with different denominators is a reasonable thing to publish and an
  // unreasonable thing to leave unlabelled.
  lines.push(
    `  (the step rate counts every result, halts and mapping refusals included; the per-intent tally below does not)`,
  );
  const misbehaving = misbehavingControls(report);
  lines.push(
    `controls — positive ${report.controls.positive.toUpperCase()}, negative ${report.controls.negative.toUpperCase()}, ` +
      `negative-scored ${report.controls.negative_scored.toUpperCase()}, sighted ${report.controls.sighted.toUpperCase()}, ` +
      `page-dump ${report.controls.page_dump.toUpperCase()}, page-dump-2line ${report.controls.page_dump_two_line.toUpperCase()}` +
      (misbehaving.length === 0
        ? ''
        : `   ⛔ A CONTROL MISBEHAVED — THE NUMBERS ABOVE ARE NOT TRUSTWORTHY: ${misbehaving.join('; ')}`),
  );
  lines.push('');
  lines.push(
    `steps that never reached the device — ${String(report.stepsNeverDispatched.halted_for_confirmation)} halted by the safety gate, ` +
      `${String(report.stepsNeverDispatched.refused_at_mapping)} refused at mapping, ` +
      `${String(report.stepsNeverDispatched.mapped_but_never_sent)} mapped but never sent`,
  );
  lines.push(
    '  (these are excluded from the per-intent tally below: a halt before dispatch is not a failed click)',
  );
  const anomalies = report.tasks.flatMap((t) =>
    t.indexSpaceAnomalies.map((a) => `${t.taskId}: ${a}`),
  );
  if (anomalies.length > 0) {
    lines.push('');
    lines.push('⛔ INDEX-SPACE ANOMALIES — EVERY ATTEMPT COUNT ABOVE IS SUSPECT:');
    for (const anomaly of anomalies) lines.push(`  ${anomaly}`);
  }
  const mismatches = report.tasks.filter((t) => t.readback.crossCheckMismatch !== null);
  if (mismatches.length > 0) {
    lines.push('');
    lines.push('⛔ READ-BACK PREDICTION vs OBSERVATION DISAGREED:');
    for (const t of mismatches) lines.push(`  ${t.taskId}: ${t.readback.crossCheckMismatch ?? ''}`);
  }
  lines.push('');
  lines.push('where turns died:');
  for (const [reason, count] of Object.entries(report.byDeathReason).sort((a, b) => b[1] - a[1])) {
    lines.push(
      `  ${pad(String(count), 4)}${pad(reason, 44)}${describeReasonClass(
        reason as Parameters<typeof describeReasonClass>[0],
      )}`,
    );
  }
  lines.push('');
  lines.push(
    'per harness intent (succeeded/DISPATCHED — steps that never reached the device are excluded):',
  );
  for (const [name, counts] of Object.entries(report.byHarnessIntent).sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    lines.push(`  ${pad(name, 20)}${String(counts.succeeded)}/${String(counts.dispatched)}`);
  }
  lines.push('');
  lines.push('failing tasks, in detail:');
  for (const task of report.tasks) {
    if (task.outcome === 'pass') continue;
    lines.push(`  ${task.taskId} — ${task.prompt}`);
    lines.push(`      expected ${task.criterion.expected}`);
    lines.push(`      actual   ${task.criterion.actual}`);
    if (task.diedAt !== null) {
      lines.push(
        `      died     ${task.diedAt.phase} on ${task.diedAt.agentIntentKind ?? 'no step'}` +
          `${task.diedAt.harnessIntentName !== null ? `→${task.diedAt.harnessIntentName}` : ''}` +
          `${task.diedAt.harnessErrorCode !== null ? ` [${task.diedAt.harnessErrorCode}]` : ''}`,
      );
      lines.push(`      because  ${describeReasonClass(task.diedAt.reasonClass)}`);
    }
    lines.push(
      `      readback answer path was ${task.readback.answerCallObserved ? 'REACHED (observed)' : 'NOT reached (observed)'}` +
        (task.readback.predictedGatesFailed.length > 0
          ? `; predicted blockers: ${task.readback.predictedGatesFailed.join(', ')}`
          : '; no blocker predicted'),
    );
    if (task.answerExtraction !== null) {
      // How much of the page came back inside the answer. Printed for every
      // answering task, not just the refused ones, because the bound is only
      // credible if a reader can see the margin it passed by.
      lines.push(`      answer   ${task.answerExtraction.why}`);
    }
    if (task.readback.crossCheckMismatch !== null) {
      lines.push(`      ⛔ ${task.readback.crossCheckMismatch}`);
    }
    if (task.readback.answerPathError !== null) {
      lines.push(`      ⛔ the answer path errored: ${task.readback.answerPathError}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

export interface WrittenReport {
  jsonPath: string;
  textPath: string;
}

/**
 * Write both artifacts.
 *
 * Default destination is the OS temp directory, not the repository: a test that
 * drops files into the working tree on every run makes `git status` noise that
 * people learn to ignore, and this report is evidence for one run, not an asset.
 * Override with EVAL_REPORT_DIR when you want to keep one.
 */
export function writeReport(report: EvalReport, text: string): WrittenReport {
  const dir = process.env.EVAL_REPORT_DIR ?? resolve(tmpdir(), 'driftstack-agent-eval');
  mkdirSync(dir, { recursive: true });
  const jsonPath = resolve(dir, `agent-eval-${report.runId}.json`);
  const textPath = resolve(dir, `agent-eval-${report.runId}.txt`);
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  writeFileSync(textPath, `${text}\n`, 'utf8');
  return { jsonPath, textPath };
}

/**
 * The shape checked into `eval-baseline.json`. Per-task, never a rate threshold.
 *
 * ⛔ THE RATE CANNOT BE READ WITHOUT ITS PROVENANCE. It used to sit in a field
 * called `recordedCompletionRate`, two lines under `"plannerMode": "scripted"`,
 * where `plannerMode` ranges over recorded|scripted|live — so the artefact named
 * its own number after a tier that had not produced it, and a reader who quoted
 * the file would have quoted a recorded number that was never measured. The rate
 * is now an object that carries who produced it and what it does and does not
 * prove, in the same breath as the value.
 */
export interface EvalBaseline {
  /** ⛔ FIRST KEY. What the file is a measurement OF, before any number. */
  headline: string;
  note: string;
  /** Second key on purpose: nobody should reach the number without reading this. */
  provenance: EvalProvenance;
  /** Mirrors `provenance.plannerMode` — the recordings guard reads it here. */
  plannerMode: EvalReport['plannerMode'];
  /**
   * ⛔ RENAMED FROM `completionRate`. That name reads as "the share of tasks the
   * agent completes", and the agent's planner is not in this loop: the plans are
   * hand-written and the scripted decomposer discards its arguments. The number
   * is the share of OUR plans the execution layers carried to their criterion,
   * produced under a FIXED plan — so it is not evidence about planning quality
   * in either direction. ⚠️ It is NOT a constant: a commit that changes planning
   * also changes the runtime and the executor, and those move it.
   */
  scriptedPlanCompletionRate: {
    value: number;
    label: string;
    producedBy: string;
    measures: string;
    cannotMeasure: string;
    /**
     * ⛔ RENAMED FROM `invariantUnderPlannerChange: true`, WHICH WAS FALSE. The
     * plan these numbers ran under is fixed; the numbers are NOT invariant under
     * a planner commit, because such a commit also changes the runtime and the
     * executor this suite runs for real. The first run after that field was
     * written moved the rate 0.455 → 0.636 for exactly that reason.
     */
    executedPlanIsFixed: true;
  };
  tasks: Record<string, { expected: string; outcome: string; reasonClass: string; why: string }>;
}

export function baselineFromReport(report: EvalReport): EvalBaseline {
  const tasks: EvalBaseline['tasks'] = {};
  for (const task of report.tasks) {
    tasks[task.taskId] = {
      expected: task.expected,
      outcome: task.outcome,
      reasonClass: task.diedAt?.reasonClass ?? 'none',
      why: task.rationale,
    };
  }
  const { provenance } = report;
  return {
    headline: provenance.headline,
    note: 'Per-task expectations, NOT a rate threshold — a rate lets a fix and a regression cancel out. A flip fails the suite until someone edits this file deliberately, in its own commit, with a one-line reason on the task that moved.',
    provenance,
    plannerMode: provenance.plannerMode,
    scriptedPlanCompletionRate: {
      value: report.totals.scriptedPlanCompletionRate,
      label: EVAL_RATE_LABEL,
      producedBy: `plannerMode=${provenance.plannerMode} (${provenance.plannerDescription}); answerer=${provenance.answererMode} (${provenance.answererDescription})`,
      measures: provenance.measures,
      cannotMeasure: provenance.cannotMeasure,
      executedPlanIsFixed: true,
    },
    tasks,
  };
}

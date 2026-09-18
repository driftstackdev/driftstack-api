// Drives ONE whole turn through the real `AgentRuntime` and hands the scorer a
// pure observation of what happened.
//
// ⛔ THE PLANNER IS NOT IN THIS LOOP, AND NOTHING HERE CAN PUT IT BACK.
// `ScriptedAgentDecomposer.decompose` discards its arguments and returns
// `task.plan`, so no decompose request is built and no model chooses a plan in
// any eval task: the EXECUTED PLAN IS FIXED and no number here is evidence about
// planning quality.
//
// ⚠️ THAT IS NOT THE SAME AS "A PLANNER COMMIT CANNOT MOVE THESE NUMBERS", and
// this file used to say the stronger thing. A commit that gives the planner the
// page also lands in the runtime and the executor below, which are the REAL ones
// here — and one did, moving the rate 0.455 → 0.636. See `provenance.ts`, which
// every surface renders from.
//
// Everything the runtime needs is already injectable, so nothing here reaches
// into a private. The only substitutions are the planner (scripted), the device
// (`IntentDispatcher`), and the clock (`AutoRetryOptions.sleep`). The executor,
// the verb mapper, the wire codec, the result mapper, the retry fences, the
// consequential gate, the session repo and the read-back gate are all the real
// ones under test.

import { execFileSync } from 'node:child_process';
import {
  AgentRuntime,
  READBACK_MIN_BUDGET_TOKENS,
  READ_INTENT_RE,
} from '../../../src/services/agent-runtime.js';
import { ControlPlaneAgentExecutor } from '../../../src/services/agent-executor-control-plane.js';
import { InMemoryAgentSessionsRepo } from '../../../src/services/agent-sessions.js';
import { SessionCaptureStore } from '../../../src/services/session-capture-store.js';
import type { IntentResult } from '../../../src/services/agent-executor.js';
import type { RunTurnResult, AgentTurnProgressEvent } from '../../../src/services/agent-runtime.js';
import { FakeDevice } from './fake-device.js';
import { StepMarkTracker } from './step-marks.js';
import { VirtualClock } from './virtual-clock.js';
import { EVAL_SITES } from './page-model.js';
import { ScriptedAgentDecomposer, SCRIPTED_DECOMPOSE_TOKENS } from './scripted-decomposer.js';
import { scoreTurn, type ReadbackGate, type TaskReport, type TurnObservation } from './score.js';
import type { EvalTask } from './tasks.js';

/** Executor timing knobs. Held here rather than defaulted so the report can
 *  state the retry budget it measured against, and so the three sleep durations
 *  the clock classifies stay visibly distinct. */
export const EVAL_MAX_RETRIES = 2;
export const EVAL_RETRY_DELAY_MS = 400;
export const EVAL_SESSION_ESTABLISH_RETRY_DELAY_MS = 1500;
export const EVAL_OBSERVE_TIMEOUT_MS = 10_000;

export const EVAL_TOKEN_BUDGET = 100_000;
export const EVAL_ARCHETYPE = 'iphone16pro_ios18_7_safari26_4';
/** Never a real credential. Its presence is what opens the read-back gate; its
 *  value never leaves this process because the scripted planner makes no call. */
const EVAL_FAKE_KEY = 'sk-ant-eval-not-a-real-key';
const EVAL_FIXED_NOW = new Date('2026-09-17T00:00:00.000Z');

export async function runEvalTask(task: EvalTask): Promise<TaskReport> {
  const clock = new VirtualClock(
    new Set([EVAL_RETRY_DELAY_MS, EVAL_SESSION_ESTABLISH_RETRY_DELAY_MS]),
  );
  const device = new FakeDevice({ sites: EVAL_SITES, startUrl: task.startUrl, clock });
  let captureSeq = 0;
  const captureStore = new SessionCaptureStore(
    2_000,
    20,
    30 * 60 * 1000,
    () => 0,
    () => `cap_eval_${task.id}_${(captureSeq += 1).toString()}`,
  );
  let intentSeq = 0;
  const executor = new ControlPlaneAgentExecutor(
    device.dispatcher,
    () => `int_eval_${(intentSeq += 1).toString()}`,
    {
      maxRetries: EVAL_MAX_RETRIES,
      retryDelayMs: EVAL_RETRY_DELAY_MS,
      sessionEstablishRetryDelayMs: EVAL_SESSION_ESTABLISH_RETRY_DELAY_MS,
      observeTimeoutMs: EVAL_OBSERVE_TIMEOUT_MS,
      sleep: clock.sleep,
    },
    captureStore,
  );
  const sessions = new InMemoryAgentSessionsRepo(() => EVAL_FIXED_NOW);
  const seed = await sessions.create({
    accountId: 'acc_eval',
    tokenBudgetTotal: EVAL_TOKEN_BUDGET,
  });
  // ⛔ ONLY THE PLAN AND THE ANSWER RULE CROSS THIS BOUNDARY. The decomposer is
  // deliberately NOT handed the task: an answerer that can reach
  // `task.criterion` is an answerer that can be scored by the pattern it just
  // used to build its answer, which is the closed loop this round removed.
  const decomposer = new ScriptedAgentDecomposer({
    plan: task.plan,
    answerRule: task.answerRule,
  });
  const runtime = new AgentRuntime({
    decomposer,
    executor,
    sessions,
    archetype: EVAL_ARCHETYPE,
  });

  const results: IntentResult[] = [];
  // ⛔ THE EXECUTOR REPORTS IN TWO INDEX SPACES — step STARTS on the plan index,
  // step RESULTS on `results.length - 1` — and every attempt count in this
  // report is a difference between marks taken in them. `StepMarkTracker` does
  // the join in one place, in ONE space, and names anything that does not fit
  // instead of absorbing it into a fallback. See `step-marks.ts`.
  const marks = new StepMarkTracker();

  const startedAt = performance.now();
  let turn: RunTurnResult | null = null;
  let turnError: string | null = null;
  try {
    turn = await runtime.runTurn({
      agentSessionId: seed.id,
      userMessage: task.prompt,
      byokApiKey: EVAL_FAKE_KEY,
      now: EVAL_FIXED_NOW,
      onStep: (result, index) => {
        results[index] = result;
        marks.stepFinished(index, result.kind, device.dispatches().length);
      },
      onProgress: (event: AgentTurnProgressEvent) => {
        if (event.kind !== 'step_start') return;
        marks.stepStarted(event.index, device.dispatches().length);
      },
    });
  } catch (err) {
    turnError = err instanceof Error ? err.message : String(err);
  }
  marks.finish();
  const wallClockMs = Math.round(performance.now() - startedAt);

  const executorResult = turn !== null && turn.kind === 'plan-executed' ? turn.executor : null;
  const executorOk = executorResult?.ok === true;
  const awaitingConfirmation = executorResult?.awaitingConfirmation === true;
  const answer = turn !== null && turn.kind === 'plan-executed' ? (turn.answer ?? null) : null;

  return scoreTurn({
    task,
    // Read off the decomposer this function actually constructed, never copied
    // from the banner — that is what makes the suite's tier assertion relate two
    // independent facts instead of a literal to itself.
    plannerTier: decomposer.tier,
    turnKind: turnError !== null ? 'threw' : (turn?.kind ?? 'none'),
    turn,
    turnError,
    // Prefer the executor's own result list; `onStep` is best-effort by contract
    // and a caller must never treat it as the record of what ran.
    results: executorResult?.results ?? results.filter((r) => r !== undefined),
    awaitingConfirmation,
    executorOk,
    answer,
    observationText: decomposer.observed.lastObservation,
    dispatches: device.dispatches(),
    stepStartMarks: marks.startMarks,
    stepEndMarks: marks.endMarks,
    planIndexForResult: marks.planIndexForResult,
    resultsWithNoStartAnnounced: marks.noStartAnnounced,
    indexSpaceAnomalies: marks.anomalies,
    deviceFlags: device.flags(),
    modelCalls: decomposer.calls,
    simulatedDeviceMs: device.deviceMs() + clock.countedSleepMs(),
    wallClockMs,
    retryDelayMs: EVAL_RETRY_DELAY_MS,
    readbackGatesFailed: predictReadbackGates({
      task,
      executorOk,
      observation: decomposer.observed.lastObservation,
      // These three conjuncts are CHECKED, not assumed. They are properties of
      // how this harness wired the runtime, and a wiring change that silently
      // closed the read-back would otherwise be attributed to whichever gate the
      // model happened to name first.
      canObserve: typeof executor.observe === 'function',
      canAnswer: typeof decomposer.answerFromObservation === 'function',
      hasKey: EVAL_FAKE_KEY.length > 0,
    }),
    observedAnswerPath: decomposer.observed,
  } satisfies TurnObservation);
}

/**
 * PREDICT which of the runtime's read-back conjuncts would block an answer.
 *
 * ⛔ THIS IS A PREDICTION AND IT IS LABELLED ONE EVERYWHERE IT SURFACES. Whether
 * the read-back ran is now OBSERVED — the decomposer double records the call —
 * and `scoreTurn` cross-checks the two and fails loudly when they disagree. This
 * function survives only to name WHICH conjunct is the likely cause, which an
 * observation cannot say on its own.
 *
 * ⚠️ THE EARLIER VERSION MODELLED FIVE OF NINE CONJUNCTS and attributed anything
 * else to a catch-all, so an unmodelled block was reported under the wrong cause.
 * All nine are named here. The three that are properties of how this harness
 * wired the runtime (`observe`, `answerFromObservation`, the key) are passed in
 * as CHECKED facts rather than assumed true, because assuming them is exactly
 * how a wiring change becomes somebody else's gate.
 *
 * ⛔ THE CONSTANTS ARE IMPORTED, NOT COPIED. A duplicated keyword pattern or
 * budget floor would keep reporting the old gate after the real one moved. The
 * budget figure is derived from the fixed scripted accounting rather than read
 * off the session, because the gate is evaluated BEFORE the answer call debits.
 *
 * `authority_lost` is modelled but never fires here: nothing in this harness
 * revokes control authority mid-turn. It is named so that if something ever
 * does, the report says so instead of blaming the nearest modelled gate.
 */
function predictReadbackGates(args: {
  task: EvalTask;
  executorOk: boolean;
  observation: string | null;
  canObserve: boolean;
  canAnswer: boolean;
  hasKey: boolean;
}): ReadbackGate[] {
  const gates: ReadbackGate[] = [];
  if (!args.executorOk) gates.push('executor_not_ok');
  if (!args.canObserve) gates.push('no_observe_capability');
  if (!args.canAnswer) gates.push('no_answer_capability');
  if (!args.hasKey) gates.push('no_key');
  if (EVAL_TOKEN_BUDGET - SCRIPTED_DECOMPOSE_TOKENS < READBACK_MIN_BUDGET_TOKENS) {
    gates.push('budget');
  }
  if (!args.task.plan.some((intent) => intent.kind === 'capture')) gates.push('no_capture_in_plan');
  if (!READ_INTENT_RE.test(args.task.prompt)) gates.push('not_read_intent');
  // The empty-observation check sits INSIDE the runtime's `if`, so it can only
  // be the cause when every conjunct above passed.
  if (gates.length === 0 && (args.observation === null || args.observation.trim().length === 0)) {
    gates.push('observe_null');
  }
  return gates;
}

export function gitSha(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: new URL('../../../../..', import.meta.url).pathname,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    // A working tree with no git is a real environment, and inventing a sha
    // would put a false provenance stamp on the report.
    return 'unknown';
  }
}

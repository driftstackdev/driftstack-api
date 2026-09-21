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
  asksForInformation,
} from '../../../src/services/agent-runtime.js';
import { ControlPlaneAgentExecutor } from '../../../src/services/agent-executor-control-plane.js';
import { InMemoryAgentSessionsRepo } from '../../../src/services/agent-sessions.js';
import { SessionCaptureStore } from '../../../src/services/session-capture-store.js';
import type { IntentResult } from '../../../src/services/agent-executor.js';
import type { RunTurnResult, AgentTurnProgressEvent } from '../../../src/services/agent-runtime.js';
import { visibleTextOf } from './dom.js';
import { FakeDevice } from './fake-device.js';
import { StepMarkTracker } from './step-marks.js';
import { VirtualClock } from './virtual-clock.js';
import { STOP_IN_FLIGHT_GRACE_MS } from '../../../src/services/agent-executor.js';
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

/**
 * Which of the executor's sleeps are ELAPSED BROWSING TIME, for the simulated
 * clock.
 *
 * ⛔ STATED AS AN EXCLUSION since R9 made the retry gaps DRAWN. The old form
 * listed the two exact durations that counted; once no exact value identifies a
 * retry gap, that list would have matched nothing and `simulatedDeviceMs` would
 * have quietly fallen, with no arm going red — a measurement that stops
 * measuring while continuing to report. What is NOT browsing time is a short,
 * closed list: the read-back's race deadline and the Stop grace, both of which
 * are "how long we are willing to wait", not time anything spent.
 */
export function countsAsElapsedBrowsingTime(ms: number): boolean {
  return ms !== EVAL_OBSERVE_TIMEOUT_MS && ms !== STOP_IN_FLIGHT_GRACE_MS;
}

/**
 * R8/R9/R5 — the eval's own entropy source.
 *
 * ⛔ SEEDED FROM A FIXED STRING, so the corpus is REPRODUCIBLE. The executor
 * draws every server-side gap now, and its default seed mixes a per-process
 * salt (deliberately: a site must not be able to reproduce a session's rhythm
 * from an id it can see). That makes the default unusable here — the suite
 * asserts that the same task run twice produces the same simulated time, and
 * would have started failing for a reason that is not a fact about the agent.
 *
 * ⚠️ SO THIS HARNESS SAYS NOTHING ABOUT THE PRODUCT'S OWN SEEDING. That is a
 * different property with its own test, which uses the real derivation over two
 * session ids: `agent-eval-rhythm.test.ts`.
 */
export function evalRandom(seed: string): () => number {
  let state = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    state ^= seed.charCodeAt(index);
    state = Math.imul(state, 0x01000193);
  }
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const EVAL_TOKEN_BUDGET = 100_000;
export const EVAL_ARCHETYPE = 'iphone16pro_ios18_7_safari26_4';
/** Never a real credential. Its presence is what opens the read-back gate; its
 *  value never leaves this process because the scripted planner makes no call. */
const EVAL_FAKE_KEY = 'sk-ant-eval-not-a-real-key';
const EVAL_FIXED_NOW = new Date('2026-09-17T00:00:00.000Z');

export async function runEvalTask(task: EvalTask): Promise<TaskReport> {
  const clock = new VirtualClock(countsAsElapsedBrowsingTime);
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
  // Declared before the executor so its dispatcher can open a step's span when
  // the look before a tap is sent — see `StepMarkTracker.lookStarted`.
  const marks = new StepMarkTracker();
  const executor = new ControlPlaneAgentExecutor(
    {
      dispatch: (dispatch) => {
        if (dispatch.intentName === 'perceive') marks.lookStarted(device.dispatches().length);
        return device.dispatcher.dispatch(dispatch);
      },
    },
    () => `int_eval_${(intentSeq += 1).toString()}`,
    {
      maxRetries: EVAL_MAX_RETRIES,
      retryDelayMs: EVAL_RETRY_DELAY_MS,
      sessionEstablishRetryDelayMs: EVAL_SESSION_ESTABLISH_RETRY_DELAY_MS,
      observeTimeoutMs: EVAL_OBSERVE_TIMEOUT_MS,
      planningObserveTimeoutMs: EVAL_OBSERVE_TIMEOUT_MS,
      sleep: clock.sleep,
      deadline: clock.deadline,
      // Fixed per TASK, so the corpus is reproducible; see `evalRandom`.
      makeRandom: () => evalRandom(task.id),
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
  // instead of absorbing it into a fallback. See `step-marks.ts`. (`marks` is
  // declared above, with the executor that feeds it.)

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
  const firstPlan =
    turn !== null && turn.kind === 'plan-executed' && turn.decomposer.kind === 'plan'
      ? turn.decomposer
      : null;

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
    // ⛔ THE PAGE'S WORDS, NOT ITS MARKUP. The observation is real HTML now; the
    // extraction bound asks how much of the PAGE came back inside the answer,
    // and a page's tags are not part of what a customer would call the page.
    // The raw observation stays on `observedAnswerPath`, untouched.
    observationText:
      decomposer.observed.lastObservation === null
        ? null
        : visibleTextOf(decomposer.observed.lastObservation),
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
      // Read off the plan the runtime was actually handed, never assumed. The
      // scripted planner returns the same plan on every call, so the first
      // plan's word stands for every segment of the turn.
      plannerSpeaksLoop: firstPlan?.status !== undefined,
      plannerWantsAnswer: firstPlan?.answerWanted === true,
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
  plannerSpeaksLoop: boolean;
  plannerWantsAnswer: boolean;
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
  // The runtime asks for a capture only of a planner that does not speak the
  // loop; one that does looks after every segment anyway.
  if (!args.plannerSpeaksLoop && !args.task.plan.some((intent) => intent.kind === 'capture')) {
    gates.push('no_capture_in_plan');
  }
  // ⛔ THE RUNTIME'S OWN FUNCTION, NOT ITS PATTERN. Testing `READ_INTENT_RE` on
  // the raw prompt skipped the NFKC fold and the URL strip the runtime applies
  // first, so a query-string `?` read as a question here and not there. And the
  // planner's `answerWanted` widens the gate exactly as the runtime ORs it.
  if (!args.plannerWantsAnswer && !asksForInformation(args.task.prompt)) {
    gates.push('not_read_intent');
  }
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

// Per-turn telemetry for the AI automation: metrics on the shared registry and
// one content-free diagnostics row per request, both produced at the message
// route's seam.
//
// WHY AT THE ROUTE AND NOT IN THE RUNTIME. The question this answers is "where
// do real tasks die?", and a quarter of production requests died BEFORE the
// runtime did anything — a 409 because the previous turn was still running, a
// control conflict, a closed session. Instrumenting the runtime would count
// only the turns that got in. The route's handler sees every request that
// reaches it, exactly once, whichever of its dozen exits it took.
//
// The boundary is the HANDLER. A request refused by a preHandler — a missing or
// invalid key, the per-caller rate limit — never gets here and is not counted;
// those show in the HTTP and rate-limit series. `rate_limited` below is
// therefore the account-level limits the handler itself applies.
//
// ⛔ CONTENT-FREE BY CONSTRUCTION. A collector is handed intents, step results,
// the turn result and the response body, all of which carry customer content:
// the task, URLs, selectors, page text, the answer. It READS them to classify
// and it KEEPS only members of the closed unions declared below plus numbers
// and booleans. There is no string field on the row whose value is not drawn
// from one of those unions, and the table repeats that as CHECK constraints, so
// "a future edit stores the URL for debugging" fails the insert rather than
// leaking. Nothing here holds a session id or an account id past the end of the
// turn either: the row cannot be joined back to a customer, on purpose — this
// is a fleet-wide health instrument, not a per-customer audit trail.
//
// ⛔ NEVER IN THE CUSTOMER'S WAY. Every public method swallows its own errors,
// classification and the row write are deferred off the response path, the
// write is bounded (a dead database drops rows instead of queueing them without
// limit), and a failed or dropped write is counted in a metric — the one place
// it can surface, since by design nothing else is allowed to notice.

import { performance } from 'node:perf_hooks';
import { ZodError } from 'zod';
import { AgentModelSchema, CLAUDE_MODELS, type AgentModel } from '@driftstack/api-types';
import type { AgentDecomposerUsageRecorder, RunTurnResult } from './agent-runtime.js';
import type { AgentTurnProgressEvent } from './agent-runtime.js';
import type { IntentResult } from './agent-executor.js';
import { ApiError } from '../lib/errors.js';
import { METRIC_NAMES, type MetricsRegistry } from './metrics-registry.js';

// ── closed unions ─────────────────────────────────────────────────────────

/**
 * How one request to the message route ended. CLOSED: every value is a metric
 * label and a CHECK-constrained column, so adding one is a migration.
 *
 *   completed               the plan ran to the end (and answered, if asked)
 *   failed                  the turn ran and did not achieve the task
 *   halted_for_confirmation stopped before a purchase/payment/deletion to ask
 *   clarified               the model asked the customer a question instead
 *   refused                 no plan: policy screen, model refusal, or the model
 *                           being unavailable (the death reason says which)
 *   stopped                 the customer interrupted it mid-turn
 *   busy_409                rejected because the previous turn is still running
 *   conflict_409            any other 409 (control lane, ended session, key reuse)
 *   rate_limited            429
 *   rejected                any other 4xx (validation, not found, no AI key…)
 *   error                   5xx
 *   manual_note             a human log line on a manual session; no AI ran
 *   replayed                an Idempotency-Key replay; the turn was counted the
 *                           first time, so this is metrics-only
 */
export const AGENT_TURN_OUTCOMES = [
  'completed',
  'failed',
  'halted_for_confirmation',
  'clarified',
  'refused',
  'stopped',
  'busy_409',
  'conflict_409',
  'rate_limited',
  'rejected',
  'error',
  'manual_note',
  'replayed',
] as const;
export type AgentTurnOutcome = (typeof AGENT_TURN_OUTCOMES)[number];

/**
 * Outcomes in which the runtime actually worked on a task. Together with
 * {@link turnRan}'s one extra arm, the denominator for per-turn durations,
 * tokens and cost.
 */
export const AGENT_TURN_RAN_OUTCOMES: readonly AgentTurnOutcome[] = [
  'completed',
  'failed',
  'halted_for_confirmation',
  'clarified',
  'refused',
  'stopped',
];

/**
 * Whether a request is a turn that RAN, for every per-turn figure.
 *
 * An `error` is normally a request that never got as far as the model, and
 * averaging its zeros into tokens-per-turn would flatter every figure. But a
 * turn that called the model and THEN returned a 5xx (a storage failure after
 * the browser work, say) spent real money and real seconds: leaving it out made
 * spend on errored turns invisible exactly where an operator looks for it. The
 * SQL aggregate repeats this predicate; the repo test holds the two together.
 */
export function turnRan(row: { outcome: AgentTurnOutcome; modelCalls: number }): boolean {
  return (
    AGENT_TURN_RAN_OUTCOMES.includes(row.outcome) || (row.outcome === 'error' && row.modelCalls > 0)
  );
}

/**
 * Outcomes that settle whether a task got done. `halted_for_confirmation` and
 * `clarified` are absent deliberately: both are the agent correctly handing the
 * decision back to a human, neither a completion nor a death, and counting them
 * either way would let a run of careful pauses move the completion rate.
 */
export const AGENT_TURN_DECIDED_OUTCOMES: readonly AgentTurnOutcome[] = [
  'completed',
  'failed',
  'refused',
  'stopped',
  'error',
];

/**
 * Decided outcomes other than `completed`: the rows the operator view lists as
 * "where tasks die". Everything else with a death reason is a request that was
 * turned away before any task existed, and is listed apart
 * ({@link AGENT_TURN_TURNED_AWAY_OUTCOMES}) so a burst of 409s cannot dilute the
 * share of real step deaths.
 */
export const AGENT_TURN_DEATH_OUTCOMES: readonly AgentTurnOutcome[] = [
  'failed',
  'refused',
  'stopped',
  'error',
];

/** Requests answered without a task ever starting. */
export const AGENT_TURN_TURNED_AWAY_OUTCOMES: readonly AgentTurnOutcome[] = [
  'busy_409',
  'conflict_409',
  'rate_limited',
  'rejected',
];

/** Outcomes never written as a row. */
const UNPERSISTED_OUTCOMES: ReadonlySet<AgentTurnOutcome> = new Set<AgentTurnOutcome>([
  'manual_note',
  'replayed',
]);

/**
 * The outcomes a ROW may carry — exactly what the table's CHECK constraint
 * allows. Derived from the two sets above rather than listed, so it cannot drift
 * from either.
 *
 * It exists as a named export because the rule "metrics count every outcome, the
 * table holds all but two" was being re-stated as an inline filter wherever
 * something compared the code to the database. A guard that re-derives the
 * exception is a guard that can re-derive it wrongly, and the day a third
 * metrics-only outcome is added, every such filter is silently one short.
 */
export const AGENT_TURN_PERSISTED_OUTCOMES: readonly AgentTurnOutcome[] =
  AGENT_TURN_OUTCOMES.filter((outcome) => !UNPERSISTED_OUTCOMES.has(outcome));

/**
 * Why a request did not reach its goal.
 *
 * The first block MIRRORS the eval's `DeathReasonClass`
 * (tests/eval/_lib/score.ts) name for name, so a death seen in production and a
 * death reproduced in the eval are the same word. It is mirrored rather than
 * imported because src must not depend on tests; a parity test keeps the two in
 * step. Three eval classes are absent because only a scorer holding the task's
 * success criterion and the device's dispatch log can assign them
 * (`answer_not_grounded`, `answer_was_not_an_extraction`, `criterion_not_met`),
 * and three more are folded into `invalid_parameter` because the route sees the
 * public diagnosis category, not the device's error code
 * (`selector_rejected_before_dispatch`, `intent_not_mappable`,
 * `navigated_but_page_never_loaded`).
 *
 * The second block is production-only: deaths the eval cannot have, because it
 * drives one turn on one healthy session with a scripted planner.
 */
export const AGENT_TURN_DEATH_REASONS = [
  // ── shared with the eval taxonomy ──
  'none',
  'halted_for_confirmation',
  'element_never_appeared_in_retry_budget',
  'element_click_intercepted',
  'element_not_interactable',
  'wait_condition_not_met',
  'capture_failed',
  'page_load_failed',
  'invalid_parameter',
  'result_too_large',
  'readback_gate_blocked',
  'answer_path_failed_after_being_reached',
  'turn_errored',
  'harness_error_unclassified',
  // ── production-only ──
  'session_error',
  'policy_refused',
  'model_refused',
  'model_unavailable',
  'customer_closed_session',
  'control_taken_mid_turn',
  'budget_exhausted',
  'transcript_limit',
  'session_not_active',
  'control_unavailable',
  'turn_in_progress',
  'idempotency_in_progress',
  'idempotency_mismatch',
  'account_turn_limit',
  'rate_limited',
  'request_rejected',
] as const;
export type AgentTurnDeathReason = (typeof AGENT_TURN_DEATH_REASONS)[number];

export const AGENT_TURN_PHASES = [
  'planning',
  'starting_browser',
  'executing',
  'reading_page',
  'answering',
] as const;
export type AgentTurnPhase = (typeof AGENT_TURN_PHASES)[number];

/** The intent kinds, plus `none` for a death that is not on a step. */
export const AGENT_TURN_STEP_KINDS = [
  'navigate',
  'interact',
  'wait',
  'capture',
  'scroll',
  'behavioral_pause',
  'none',
] as const;
export type AgentTurnStepKind = (typeof AGENT_TURN_STEP_KINDS)[number];

/**
 * The step kinds a ROW may carry. `none` is a metric LABEL for a death that is
 * not on a step; the table says the same thing with NULL, so its constraint
 * lists only the real kinds. Named for the same reason as
 * AGENT_TURN_PERSISTED_OUTCOMES.
 */
export const AGENT_TURN_PERSISTED_STEP_KINDS: readonly AgentTurnStepKind[] =
  AGENT_TURN_STEP_KINDS.filter((kind) => kind !== 'none');

export const AGENT_TURN_TRANSPORTS = ['stream', 'json'] as const;
export type AgentTurnTransport = (typeof AGENT_TURN_TRANSPORTS)[number];

/**
 * What became of one row.
 *
 *   ok       written
 *   error    the write failed or timed out
 *   dropped  not attempted: too many writes already in flight (a sick database)
 *   shed     not attempted: a turned-away request past the per-minute budget
 *            (a storm of 409s/429s — expected under load, not a fault)
 */
export const AGENT_TURN_TELEMETRY_WRITE_OUTCOMES = ['ok', 'error', 'dropped', 'shed'] as const;
export type AgentTurnTelemetryWriteOutcome = (typeof AGENT_TURN_TELEMETRY_WRITE_OUTCOMES)[number];

// `continue` — a planning call for a LATER segment of a turn whose previous
// segment succeeded and asked to go on. Kept apart from `re_plan` because they
// are opposite facts about a turn: one is the task progressing, the other is a
// step having failed. A metric label only; no stored row carries it.
export const AGENT_TURN_CALL_KINDS = [
  'plan',
  're_plan',
  'continue',
  'answer',
  'unattributed',
] as const;
export type AgentTurnCallKind = (typeof AGENT_TURN_CALL_KINDS)[number];

/** `other`: a model id outside the catalogue. `none`: no model call settled. */
export const AGENT_TURN_MODEL_LABELS: readonly string[] = [
  ...AgentModelSchema.options,
  'other',
  'none',
];

/** Seconds. Turns run from sub-second rejections to multi-minute plans. */
export const AGENT_TURN_DURATION_BUCKETS_SECONDS = [
  0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20, 30, 60, 120, 300, 600,
] as const;
/** Seconds. Finer at the low end: the promise is "something within a second". */
export const AGENT_TURN_FIRST_PROGRESS_BUCKETS_SECONDS = [
  0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60,
] as const;
/** Re-plan attempts; the runtime caps a turn at 2. */
export const AGENT_TURN_REPLAN_BUCKETS = [0, 1, 2, 3] as const;

/** How long diagnostics rows are kept. See agent-turn-telemetry-prune-job.ts. */
export const AGENT_TURN_TELEMETRY_RETENTION_DAYS = 90;

// ── the row ───────────────────────────────────────────────────────────────

/**
 * One request, as persisted. Every string member is one of the closed unions
 * above; everything else is a number, a boolean or a timestamp. There is no
 * free-text member and no identifier.
 */
export interface AgentTurnTelemetryRow {
  occurredAt: Date;
  outcome: AgentTurnOutcome;
  deathReason: AgentTurnDeathReason;
  /** Index in the turn's result list of the step that ended it; null when the
   *  death was not on a step. */
  diedStepIndex: number | null;
  diedStepKind: AgentTurnStepKind | null;
  httpStatus: number;
  transport: AgentTurnTransport;
  model: string;
  stepsPlanned: number;
  stepsRun: number;
  stepsSucceeded: number;
  /** Re-plan ATTEMPTS: every return to `planning` after the first plan. */
  replans: number;
  /** Model calls attempted: every `planning` and `answering` phase entered. */
  modelCalls: number;
  recoveredAfterReplan: boolean;
  durationMs: number;
  timeToFirstProgressMs: number | null;
  planningMs: number;
  startingBrowserMs: number;
  executingMs: number;
  readingPageMs: number;
  answeringMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Thousandths of a cent, list price. Integer so sums never drift. */
  estimatedCostMillicents: number;
  customerStopped: boolean;
  viewerDisconnected: boolean;
}

export interface AgentTurnTelemetryWriter {
  insert(row: AgentTurnTelemetryRow): Promise<void>;
}

// ── classification (pure) ─────────────────────────────────────────────────

const STEP_KIND_SET: ReadonlySet<string> = new Set(AGENT_TURN_STEP_KINDS);

function stepKindOf(result: IntentResult | undefined): AgentTurnStepKind | null {
  const kind: unknown = result?.intent.kind;
  return typeof kind === 'string' && kind !== 'none' && STEP_KIND_SET.has(kind)
    ? (kind as AgentTurnStepKind)
    : null;
}

/** The device's wording for an element that never showed up. Mirrors
 *  NEVER_BECAME_VISIBLE in the eval scorer. */
const NEVER_BECAME_VISIBLE = 'never became visible';
/** The device's wording for a match that cannot take a gesture. Mirrors
 *  ELEMENT_NOT_INTERACTABLE in the eval scorer. */
const ELEMENT_NOT_INTERACTABLE = 'element not interactable';

/**
 * The death-reason class of one failed step.
 *
 * Reads the failure's machine-readable diagnosis first. The prose `reason` is
 * consulted for exactly one thing — the device's "never became visible" wording,
 * which is the only way to tell an element that never appeared from one that
 * was covered when both arrive as the same category — and is never kept. (Two
 * phrases now: the second tells a match that cannot be tapped from a covered one.)
 */
export function classifyStepFailure(
  result: Extract<IntentResult, { kind: 'failure' }>,
): AgentTurnDeathReason {
  const category = result.diagnosis?.category;
  switch (category) {
    case 'element_not_found':
      return 'element_never_appeared_in_retry_budget';
    case 'page_load_failed':
      return 'page_load_failed';
    case 'condition_not_met':
      return 'wait_condition_not_met';
    case 'capture_failed':
      return 'capture_failed';
    case 'invalid_request':
      return 'invalid_parameter';
    case 'result_too_large':
      return 'result_too_large';
    case 'session_error':
      return 'session_error';
    case 'scroll_failed':
      return 'harness_error_unclassified';
    case 'unknown':
    case undefined: {
      if (typeof result.reason === 'string' && result.reason.includes(NEVER_BECAME_VISIBLE)) {
        return 'element_never_appeared_in_retry_budget';
      }
      // The selector DID match, and what it matched cannot be tapped — usually a
      // hidden copy of a control. Filing it as "intercepted" would send a reader
      // looking for an overlay that is not there.
      if (typeof result.reason === 'string' && result.reason.includes(ELEMENT_NOT_INTERACTABLE)) {
        return 'element_not_interactable';
      }
      // An interact whose outcome the device could not confirm is diagnosed
      // `unknown` on purpose (replaying it might click twice). The eval names
      // that same event by what the page did.
      return category === 'unknown' && result.intent.kind === 'interact'
        ? 'element_click_intercepted'
        : 'harness_error_unclassified';
    }
    default: {
      // A diagnosis category added to the public union without a class here
      // would be silently bucketed; make the omission a build error instead.
      const _exhaustive: never = category;
      void _exhaustive;
      return 'harness_error_unclassified';
    }
  }
}

export interface TurnClassification {
  outcome: AgentTurnOutcome;
  deathReason: AgentTurnDeathReason;
  diedStepIndex: number | null;
  diedStepKind: AgentTurnStepKind | null;
  customerStopped: boolean;
}

function flag(body: unknown, key: string): unknown {
  return typeof body === 'object' && body !== null
    ? (body as Record<string, unknown>)[key]
    : undefined;
}

function closedSessionReason(reason: string): AgentTurnDeathReason {
  if (reason === 'budget-exhausted') return 'budget_exhausted';
  if (reason === 'transcript-limit') return 'transcript_limit';
  return 'session_not_active';
}

/** Classify from the HTTP terminal alone — the path for every exit that never
 *  produced a turn result (validation, admission conflicts, replays' siblings). */
function classifyFromResponse(status: number, body: unknown): TurnClassification {
  const base = { diedStepIndex: null, diedStepKind: null, customerStopped: false };
  if (status >= 500) return { ...base, outcome: 'error', deathReason: 'turn_errored' };
  if (status === 409) {
    if (flag(body, 'turn_in_progress') === true) {
      return { ...base, outcome: 'busy_409', deathReason: 'turn_in_progress' };
    }
    const idempotency = flag(body, 'idempotency_status');
    if (idempotency === 'in_progress') {
      return { ...base, outcome: 'busy_409', deathReason: 'idempotency_in_progress' };
    }
    if (idempotency === 'mismatch') {
      return { ...base, outcome: 'conflict_409', deathReason: 'idempotency_mismatch' };
    }
    if (flag(body, 'ai_control_unavailable') === true) {
      return { ...base, outcome: 'conflict_409', deathReason: 'control_unavailable' };
    }
    return { ...base, outcome: 'conflict_409', deathReason: 'session_not_active' };
  }
  if (status === 429) return { ...base, outcome: 'rate_limited', deathReason: 'rate_limited' };
  if (status >= 400) return { ...base, outcome: 'rejected', deathReason: 'request_rejected' };
  // A 2xx with no observed turn result. Only reachable if a caller did not hand
  // the collector the result; classify from the public body rather than guess.
  const kind = flag(body, 'kind');
  if (kind === 'logged-manual') return { ...base, outcome: 'manual_note', deathReason: 'none' };
  if (kind === 'clarify') return { ...base, outcome: 'clarified', deathReason: 'none' };
  if (kind === 'refuse') return { ...base, outcome: 'refused', deathReason: 'model_refused' };
  // B2 — a stopped turn answers 200 like a completed one; without this a
  // stopped body reached here would be counted as a completion.
  if (kind === 'stopped') {
    return { ...base, outcome: 'stopped', deathReason: 'none', customerStopped: true };
  }
  if (kind === 'plan-executed' && flag(body, 'ok') !== true) {
    return { ...base, outcome: 'failed', deathReason: 'harness_error_unclassified' };
  }
  return { ...base, outcome: 'completed', deathReason: 'none' };
}

export interface ClassifyTurnArgs {
  status: number;
  body: unknown;
  result: RunTurnResult | undefined;
  /** Whether the runtime ever announced `planning` / `answering`. */
  sawPlanning: boolean;
  sawAnswering: boolean;
}

/**
 * B1 — a turn whose every step is a tick, and which still told the customer "the
 * task is not finished", is NOT `completed`.
 *
 * It was being filed as one: the loop's own bounds end a turn on a column of
 * green steps, the classifier read `executor.ok`, and the completion rate — the
 * number this work is judged by — counted a half-done task as done.
 *
 * ⛔ THE VOCABULARY IS THE TABLE'S. `outcome` and `death_reason` are CHECK-
 * constrained columns, so until a migration adds a word for "stopped at a loop
 * bound" each stop is filed under the existing word that is TRUE of it:
 *  · the planner asked the customer something part-way   → `clarified`
 *  · the planner declined part-way                       → `refused`
 *  · the chat's AI budget could not cover another look   → `failed` / `budget_exhausted`
 *  · the next plan could not be obtained                 → `failed` / `model_unavailable`
 *  · out of planning calls or time, going in circles, or a refused repeat
 *    → `clarified`: the turn handed the decision back to the customer with a
 *    sentence saying what to do next, which is what that outcome means ("neither
 *    a completion nor a death") — and, like every `clarified`, it is in neither
 *    the numerator nor the denominator of the completion rate. WHICH bound it was
 *    is on the turn result (`loop.stopped`) and in the `agent_turn_stopped_unfinished`
 *    log line; a `death_reason` of its own needs the migration.
 */
function classifyUnfinishedLoop(
  loop: Extract<RunTurnResult, { kind: 'plan-executed' }>['loop'],
): Pick<TurnClassification, 'outcome' | 'deathReason'> | null {
  if (loop === undefined) return null;
  if (loop.handedBack === true) {
    return loop.handedBackKind === 'refuse'
      ? { outcome: 'refused', deathReason: 'model_refused' }
      : { outcome: 'clarified', deathReason: 'none' };
  }
  switch (loop.stopped) {
    case undefined:
      return null;
    case 'budget_floor':
      return { outcome: 'failed', deathReason: 'budget_exhausted' };
    case 'planner_unavailable':
      return { outcome: 'failed', deathReason: 'model_unavailable' };
    case 'planner_call_limit':
    case 'wall_clock':
    case 'no_progress':
    case 'repeat_refused':
      return { outcome: 'clarified', deathReason: 'none' };
    default: {
      const _exhaustive: never = loop.stopped;
      void _exhaustive;
      return null;
    }
  }
}

export function classifyTurn(args: ClassifyTurnArgs): TurnClassification {
  const { result, status } = args;
  const base = { diedStepIndex: null, diedStepKind: null, customerStopped: false };
  // A 5xx wins over whatever the runtime returned: the customer got an error,
  // and that is the outcome, even if the browser work behind it succeeded.
  if (result === undefined || status >= 500) return classifyFromResponse(status, args.body);
  switch (result.kind) {
    case 'plan-executed': {
      const results = result.executor.results;
      if (result.executor.awaitingConfirmation === true) {
        const index = results.length - 1;
        return {
          ...base,
          outcome: 'halted_for_confirmation',
          deathReason: 'halted_for_confirmation',
          diedStepIndex: index >= 0 ? index : null,
          diedStepKind: stepKindOf(results[index]),
        };
      }
      if (!result.executor.ok) {
        // The LAST non-success result is the one that ended the run; an earlier
        // failure may have been recovered by a re-plan.
        let index = -1;
        for (let i = results.length - 1; i >= 0; i -= 1) {
          if (results[i]?.kind !== 'success') {
            index = i;
            break;
          }
        }
        const died = index >= 0 ? results[index] : undefined;
        return {
          ...base,
          outcome: 'failed',
          deathReason:
            died?.kind === 'failure' ? classifyStepFailure(died) : 'harness_error_unclassified',
          diedStepIndex: index >= 0 ? index : null,
          diedStepKind: stepKindOf(died),
        };
      }
      const unfinished = classifyUnfinishedLoop(result.loop);
      if (unfinished !== null) {
        return {
          ...base,
          ...unfinished,
          // A death has a place; a hand-back to the customer does not.
          diedStepIndex: unfinished.outcome === 'failed' ? results.length : null,
        };
      }
      if (result.readbackUnavailable !== undefined) {
        // Every step succeeded and the question still went unanswered. Whether
        // the runtime ever REACHED the answer call is the split the eval makes,
        // and the `answering` phase event is that fact.
        return {
          ...base,
          outcome: 'failed',
          deathReason: args.sawAnswering
            ? 'answer_path_failed_after_being_reached'
            : 'readback_gate_blocked',
          diedStepIndex: results.length,
        };
      }
      return { ...base, outcome: 'completed', deathReason: 'none' };
    }
    case 'clarify':
      return { ...base, outcome: 'clarified', deathReason: 'none' };
    case 'refuse':
      return {
        ...base,
        outcome: 'refused',
        // The policy screen refuses BEFORE `planning` is announced; a transient
        // provider failure is synthesised as a refuse with no usage block.
        deathReason: !args.sawPlanning
          ? 'policy_refused'
          : result.decomposer.usage === undefined
            ? 'model_unavailable'
            : 'model_refused',
      };
    case 'session-closed': {
      if (result.reason === 'customer-closed') {
        return {
          ...base,
          outcome: 'stopped',
          deathReason: 'customer_closed_session',
          customerStopped: true,
        };
      }
      const worked =
        result.usage !== undefined ||
        result.tokensConsumed !== undefined ||
        result.executor !== undefined;
      return {
        ...base,
        outcome: worked ? 'failed' : 'conflict_409',
        deathReason: closedSessionReason(result.reason),
      };
    }
    case 'turn-in-progress':
      return { ...base, outcome: 'busy_409', deathReason: 'turn_in_progress' };
    case 'account-turn-limit':
      return { ...base, outcome: 'rate_limited', deathReason: 'account_turn_limit' };
    case 'ai-control-unavailable':
      // At admission nothing ran: a plain conflict. Anywhere later, a person
      // took the controls away from a turn that was already working.
      return result.phase === 'admission'
        ? { ...base, outcome: 'conflict_409', deathReason: 'control_unavailable' }
        : {
            ...base,
            outcome: 'stopped',
            deathReason: 'control_taken_mid_turn',
            customerStopped: true,
          };
    case 'stopped':
      // B2 — the customer pressed Stop and the turn honoured it. `stopped` is the
      // outcome that means exactly that ("the customer interrupted it
      // mid-turn"), and `customer_stopped` is the column that says a person did
      // it. The death reason is `none` because nothing killed the task: the
      // customer chose to end it. That keeps a Stop apart from a takeover
      // (`control_taken_mid_turn`) without widening the table's CHECK list,
      // which would need a migration for a word this pair already expresses.
      return { ...base, outcome: 'stopped', deathReason: 'none', customerStopped: true };
    case 'logged-manual':
      return { ...base, outcome: 'manual_note', deathReason: 'none' };
    default: {
      const _exhaustive: never = result;
      void _exhaustive;
      return classifyFromResponse(status, args.body);
    }
  }
}

// ── usage, read defensively ───────────────────────────────────────────────

/**
 * Non-negative integer from the first of `keys` that holds one.
 *
 * The cache fields are read by NAME from an untyped view because the usage
 * object does not declare them yet; the planner lane is adding prompt caching,
 * and this must start counting the day it does without a coordinated edit.
 */
function tokenField(usage: unknown, keys: readonly string[]): number {
  if (typeof usage !== 'object' || usage === null) return 0;
  const record = usage as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value);
  }
  return 0;
}

export interface UsageTokens {
  input: number;
  output: number;
  cacheRead: number;
  /** Every token written to the cache, whatever its lifetime. */
  cacheWrite: number;
  /** The part of `cacheWrite` written with the one-hour lifetime, which bills
   *  at a higher rate. Zero when the provider gave no breakdown. */
  cacheWrite1h: number;
}

export function readUsageTokens(usage: unknown): UsageTokens {
  const write5m = tokenField(usage, ['anthropicCacheCreation5mInputTokens']);
  const write1h = tokenField(usage, ['anthropicCacheCreation1hInputTokens']);
  const writeTotal = tokenField(usage, [
    'anthropicCacheCreationInputTokens',
    'cacheCreationInputTokens',
    'cacheWriteTokens',
  ]);
  // The total wins when it is larger (a breakdown that covers only part of the
  // write); the breakdown wins when the total is absent. Either way the
  // one-hour share can never exceed the whole.
  const cacheWrite = Math.max(writeTotal, write5m + write1h);
  return {
    input: tokenField(usage, ['anthropicInputTokens', 'inputTokens']),
    output: tokenField(usage, ['anthropicOutputTokens', 'outputTokens']),
    cacheRead: tokenField(usage, [
      'anthropicCacheReadInputTokens',
      'cacheReadInputTokens',
      'cacheReadTokens',
    ]),
    cacheWrite,
    cacheWrite1h: Math.min(write1h, cacheWrite),
  };
}

export function modelLabel(model: unknown): string {
  if (typeof model !== 'string' || model.length === 0) return 'none';
  return AgentModelSchema.safeParse(model).success ? model : 'other';
}

// Fallback cache multipliers on the input rate (Anthropic list price: a read
// bills at a tenth, a 5-minute write at one and a quarter, a 1-hour write at
// double). The model catalogue
// carries its own per-model multipliers and those win when present; they are
// read through an optional view because that part of the catalogue is newer
// than this file and owned elsewhere.
const FALLBACK_CACHE_READ_MULTIPLIER = 0.1;
const FALLBACK_CACHE_WRITE_MULTIPLIER = 1.25;
const FALLBACK_CACHE_WRITE_1H_MULTIPLIER = 2;

interface ModelRateView {
  inputCentsPer1k: number;
  outputCentsPer1k: number;
  cacheReadMultiplier?: number;
  cacheWrite5mMultiplier?: number;
  cacheWrite1hMultiplier?: number;
}

/**
 * List-price estimate in thousandths of a cent. `tokens × cents-per-1k` IS
 * millicents, which is why the unit was chosen: no division, no rounding until
 * the end. Zero for a model outside the catalogue — an honest "unknown" beats a
 * confident number built on somebody else's rate.
 *
 * A cache write is priced by its lifetime when the usage object breaks it down:
 * the planner caches its system prompt — the largest prefix — for an hour, and
 * pricing that at the 5-minute rate understated every cold call. Writes with no
 * breakdown fall back to the 5-minute rate. This is an operator's estimate of
 * spend per turn, not a bill, and it says so wherever it is shown.
 */
export function estimateCostMillicents(model: string, tokens: UsageTokens): number {
  const parsed = AgentModelSchema.safeParse(model);
  if (!parsed.success) return 0;
  const catalogueModel: AgentModel = parsed.data;
  const rate: ModelRateView = CLAUDE_MODELS[catalogueModel];
  const readMultiplier = rate.cacheReadMultiplier ?? FALLBACK_CACHE_READ_MULTIPLIER;
  const writeMultiplier = rate.cacheWrite5mMultiplier ?? FALLBACK_CACHE_WRITE_MULTIPLIER;
  const write1hMultiplier = rate.cacheWrite1hMultiplier ?? FALLBACK_CACHE_WRITE_1H_MULTIPLIER;
  const write1h = Math.min(tokens.cacheWrite1h, tokens.cacheWrite);
  return Math.round(
    tokens.input * rate.inputCentsPer1k +
      tokens.output * rate.outputCentsPer1k +
      tokens.cacheRead * rate.inputCentsPer1k * readMultiplier +
      (tokens.cacheWrite - write1h) * rate.inputCentsPer1k * writeMultiplier +
      write1h * rate.inputCentsPer1k * write1hMultiplier,
  );
}

// ── the collector ─────────────────────────────────────────────────────────

export interface AgentTurnFinishArgs {
  status: number;
  body: unknown;
  /** The stream's viewer went away before the terminal frame. */
  viewerDisconnected?: boolean;
}

/** One request's observations. Every method is safe to call from the hot path:
 *  none throws, none awaits, none does more than a few assignments. */
export interface AgentTurnTelemetryCollector {
  /** Note a progress event's kind and time. The event itself is not kept. */
  recordProgress(event: AgentTurnProgressEvent): void;
  observeResult(result: RunTurnResult): void;
  markReplay(): void;
  finish(args: AgentTurnFinishArgs): void;
  /** For an exit that threw instead of producing a terminal. */
  finishWithError(error: unknown): void;
}

export interface AgentTurnTelemetryDeps {
  writer?: AgentTurnTelemetryWriter;
  metrics?: MetricsRegistry;
  logger?: { warn?: (obj: Record<string, unknown>, msg: string) => void };
  /** Monotonic milliseconds. Test seam. */
  nowMs?: () => number;
  /** Wall clock for the row's timestamp. Test seam. */
  wallClock?: () => Date;
  /** Writes allowed in flight before new rows are dropped. */
  maxPendingWrites?: number;
  /** How long one row write may take before its slot is taken back. */
  writeTimeoutMs?: number;
  /** Rows for turned-away requests (409/429/4xx) written per minute. */
  maxTurnedAwayRowsPerMinute?: number;
}

// Proportionate to a connection pool the customer's queries share: enough to
// ride out a burst, far too few to starve anything while the database is slow.
const DEFAULT_MAX_PENDING_WRITES = 20;
// A write that has not settled in this long is counted as an error and its slot
// released. Without it, a black-holed connection pinned the in-flight count at
// the cap and every later row was dropped until restart — even after the
// database came back.
const DEFAULT_WRITE_TIMEOUT_MS = 10_000;
// A request that was turned away is the path that SHEDS load, and a database
// write per rejection made shedding cost the thing it protects. One a second is
// far above honest traffic (production saw 27 turns in total) and far below a
// retry storm. Past it the row is skipped and counted as `shed`; the metrics
// still count every request, so the 409 rate on the scrape stays exact and only
// the table's copy saturates.
const DEFAULT_MAX_TURNED_AWAY_ROWS_PER_MINUTE = 60;
const TURNED_AWAY_WINDOW_MS = 60_000;
// Record ids remembered for de-duplicating a retried usage write. A turn makes
// at most four model calls, so this covers every turn in flight many times over.
const SEEN_RECORD_IDS_MAX = 512;
const ACTIVE_SWEEP_THRESHOLD = 1000;
const ABANDONED_AFTER_MS = 60 * 60 * 1000;

class Collector implements AgentTurnTelemetryCollector {
  readonly startedAt: number;
  private firstProgressAt: number | undefined;
  private currentPhase: AgentTurnPhase | undefined;
  private currentPhaseSince = 0;
  private readonly phaseMs: Record<AgentTurnPhase, number> = {
    planning: 0,
    starting_browser: 0,
    executing: 0,
    reading_page: 0,
    answering: 0,
  };
  private planningEntered = 0;
  /** `planning` phases the runtime marked as following a SUCCESSFUL segment that
   *  asked to continue. They are model calls and are not re-plans. */
  private continuesEntered = 0;
  private lastPlanningCause: 'continue' | 'replan' | undefined;
  private answeringEntered = 0;
  /** A `plan` arrived before any `planning`: an approved plan being resumed, so
   *  no first model call happened and every `planning` is a re-plan. */
  private resumedWithoutPlanning = false;
  private stepsPlanned = 0;
  /** A settled model call was credited to this turn by the usage recorder. */
  private usageObserved = false;
  private result: RunTurnResult | undefined;
  private replayed = false;
  private finished = false;
  readonly tokens: UsageTokens = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cacheWrite1h: 0,
  };
  costMillicents = 0;
  model = 'none';

  constructor(
    private readonly owner: AgentTurnTelemetry,
    readonly agentSessionId: string,
    private readonly transport: AgentTurnTransport,
  ) {
    this.startedAt = owner.nowMs();
  }

  get progressSeen(): boolean {
    return this.firstProgressAt !== undefined;
  }

  /** The kind of model call in flight right now, from the phase the runtime
   *  announced before making it. */
  callKindNow(): AgentTurnCallKind {
    if (this.currentPhase === 'answering') return 'answer';
    if (this.currentPhase === 'planning') {
      if (this.lastPlanningCause === 'continue') return 'continue';
      return this.planningEntered > 1 || this.resumedWithoutPlanning ? 're_plan' : 'plan';
    }
    return 'unattributed';
  }

  recordProgress(event: AgentTurnProgressEvent): void {
    try {
      this.noteProgress(event);
    } catch {
      /* telemetry must never reach the turn */
    }
  }

  private noteProgress(event: AgentTurnProgressEvent): void {
    const now = this.owner.nowMs();
    this.firstProgressAt ??= now;
    switch (event.kind) {
      case 'phase': {
        if (this.currentPhase !== undefined) {
          this.phaseMs[this.currentPhase] += Math.max(0, now - this.currentPhaseSince);
        }
        this.currentPhase = event.phase;
        this.currentPhaseSince = now;
        if (event.phase === 'planning') {
          this.planningEntered += 1;
          this.lastPlanningCause = event.cause;
          if (event.cause === 'continue') this.continuesEntered += 1;
        }
        if (event.phase === 'answering') this.answeringEntered += 1;
        return;
      }
      case 'plan':
        if (this.planningEntered === 0) this.resumedWithoutPlanning = true;
        // A count. The intents themselves are never touched. ASSIGNED, not
        // summed: the runtime's `total` is already cumulative (steps run so far
        // plus the new plan), so after a re-plan the last event IS the length of
        // the plan of record, and adding the earlier one counted its steps twice.
        if (Number.isFinite(event.total)) this.stepsPlanned = Math.max(0, Math.floor(event.total));
        return;
      case 'step_start':
      case 'answer':
      case 'notice':
        return;
      default: {
        const _exhaustive: never = event;
        void _exhaustive;
        return;
      }
    }
  }

  /** The loop bound that ended this turn short of its task, if one did. */
  loopStoppedAt(): string | null {
    return this.result?.kind === 'plan-executed' ? (this.result.loop?.stopped ?? null) : null;
  }

  observeResult(result: RunTurnResult): void {
    this.result = result;
    // The runtime has returned, so its last phase is over NOW. What the route
    // does next — the transcript append, the token debit, the idempotency
    // receipt — is storage work, and folding it into `answering` or `executing`
    // would make a slow database read as a slow model. It stays visible as the
    // remainder: duration − time to first progress − the phases.
    this.closeOpenPhase(this.owner.nowMs());
  }

  private closeOpenPhase(now: number): void {
    if (this.currentPhase === undefined) return;
    this.phaseMs[this.currentPhase] += Math.max(0, now - this.currentPhaseSince);
    this.currentPhase = undefined;
  }

  markReplay(): void {
    this.replayed = true;
  }

  finishWithError(error: unknown): void {
    const { status, body } = responseOfThrown(error);
    this.finish({ status, body });
  }

  finish(args: AgentTurnFinishArgs): void {
    if (this.finished) return;
    this.finished = true;
    try {
      const endedAt = this.owner.nowMs();
      // Stamped now, not when the deferred write runs: the row records when
      // the request ENDED, and a summary asked for a moment later must see it.
      const occurredAt = this.owner.wallClock();
      // Only still open when the runtime threw instead of returning.
      this.closeOpenPhase(endedAt);
      this.owner.settle(this, () => this.buildRow(args, endedAt, occurredAt));
    } catch {
      // The route calls this between deciding a response and sending it. There
      // is no failure here worth more than the customer's reply.
      this.owner.release(this);
    }
  }

  private buildRow(
    args: AgentTurnFinishArgs,
    endedAt: number,
    occurredAt: Date,
  ): AgentTurnTelemetryRow {
    const classification: TurnClassification = this.replayed
      ? {
          outcome: 'replayed',
          deathReason: 'none',
          diedStepIndex: null,
          diedStepKind: null,
          customerStopped: false,
        }
      : classifyTurn({
          status: args.status,
          body: args.body,
          result: this.result,
          sawPlanning: this.planningEntered > 0,
          sawAnswering: this.answeringEntered > 0,
        });
    const executor =
      this.result !== undefined && 'executor' in this.result ? this.result.executor : undefined;
    const stepsRun = executor?.results.length ?? 0;
    const stepsSucceeded = executor?.results.filter((r) => r.kind === 'success').length ?? 0;
    // No recorder observed a call (unwired, or a fixture): fall back to the one
    // usage block the result itself carries, so tokens are under-counted on a
    // multi-call turn rather than reported as zero.
    if (!this.usageObserved && this.result !== undefined) {
      const usage =
        'decomposer' in this.result
          ? this.result.decomposer.usage
          : 'usage' in this.result
            ? this.result.usage
            : undefined;
      if (usage !== undefined) this.addUsage(usage, 'result');
    }
    const firstPlanCalls = this.resumedWithoutPlanning ? 0 : Math.min(1, this.planningEntered);
    return {
      occurredAt,
      outcome: classification.outcome,
      deathReason: classification.deathReason,
      diedStepIndex: classification.diedStepIndex,
      diedStepKind: classification.diedStepKind,
      httpStatus: args.status,
      transport: this.transport,
      model: this.model,
      stepsPlanned: Math.max(this.stepsPlanned, stepsRun),
      stepsRun,
      stepsSucceeded,
      // ⛔ A `continue` IS NOT A RE-PLAN. Both return to `planning`, and until a
      // turn could go round on SUCCESS every return was a recovery. Counting
      // them alike would report a healthy four-page task as three recoveries,
      // and the re-plan histogram — the one that says how often plans hit a
      // wall — would become a histogram of task length. The continues stay in
      // `modelCalls`, where a call is a call.
      replans: Math.max(0, this.planningEntered - firstPlanCalls - this.continuesEntered),
      modelCalls: this.planningEntered + this.answeringEntered,
      recoveredAfterReplan: executor?.recoveredAfterReplan === true,
      durationMs: Math.max(0, Math.round(endedAt - this.startedAt)),
      timeToFirstProgressMs:
        this.firstProgressAt === undefined
          ? null
          : Math.max(0, Math.round(this.firstProgressAt - this.startedAt)),
      planningMs: Math.round(this.phaseMs.planning),
      startingBrowserMs: Math.round(this.phaseMs.starting_browser),
      executingMs: Math.round(this.phaseMs.executing),
      readingPageMs: Math.round(this.phaseMs.reading_page),
      answeringMs: Math.round(this.phaseMs.answering),
      inputTokens: this.tokens.input,
      outputTokens: this.tokens.output,
      cacheReadTokens: this.tokens.cacheRead,
      cacheWriteTokens: this.tokens.cacheWrite,
      estimatedCostMillicents: this.costMillicents,
      customerStopped: classification.customerStopped,
      viewerDisconnected: args.viewerDisconnected === true,
    };
  }

  /** The failed steps of this turn, for the step-failure counter. Recovered
   *  failures count too: a step that failed and was re-planned around still
   *  failed, and that is where the page beat the planner. */
  failedSteps(): Array<{ reason: AgentTurnDeathReason; stepKind: AgentTurnStepKind }> {
    const executor =
      this.result !== undefined && 'executor' in this.result ? this.result.executor : undefined;
    const out: Array<{ reason: AgentTurnDeathReason; stepKind: AgentTurnStepKind }> = [];
    for (const r of executor?.results ?? []) {
      if (r.kind !== 'failure') continue;
      out.push({ reason: classifyStepFailure(r), stepKind: stepKindOf(r) ?? 'none' });
    }
    return out;
  }

  addUsage(
    usage: unknown,
    source: 'recorder' | 'result' = 'recorder',
  ): { tokens: UsageTokens; model: string } {
    // Asked directly rather than inferred from the model label: a recorder call
    // for a model-less usage block is still a recorder call, and falling back
    // to the result's block on top of it would count those tokens twice.
    if (source === 'recorder') this.usageObserved = true;
    const tokens = readUsageTokens(usage);
    const model = modelLabel((usage as { model?: unknown } | null)?.model);
    this.tokens.input += tokens.input;
    this.tokens.output += tokens.output;
    this.tokens.cacheRead += tokens.cacheRead;
    this.tokens.cacheWrite += tokens.cacheWrite;
    this.tokens.cacheWrite1h += tokens.cacheWrite1h;
    this.costMillicents += estimateCostMillicents(model, tokens);
    // The LAST settled call names the turn's model. A turn uses one model.
    if (model !== 'none') this.model = model;
    return { tokens, model };
  }
}

// ── the service ───────────────────────────────────────────────────────────

export class AgentTurnTelemetry {
  private readonly active = new Map<string, Set<Collector>>();
  private readonly pending = new Set<Promise<void>>();
  private writesInFlight = 0;
  /** Insertion-ordered, so the oldest id is the first key. Random row ids the
   *  runtime mints per usage write: never persisted, never logged. */
  private readonly seenRecordIds = new Set<string>();
  private turnedAwayWindowStart = 0;
  private turnedAwayRowsInWindow = 0;
  readonly nowMs: () => number;
  readonly wallClock: () => Date;

  constructor(private readonly deps: AgentTurnTelemetryDeps = {}) {
    this.nowMs = deps.nowMs ?? (() => performance.now());
    this.wallClock = deps.wallClock ?? (() => new Date());
    this.seedClosedEnumSeries();
  }

  /**
   * Create every `outcome` series at zero.
   *
   * The registry renders a labelled series only once it has been incremented,
   * and an alert divides `completed` by the decided total. With NO completion
   * since the last restart the numerator was an empty vector, `empty / x` is
   * empty, and "completion rate under 50%" stayed silent at exactly 0% — the
   * state that prompted this instrument. A series born at zero also lets
   * `increase()` see its first event, which a series born at 1 hides; at tens of
   * turns a day and a restart per deploy that first event was most of the data.
   *
   * Only the two counters whose label is a single small enum. Seeding
   * reason × step-kind or call-kind × model would mint hundreds of series that
   * no expression divides by.
   */
  private seedClosedEnumSeries(): void {
    const metrics = this.deps.metrics;
    if (metrics === undefined) return;
    try {
      for (const outcome of AGENT_TURN_OUTCOMES) {
        metrics.inc(METRIC_NAMES.agentTurnTotal, { outcome }, 0);
      }
      for (const outcome of AGENT_TURN_TELEMETRY_WRITE_OUTCOMES) {
        metrics.inc(METRIC_NAMES.agentTurnTelemetryWriteTotal, { outcome }, 0);
      }
    } catch {
      /* a registry without these counters simply has nothing to seed */
    }
  }

  /** Start observing one request. Never throws. */
  begin(args: {
    agentSessionId: string;
    transport: AgentTurnTransport;
  }): AgentTurnTelemetryCollector {
    const collector = new Collector(this, args.agentSessionId, args.transport);
    try {
      this.evictAbandoned();
      const peers = this.active.get(args.agentSessionId) ?? new Set<Collector>();
      peers.add(collector);
      this.active.set(args.agentSessionId, peers);
    } catch {
      /* an unregistered collector still classifies its own request */
    }
    return collector;
  }

  /**
   * A request whose handler died between `begin` and `finish` would otherwise
   * sit in the active map for the life of the process. No turn runs for an
   * hour, so anything older is abandoned; the sweep only runs once the map is
   * large enough for the leak to be real.
   */
  private evictAbandoned(): void {
    if (this.active.size < ACTIVE_SWEEP_THRESHOLD) return;
    const cutoff = this.nowMs() - ABANDONED_AFTER_MS;
    for (const [sessionId, peers] of this.active) {
      for (const c of peers) if (c.startedAt < cutoff) peers.delete(c);
      if (peers.size === 0) this.active.delete(sessionId);
    }
  }

  /**
   * The collector a settled model call belongs to.
   *
   * The runtime's usage recorder knows the agent session, not the request. Two
   * requests can be open on one session at once — the second is the one about
   * to be told 409 — so ownership goes to the one the runtime is actually
   * talking to: the collector that has received a progress event.
   */
  private collectorFor(agentSessionId: string): Collector | undefined {
    const peers = this.active.get(agentSessionId);
    if (peers === undefined) return undefined;
    // The MOST RECENTLY started one that has seen progress. A set iterates in
    // insertion order, which is start order. Taking the first instead handed
    // every later model call on the session to a collector leaked by a handler
    // that died between `begin` and `finish`, and the live turn's row then
    // showed zero tokens.
    let talking: Collector | undefined;
    let only: Collector | undefined;
    for (const c of peers) {
      if (c.progressSeen) talking = c;
      only = peers.size === 1 ? c : undefined;
    }
    return talking ?? only;
  }

  /** Count one settled model call and credit it to its turn. Never throws. */
  observeModelCall(args: { agentSessionId: string; usage: unknown }): void {
    try {
      const collector = this.collectorFor(args.agentSessionId);
      const callKind: AgentTurnCallKind = collector?.callKindNow() ?? 'unattributed';
      const { tokens, model } =
        collector !== undefined
          ? collector.addUsage(args.usage)
          : {
              tokens: readUsageTokens(args.usage),
              model: modelLabel((args.usage as { model?: unknown } | null)?.model),
            };
      const metrics = this.deps.metrics;
      if (metrics === undefined) return;
      metrics.inc(METRIC_NAMES.agentTurnModelCallTotal, { call_kind: callKind, model });
      const byType: ReadonlyArray<readonly [string, number]> = [
        ['input', tokens.input],
        ['output', tokens.output],
        ['cache_read', tokens.cacheRead],
        ['cache_write', tokens.cacheWrite],
      ];
      for (const [tokenType, count] of byType) {
        if (count === 0) continue;
        metrics.inc(
          METRIC_NAMES.agentTurnTokensTotal,
          { token_type: tokenType, call_kind: callKind, model },
          count,
        );
      }
    } catch {
      /* telemetry must never reach the turn */
    }
  }

  /**
   * Observe every settled model call by standing in front of the runtime's
   * usage recorder. The recorder is the one seam that sees ALL of a turn's
   * calls — the turn result carries only the plan's — and wrapping it needs no
   * edit to the runtime.
   *
   * The inner recorder is called exactly as before and its outcome is returned
   * untouched; with no inner recorder the wrapper still observes.
   *
   * ⛔ ONE MODEL CALL IS ONE OBSERVATION, HOWEVER MANY TIMES ITS ROW IS WRITTEN.
   * The runtime retries a failed usage write up to three times and reuses one
   * `recordId` across the attempts so billing stays idempotent. Observing every
   * attempt counted one call as three — tripling calls, tokens and cost in both
   * the metrics and the row — and only while the database was flaky, which is
   * when these numbers get read. A call with no `recordId` cannot be a retry of
   * anything this can identify, and is observed as it always was.
   */
  wrapUsageRecorder(inner?: AgentDecomposerUsageRecorder): AgentDecomposerUsageRecorder {
    return {
      record: async (args) => {
        if (this.firstSightOf(args.recordId)) {
          this.observeModelCall({ agentSessionId: args.agentSessionId, usage: args.usage });
        }
        if (inner !== undefined) await inner.record(args);
      },
    };
  }

  /** True the first time a record id is seen, and for a call without one.
   *  Never throws: on any fault the call is observed rather than lost. */
  private firstSightOf(recordId: unknown): boolean {
    try {
      if (typeof recordId !== 'string' || recordId.length === 0) return true;
      if (this.seenRecordIds.has(recordId)) return false;
      this.seenRecordIds.add(recordId);
      if (this.seenRecordIds.size > SEEN_RECORD_IDS_MAX) {
        for (const oldest of this.seenRecordIds) {
          this.seenRecordIds.delete(oldest);
          break;
        }
      }
      return true;
    } catch {
      return true;
    }
  }

  /** @internal Forget a finished collector so the active map cannot grow. */
  release(collector: Collector): void {
    try {
      const peers = this.active.get(collector.agentSessionId);
      peers?.delete(collector);
      if (peers?.size === 0) this.active.delete(collector.agentSessionId);
    } catch {
      /* best effort */
    }
  }

  /** @internal Open requests being observed. Test seam for the leak check. */
  activeCount(): number {
    let n = 0;
    for (const peers of this.active.values()) n += peers.size;
    return n;
  }

  /** @internal Called once per collector, from finish(). */
  settle(collector: Collector, build: () => AgentTurnTelemetryRow): void {
    this.release(collector);
    // Deferred past the current tick, so neither classification nor the write
    // sits between the decided response and the socket.
    const task = new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => this.emitAndPersist(collector, build()))
      .catch((err: unknown) => {
        this.countWrite('error');
        this.deps.logger?.warn?.(
          { component: 'agent-turn-telemetry', err: errorName(err) },
          'agent turn telemetry failed; the turn was not affected',
        );
      })
      .finally(() => {
        this.pending.delete(task);
      });
    this.pending.add(task);
  }

  private async emitAndPersist(collector: Collector, row: AgentTurnTelemetryRow): Promise<void> {
    this.emitMetrics(collector, row);
    const stoppedAt = collector.loopStoppedAt();
    if (stoppedAt !== null) {
      // The row's columns are a closed vocabulary with no word for WHICH bound
      // ended the turn (see classifyUnfinishedLoop); this line is where an
      // operator reads it until a migration gives it a column value. The reason
      // is one of a fixed set of identifiers — never page or customer text.
      this.deps.logger?.warn?.(
        {
          component: 'agent-turn-telemetry',
          event: 'agent_turn_stopped_unfinished',
          stopped: stoppedAt,
          outcome: row.outcome,
          model_calls: row.modelCalls,
        },
        'an agent turn stopped at a loop bound with its task unfinished',
      );
    }
    if (UNPERSISTED_OUTCOMES.has(row.outcome)) return;
    const writer = this.deps.writer;
    if (writer === undefined) return;
    if (AGENT_TURN_TURNED_AWAY_OUTCOMES.includes(row.outcome) && !this.admitTurnedAwayRow()) {
      this.countWrite('shed');
      return;
    }
    // A database that has stopped answering must cost dropped rows, never an
    // unbounded queue of promises each holding a row.
    if (this.writesInFlight >= (this.deps.maxPendingWrites ?? DEFAULT_MAX_PENDING_WRITES)) {
      this.countWrite('dropped');
      return;
    }
    this.writesInFlight += 1;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeoutMs = this.deps.writeTimeoutMs ?? DEFAULT_WRITE_TIMEOUT_MS;
      const insert = writer.insert(row);
      // The slot comes back at the deadline whether or not the driver ever
      // settles; a late rejection must not surface as an unhandled one.
      insert.catch(() => undefined);
      await Promise.race([
        insert,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new AgentTurnTelemetryWriteTimeout());
          }, timeoutMs);
          timer.unref();
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      this.writesInFlight -= 1;
    }
    this.countWrite('ok');
  }

  /** Fixed one-minute windows on the monotonic clock. */
  private admitTurnedAwayRow(): boolean {
    const now = this.nowMs();
    if (now - this.turnedAwayWindowStart >= TURNED_AWAY_WINDOW_MS) {
      this.turnedAwayWindowStart = now;
      this.turnedAwayRowsInWindow = 0;
    }
    const limit = this.deps.maxTurnedAwayRowsPerMinute ?? DEFAULT_MAX_TURNED_AWAY_ROWS_PER_MINUTE;
    if (this.turnedAwayRowsInWindow >= limit) return false;
    this.turnedAwayRowsInWindow += 1;
    return true;
  }

  private countWrite(outcome: AgentTurnTelemetryWriteOutcome): void {
    try {
      this.deps.metrics?.inc(METRIC_NAMES.agentTurnTelemetryWriteTotal, { outcome });
    } catch {
      /* an unregistered counter must not turn a swallowed failure into a thrown one */
    }
  }

  private emitMetrics(collector: Collector, row: AgentTurnTelemetryRow): void {
    const metrics = this.deps.metrics;
    if (metrics === undefined) return;
    try {
      const outcome = row.outcome;
      metrics.inc(METRIC_NAMES.agentTurnTotal, { outcome });
      metrics.observe(METRIC_NAMES.agentTurnDurationSeconds, row.durationMs / 1000, { outcome });
      if (row.timeToFirstProgressMs !== null) {
        metrics.observe(
          METRIC_NAMES.agentTurnTimeToFirstProgressSeconds,
          row.timeToFirstProgressMs / 1000,
          { transport: row.transport },
        );
      }
      const phases: ReadonlyArray<readonly [AgentTurnPhase, number]> = [
        ['planning', row.planningMs],
        ['starting_browser', row.startingBrowserMs],
        ['executing', row.executingMs],
        ['reading_page', row.readingPageMs],
        ['answering', row.answeringMs],
      ];
      for (const [phase, ms] of phases) {
        // A phase the turn never entered is absent, not a zero-second sample:
        // zeros would drag every percentile toward the floor.
        if (ms <= 0) continue;
        metrics.observe(METRIC_NAMES.agentTurnPhaseDurationSeconds, ms / 1000, { phase });
      }
      if (turnRan(row)) {
        metrics.observe(METRIC_NAMES.agentTurnReplans, row.replans, { outcome });
      }
      for (const failed of collector.failedSteps()) {
        metrics.inc(METRIC_NAMES.agentTurnStepFailureTotal, {
          reason: failed.reason,
          step_kind: failed.stepKind,
        });
      }
      if (row.outcome === 'failed' && row.diedStepKind === null) {
        // A death that was not on a step (the read-back, a closed session) has
        // no failure row to count above.
        metrics.inc(METRIC_NAMES.agentTurnStepFailureTotal, {
          reason: row.deathReason,
          step_kind: 'none',
        });
      }
    } catch {
      /* metrics are best-effort */
    }
  }

  /** Test seam and shutdown hook: resolves once every deferred task settled. */
  async flush(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending]);
    }
  }
}

class AgentTurnTelemetryWriteTimeout extends Error {
  constructor() {
    super('agent turn telemetry write timed out');
    this.name = 'AgentTurnTelemetryWriteTimeout';
  }
}

/**
 * The status and problem extensions the CUSTOMER receives for a thrown error,
 * mirroring `normaliseError` in middleware/error-handler.ts arm for arm.
 *
 * ⛔ Never a bare numeric `.status`. The streamed planner throws a provider error
 * carrying the PROVIDER's status (401 for a bad credential); the customer gets a
 * 500 for it, and reading that 401 filed a provider outage under "the request
 * was rejected" — outside the `error` outcome and outside the completion rate's
 * denominator, which is where an outage most needs to show.
 */
function responseOfThrown(error: unknown): { status: number; body: unknown } {
  try {
    if (error instanceof ApiError) return { status: error.status, body: error.extensions };
    if (error instanceof ZodError) return { status: 400, body: undefined };
    const statusCode: unknown =
      typeof error === 'object' && error !== null
        ? (error as { statusCode?: unknown }).statusCode
        : undefined;
    // The framework's own parser/validator errors, which the handler maps to
    // their 4xx. Anything else — 5xx included — is answered as a 500.
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      return { status: statusCode, body: undefined };
    }
  } catch {
    /* a hostile getter is an unexpected error like any other */
  }
  return { status: 500, body: undefined };
}

/** The error's class name only. A database error MESSAGE can quote the failing
 *  value, and this log line must stay as content-free as the row. */
function errorName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

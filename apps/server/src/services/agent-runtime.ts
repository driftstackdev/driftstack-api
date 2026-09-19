// AI-COMPOSE — AgentRuntime composes the three AI-CHAT primitives
// (AgentDecomposer + AgentSessionsRepo + AgentExecutor) into the
// single end-to-end loop the dashboard chat UI hits per turn:
//
//   user-message → load AgentSession → decomposer.decompose() →
//     (refuse | clarify | plan→executor.execute) → debit tokens →
//     append transcripts → return turn result
//
// This is the FIRST place where the three primitive interfaces meet,
// so the contract is testable end-to-end without any of them needing
// a real backend. Each can be swapped (Deterministic→Claude;
// Stub→Wired; InMemory→Drizzle) without changing the runtime.

import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type {
  AgentDecomposer,
  AgentIntent,
  CredentialBag,
  DecomposeResult,
  DecomposeUsage,
  PlanStatus,
  TranscriptEntry,
  TurnProgress,
} from './agent-decomposer.js';
import {
  AgentDecomposerContinuationDeniedError,
  AgentDecomposerSettledError,
  credentialRefsFor,
} from './agent-decomposer.js';
import type {
  AgentExecutor,
  ElementWaitBudget,
  ExecuteArgs,
  ExecutorRunResult,
  IntentResult,
} from './agent-executor.js';
import {
  runResultToTranscriptEntry,
  sanitizeTranscriptText,
  STOPPED_OUTCOME_UNKNOWN_REASON,
  stopRequested,
} from './agent-executor.js';
import { intentReplayMayDuplicateEffect } from './agent-intent-result.js';
import type {
  AgentSessionAuthoritySnapshot,
  AgentSessionRecord,
  AgentSessionsRepo,
} from './agent-sessions.js';
import type { AgentSessionEventBus } from './agent-session-event-bus.js';
import type { AgentTurnStopChannel } from './agent-turn-stop-channel.js';
import { METRIC_NAMES } from './metrics-registry.js';
import { screenTaskForRefusal, type RefusalPattern } from './task-refusal.js';

export interface RunTurnArgs {
  agentSessionId: string;
  /** Customer's free-text task. */
  userMessage: string;
  /**
   * Wall-clock for transcript entries + updatedAt. Defaulted to
   * `new Date()` by callers; injected here for deterministic tests.
   */
  now?: Date;
  /**
   * BYOK Anthropic API key threaded through from the route layer
   * (resolved from per-customer storage or the deployment fallback;
   * see `DecomposeArgs.byokAnthropicApiKey` JSDoc for the priority
   * order). NEVER logged, NEVER persisted into the transcript.
   * DeterministicAgentDecomposer ignores it; AI-B1.b Claude wire
   * forwards as the `x-api-key` header on the Anthropic API call.
   */
  byokApiKey?: string;
  /**
   * Arc 1 sub-slice 6.4 (v2-#6) — which leg of the route's
   * resolution chain produced `byokApiKey`. The usage recorder
   * writes a distinct record_type for 'bundled' so the soft-cap
   * sweep (sub-slice 6.5) can sum bundled-only spend without
   * double-counting BYOK turns. Defaults to 'none' so existing
   * callers (which don't pass keySource) keep recording under the
   * generic 'agent_decomposer' record_type.
   */
  keySource?: 'header' | 'cached' | 'bundled' | 'fallback' | 'none';
  /**
   * P2 — the credentials this session may use to log in, held in memory for the
   * length of this call only.
   *
   * ⛔ THE SPLIT IS THE POINT. The planner is told only the NAMES
   * (`credentialRefsFor`) so it can plan `{{credential:username}}`; the executor
   * is given the bag so it can substitute the real value into the dispatch. No
   * value reaches a prompt, a provider request, an executor result, or the
   * transcript — which is what the bag's own contract ("never persisted in
   * plaintext") requires.
   *
   * ⚠️ WHAT IS NOT DECIDED HERE: where the bag comes from. There is no
   * credential store and no UI that collects one; this threads the safe path end
   * to end so that whatever product decision is made about storage has somewhere
   * to deliver to. Until a caller supplies it, log-in tasks still cannot work —
   * but they now fail for a reason someone can act on rather than silently
   * planning against a field nothing populates.
   */
  credentials?: CredentialBag;
  /**
   * W443/W445 — consequential-action signatures the customer approved on a
   * prior turn (the executor halted with `confirmation_required`). Threaded to
   * the executor so the re-planned consequential action dispatches instead of
   * halting again. The route maps the request's {category, matched_text} pairs
   * to signatures via `consequentialSignature`.
   */
  approvedConsequentialActions?: ReadonlySet<string>;
  /**
   * Live-progress hook (step streaming). Forwarded verbatim to the executor's
   * `onStep`, which fires it once per intent AS its result lands. The streaming
   * POST /message handler passes one that writes an SSE `event: step` frame so a
   * client sees steps arrive instead of only the final response. Optional and
   * best-effort — omitted on the non-streaming path and by the idempotency
   * replay (a replayed turn does no live execution, so no steps fire).
   */
  onStep?: (result: IntentResult, index: number) => void;
  /**
   * Live-progress hook for everything that happens BEFORE a step result exists.
   * `onStep` only fires once an intent has COMPLETED, so between Send and the
   * first completed intent a customer saw nothing at all — planning alone can
   * take tens of seconds. These events are strictly additive: a caller that
   * omits the hook, or a client that never subscribes, behaves exactly as
   * before. Best-effort — a throwing sink never affects the turn.
   */
  onProgress?: (event: AgentTurnProgressEvent) => void;
  /** Route-admitted control lane. Production captures this before any
   * credential, budget, or provider work so a mode change cannot reinterpret
   * the same request. Direct/test callers may omit it; the runtime then admits
   * exactly the current durable lane itself. */
  admission?: AgentTurnAdmission;
  /**
   * B2 — the window the route opened for this request when it admitted it (see
   * {@link AgentRuntime.openTurnStopWindow}). A Stop that arrived during the
   * route's own preflight has already aborted it, and the turn then ends
   * `stopped` at its first check. Omitted, the turn makes its own controller.
   */
  stopWindow?: AgentTurnStopWindow;
}

/**
 * B2 — a request that has been admitted but whose turn may not have started
 * yet. Between the route admitting a message and the runtime taking the
 * session's turn slot there are several awaits (the idempotency receipt, key and
 * spend checks, runTurn's own reads); a Stop pressed right after Send lands
 * there. Without a window it would find no running turn, answer "nothing to
 * stop", and the turn would then run to completion.
 */
export interface AgentTurnStopWindow {
  /** Aborted by a Stop for this session while the window is open. */
  readonly signal: AbortSignal;
  /** Forget the window. Call once the request has finished, in a `finally`. */
  close(): void;
}

/**
 * Turn-progress events, in the order a normal plan turn emits them:
 *
 *   phase:planning → plan → phase:starting_browser → phase:executing →
 *   step_start(0) → (existing `step` result) → step_start(1) → … →
 *   phase:reading_page → phase:answering → answer
 *
 * Phases are skipped, never reordered: a turn with no read-back never emits
 * `reading_page`/`answering`/`answer`, and a refuse/clarify stops after
 * `planning`. The `intents` on a `plan` event are the RAW planned intents —
 * the route projects them through `publicAgentIntent` before they reach a
 * client, exactly like the turn response does.
 */
export type AgentTurnProgressEvent =
  | {
      kind: 'phase';
      phase: 'planning' | 'starting_browser' | 'executing' | 'reading_page' | 'answering';
      /**
       * B6 — which SEGMENT of the turn this phase belongs to (1-based), and, on a
       * `planning` or `reading_page` phase after the first segment, WHY the turn
       * is going round again: the previous segment asked to `continue`, or a step
       * failed and the rest is being re-planned. Both absent on a turn's first
       * pass, so a single-segment turn emits exactly the events it always did.
       *
       * They exist because the two are different things to every reader: the
       * customer ("Continuing…" is not "something went wrong"), and the telemetry,
       * whose `replans` would otherwise count a healthy four-segment task as
       * three recoveries.
       */
      segment?: number;
      cause?: 'continue' | 'replan';
    }
  | {
      kind: 'plan';
      intents: ReadonlyArray<AgentIntent>;
      /** Steps run so far this turn PLUS this segment's — cumulative. */
      total: number;
      /** B6 — how many steps ran before this segment: the index, in the turn's
       *  one step list, of this segment's first intent. `step_start.index` and
       *  the `step` results are in that same space. Absent on a first segment. */
      offset?: number;
      segment?: number;
      status?: PlanStatus;
    }
  | { kind: 'step_start'; index: number; total: number }
  | { kind: 'answer'; answer: string }
  /** B1 — the turn stopped short of finished, or the planner asked something
   *  part-way through. See `notice` on the plan-executed turn result. */
  | { kind: 'notice'; notice: string };

/** Publish a progress event without ever letting a broken sink break the turn. */
function emitProgress(sink: RunTurnArgs['onProgress'], event: AgentTurnProgressEvent): void {
  if (sink === undefined) return;
  try {
    sink(event);
  } catch {
    /* a broken progress handler must not affect the turn */
  }
}

export interface AgentControlAuthoritySnapshot {
  status: 'active';
  mode: 'manual' | 'ai' | 'pair';
  pairModeState: null | { kind: 'ai-driving' };
  revision: number;
}

export type AgentTurnAdmission =
  | { kind: 'manual-transcript'; authority: AgentControlAuthoritySnapshot }
  | { kind: 'ai-control'; authority: AgentControlAuthoritySnapshot };

function isExactAiDrivingState(value: unknown): value is { kind: 'ai-driving' } {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    (value as { kind?: unknown }).kind === 'ai-driving'
  );
}

/** Strict executable AI-authority predicate shared by route admission and all
 * runtime continuation fences. Pair NULL is temporarily accepted because it
 * is the persisted pre-normalization representation of `ai-driving`. */
export function agentSessionHasCurrentAiAuthority(
  session: Pick<AgentSessionRecord, 'status' | 'mode' | 'pairModeState'>,
): boolean {
  if (session.status !== 'active') return false;
  if (session.mode === 'ai') return session.pairModeState === null;
  if (session.mode !== 'pair') return false;
  return session.pairModeState === null || isExactAiDrivingState(session.pairModeState);
}

/** Resolve one active row to exactly one admitted lane. Human-controlled,
 * pending, queued, and malformed pair states deliberately return null. */
export function agentTurnAdmissionForSession(
  session: AgentSessionAuthoritySnapshot,
): AgentTurnAdmission | null {
  if (session.status === 'active' && session.mode === 'manual' && session.pairModeState === null) {
    return {
      kind: 'manual-transcript',
      authority: {
        status: 'active',
        mode: 'manual',
        pairModeState: null,
        revision: session.revision,
      },
    };
  }
  if (!agentSessionHasCurrentAiAuthority(session)) return null;
  return {
    kind: 'ai-control',
    authority: {
      status: 'active',
      mode: session.mode,
      pairModeState: session.pairModeState === null ? null : { kind: 'ai-driving' },
      revision: session.revision,
    },
  };
}

export function agentTurnAdmissionMatchesSnapshot(
  admission: AgentTurnAdmission,
  session: AgentSessionAuthoritySnapshot,
): boolean {
  const current = agentTurnAdmissionForSession(session);
  return (
    current !== null &&
    current.kind === admission.kind &&
    isDeepStrictEqual(current.authority, admission.authority)
  );
}

export type RunTurnResult =
  | {
      kind: 'plan-executed';
      decomposer: DecomposeResult;
      executor: ExecutorRunResult;
      session: AgentSessionRecord;
      /**
       * The read-back answer — what the customer actually asked for ("tell me
       * the IP"). It was computed, sanitized, billed and appended to the
       * transcript, and then went nowhere: the turn result carried only the
       * step list, so the chat showed "✓ navigated · ✓ captured" and never the
       * answer. Present only when a read-back ran AND survived sanitisation;
       * absent otherwise, which renders exactly as before.
       */
      answer?: string;
      /**
       * P5 — why the customer is NOT getting an answer, when they asked for one
       * and the read-back could not produce it. Mutually exclusive with
       * {@link answer}: exactly one of the two is present on a turn whose
       * wording asked a question, and neither on a pure-action turn.
       *
       * It exists because the alternative was SILENCE. The read-back is gated on
       * several conjuncts that have nothing to do with whether the customer
       * asked — the AI budget left, whether a key is configured, whether the page
       * could be read at all — and every one of them used to end the turn with
       * the steps rendered and the question unanswered and unacknowledged. The
       * sentence is already published as an agent transcript entry; this field
       * carries it to callers that read the turn result directly.
       */
      readbackUnavailable?: string;
      /**
       * B1 — what the customer must be TOLD about how this turn ended, when the
       * step list alone would mislead them: the loop stopped at one of its bounds
       * with the task unfinished (every step a tick, nothing done), or the
       * planner, shown the page part-way through, asked a question or declined.
       * Customer-visible copy. Absent on a turn that finished or failed on a
       * step — a ✗ row is its own explanation.
       */
      notice?: string;
      /** B1 — how the loop ran, for callers that classify turns rather than
       *  render them. `stopped` is the bound that ended it, when one did. */
      loop?: {
        segments: number;
        plannerCalls: number;
        replans: number;
        finalStatus?: PlanStatus;
        stopped?: TurnLoopStopReason;
        handedBack?: boolean;
        /** Whether the planner handed back with a QUESTION or a REFUSAL — they
         *  are different outcomes for a turn, and telemetry says which. */
        handedBackKind?: 'clarify' | 'refuse';
      };
    }
  | {
      kind: 'clarify';
      decomposer: Extract<DecomposeResult, { kind: 'clarify' }>;
      session: AgentSessionRecord;
    }
  | {
      kind: 'refuse';
      decomposer: Extract<DecomposeResult, { kind: 'refuse' }>;
      session: AgentSessionRecord;
    }
  | {
      kind: 'session-closed';
      reason: string;
      session: AgentSessionRecord;
      /** Work that settled before the terminal lifecycle winner. Preserve it
       * so callers never infer that a browser action was safe to repeat. */
      usage?: DecomposeUsage;
      tokensConsumed?: number;
      executor?: ExecutorRunResult;
    }
  | {
      /** A turn is already decomposing/executing for this exact session. The
       *  caller maps this non-mutating result to 409 and retries later. */
      kind: 'turn-in-progress';
      session: AgentSessionRecord;
    }
  | {
      /** This owner account already has the configured maximum number of AI
       *  turns in flight across its other sessions. The route maps this
       *  non-mutating result to the existing typed retryable 429 problem. */
      kind: 'account-turn-limit';
      current: number;
      limit: number;
      session: AgentSessionRecord;
    }
  | {
      /** The row remains active, but this request no longer owns the control
       * lane it was admitted under. No later model/browser work or normal
       * transcript publication is allowed. */
      kind: 'ai-control-unavailable';
      phase:
        | 'admission'
        | 'message-publication'
        | 'decompose'
        | 'execution'
        | 'plan-publication'
        | 'observation'
        | 'readback'
        | 'finalize';
      session: AgentSessionRecord;
      usage?: DecomposeUsage;
      tokensConsumed?: number;
      executor?: ExecutorRunResult;
    }
  | {
      /**
       * B2 — the customer pressed Stop and the turn honoured it.
       *
       * A NORMAL ENDING, not an error: the customer asked for it, and what they
       * need back is exactly what ran — the steps, including one that was already
       * running when Stop arrived (recorded with its real result, or as
       * outcome-unknown; never as "not done"). The transcript carries the same
       * account, so the next turn's planner knows the task was left unfinished.
       * The session's turn slot is released as this returns, so the customer's
       * next message is accepted.
       */
      kind: 'stopped';
      session: AgentSessionRecord;
      /** What the turn was doing when the stop was observed. */
      stoppedDuring: AgentTurnStopPhase;
      /** Every step that ran, in order. Absent when the turn stopped before any
       *  plan was run. */
      executor?: ExecutorRunResult;
      /** The steps planned so far this turn, counting the ones that ran. */
      stepsPlanned: number;
      /** Customer-visible: how far the turn got, and what to check. */
      notice: string;
      /** The turn's first model call's usage, as on every other result kind;
       *  every call's own row was recorded as it settled or was cut short. */
      usage?: DecomposeUsage;
      tokensConsumed?: number;
    }
  | {
      // Arc 2 sub-slice 8.6 (v2-#8) — manual mode pass-through.
      // The user_message was recorded as an actor='operator' transcript
      // entry; no decompose / executor ran. Customer's gui-client is
      // responsible for driving real intents via the V-174 gui_control
      // routes (sub-slice 8.4 mints the gui_control_key for that).
      kind: 'logged-manual';
      session: AgentSessionRecord;
    };

/**
 * v2-#4 Q.1.e — per-turn usage recorder. AgentRuntime calls this
 * after every decomposer.decompose() that returns a `usage` block.
 * Bootstrap wires this to a usage_records writer when the Drizzle
 * dependency direction is permitted. When unwired, AgentRuntime
 * silently skips recording — the dashboard usage page only reflects
 * what we successfully persisted, so a missing wire shows as missing
 * cost data rather than a synthesized zero.
 */
export interface AgentDecomposerUsageRecorder {
  record(args: {
    accountId: string;
    /**
     * Stable row identity, generated ONCE per row by the caller and reused on
     * every retry attempt, so the write is idempotent.
     *
     * `recordUsageRowWithRetry` re-invokes this on any throw. Without a caller
     * -supplied id the insert takes the `gen_random_uuid()` default, so a
     * commit-that-appears-to-fail — connection reset after the server
     * committed, or a client-side timeout on a statement that landed — posts a
     * SECOND $0.10 row for one turn. That is the same harm as the per-row/per-
     * turn bug fixed in f97cf1349: the monthly cap is consumed at 2x and the
     * customer is hard-402'd after fewer turns than they were sold, while the
     * turn's own response still reports 10.
     *
     * Optional so existing callers and fixtures stay source-compatible; when
     * omitted the database default applies and the write is NOT retry-safe.
     */
    recordId?: string;
    /** Driftstack session id (NOT agent-session id) if the agent-
     *  session has one attached; null otherwise. */
    driftstackSessionId: string | null;
    agentSessionId: string;
    decomposeResultKind: 'plan' | 'clarify' | 'refuse';
    usage: DecomposeUsage;
    tokensConsumed: number;
    now: Date;
    /**
     * Arc 1 sub-slice 6.4 (v2-#6) — drives the record_type column
     * on the usage_records insert: 'bundled' → 'agent_decomposer_bundled',
     * else → 'agent_decomposer'. Bundled rows post a flat $0.10/turn
     * cost (Q5=A hide actual upstream); non-bundled rows keep the
     * v2-#4 metadata.cost_usd_cents Anthropic-derived value.
     *
     * Every row, bundled or not, ALSO carries the call's true list-price cost
     * as `metadata.list_price_cost_millicents`, which the recorder derives from
     * `usage` (model + the token counts, each part at its own rate). That is a
     * second field, not a replacement: the soft cap keeps summing the posted
     * `cost_usd_cents`, and nothing sums the list price yet.
     */
    keySource?: 'header' | 'cached' | 'bundled' | 'fallback' | 'none';
    /**
     * True for the SECOND usage row of a single turn (the #140 read-back).
     *
     * The bundled flat charge is per TURN, not per row — migration 0051 states
     * the invariant ("one row of this type per bundled-LLM-served agent-session
     * turn with a flat $0.10 posted cost") and the customer docs, dashboard and
     * pricing page all promise "a flat $0.10 per agent turn". A read-intent turn
     * posts two rows, so writing the flat amount on both charged the customer
     * $0.20 for one turn: their monthly cap was consumed at 2x and they were
     * hard-402'd after half the turns they were sold, while the turn's own API
     * response still reported 10. The two-row shape is right for BYOK, where
     * each row carries a real upstream cost; for bundled only the first row
     * carries the turn's flat charge and this one posts 0.
     */
    bundledFlatCostAlreadyPosted?: boolean;
  }): Promise<void>;
}

export interface AgentRuntimeDeps {
  decomposer: AgentDecomposer;
  executor: AgentExecutor;
  sessions: AgentSessionsRepo;
  /**
   * Process-wide FALLBACK device told to the planner. Correct only for a session
   * that has neither an attached driftstack session nor a bound profile — i.e.
   * one where nothing has been launched, so there is no real device to name. For
   * every other session this literal is the WRONG device on every turn; see
   * `resolveSessionArchetype`, which supersedes it whenever it can answer.
   */
  archetype: string;
  /**
   * P-15 follow-up (a) — resolves the device the box ACTUALLY launched, from the
   * two ids carried on the agent-session row: the attached driftstack session
   * (authoritative — that row is what the box launched) and, failing that, the
   * bound profile (the common case, since `driftstack_session_id` is an optional
   * create-body field that most sessions leave null).
   *
   * Without it the planner was told `deps.archetype` — one bootstrap literal —
   * for every customer on every turn, so a session running an iPad or an older
   * iPhone was planned against an iPhone 17. The archetype steers viewport,
   * touch geometry and capability assumptions in the prompt, so a wrong value
   * is a silently degraded plan, never an error.
   *
   * ⛔ SCOPED, NOT UNSCOPED. Both ids come off the agent-session row this turn
   * already loaded, and the resolver is wired to the ACCOUNT-SCOPED finder —
   * `findSession(id, accountId)`, never `findSessionUnscoped`, which the
   * `unscoped-finders-admin-only-sweep` guard pins at zero callers because it
   * skips the account check. A cross-account attachment therefore resolves to
   * null and falls back to the literal, rather than reading another account's
   * device. Optional: unwired (direct/test callers) keeps the literal.
   */
  resolveSessionArchetype?: (args: {
    accountId: string;
    driftstackSessionId: string | null;
    profileId: string | null;
  }) => Promise<string | null | undefined>;
  /** Per-owner-account AI turns allowed concurrently across distinct agent
   *  sessions. Manual transcript-only turns do not consume a slot. Default 3. */
  maxConcurrentTurnsPerAccount?: number;
  /**
   * Monotonic milliseconds, for the turn's wall-clock ceiling
   * (MAX_TURN_WALL_CLOCK_MS). Defaults to `performance.now()`. Injected so a test
   * can make a turn "take" four minutes without taking four minutes — and
   * deliberately NOT `RunTurnArgs.now`, which is one fixed instant per turn (the
   * transcript timestamp) and so cannot measure anything.
   */
  nowMs?: () => number;
  /** v2-#4 Q.1.e — optional usage recorder. When wired, AgentRuntime
   *  persists a usage_records row per decompose() call that returns
   *  a `usage` block. */
  usageRecorder?: AgentDecomposerUsageRecorder;
  /**
   * Arc 2 sub-slice 8.3 (v2-#8) — optional transcript event bus.
   * When wired, AgentRuntime publishes every transcript-append to
   * the bus so the SSE endpoint can stream live turns to dashboard
   * subscribers. Omitting the bus is a silent no-op (the runtime
   * still writes to the repo).
   */
  eventBus?: AgentSessionEventBus;
  /**
   * Arc 7 obs.3 — optional metrics registry. When wired, the
   * runtime increments `driftstack_agent_decompose_total{kind}` on
   * every decompose() call (kind = plan / clarify / refuse) so the
   * Grafana dashboard can ratio useful turns against no-op kinds.
   * Best-effort: a registry inc never throws under normal operation
   * (counters validated at registration) but the call site wraps
   * in try/swallow so a stray bug can't break the turn.
   */
  metrics?: {
    inc: (name: string, labels?: Readonly<Record<string, string>>, delta?: number) => void;
  };
  /**
   * W589 — file-06 §Safety guardrail #3: the task-refusal start-gate
   * pattern list (founder/AUP-curated, Tier-3). Screened deterministically
   * BEFORE the LLM decompose; an obvious-abuse match short-circuits to a
   * refuse outcome with NO LLM call + NO token charge. Empty/omitted ⇒ the
   * gate is a no-op (allows everything), so the wiring ships with zero
   * runtime-behavior change until the founder supplies the curated list as
   * pure data. Mechanism + contract: services/task-refusal.ts (W582).
   */
  refusalPatterns?: readonly RefusalPattern[];
  /** W589 — optional structured logger for the task-refusal audit trail
   *  (which rule fired: category + patternId). Omitted ⇒ no audit log; the
   *  gate still works. Wired alongside the founder/AUP pattern list.
   *  `error` is used for the spend-meter loud-log (see the usageRecorder
   *  call site): a final record-write failure must be visible because that
   *  row is the ONLY input to the bundled-LLM monthly soft-cap. */
  logger?: {
    warn?: (obj: Record<string, unknown>, msg: string) => void;
    error?: (obj: Record<string, unknown>, msg: string) => void;
  };
  /**
   * B2 — the cross-process half of Stop (see agent-turn-stop-channel.ts). When
   * wired, every AI turn claims itself there and polls it for a stop recorded
   * by another process; `requestTurnStop` asks it when this process does not
   * hold the turn. Unwired (tests, a single dev process), Stop is answered from
   * this process's own registry, which is the whole truth when it is the only
   * process there is.
   */
  turnStopChannel?: AgentTurnStopChannel;
  /** B2 — how often a running turn polls `turnStopChannel`. Default 1000ms. */
  turnStopPollMs?: number;
}

/** B2 — see {@link AgentRuntimeDeps.turnStopPollMs}. One second is the delay a
 *  customer can wait after pressing Stop without wondering whether it worked; the
 *  cost is one key read per second per running turn. */
export const TURN_STOP_POLL_MS = 1_000;

/** B2 — the most a turn's start waits on its cross-process claim. The claim is a
 *  convenience for a second process; a slow store must not delay the turn. */
const TURN_STOP_CLAIM_DEADLINE_MS = 500;

/** B2 — the most a Stop waits on the cross-process store before answering 503.
 *  The route must answer quickly; a store that has not answered by now is
 *  treated as one that could not be asked, never as "nothing is running". */
export const TURN_STOP_REQUEST_DEADLINE_MS = 1_500;

/** B2 — what {@link AgentRuntime.requestTurnStop} found. */
export type TurnStopRequestOutcome = 'stop_requested' | 'no_turn_running';

/**
 * Billing-integrity hardening — bounded retry for the bundled-LLM cost
 * row. The $0.10/turn `usage_records` row written by `usageRecorder.record`
 * is the ONLY input to `sumMonthlySpendCents`, which is the ONLY enforcement
 * of the monthly soft-cap. A single transient write failure that silently
 * drops the row makes the cap stop advancing → uncapped upstream cost.
 *
 * Design constraint (deliberate): a meter outage must NOT break the
 * customer's chat turn. So the retry is best-effort + bounded, and a
 * final failure is logged LOUDLY (logger.error with accountId + the turn
 * cost) so a silently-stuck cap is visible in alerting rather than
 * surfacing as a 500 to the customer.
 */
const SPEND_RECORD_MAX_ATTEMPTS = 3;
const SPEND_RECORD_RETRY_BASE_MS = 50;

// #140 read-and-report — only read BACK for information-SEEKING tasks. A read-back
// is a 2nd LLM call (+ a bundled cost row), so gate it to tasks that actually want
// an answer ("get the IP", "what's the price"), not pure action/screenshot tasks.
// Conservative keyword match; the decomposer-signalled variant is the robust
// follow-up (a `wantsAnswer` flag on the plan, prompt-eval-gated).
// Exported (additively, no behaviour change) so the agent eval harness can
// report WHICH of the read-back gate's conjuncts blocked an answer. A harness
// that copied this pattern instead would keep naming the old gate after the real
// one moved — confidently wrong about the one thing it exists to explain.
// P5 — WIDENED, because the narrow version was refusing to answer people who
// had plainly asked a question. The measured case: "search X and GIVE ME the
// first result" ran every step, read nothing back, and told the customer
// nothing — `give` was not a token here, and neither was a literal question
// mark. The pattern's job is one question — DID THE CUSTOMER ASK FOR
// INFORMATION BACK? — so it now covers the three ways people write that:
//   (a) a verb aimed at the agent reporting back (get / give / tell / show /
//       summarise / describe / check / verify / count / compare / quote …),
//   (b) an interrogative (what / which / who / whether / does … have …),
//   (c) a literal question mark, which is the cheapest and most reliable signal
//       of all and was not being read at all.
// ⛔ IT MUST STILL SAY NO. "open news.test and take a screenshot" is a pure
// action task and matches nothing here — a second model call on it would be
// money spent to answer a question nobody asked. `check` excludes "check out",
// which is a purchase step, not a request for information.
// ⛔ `confirm` excludes the PURCHASE sense for the same reason `check` excludes
// "check out": "confirm the order" is the customer describing an action, not
// asking to be told something.
export const READ_INTENT_RE =
  /\?|\b(get|give|find|read|extract|scrape|fetch|show|tell|say|list|report|summar\w*|describe|quote|compare|count|verify|confirm(?!\s+(?:the\s+)?(?:purchase|order|payment|checkout|booking|subscription))|check(?!\s*-?\s*out)|look\s?up|lookup|what|whats|which|when|where|who|whether|why|does|do\s+(?:i|we|they|you)|is\s+there|are\s+there|how\s+(?:many|much|long|old|far|big))\b/i;

/**
 * P5 — a URL is not prose, and its punctuation is not the customer's.
 *
 * The `?` alternative above is the cheapest and most reliable "did they ask a
 * question" signal there is — in a SENTENCE. In a URL it is a query-string
 * separator, and a browser-automation task is full of them:
 * "open https://news.test/?utm_source=x and take a screenshot" is a pure action
 * task that the raw pattern reads as a question, which is precisely the cost the
 * pattern's own comment says it must refuse. Every URL-ish token is removed
 * before the test, so the pattern judges what the person WROTE.
 *
 * `READ_INTENT_RE` stays exported unchanged — the eval harness reports the gate
 * by name and must read the live pattern rather than a copy.
 */
const URLISH_RE = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/\S*)?/gi;

export function asksForInformation(message: string): boolean {
  return READ_INTENT_RE.test(message.replace(URLISH_RE, ' '));
}

// #140 — only fire the read-back when the session has enough budget to cover a
// FULL answer call (~MAX_OBSERVATION_CHARS=20k input chars ≈ ~5k tokens +
// ANSWER_MAX_OUTPUT_TOKENS=512). A coarse `> 0` gate let a near-empty balance run
// a full ~5.5k-token call that debitTokens then floored to 0 — a silent
// per-session budget-cap overspend (post-ship audit finding). Below this, skip
// the read-back: the customer still gets the plan result, no overspend.
// Exported additively for the same reason as READ_INTENT_RE above: the eval
// harness reports this gate by name and must read the live floor, not a copy.
export const READBACK_MIN_BUDGET_TOKENS = 6_000;

// ── P1 re-plan bounds ────────────────────────────────────────────────
//
// WHY TWO. The re-plan count bounds the LOOP and the model-call count bounds the
// COST, and they are not the same question: the read-back is a model call that
// is not a re-plan, and a future turn-local call would be another. Deriving one
// from the other would make the cost ceiling drift silently the next time a call
// is added.
//
// ⛔ AND SAY PLAINLY WHAT THIS ONE IS, because it was briefly described as a
// second independent bound and it is not one. `modelCalls` counted the
// decompose and the re-plans only, which made `modelCalls < MAX - 1` and
// `replans < MAX_REPLANS_PER_TURN` the same inequality: deleting the conjunct
// changed nothing and no test could tell the two apart. The read-back now
// increments and checks it too, so the counter is at least HONEST about the
// turn's provider calls — but at today's values (2 re-plans + 1 read-back + the
// first plan = exactly 4) the RE-PLAN ceiling is still what stops the loop and
// this constant never binds first. It is the turn's total-call BUDGET, and what
// keeps it true is a test pinning the maximal turn's call count to it: raise
// MAX_REPLANS_PER_TURN, or add a call anywhere in a turn, and that test fails
// until this number is re-derived. Treat it as a fence, not as a gate.
//
// TWO RE-PLANS. The first covers the common real case by a wide margin — a
// selector that was wrong because the model had not seen the page, fixed by
// looking. A second covers the page that changed under the first re-plan (a
// consent dialog appearing, a redirect). Beyond that the evidence is that the
// model does not know how to do this task, and more attempts are the customer
// paying to watch it fail more slowly.
export const MAX_REPLANS_PER_TURN = 2;
// ── B1 — THE TURN IS A LOOP, AND THIS IS HOW LONG IT MAY RUN ────────────
//
// SIX PLANNER CALLS. A turn now looks, plans as far as it can see, acts and looks
// again, so the number of planning calls is the number of PAGES a task crosses
// plus one. The reference shape — search, result, detail, answer — is FOUR: a
// blind first segment (go there), the search, the result, and the look that says
// "done". A form is three, a sign-in is three or four. Six is those four plus the
// two recoveries MAX_REPLANS_PER_TURN already allows (a consent banner that was
// not there on the last look, a control that moved), because a task that needed
// every recovery should still be able to finish. Beyond six the evidence is that
// the task is either longer than one message should be or is not converging, and
// the honest move is to hand the page back and say so — every extra segment is
// seconds the customer waits and tokens they pay for.
//
// ⚠️ NOT A COMFORTABLE MARGIN, AND SAID SO. In two early live runs (2026-09-18,
// before the prompt told the planner to judge the goal state from the steps
// already run) an easy fixture task reached exactly six planning calls by
// dithering over a page it had already finished. After that prompt change no
// measured turn took more than five. Re-measure the maximum before calling six
// comfortable, and read a turn that hits it as dithering until shown otherwise.
//
// It bounds `continue` segments and failure re-plans TOGETHER (they are the same
// call), while MAX_REPLANS_PER_TURN keeps bounding the failures on their own: a
// model that fails three times running is not rescued by having calls left.
export const MAX_PLANNER_CALLS_PER_TURN = 6;
// SEVEN MODEL CALLS: the planner calls above, and the read-back. The loop stops
// one short of the ceiling so the LAST call is always available to the read-back
// — a turn that spent every call planning and then could not tell the customer
// what it found would have optimised the wrong half.
export const MAX_MODEL_CALLS_PER_TURN = 7;
// A WALL-CLOCK CEILING, because the call ceiling does not bound TIME: six
// segments of eight steps, each with its human pacing and its element waits, is
// minutes. After this long no NEW segment is asked for. The segment in flight is
// never cut off — abandoning a plan halfway leaves dispatched actions in an
// unknown state — so this bounds when the turn stops STARTING work, and the
// read-back may still run after it. Three minutes: past that a customer watching
// a chat has stopped believing it is working, and "here is what I did, say
// continue" is a better message than another minute of steps.
export const MAX_TURN_WALL_CLOCK_MS = 180_000;
// Never START a plan call the remaining budget cannot cover. Same floor and same
// reason as the read-back's: a coarse `> 0` check lets a near-empty balance run
// a full call that the debit then floors at zero, which is a silent per-session
// budget overspend rather than a refusal.
export const REPLAN_MIN_BUDGET_TOKENS = 6_000;

/**
 * P1 — failure categories a re-plan may follow, as an ALLOWLIST.
 *
 * ⛔ THE DIRECTION IS THE SAFETY PROPERTY, exactly as in
 * `REPLAY_SAFE_INTENT_KINDS`. Every category here is one where the step
 * PROVABLY did not take effect — the element was not found, the page did not
 * load, the device refused the parameters, the result was too large to return,
 * the capture failed, the condition was never met. Re-planning from those is
 * safe because the page is in the state the failed step found it in.
 *
 * `unknown` is deliberately ABSENT, and it is the one that matters: it is the
 * outcome-unknown class (a coarse WebDriver or dispatch failure on a click, a
 * submit, a navigation) where the action MAY have applied and the result was
 * lost. Re-planning there would plan against a page we cannot describe, and the
 * new plan could repeat an effect that already happened. `session_error` is
 * absent for a different reason: the box is unhealthy, and a new plan does not
 * make it healthy. A category added later is unsafe by omission.
 *
 * `element_covered` qualifies for the same reason as `element_not_found`: the
 * tap was NOT made — the executor saw the cover before tapping, or the device
 * refused the tap — so the page is as the step found it, and a new look is how
 * the plan finds the banner and closes it. It is not RETRYABLE (the cover is
 * still there), which is a different question from re-plannable.
 *
 * `target_unverified` qualifies on the same ground: the device refused the tap
 * BEFORE touching the page because it could not confirm the tap point, so the
 * page is as the step found it and a new look is safe. Not retryable — the same
 * check on the same page gives the same answer.
 */
const REPLANNABLE_FAILURE_CATEGORIES: ReadonlySet<string> = new Set([
  'element_not_found',
  'page_load_failed',
  'condition_not_met',
  'capture_failed',
  'scroll_failed',
  'invalid_request',
  'result_too_large',
  'element_covered',
  'target_unverified',
]);

/**
 * B1 — why a turn's loop stopped BEFORE the planner said `done`, when every step
 * on the screen is a tick.
 *
 * That last clause is the reason this exists. A turn that stops on a failed step
 * explains itself: the ✗ row is the message. A turn that stops because it ran out
 * of calls, or time, or budget, or noticed it was going in circles, shows the
 * customer a column of green ticks over a task that is NOT finished — exactly the
 * "every step succeeded and nothing was done" failure the loop was built to end,
 * re-created by the loop's own bounds. So each bound has its own sentence.
 *
 * ⛔ CUSTOMER-VISIBLE COPY. No internals: nothing here names a model, a call, a
 * segment, a digest or a limit's number.
 */
export type TurnLoopStopReason =
  | 'planner_call_limit'
  | 'wall_clock'
  | 'budget_floor'
  | 'no_progress'
  | 'repeat_refused'
  | 'planner_unavailable';

export const TURN_LOOP_STOP_SENTENCES: Readonly<Record<TurnLoopStopReason, string>> = {
  planner_call_limit:
    'I did the steps above, but this task needs more steps than I take in one message, so it is not finished yet. Send “continue” and I will carry on from this page.',
  wall_clock:
    'I did the steps above, but this was taking too long for one message, so I stopped before it was finished. Send “continue” and I will carry on from this page.',
  budget_floor:
    'I did the steps above, but there is not enough of this chat’s AI budget left to keep going, so the task is not finished. Start a new chat to carry on.',
  no_progress:
    'I did the steps above, but the page did not change and I was about to try the same thing again, so I stopped rather than go in circles. The task is not finished — tell me what to try differently.',
  repeat_refused:
    'I did the steps above, but my next steps would have repeated an action that already ran, which could do it twice, so I stopped. Check the page, and send “continue” if it is safe to carry on.',
  planner_unavailable:
    'I did the steps above, but could not work out the next ones just now, so the task is not finished. Send “continue” to try again.',
};

/**
 * B2 — what a turn was doing when it observed the customer's Stop. `planning`
 * covers the look before a plan and the plan call itself; `reading_page` and
 * `answering` are the read-back, which only runs after every step has.
 */
export type AgentTurnStopPhase = 'planning' | 'executing' | 'reading_page' | 'answering';

/**
 * B2 — the sentence a stopped turn tells the customer.
 *
 * ⛔ CUSTOMER-VISIBLE COPY, and it has one job: say exactly how far the turn got,
 * so the customer can decide what to do next without guessing. A step that was
 * already running when Stop arrived and did not answer in time is named as
 * UNCONFIRMED — telling someone a submit did not happen when it may have is how
 * it gets submitted twice.
 */
export function stoppedTurnNotice(args: {
  stoppedDuring: AgentTurnStopPhase;
  results: ReadonlyArray<IntentResult>;
  stepsPlanned: number;
}): string {
  const ran = args.results.length;
  if (args.stoppedDuring === 'reading_page' || args.stoppedDuring === 'answering') {
    return 'Stopped before reading the page back, as you asked. The steps above all ran, but I did not answer your question.';
  }
  if (ran === 0) {
    return 'Stopped before any step ran, as you asked. Nothing was done on the page.';
  }
  const total = Math.max(ran, args.stepsPlanned);
  const which = total > ran ? `step ${String(ran)} of ${String(total)}` : `step ${String(ran)}`;
  const last = args.results.at(-1);
  if (last?.kind === 'failure' && last.reason === STOPPED_OUTCOME_UNKNOWN_REASON) {
    return `Stopped during ${which}, as you asked. That step was already running, and I could not confirm whether it happened — check the page before doing it again. Nothing after it was sent, and the task is not finished.`;
  }
  return `Stopped after ${which}, as you asked. The steps above are what ran; nothing after them was sent, and the task is not finished.`;
}

/**
 * B2 — what a model call cut short by Stop is known to have cost.
 *
 * The provider lane reports what the provider counted on the error when it can
 * (`usage`, `tokensConsumed`); this reads it DEFENSIVELY, because an aborted
 * request is the one case where a well-formed accounting block is least
 * guaranteed. ⛔ THE ROW IS NEVER SKIPPED. A call that started may have been
 * billed upstream, and the usage row is the only input to the bundled monthly
 * cap: a customer who could start a turn and stop it for free would be spending
 * Driftstack's key at no cost to themselves. With nothing observable, the row
 * still lands — zero tokens, the session's model — so the turn is counted.
 */
export function abortedCallEvidence(
  err: unknown,
  model: string | undefined,
): { usage: DecomposeUsage; tokensConsumed: number } {
  const record =
    typeof err === 'object' && err !== null ? (err as Record<string, unknown>) : undefined;
  const reported = record?.['usage'];
  const usage: DecomposeUsage =
    typeof reported === 'object' &&
    reported !== null &&
    ((reported as { decomposerKind?: unknown }).decomposerKind === 'claude' ||
      (reported as { decomposerKind?: unknown }).decomposerKind === 'deterministic')
      ? (reported as DecomposeUsage)
      : { decomposerKind: 'claude', ...(model !== undefined ? { model } : {}) };
  const tokens = record?.['tokensConsumed'];
  const tokensConsumed =
    typeof tokens === 'number' && Number.isFinite(tokens) && tokens > 0 ? Math.floor(tokens) : 0;
  return { usage, tokensConsumed };
}

/**
 * B1 — did this run get through its steps? A failed `wait` does not count
 * against it: the executor treats a wait as a best-effort synchronisation hint
 * and carries on past one, so a segment whose only ✗ is a wait DID run, and a
 * planner that said `continue` should be shown the page it produced.
 */
export function segmentRanToItsEnd(run: ExecutorRunResult): boolean {
  if (run.authorityLost === true || run.awaitingConfirmation === true) return false;
  return run.results.every((r) => r.kind === 'success' || r.intent.kind === 'wait');
}

/**
 * B1 — may repeating this intent do something to the SITE a second time?
 *
 * Narrower than {@link intentReplayMayDuplicateEffect}, on purpose, and only for
 * the question the repeat guard asks. That predicate answers "may the EXECUTOR
 * blindly re-send this after an ambiguous failure", where a second scroll or a
 * second pause is a real distortion of what ran. The guard asks something else:
 * "is this new plan about to SUBMIT, BUY or NAVIGATE again". A scroll and a pause
 * cannot, and a loop whose segments each pace themselves like a person emits the
 * same `behavioral_pause` in most of them — refusing a whole segment for that
 * would stop healthy turns to prevent nothing. Navigation and every interaction
 * that acts on an element stay guarded, which is where the duplicate order lives.
 */
function repeatMayDuplicateSiteEffect(intent: AgentIntent): boolean {
  if (intent.kind === 'scroll' || intent.kind === 'behavioral_pause') return false;
  // Scrolling TO an element moves the viewport and nothing else.
  if (intent.kind === 'interact' && intent.action === 'scroll') return false;
  return intentReplayMayDuplicateEffect(intent);
}

/** A navigation target, reduced to what decides where the browser ends up. */
function navigationIdentity(url: string): string {
  try {
    const parsed = new URL(url.trim());
    return `${parsed.host.toLowerCase()}${parsed.pathname.replace(/\/+$/, '')}${parsed.search}`;
  } catch {
    return url.trim().toLowerCase();
  }
}

/**
 * The elements a selector may address, reduced to what identifies them.
 *
 * ⛔ WHY NOT THE SELECTOR STRING. `#send`, `button#send` and `form #send.primary`
 * are one button, and a guard that compares the strings lets the second spelling
 * tap it again. An id is unique in a document, so a branch whose LAST compound
 * carries one is that id and nothing else. Everything else is compared as
 * written, whitespace and case folded — folding case can only make two selectors
 * MORE alike, which is the safe direction for a guard against doing it twice.
 * A comma list is every branch: the device takes whichever matches first, so two
 * lists that share a branch may be the same element.
 */
function selectorTargets(selector: string | undefined): string[] {
  if (selector === undefined) return [''];
  const branches: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';
  for (const ch of selector) {
    if (quote !== null) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '[' || ch === '(') depth += 1;
    else if (ch === ']' || ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) {
      branches.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  branches.push(current);
  return branches
    .map((branch) => branch.replace(/\s+/g, ' ').trim().toLowerCase())
    .filter((branch) => branch.length > 0)
    .map((branch) => {
      const withoutAttributes = branch.replace(/\[[^\]]*\]/g, '');
      const lastCompound = withoutAttributes.split(/[\s>+~]+/).at(-1) ?? '';
      const id = /#([-\w]+)/.exec(lastCompound);
      return id !== null ? `#${id[1] ?? ''}` : branch;
    });
}

/**
 * B1 — would running `b` do to the site what `a` already did?
 *
 * ⛔ EFFECT IDENTITY, NOT DEEP EQUALITY — and the difference was a double submit.
 * A tap's `value` is only the label the device uses to confirm it found the right
 * element; it is optional and a planner words it differently from one segment to
 * the next. Compared by deep equality, `tap #send "Send"` and `tap #send` were two
 * different steps, so the guard below let the second one through and the form
 * went twice in one customer message with no notice. So a tap is its TARGET. A
 * `type` is its target AND its text (typing different text is a different act;
 * typing the same text again doubles what is in the box), and a key press is its
 * key and its target. A kind this does not know is compared whole.
 */
export function sameSiteEffect(
  a: AgentIntent,
  b: AgentIntent,
  /** What the device said `a` landed on (its canonical selectors), when known. */
  aTargets?: ReadonlyArray<string>,
  /** The same for `b`. */
  bTargets?: ReadonlyArray<string>,
): boolean {
  if (a.kind === 'navigate' && b.kind === 'navigate') {
    return navigationIdentity(a.url) === navigationIdentity(b.url);
  }
  if (a.kind !== 'interact' || b.kind !== 'interact') return isDeepStrictEqual(a, b);
  if (a.action !== b.action) return false;
  if (a.action === 'type' && (a.value ?? '') !== (b.value ?? '')) return false;
  if (
    a.action === 'press' &&
    (a.value ?? '').trim().toLowerCase() !== (b.value ?? '').trim().toLowerCase()
  ) {
    return false;
  }
  const targetsOfB = new Set(effectTargets(b.selector, bTargets));
  return effectTargets(a.selector, aTargets).some((target) => targetsOfB.has(target));
}

/**
 * Every identity a tap's element answers to: the selector as the plan spelled
 * it, and — when the device identified the element before the tap — the
 * device's CANONICAL selector for what the tap lands on.
 *
 * ⛔ WHY THE DEVICE'S NAME. An element with an id is one string however it is
 * spelled ({@link selectorTargets}); one WITHOUT an id is not. `form > button.primary`
 * and `[aria-label="Send"]` are one button, and compared as written they were two
 * steps, so the second spelling could send the form again. The device resolves
 * both to one canonical selector, and that is compared first.
 *
 * ⛔ WHY STILL THE SPELLING TOO. A union can only make two taps MORE alike —
 * the safe direction for a guard against doing something twice. Dropping the
 * spelling would let through a repeat the guard refuses today whenever the
 * device's answer is missing or differs (a look that timed out, an older
 * device), which is exactly when there is least evidence.
 */
function effectTargets(
  selector: string | undefined,
  deviceTargets: ReadonlyArray<string> | undefined,
): string[] {
  const planned = selectorTargets(selector);
  if (deviceTargets === undefined || deviceTargets.length === 0) return planned;
  // Prefixed so a canonical selector can never collide with a planner branch
  // that merely LOOKS like one (the device's `div > button` is not the same
  // claim as a plan that wrote `div > button`, which may match elsewhere).
  const canonical = deviceTargets
    .map((target) => target.replace(/\s+/g, ' ').trim())
    .filter((target) => target.length > 0)
    .map((target) => `device:${target}`);
  return [...canonical, ...planned];
}

/** Two steps that are the same step: the same site effect, or — for a step that
 *  has none — the same step as written. */
function sameStep(a: AgentIntent, b: AgentIntent): boolean {
  return repeatMayDuplicateSiteEffect(a) || repeatMayDuplicateSiteEffect(b)
    ? sameSiteEffect(a, b)
    : isDeepStrictEqual(a, b);
}

/** Two plans that are the same plan, step for step. */
export function samePlan(a: ReadonlyArray<AgentIntent>, b: ReadonlyArray<AgentIntent>): boolean {
  return (
    a.length === b.length &&
    a.every((intent, i) => {
      const other = b[i];
      return other !== undefined && sameStep(intent, other);
    })
  );
}

/** The steps a turn has run so far, as the planner is told them — the same
 *  bounded, credential-scrubbed `✓ / ✗` lines the transcript will carry. */
export function describeStepsSoFar(run: ExecutorRunResult): string[] {
  return runResultToTranscriptEntry(run, '')
    .body.split('\n')
    .filter((line) => line.length > 0)
    .map((line) => (line.length > 240 ? `${line.slice(0, 240)}…` : line));
}

/**
 * P1 — may the turn look at the page and plan the remainder?
 *
 * Reads the LAST result, because that is the one that stopped the run. A
 * failure with NO diagnosis at all is a MAPPING refusal: the intent never
 * reached the device, so nothing happened and re-planning is the correct
 * response — it is also the exact shape of the measured production failure
 * where the model emits a Playwright selector that CSS cannot express.
 */
export function isReplannableFailure(run: ExecutorRunResult): boolean {
  const last = run.results.at(-1);
  if (last === undefined || last.kind !== 'failure') return false;
  if (last.diagnosis === undefined) return true;
  return REPLANNABLE_FAILURE_CATEGORIES.has(last.diagnosis.category);
}

/**
 * P1 — one customer-safe sentence naming where the previous plan stopped, for
 * the re-plan request. Built from the executor's own reason, which is already
 * bounded and redacted by `intentResultToCustomer`; nothing new is exposed.
 */
export function describeExecutorStop(run: ExecutorRunResult): string {
  const index = run.results.length - 1;
  const last = run.results.at(-1);
  if (last === undefined || last.kind !== 'failure') return 'the previous plan did not complete';
  return `step ${String(index + 1)} (${last.intent.kind}) failed: ${last.reason}`;
}

/**
 * P1 — one run of the plan, then the re-planned remainder, as a single result.
 *
 * `ok` and `awaitingConfirmation` come from the LAST run because they describe
 * where the turn ended up; `results` are concatenated because they describe what
 * happened, and the customer needs to see the steps that failed as well as the
 * ones that worked. ⛔ A merge that dropped the failed prefix would report a
 * clean run of a plan that is not the plan that ran.
 */
export function mergeExecutorRuns(
  first: ExecutorRunResult,
  second: ExecutorRunResult,
): ExecutorRunResult {
  return {
    results: [...first.results, ...second.results],
    ok: second.ok,
    // P1 — the merged result carries a failure row AND, when the re-plan
    // finished the job, `ok: true`. That combination is impossible for a single
    // run (`execute()` derives ok from its own results), so the transcript
    // builder cannot read "a failure is present" as "the plan halted" any more.
    // Without this a recovered turn wrote "(plan halted on failure)" into the
    // history the NEXT turn's model reads — telling it the last turn stopped
    // when it had completed, which is the defensive planning P1 exists to end.
    ...(second.ok && first.results.some((r) => r.kind === 'failure')
      ? { recoveredAfterReplan: true }
      : {}),
    ...(second.awaitingConfirmation === true ? { awaitingConfirmation: true } : {}),
    ...(second.authorityLost === true ? { authorityLost: true } : {}),
    // B2 — the run that honoured Stop is always the LAST one: nothing runs after it.
    ...(second.stopped === true ? { stopped: true } : {}),
    // B1 — likewise a run the repeat guard stopped: nothing ran after it.
    ...(second.repeatRefused !== undefined ? { repeatRefused: second.repeatRefused } : {}),
  };
}

/**
 * One step that SUCCEEDED earlier in this turn, with the page on either side of
 * the segment it ran in — as the planner was shown it (`undefined`: planned
 * blind, or the look failed).
 */
export interface RanStep {
  intent: AgentIntent;
  /** What the device said the step landed on (ExecutorRunResult.tapTargets):
   *  its canonical selectors, compared before the plan's spelling. */
  targets?: ReadonlyArray<string>;
  /** The look the segment that ran this step was planned against. */
  pageBefore: string | undefined;
  /** The first look after that segment finished. */
  pageAfter: string | undefined;
}

/**
 * How many times one site-effecting step may run in a turn. Each run past the
 * first already has to be on a page that has moved (see {@link admitSegment});
 * this is the backstop for a page that moves EVERY time — a basket counter, a
 * feed — under a planner that has stopped converging. Three is a three-page
 * wizard sharing one Continue button, or "next page" twice; past that the turn
 * hands back and the customer says whether to carry on.
 */
export const MAX_RUNS_OF_ONE_STEP_PER_TURN = 3;

// ⛔ DISCRIMINATED ON `admitted`, NOT `kind`. Every `kind` string literal in
// this file is read by the SDK-parity pin as a turn-result kind a customer can
// receive, so an internal verdict keyed on `kind` read as a new public kind.
export type SegmentAdmission =
  | { admitted: true; intents: AgentIntent[] }
  | { admitted: false; reason: 'no_progress' | 'repeat_refused' };

/**
 * B1 — the part of a newly planned segment that may run, or why none of it may.
 *
 * ⛔ THE HAZARD THIS EXISTS FOR. A planner asked to carry on routinely returns the
 * WHOLE task, prefix included — it is describing the job, not the remainder.
 * Running that as returned re-taps the button that already worked. The measured
 * shape: a plan ending in a `wait` that times out does NOT halt the executor (a
 * wait is best-effort), so the run ends with a click already landed; a re-plan of
 * `[navigate, tap #send, wait longer]` then sends twice. Steps are compared by
 * what they DO ({@link sameSiteEffect}), never by how they are spelled.
 *
 * AFTER A FAILURE (`replan`) — unchanged in shape from P1, and unconditional,
 * because the page is not known to have moved:
 *  1. Drop the LEADING steps that already succeeded, in order.
 *  2. If a site-effecting step that already succeeded survives further in,
 *     REFUSE the segment. A refused re-plan costs a turn that stops; an accepted
 *     one can cost a second order.
 *
 * AFTER A SUCCESS (`continue`) — where the planner has been SHOWN what ran:
 *  1. A leading repeat is dropped ONLY when it re-describes everything that ran
 *     (nothing site-effecting that succeeded is left unmatched). ⛔ A partial
 *     trim is wrong here, and was a defect: `[navigate /contact, …]` three
 *     segments after the turn left /contact is a deliberate trip BACK, and
 *     dropping the navigate ran the rest of the segment on the page the planner
 *     was leaving.
 *  2. A repeated step is what a person does all the time — Continue on the
 *     second page of a sign-in, "next page", Enter in a different box, a consent
 *     banner that came back, a trip back to the list, and on a form built from
 *     one template, tap the field and tap Continue again on the next page — and
 *     refusing those made the customer type "continue" in the middle of a form.
 *     EACH repeated step may run only when the page has MOVED since every
 *     earlier run of it:
 *       · the page in front of the planner is not the page any earlier run was
 *         planned against (same page, same step → going in circles), and
 *       · for a navigate, is not the page that navigate led to either;
 *       · for anything else, every earlier run has a known page to compare with
 *         — a step planned blind cannot be shown to have moved anything;
 *       · it is not a `type` (the same text into the same box is never the next
 *         thing; it doubles what is there), and
 *       · it has not already run {@link MAX_RUNS_OF_ONE_STEP_PER_TURN} times.
 *     ⛔ EACH STEP, NOT A COUNT. This used to refuse any segment repeating TWO
 *     steps as "the job being re-described". Measured live (2026-09-18): a
 *     planner on page 2 of a two-page quote form planned [tap the field, type
 *     the new postcode, tap Continue] — the same field and button as page 1,
 *     on a page that had moved — and was refused mid-form. The re-description
 *     that rule was for is still refused step by step: the same text typed
 *     again is refused, a navigate back to where the turn already is is
 *     circles, and anything on an unchanged page is circles.
 *     What this cannot see: a page that changed AND still offers the same
 *     one-shot control (an inline "sent" notice above a live form). There the
 *     planner, which has been told the step ran and shown the notice, is the
 *     only judge — and the purchase-shaped cases are behind the confirmation
 *     gate regardless, which no segment ever carries an approval past.
 */
export function admitSegment(args: {
  cause: 'continue' | 'replan';
  planned: ReadonlyArray<AgentIntent>;
  ran: ReadonlyArray<RanStep>;
  pageNow: string | undefined;
}): SegmentAdmission {
  const { cause, planned, ran, pageNow } = args;
  let trimmed = 0;
  while (trimmed < planned.length && trimmed < ran.length) {
    const next = planned[trimmed];
    const done = ran[trimmed];
    if (next === undefined || done === undefined || !sameStep(next, done.intent)) break;
    trimmed += 1;
  }
  const redescribedEverything = ran
    .slice(trimmed)
    .every((done) => !repeatMayDuplicateSiteEffect(done.intent));
  // Nor is a segment that is NOTHING BUT a repeat a re-description with its new
  // part missing: `[tap #next]` after `[tap #next]` is "next page" again, and the
  // page decides that below.
  if (cause === 'continue' && (!redescribedEverything || trimmed === planned.length)) {
    trimmed = 0;
  }
  const suffix = planned.slice(trimmed);
  if (suffix.length === 0) return { admitted: false, reason: 'repeat_refused' };

  const repeats = suffix.filter(
    (intent) =>
      repeatMayDuplicateSiteEffect(intent) &&
      ran.some((done) => sameSiteEffect(done.intent, intent, done.targets)),
  );
  if (repeats.length === 0) return { admitted: true, intents: [...suffix] };
  if (cause === 'replan') return { admitted: false, reason: 'repeat_refused' };
  for (const repeat of repeats) {
    const refused = repeatRefusedOnThisPage(repeat, ran, pageNow);
    if (refused !== null) return { admitted: false, reason: refused };
  }
  return { admitted: true, intents: [...suffix] };
}

/** Rule 2 of {@link admitSegment}, for one repeated step: null when the page
 *  has moved since every earlier run of it, else why it may not run. */
function repeatRefusedOnThisPage(
  repeat: AgentIntent,
  ran: ReadonlyArray<RanStep>,
  pageNow: string | undefined,
  repeatTargets?: ReadonlyArray<string>,
): 'no_progress' | 'repeat_refused' | null {
  const earlier = ran.filter((done) =>
    sameSiteEffect(done.intent, repeat, done.targets, repeatTargets),
  );
  if (pageNow !== undefined && earlier.some((done) => done.pageBefore === pageNow)) {
    return 'no_progress';
  }
  if (repeat.kind === 'navigate') {
    if (pageNow !== undefined && earlier.some((done) => done.pageAfter === pageNow)) {
      return 'no_progress';
    }
  } else if (
    (repeat.kind === 'interact' && repeat.action === 'type') ||
    earlier.some((done) => done.pageBefore === undefined)
  ) {
    return 'repeat_refused';
  }
  if (pageNow === undefined || earlier.length >= MAX_RUNS_OF_ONE_STEP_PER_TURN) {
    return 'repeat_refused';
  }
  return null;
}

/**
 * B1 — {@link admitSegment}'s question again, for ONE tap, at the moment the
 * device has said which element it lands on (ExecuteArgs.repeatGuard).
 *
 * Admission compares the plan's spellings, so it cannot see that a tap in this
 * segment is the id-less button an earlier segment already pressed under another
 * name. This compares by the device's canonical selector as well, against every
 * step that succeeded in an EARLIER segment, and applies the same rules: after a
 * failure any repeat is refused; after a success a repeat may run only on a page
 * that has moved. It can only refuse more than admission did — a step admission
 * already let through as a repeat gets the same verdict here, because the page
 * rules are the same function.
 */
export function repeatRefusedAtTarget(args: {
  cause: 'continue' | 'replan';
  intent: AgentIntent;
  targets: ReadonlyArray<string>;
  ran: ReadonlyArray<RanStep>;
  pageNow: string | undefined;
}): 'no_progress' | 'repeat_refused' | null {
  const { cause, intent, targets, ran, pageNow } = args;
  if (!repeatMayDuplicateSiteEffect(intent)) return null;
  if (!ran.some((done) => sameSiteEffect(done.intent, intent, done.targets, targets))) {
    return null;
  }
  if (cause === 'replan') return 'repeat_refused';
  return repeatRefusedOnThisPage(intent, ran, pageNow, targets);
}

// Public message turns rewrite one application-encrypted JSONB transcript on
// every append. Bound both axes before any browser work: entry count stops a
// high-rate stream of tiny messages; serialized bytes stop fewer worst-case
// 8KiB user messages or model-rich plan entries. 256 entries accommodates the
// repository's documented ~100-message session expectation (AI turns normally
// consume two entries). The byte ceiling is plaintext JSON; encrypted/base64
// storage has constant-factor overhead but remains bounded by it.
export const AGENT_TRANSCRIPT_MAX_ENTRIES = 256;
export const AGENT_TRANSCRIPT_MAX_SERIALIZED_BYTES = 1024 * 1024;
const AGENT_TURN_OUTPUT_RESERVE_BYTES = 128 * 1024;

/**
 * The ceilings a SEEDED transcript (continue_from_agent_session_id) must fit
 * UNDER, exported from here so they cannot drift from the admission preflight
 * above — these are the preflight's own numbers, minus what one full AI turn
 * reserves (3 entries; the 128KiB output reserve plus the largest admissible
 * 8,000-char user message entry, rounded up to 16KiB for JSON framing).
 *
 * ⛔ Why not seed to AGENT_TRANSCRIPT_MAX_ENTRIES: the preflight CLOSES a
 * session it cannot reserve capacity in — it does not trim. A seed at the raw
 * ceiling produced a session whose very first message closed it with
 * 'transcript-limit', i.e. "continue this session" manufactured a dead session.
 * And entries alone are not the ceiling: the preflight also enforces the byte
 * ceiling, which a 256-entry clamp never looked at.
 */
export const AGENT_SEED_MAX_ENTRIES = AGENT_TRANSCRIPT_MAX_ENTRIES - 3;
export const AGENT_SEED_MAX_SERIALIZED_BYTES =
  AGENT_TRANSCRIPT_MAX_SERIALIZED_BYTES - AGENT_TURN_OUTPUT_RESERVE_BYTES - 16 * 1024;

// #130 — reconstruct the plan the customer is APPROVING from the transcript so a
// consequential-approval turn re-runs the reviewed plan instead of re-decomposing.
// Re-decomposing on approval would (a) charge a SECOND flat $0.10 bundled row + burn
// 2x the token budget for ONE logical task, and (b) let the non-deterministic re-plan
// DRIFT from what the customer reviewed (a same-phrase/different-target action could
// be greenlit without re-review — the known v1.1 gate limitation, now live-reachable).
// Plan turns persist their structured `intents` and exact halted index on the
// transcript entry (see the plan-path `planEntry`). Resume is deliberately bound
// to the IMMEDIATELY preceding agent entry and its explicit
// `awaitingConfirmation` marker. Scanning backward to any structured plan would
// replay a completed/stale plan; replaying the full marked plan would double every
// already-successful prefix action. Forwarding a grant when no marked plan exists
// would let a caller pre-authorize a newly decomposed action without ever seeing
// the confirmation halt. Returned as a plan-kind result with tokensConsumed 0 and
// NO usage, so the runtime writes no cost row + no token debit (the resume is free).
// Returns null for a fresh, completed, stale, legacy-without-index, or malformed
// plan; that fail-closed path re-decomposes and requires confirmation again.
function reconstructHaltedPlan(
  transcript: ReadonlyArray<TranscriptEntry>,
): Extract<DecomposeResult, { kind: 'plan' }> | null {
  // runTurn appends the current approval user entry before reaching here, so
  // the only plan it may authorize is exactly one entry earlier.
  const pending = transcript.at(-2);
  const intents = pending?.intents;
  const resumeFrom = pending?.resumeFromIntentIndex;
  if (
    pending?.role !== 'agent' ||
    pending.awaitingConfirmation !== true ||
    intents === undefined ||
    intents.length === 0 ||
    !Number.isSafeInteger(resumeFrom) ||
    resumeFrom === undefined ||
    resumeFrom < 0 ||
    resumeFrom >= intents.length
  ) {
    return null;
  }
  return { kind: 'plan', intents: intents.slice(resumeFrom), tokensConsumed: 0 };
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class AgentRuntime {
  // One browser plan at a time per agent session. The production app owns one
  // singleton runtime in one systemd process, so an in-process set is the exact
  // current execution boundary. Reject instead of queueing: an API burst must
  // not become an unbounded chain of stale natural-language tasks. Different
  // session ids remain independent up to the owner-account ceiling below. A
  // horizontally scaled API must promote both contracts to distributed locks;
  // per-instance bounding still caps each process's own LLM/worker fan-out.
  private readonly activeTurnSessionIds = new Set<string>();
  private readonly activeTurnAccountCounts = new Map<string, number>();
  private readonly maxConcurrentTurnsPerAccount: number;
  // B2 — the running AI turn of each session, and the controller that stops it.
  // Entered in the same synchronous block that takes the session's turn slot and
  // removed in the same `finally` that frees it, so "is a turn running here" and
  // "can Stop reach it" can never disagree. Manual-mode notes are not entered:
  // they only append a line, and there is nothing in them to stop.
  private readonly runningTurns = new Map<
    string,
    { turnId: string; controller: AbortController }
  >();
  // B2 — requests admitted for each session whose turn may not have registered
  // above yet (see AgentTurnStopWindow). A Set per session because two requests
  // for one session can both be in their preflight; the one that loses the slot
  // ends `turn-in-progress` whatever its window says.
  private readonly openStopWindows = new Map<string, Set<AbortController>>();
  private readonly stopWindowControllers = new WeakMap<AgentTurnStopWindow, AbortController>();

  constructor(private readonly deps: AgentRuntimeDeps) {
    const limit = deps.maxConcurrentTurnsPerAccount ?? 3;
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error('maxConcurrentTurnsPerAccount must be a positive safe integer');
    }
    this.maxConcurrentTurnsPerAccount = limit;
  }

  private nowMs(): number {
    return (this.deps.nowMs ?? (() => performance.now()))();
  }

  /**
   * B2 — ask the running turn of `agentSessionId` to stop. Returns at once; it
   * REQUESTS the stop and does not wait for the turn to wind down (the turn
   * reports how it ended on its own response, which is what frees the chat).
   *
   * Idempotent: asking twice aborts an already-aborted controller, and asking
   * when nothing is running says so. The caller has already decided the asker
   * may stop this session — this method only finds the turn.
   *
   * Throws when this process does not hold the turn AND the cross-process store
   * cannot be asked: "I could not find out" must not be reported as "nothing is
   * running", which is the silent ignore this exists to prevent.
   */
  async requestTurnStop(agentSessionId: string): Promise<TurnStopRequestOutcome> {
    let found = false;
    const local = this.runningTurns.get(agentSessionId);
    if (local !== undefined) {
      local.controller.abort();
      found = true;
    }
    // A request admitted before this Stop whose turn has not registered yet.
    // Aborting its window is what makes Stop-right-after-Send stop the turn.
    const pending = this.openStopWindows.get(agentSessionId);
    if (pending !== undefined && pending.size > 0) {
      for (const controller of pending) controller.abort();
      found = true;
    }
    if (found) return 'stop_requested';
    const channel = this.deps.turnStopChannel;
    if (channel === undefined) return 'no_turn_running';
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const requested = await Promise.race([
        channel.requestStop(agentSessionId),
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => {
            reject(new Error('the shared turn store did not answer in time'));
          }, TURN_STOP_REQUEST_DEADLINE_MS);
        }),
      ]);
      return requested ? 'stop_requested' : 'no_turn_running';
    } finally {
      if (deadline !== undefined) clearTimeout(deadline);
    }
  }

  /**
   * B2 — open the stop window for a request the route has just admitted for
   * `agentSessionId` (see {@link AgentTurnStopWindow}). Synchronous, so there is
   * no await between admission and the window. Pass it to `runTurn` as
   * `stopWindow`, and close it in a `finally` once the request is answered.
   *
   * Local to this process: a Stop that lands on another process while this
   * request is still in its preflight finds no claim there yet. The desktop app
   * covers that by asking again while its own request is still unanswered.
   */
  openTurnStopWindow(agentSessionId: string): AgentTurnStopWindow {
    const controller = new AbortController();
    let set = this.openStopWindows.get(agentSessionId);
    if (set === undefined) {
      set = new Set();
      this.openStopWindows.set(agentSessionId, set);
    }
    set.add(controller);
    const window: AgentTurnStopWindow = {
      signal: controller.signal,
      close: () => {
        const current = this.openStopWindows.get(agentSessionId);
        if (current === undefined) return;
        current.delete(controller);
        if (current.size === 0) this.openStopWindows.delete(agentSessionId);
      },
    };
    this.stopWindowControllers.set(window, controller);
    return window;
  }

  /**
   * B2 — make this turn reachable from other processes: claim it in the shared
   * store, and poll that store for a stop recorded against it. Returns the undo.
   * Best-effort throughout — a store that is slow or down costs cross-process
   * Stop, never the turn, and a Stop on this process still works.
   */
  private async watchForRemoteStop(
    agentSessionId: string,
    turnId: string,
    controller: AbortController,
  ): Promise<() => Promise<void>> {
    const channel = this.deps.turnStopChannel;
    if (channel === undefined) return () => Promise.resolve();
    const warn = (event: string, err: unknown): void => {
      try {
        this.deps.logger?.warn?.(
          {
            component: 'agent-runtime',
            event,
            agent_session_id: agentSessionId,
            err: err instanceof Error ? err.message : String(err),
          },
          'cross-process stop is unavailable for this turn; a stop on this process still works',
        );
      } catch {
        /* logging is best-effort */
      }
    };
    let deadline: ReturnType<typeof setTimeout> | undefined;
    // Kept, so the release below runs only once the claim has settled: a claim
    // that lands after its deadline would otherwise outlive a release sent
    // before it, and answer "a turn is running" for fifteen minutes.
    const claimed = channel.claim(agentSessionId, turnId).then(
      () => undefined,
      (err: unknown) => {
        warn('turn_stop_claim_failed', err);
      },
    );
    try {
      await Promise.race([
        claimed,
        new Promise<void>((resolve) => {
          deadline = setTimeout(resolve, TURN_STOP_CLAIM_DEADLINE_MS);
        }),
      ]);
    } finally {
      if (deadline !== undefined) clearTimeout(deadline);
    }
    let polling = false;
    const poll = setInterval(() => {
      if (polling || controller.signal.aborted) return;
      polling = true;
      channel
        .stopRequested(agentSessionId, turnId)
        .then((requested) => {
          if (requested) controller.abort();
        })
        .catch(() => undefined)
        .finally(() => {
          polling = false;
        });
    }, this.deps.turnStopPollMs ?? TURN_STOP_POLL_MS);
    poll.unref();
    return async () => {
      clearInterval(poll);
      const released = claimed
        .then(() => channel.release(agentSessionId, turnId))
        .catch((err: unknown) => {
          warn('turn_stop_release_failed', err);
        });
      // Awaited, bounded, while the turn still holds its slot: a Stop that
      // arrives after the turn has answered must find no claim and be told
      // nothing is running. A store slower than the bound costs only that —
      // the release still lands, and the turn's answer is not held for it.
      let bound: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          released,
          new Promise<void>((resolve) => {
            bound = setTimeout(resolve, TURN_STOP_CLAIM_DEADLINE_MS);
          }),
        ]);
      } finally {
        if (bound !== undefined) clearTimeout(bound);
      }
    };
  }

  private async sessionIsActive(sessionId: string): Promise<boolean> {
    return (await this.deps.sessions.get(sessionId))?.status === 'active';
  }

  private async authorityStillCurrent(
    sessionId: string,
    admission: AgentTurnAdmission,
  ): Promise<boolean> {
    try {
      const current = await this.deps.sessions.getAuthoritySnapshot(sessionId);
      return current !== null && agentTurnAdmissionMatchesSnapshot(admission, current);
    } catch {
      // Authority storage is a safety dependency. A read failure must stop new
      // provider/browser work instead of silently treating the lane as valid.
      return false;
    }
  }

  private async interruptedTurnResult(
    sessionId: string,
    fallback: AgentSessionRecord,
    phase: Extract<RunTurnResult, { kind: 'ai-control-unavailable' }>['phase'],
    evidence: Pick<
      Extract<RunTurnResult, { kind: 'ai-control-unavailable' }>,
      'usage' | 'tokensConsumed' | 'executor'
    > = {},
  ): Promise<
    | Extract<RunTurnResult, { kind: 'session-closed' }>
    | Extract<RunTurnResult, { kind: 'ai-control-unavailable' }>
  > {
    let current: AgentSessionRecord;
    try {
      current = (await this.deps.sessions.get(sessionId)) ?? fallback;
    } catch {
      current = fallback;
    }
    if (current.status !== 'active') {
      return {
        kind: 'session-closed',
        reason: current.closedReason ?? `session ${current.status}`,
        session: current,
        ...evidence,
      };
    }
    return { kind: 'ai-control-unavailable', phase, session: current, ...evidence };
  }

  private async appendTranscriptIfAuthorityRevision(
    sessionId: string,
    admission: AgentTurnAdmission,
    entry: TranscriptEntry,
  ): Promise<AgentSessionRecord | null> {
    return this.deps.sessions.appendTranscriptIfAuthorityRevision(
      sessionId,
      admission.authority.revision,
      entry,
    );
  }

  private async debitTokensIfActive(
    sessionId: string,
    tokens: number,
  ): Promise<AgentSessionRecord | null> {
    const activeOnly = (
      this.deps.sessions as Partial<Pick<AgentSessionsRepo, 'debitTokensIfActive'>>
    ).debitTokensIfActive;
    if (activeOnly !== undefined) return activeOnly.call(this.deps.sessions, sessionId, tokens);
    if (!(await this.sessionIsActive(sessionId))) return null;
    return this.deps.sessions.debitTokens(sessionId, tokens);
  }

  /**
   * P1 — read the page for a RE-PLAN. Best-effort: perceiving improves the next
   * plan, it is not a precondition for making one, so an executor that cannot
   * observe, or an observation that fails, simply re-plans blind — which is
   * still strictly better than stopping, because the model at least learns which
   * step failed and why.
   */
  private async observeForReplan(
    sessionId: string,
    shouldContinue: () => Promise<boolean>,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    const observeDigest = this.deps.executor.observeDigest?.bind(this.deps.executor);
    if (observeDigest === undefined) return undefined;
    try {
      return (await observeDigest(sessionId, shouldContinue, signal)) ?? undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * P1 — account for a decompose call that is NOT the turn's first.
   *
   * ⛔ EVERY ITERATION RECORDS ITS OWN ROW. `sumMonthlySpendCents` is the sole
   * enforcement of the bundled-LLM monthly cap and it sums exactly these rows,
   * so a re-plan whose provider call settled but whose row was skipped would
   * make the cap stop advancing while real upstream cost accrued. The flat
   * bundled per-turn charge was already posted by the first decompose row, so
   * this one is marked as such — the turn is charged once, the usage is recorded
   * every time, which is the same split the read-back row already uses.
   */
  private async accountForExtraDecompose(
    session: AgentSessionRecord,
    driftstackSessionId: string | null,
    decomposed: DecomposeResult,
    args: RunTurnArgs,
  ): Promise<void> {
    try {
      this.deps.metrics?.inc(METRIC_NAMES.agentDecomposeTotal, { result_kind: decomposed.kind });
    } catch {
      // Swallow; metrics are best-effort.
    }
    if (this.deps.usageRecorder === undefined || decomposed.usage === undefined) return;
    await this.recordUsageRowWithRetry(
      this.deps.usageRecorder,
      {
        accountId: session.accountId,
        driftstackSessionId,
        agentSessionId: session.id,
        decomposeResultKind: decomposed.kind,
        usage: decomposed.usage,
        tokensConsumed: decomposed.tokensConsumed,
        now: args.now ?? new Date(),
        ...(args.keySource !== undefined ? { keySource: args.keySource } : {}),
        bundledFlatCostAlreadyPosted: true,
      },
      { accountId: session.accountId, agentSessionId: session.id, label: 'replan' },
    );
  }

  /**
   * B2 — account for a model call the customer's Stop cut short: its usage row
   * (never skipped — see {@link abortedCallEvidence}) and its token debit.
   * Returns the debited session, or null when there was nothing to debit or the
   * debit could not land. Never throws: by the time a stop is being wound down
   * the customer is owed the stopped ending, not a storage error.
   *
   * `flatChargeAlreadyPosted` is false only for a turn's FIRST call, whose row
   * carries the bundled per-turn price exactly as a completed first call's does.
   */
  private async accountForAbortedCall(a: {
    session: AgentSessionRecord;
    driftstackSessionId: string | null;
    evidence: { usage: DecomposeUsage; tokensConsumed: number };
    args: RunTurnArgs;
    label: 'decompose' | 'replan' | 'readback';
    flatChargeAlreadyPosted: boolean;
  }): Promise<AgentSessionRecord | null> {
    if (this.deps.usageRecorder !== undefined) {
      await this.recordUsageRowWithRetry(
        this.deps.usageRecorder,
        {
          accountId: a.session.accountId,
          driftstackSessionId: a.driftstackSessionId,
          agentSessionId: a.session.id,
          // What the settled-error path records for a call no plan came out of;
          // the read-back row keeps the kind its completed twin writes.
          decomposeResultKind: a.label === 'readback' ? 'plan' : 'refuse',
          usage: a.evidence.usage,
          tokensConsumed: a.evidence.tokensConsumed,
          now: a.args.now ?? new Date(),
          ...(a.args.keySource !== undefined ? { keySource: a.args.keySource } : {}),
          ...(a.flatChargeAlreadyPosted ? { bundledFlatCostAlreadyPosted: true } : {}),
        },
        { accountId: a.session.accountId, agentSessionId: a.session.id, label: a.label },
      );
    }
    if (a.evidence.tokensConsumed <= 0) return null;
    try {
      return await this.debitTokensIfActive(a.session.id, a.evidence.tokensConsumed);
    } catch {
      return null;
    }
  }

  /**
   * B2 — end a turn the customer stopped.
   *
   * ONE agent transcript entry, published under the same authority fence as
   * every other entry this turn writes, saying what ran — so the next turn's
   * planner reads an unfinished task, not a finished one, and never a step that
   * did not happen. The steps come from the executor as they SETTLED, including
   * a step that was running when Stop arrived. `intents` on the entry are the
   * steps that ran, not the ones that were planned: a recipe built from this turn
   * must not replay steps the customer stopped before they happened.
   *
   * Authority loss still wins: a stop that races a takeover publishes nothing
   * under the successor controller and returns the same interrupted result any
   * other ending would.
   */
  private async finishStoppedTurn(stop: {
    stoppedDuring: AgentTurnStopPhase;
    executor: ExecutorRunResult | undefined;
    stepsPlanned: number;
    latest: AgentSessionRecord;
    planAlreadyPublished: boolean;
    evidence: { usage?: DecomposeUsage; tokensConsumed?: number };
    at: string;
    admission: AgentTurnAdmission;
    onProgress: RunTurnArgs['onProgress'];
  }): Promise<RunTurnResult> {
    const sessionId = stop.latest.id;
    const executor =
      stop.executor === undefined ? undefined : { ...stop.executor, ok: false, stopped: true };
    const results = executor?.results ?? [];
    const notice = stoppedTurnNotice({
      stoppedDuring: stop.stoppedDuring,
      results,
      stepsPlanned: stop.stepsPlanned,
    });
    const evidence = { ...stop.evidence, ...(executor !== undefined ? { executor } : {}) };
    const phase = stop.planAlreadyPublished ? 'finalize' : 'plan-publication';
    const entry: TranscriptEntry = stop.planAlreadyPublished
      ? {
          at: stop.at,
          role: 'agent',
          body: '(stopped by the customer before the page was read back — the steps above ran; the question was not answered)',
        }
      : executor !== undefined && results.length > 0
        ? {
            ...runResultToTranscriptEntry(executor, stop.at),
            intents: results.map((r) => r.intent),
          }
        : {
            at: stop.at,
            role: 'agent',
            body: '(stopped by the customer before any step ran — nothing was done on the page; the task is NOT finished)',
          };
    if (!(await this.authorityStillCurrent(sessionId, stop.admission))) {
      return this.interruptedTurnResult(sessionId, stop.latest, phase, evidence);
    }
    const updated = await this.appendTranscriptIfAuthorityRevision(
      sessionId,
      stop.admission,
      entry,
    );
    if (updated === null) {
      return this.interruptedTurnResult(sessionId, stop.latest, phase, evidence);
    }
    if (!(await this.authorityStillCurrent(sessionId, stop.admission))) {
      return this.interruptedTurnResult(sessionId, updated, phase, evidence);
    }
    this.deps.eventBus?.publish({
      agentSessionId: sessionId,
      index: updated.transcript.length - 1,
      entry,
    });
    // Past the fence, like every other sentence this turn streams.
    emitProgress(stop.onProgress, { kind: 'notice', notice });
    return {
      kind: 'stopped',
      session: updated,
      stoppedDuring: stop.stoppedDuring,
      ...(executor !== undefined ? { executor } : {}),
      stepsPlanned: Math.max(stop.stepsPlanned, results.length),
      notice,
      ...stop.evidence,
    };
  }

  /**
   * Persist ONE bundled-LLM cost row with the billing-integrity discipline the
   * monthly soft-cap depends on: a bounded retry (SPEND_RECORD_MAX_ATTEMPTS,
   * linear backoff) and, on final failure, a LOUD logger.error + a
   * bundledLlmErrorTotal metric so a stuck/undercounting cap is visible in
   * alerting rather than failing silently. Never throws — a meter blip must not
   * break the turn (the deliberate product intent). Shared by BOTH the decompose
   * row and the #140 read-back row so neither is a silent single-shot that would
   * undercount the cap without an alert (audit #9). A read-intent turn therefore
   * posts up to TWO rows (decompose + read-back) — both are real, within-slot
   * LLM calls, so the monthly sum stays accurate and the concurrency limiter's
   * overshoot stays bounded (its per-turn constant just includes the read-back).
   */
  private async recordUsageRowWithRetry(
    recorder: AgentDecomposerUsageRecorder,
    recordArgs: Parameters<AgentDecomposerUsageRecorder['record']>[0],
    ctx: { accountId: string; agentSessionId: string; label: string },
  ): Promise<void> {
    let lastErr: unknown;
    let recorded = false;
    // ONE identity for this row, reused by every attempt. A retry after a write
    // that actually committed must be a no-op, not a second charge — see the
    // `recordId` contract on AgentDecomposerUsageRecorder.
    const attemptArgs = { ...recordArgs, recordId: recordArgs.recordId ?? randomUUID() };
    for (let attempt = 1; attempt <= SPEND_RECORD_MAX_ATTEMPTS; attempt++) {
      try {
        await recorder.record(attemptArgs);
        recorded = true;
        break;
      } catch (err) {
        lastErr = err;
        if (attempt < SPEND_RECORD_MAX_ATTEMPTS) {
          // Linear backoff between attempts (50ms, 100ms). Bounded so a meter
          // blip recovers without adding noticeable turn latency.
          await delay(SPEND_RECORD_RETRY_BASE_MS * attempt);
        }
      }
    }
    if (!recorded) {
      // LOUD: the cost row never landed after all retries. For bundled turns
      // this means the soft-cap silently stopped advancing for this account —
      // surface it so alerting catches a stuck cap. Best-effort: a throwing
      // logger/metric must not break the turn either.
      try {
        this.deps.logger?.error?.(
          {
            component: 'agent-runtime',
            event: 'usage_record_persist_failed',
            account_id: ctx.accountId,
            agent_session_id: ctx.agentSessionId,
            key_source: recordArgs.keySource ?? 'none',
            cost_usd_cents: recordArgs.usage.costUsdCents ?? null,
            record_label: ctx.label,
            attempts: SPEND_RECORD_MAX_ATTEMPTS,
            err: lastErr,
          },
          'bundled-LLM cost row failed to persist after retries — monthly soft-cap will undercount this turn',
        );
      } catch {
        // Swallow; logging is best-effort and must not break the turn.
      }
      try {
        this.deps.metrics?.inc(METRIC_NAMES.bundledLlmErrorTotal, {
          kind: 'usage_record_persist_failed',
        });
      } catch {
        // Swallow; metrics are best-effort.
      }
    }
  }

  async runTurn(args: RunTurnArgs): Promise<RunTurnResult> {
    const session = await this.deps.sessions.get(args.agentSessionId);
    if (session === null) {
      throw new Error(`AgentSession ${args.agentSessionId} not found`);
    }
    if (this.activeTurnSessionIds.has(args.agentSessionId)) {
      return { kind: 'turn-in-progress', session };
    }

    if (session.status !== 'active') {
      return {
        kind: 'session-closed',
        reason: session.closedReason ?? `session ${session.status}`,
        session,
      };
    }
    const authority = await this.deps.sessions.getAuthoritySnapshot(args.agentSessionId);
    const currentAdmission = authority === null ? null : agentTurnAdmissionForSession(authority);
    const admission = args.admission ?? currentAdmission;
    if (
      admission === null ||
      currentAdmission === null ||
      admission.kind !== currentAdmission.kind ||
      !isDeepStrictEqual(admission.authority, currentAdmission.authority)
    ) {
      return { kind: 'ai-control-unavailable', phase: 'admission', session };
    }
    // The narrow authority read above is an await. Re-elect the per-session
    // owner after it: two requests can both pass the earlier fast-path check,
    // but only the first continuation may synchronously add the id below.
    if (this.activeTurnSessionIds.has(args.agentSessionId)) {
      return { kind: 'turn-in-progress', session };
    }

    // Bound one owner's aggregate AI work across DISTINCT sessions. The
    // per-session set above prevents stale same-session queues; this account
    // counter prevents alternate session ids / BYOK keys from fanning out into
    // unbounded LLM calls and control-plane plans. It is synchronous between
    // the last await and the increment, so concurrent continuations cannot all
    // observe a stale count on Node's event loop. Manual mode only appends one
    // transcript entry and never decomposes or dispatches, so it bypasses the
    // expensive-work slot while retaining the per-session lock.
    const consumesAccountSlot = admission.kind === 'ai-control';
    const currentForAccount = this.activeTurnAccountCounts.get(session.accountId) ?? 0;
    if (consumesAccountSlot && currentForAccount >= this.maxConcurrentTurnsPerAccount) {
      return {
        kind: 'account-turn-limit',
        current: currentForAccount,
        limit: this.maxConcurrentTurnsPerAccount,
        session,
      };
    }

    this.activeTurnSessionIds.add(args.agentSessionId);
    if (consumesAccountSlot) {
      this.activeTurnAccountCounts.set(session.accountId, currentForAccount + 1);
    }
    // B2 — registered in the SAME synchronous block as the slot above, so there
    // is no instant at which the session is busy and Stop cannot reach the turn.
    // The route's window when it opened one, so a Stop pressed before this point
    // has already aborted the controller this turn runs under.
    const controller =
      (args.stopWindow !== undefined
        ? this.stopWindowControllers.get(args.stopWindow)
        : undefined) ?? new AbortController();
    const turnId = randomUUID();
    if (consumesAccountSlot) {
      this.runningTurns.set(args.agentSessionId, { turnId, controller });
    }
    let stopWatching: () => Promise<void> = () => Promise.resolve();
    try {
      if (consumesAccountSlot) {
        stopWatching = await this.watchForRemoteStop(args.agentSessionId, turnId, controller);
      }
      // Use the SAME session snapshot that decided slot ownership. Re-fetching
      // here would let a concurrent manual→AI mode change bypass the account
      // slot after the earlier manual-mode check.
      return await this.runExclusiveTurn(args, session, admission, controller.signal);
    } finally {
      // B2 — the cross-process claim goes first, while the turn is still
      // registered here, so that by the time the turn answers no process can
      // still see it as running. Bounded, and it never throws — but guarded
      // anyway, because nothing may stand between a turn and freeing its slot.
      try {
        await stopWatching();
      } catch {
        /* the release is best-effort; its key expires on its own */
      }
      // Out of the registry in the same `finally` that frees the slot, so a
      // Stop that arrives after the turn ended is told so rather than aborting
      // a controller nothing reads.
      if (this.runningTurns.get(args.agentSessionId)?.turnId === turnId) {
        this.runningTurns.delete(args.agentSessionId);
      }
      // Covers success, controlled result variants, decomposer failures, and
      // executor/repository throws. A failed turn can never strand the session.
      this.activeTurnSessionIds.delete(args.agentSessionId);
      if (consumesAccountSlot) {
        const remaining = (this.activeTurnAccountCounts.get(session.accountId) ?? 1) - 1;
        if (remaining <= 0) this.activeTurnAccountCounts.delete(session.accountId);
        else this.activeTurnAccountCounts.set(session.accountId, remaining);
      }
    }
  }

  private async runExclusiveTurn(
    args: RunTurnArgs,
    session: AgentSessionRecord,
    admission: AgentTurnAdmission,
    // B2 — aborts when the customer presses Stop. Never aborted for a manual note.
    signal: AbortSignal,
  ): Promise<RunTurnResult> {
    const at = (args.now ?? new Date()).toISOString();
    // The wall clock starts HERE — before the first look and the first planning
    // call, which is the slowest single thing a turn does. Started after them, a
    // "three-minute turn" was three minutes plus however long the first plan took.
    const turnStartedAtMs = this.nowMs();
    if (session.status !== 'active') {
      // Closed/paused sessions return a short-circuit result. The
      // caller (route handler) maps this to a 409 Conflict — the
      // chat UI distinguishes resuming a pause from replacing a closed row.
      return {
        kind: 'session-closed',
        reason: session.closedReason ?? `session ${session.status}`,
        session,
      };
    }

    // Capacity is reserved BEFORE appending the user/operator message and,
    // critically, before decomposition or browser execution. An AI turn can
    // durably append user + plan/result + read-back answer (three entries); a
    // manual turn appends one. The 128KiB AI output reserve comfortably bounds a
    // TYPICAL turn's plan entry — every segment's intents (a turn is a loop of up
    // to MAX_PLANNER_CALLS_PER_TURN segments of eight; a real intent is ~150
    // bytes) and its capped result lines — plus the read-back answer. It is NOT
    // a worst-case bound and never was: a turn whose every intent carried a
    // limit-length selector and typed value outgrows it, and the next turn's
    // preflight then closes the session rather than this one failing. A turn's
    // stop sentence rides INSIDE the plan entry, so the entry count is unchanged.
    // Same-session turn serialization above makes this preflight exact in the
    // current singleton runtime.
    const entryReserve = admission.kind === 'manual-transcript' ? 1 : 3;
    const messageEntryBytes = Buffer.byteLength(
      JSON.stringify({
        at,
        role: admission.kind === 'manual-transcript' ? 'operator' : 'user',
        body: args.userMessage,
      }),
      'utf8',
    );
    const serializedBytes = Buffer.byteLength(JSON.stringify(session.transcript), 'utf8');
    const byteReserve =
      messageEntryBytes +
      (admission.kind === 'manual-transcript' ? 0 : AGENT_TURN_OUTPUT_RESERVE_BYTES);
    if (
      session.transcript.length + entryReserve > AGENT_TRANSCRIPT_MAX_ENTRIES ||
      serializedBytes + byteReserve > AGENT_TRANSCRIPT_MAX_SERIALIZED_BYTES
    ) {
      if (!(await this.authorityStillCurrent(session.id, admission))) {
        return this.interruptedTurnResult(session.id, session, 'message-publication');
      }
      const closed = await this.deps.sessions.closeWithReasonIfAuthorityRevision(
        session.id,
        admission.authority.revision,
        'transcript-limit',
      );
      if (closed === null) {
        return this.interruptedTurnResult(session.id, session, 'message-publication');
      }
      return { kind: 'session-closed', reason: 'transcript-limit', session: closed };
    }

    // Arc 2 sub-slice 8.6 (v2-#8) — manual mode pass-through. Record
    // the customer's user_message as actor='operator' on the transcript
    // (no decompose / executor / token debit; the gui-client drives
    // intents directly via the gui_control plane). Returns a distinct
    // result kind so the route maps to a 200 'logged' response.
    if (admission.kind === 'manual-transcript') {
      if (!(await this.authorityStillCurrent(session.id, admission))) {
        return this.interruptedTurnResult(session.id, session, 'message-publication');
      }
      const operatorEntry = {
        at,
        role: 'operator' as const,
        body: args.userMessage,
      };
      const updated = await this.appendTranscriptIfAuthorityRevision(
        session.id,
        admission,
        operatorEntry,
      );
      if (updated === null) {
        return this.interruptedTurnResult(session.id, session, 'message-publication');
      }
      if (!(await this.authorityStillCurrent(session.id, admission))) {
        return this.interruptedTurnResult(session.id, updated, 'message-publication');
      }
      this.deps.eventBus?.publish({
        agentSessionId: session.id,
        index: updated.transcript.length - 1,
        entry: operatorEntry,
      });
      return { kind: 'logged-manual', session: updated };
    }

    // Append the user turn FIRST so the decomposer sees its own
    // prior plans + the new user task in the history.
    const userEntry = {
      at,
      role: 'user' as const,
      body: args.userMessage,
    };
    if (!(await this.authorityStillCurrent(session.id, admission))) {
      return this.interruptedTurnResult(session.id, session, 'message-publication');
    }
    // Use the append's row-locked return as the exact history snapshot for this
    // turn. A separate get can observe a later concurrent append, mis-attribute
    // the SSE index, and bind an approval to the wrong user turn.
    const sessionWithUser = await this.appendTranscriptIfAuthorityRevision(
      session.id,
      admission,
      userEntry,
    );
    if (sessionWithUser === null) {
      return this.interruptedTurnResult(session.id, session, 'message-publication');
    }
    if (!(await this.authorityStillCurrent(session.id, admission))) {
      return this.interruptedTurnResult(session.id, sessionWithUser, 'message-publication');
    }
    // Arc 2 sub-slice 8.3 (v2-#8) — publish the user-turn entry to
    // the SSE event bus. Index = length-1 of the post-append
    // transcript so subscribers can resume via Last-Event-ID.
    this.deps.eventBus?.publish({
      agentSessionId: session.id,
      index: sessionWithUser.transcript.length - 1,
      entry: userEntry,
    });

    // B2 — every stopped ending below goes through here, so each one publishes
    // exactly one agent entry, under the same fence, with the same sentence.
    // Hoisted as closures over this turn's own facts; the few that change as the
    // turn runs are passed in.
    const endStopped = (stop: {
      stoppedDuring: AgentTurnStopPhase;
      executor: ExecutorRunResult | undefined;
      stepsPlanned: number;
      latest: AgentSessionRecord;
      planAlreadyPublished: boolean;
      evidence: { usage?: DecomposeUsage; tokensConsumed?: number };
    }): Promise<RunTurnResult> =>
      this.finishStoppedTurn({ ...stop, at, admission, onProgress: args.onProgress });
    // Pressed before anything was asked of the model: nothing ran, nothing was spent.
    if (stopRequested(signal)) {
      return endStopped({
        stoppedDuring: 'planning',
        executor: undefined,
        stepsPlanned: 0,
        latest: sessionWithUser,
        planAlreadyPublished: false,
        evidence: {},
      });
    }

    // Q.1.b — hybrid error classification per founder verdict
    // 2026-05-17. Transient operational failures (5xx after the
    // decomposer's internal retry, network errors) return a
    // synthesized refuse so the customer's session stays active
    // and they can retry the same turn after upstream recovery.
    // Fatal failures (credential errors / malformed responses /
    // missing-key configuration) re-throw — the route layer maps
    // them to 502 + Sentry alert.
    // W589 — file-06 guardrail #3: deterministic task-refusal start-gate,
    // screened BEFORE the LLM decompose. An obvious-abuse match short-circuits
    // to a refuse outcome (no LLM call, no token charge) — reusing the
    // existing `refuse` path. Empty/omitted patterns ⇒ no-op (allows all), so
    // this is inert until the founder/AUP curated list is supplied as data.
    const refusal = screenTaskForRefusal(args.userMessage, this.deps.refusalPatterns ?? []);
    // #130 — consequential-approval RESUME (see reconstructHaltedPlan). When the
    // customer approves a halted consequential action the gui-client re-sends the same
    // message WITH the approved signatures; re-running the LLM decompose here would
    // double-charge the flat bundled row + burn 2x budget for ONE task AND risk the
    // re-plan drifting from what was reviewed. Instead re-run the reviewed plan from
    // the transcript. No LLM call ⇒ no usage row (skips the charge) ⇒ no drift. Falls
    // back to a normal decompose when there is no prior plan to resume.
    const resumePlan =
      args.approvedConsequentialActions !== undefined && args.approvedConsequentialActions.size > 0
        ? reconstructHaltedPlan(sessionWithUser.transcript)
        : null;
    // A grant is valid only for the verified paused-plan resume above. Never
    // forward caller-supplied preapprovals into a fresh decomposition.
    const verifiedConsequentialApprovals =
      resumePlan !== null ? args.approvedConsequentialActions : undefined;
    const authorityMayContinue = () => this.authorityStillCurrent(session.id, admission);
    // Hoisted out of the first-plan branch because every LATER segment of the
    // turn plans for the same device and is compared against the same first look.
    // (The re-plan used to pass `deps.archetype` here — the process-wide literal
    // the resolver exists to supersede — so a recovered turn planned its second
    // half for a different phone than its first.)
    let turnArchetype = this.deps.archetype;
    let firstPlanObservation: string | undefined;
    let decomposed: DecomposeResult;
    if (resumePlan !== null) {
      decomposed = resumePlan;
    } else if (refusal.refuse) {
      // (the canonical decompose-total metric is bumped once below, labelled
      // result_kind:'refuse' — no separate inc here to avoid double-counting.)
      decomposed = {
        kind: 'refuse',
        // Surface the policy reason to the customer; the matched
        // category/patternId go to the structured log for the audit trail.
        refuseReason: refusal.reason ?? 'This task is not permitted.',
        tokensConsumed: 0,
      };
      this.deps.logger?.warn?.(
        {
          component: 'agent-runtime',
          event: 'task_refused',
          agent_session_id: session.id,
          refusal_category: refusal.category,
          refusal_pattern_id: refusal.patternId,
        },
        'task refused by start-gate',
      );
    } else {
      // P-15 follow-up (a) — plan against the device this session is really
      // running. `deps.archetype` is a process-wide literal; when the agent
      // session is attached to a driftstack session, that session's row is
      // what the box launched. Resolution failures are non-fatal: a degraded
      // device hint is better than a failed turn, so fall back to the literal.
      //
      // ⛔ BOTH ids matter, and the second one is the COMMON case. An agent session
      // stores no archetype of its own (there is no such column), and
      // `driftstack_session_id` is an OPTIONAL create-body field the caller
      // supplies — everything the desktop app creates leaves it null. Resolving
      // only from that id would have made this fix inert for almost every real
      // session while looking correct. `profile_id` is what a profile-bound
      // session actually carries, and the profile's archetype is what the dispatch
      // computed the launch from.
      const attachedSessionId = sessionWithUser.driftstackSessionId ?? null;
      const boundProfileId = sessionWithUser.profileId ?? null;
      if (
        this.deps.resolveSessionArchetype !== undefined &&
        (attachedSessionId !== null || boundProfileId !== null)
      ) {
        try {
          const launched = await this.deps.resolveSessionArchetype({
            accountId: session.accountId,
            driftstackSessionId: attachedSessionId,
            profileId: boundProfileId,
          });
          if (typeof launched === 'string' && launched.length > 0) turnArchetype = launched;
        } catch (err) {
          this.deps.logger?.warn?.(
            {
              component: 'agent-runtime',
              event: 'session_archetype_unresolved',
              agent_session_id: session.id,
              err: err instanceof Error ? err.message : String(err),
            },
            'could not resolve the attached session archetype; planning with the default device',
          );
        }
      }
      // P1 (a) — PERCEIVE BEFORE PLANNING, when there is already a page to look
      // at. The planner's worst failure is guessing a selector from memory on a
      // page it has never seen, and the cheapest fix is to look first.
      //
      // ⛔ GATED ON THE SESSION HAVING DRIVEN THE BROWSER ALREADY, and not on
      // "can we observe". On the FIRST turn of a session the device is on a
      // blank page: the read would cost a dispatch and return nothing anyone
      // could plan against, on every single first turn. A transcript entry
      // carrying `intents` is the durable record that this session has actually
      // navigated somewhere, so it is the honest test for "is there a page".
      const hasPriorBrowserWork = sessionWithUser.transcript.some(
        (entry) => entry.intents !== undefined && entry.intents.length > 0,
      );
      const observeDigest = this.deps.executor.observeDigest?.bind(this.deps.executor);
      let pageObservation: string | undefined;
      if (hasPriorBrowserWork && observeDigest !== undefined) {
        emitProgress(args.onProgress, { kind: 'phase', phase: 'reading_page' });
        // Best-effort by the same rule as the read-back: perceiving is an
        // improvement to planning, never a precondition for it, so a failure
        // here plans blind rather than failing the turn.
        try {
          pageObservation =
            (await observeDigest(session.id, authorityMayContinue, signal)) ?? undefined;
        } catch {
          pageObservation = undefined;
        }
      }
      firstPlanObservation = pageObservation;
      // B2 — never START a model call after Stop: the look above may have been
      // what the customer was watching when they pressed it.
      if (stopRequested(signal)) {
        return endStopped({
          stoppedDuring: 'planning',
          executor: undefined,
          stepsPlanned: 0,
          latest: sessionWithUser,
          planAlreadyPublished: false,
          evidence: {},
        });
      }
      try {
        // The customer is now staring at three dots for however long the model
        // takes. Say what is happening before the call, not after it.
        emitProgress(args.onProgress, { kind: 'phase', phase: 'planning' });
        decomposed = await this.deps.decomposer.decompose({
          task: args.userMessage,
          archetype: turnArchetype,
          history: sessionWithUser.transcript,
          budgetTokensRemaining: sessionWithUser.tokenBudgetRemaining,
          ...(pageObservation !== undefined ? { observation: pageObservation } : {}),
          // P2 — NAMES ONLY. The values go to the executor, never here.
          ...(args.credentials !== undefined
            ? { credentialRefs: credentialRefsFor(args.credentials) }
            : {}),
          // 6.c / #15 — the session's picked Claude 4.x model drives the
          // Anthropic call + the per-model cost-to-serve rate.
          model: sessionWithUser.model,
          ...(args.byokApiKey !== undefined ? { byokAnthropicApiKey: args.byokApiKey } : {}),
          shouldContinue: authorityMayContinue,
          // B2 — the provider lane ends the request when this aborts.
          signal,
        });
      } catch (err) {
        if (err instanceof AgentDecomposerContinuationDeniedError) {
          return this.interruptedTurnResult(session.id, sessionWithUser, 'decompose');
        }
        if (stopRequested(signal)) {
          // B2 — the customer stopped the turn while its first plan was being
          // made. Whatever the provider counted is this turn's first (and, for
          // the bundled price, charging) row — see abortedCallEvidence.
          const aborted = abortedCallEvidence(err, sessionWithUser.model);
          const latest = await this.accountForAbortedCall({
            session,
            driftstackSessionId: sessionWithUser.driftstackSessionId ?? null,
            evidence: aborted,
            args,
            label: 'decompose',
            flatChargeAlreadyPosted: false,
          });
          return endStopped({
            stoppedDuring: 'planning',
            executor: undefined,
            stepsPlanned: 0,
            latest: latest ?? sessionWithUser,
            planAlreadyPublished: false,
            evidence: {
              usage: aborted.usage,
              ...(aborted.tokensConsumed > 0 ? { tokensConsumed: aborted.tokensConsumed } : {}),
            },
          });
        }
        if (err instanceof AgentDecomposerSettledError) {
          // The strict result codec rejected the provider content, but the
          // envelope carried validated usage. Preserve real spend/budget
          // accounting before surfacing the fatal protocol error (or an
          // authority conflict if the admitted controller changed meanwhile).
          if (this.deps.usageRecorder !== undefined) {
            await this.recordUsageRowWithRetry(
              this.deps.usageRecorder,
              {
                accountId: session.accountId,
                driftstackSessionId: sessionWithUser.driftstackSessionId ?? null,
                agentSessionId: session.id,
                decomposeResultKind: 'refuse',
                usage: err.usage,
                tokensConsumed: err.tokensConsumed,
                now: args.now ?? new Date(),
                ...(args.keySource !== undefined ? { keySource: args.keySource } : {}),
              },
              { accountId: session.accountId, agentSessionId: session.id, label: 'decompose' },
            );
          }
          if (err.tokensConsumed > 0) {
            try {
              await this.debitTokensIfActive(session.id, err.tokensConsumed);
            } catch {
              /* debit best-effort — settled spend is already recorded above */
            }
          }
          if (!(await this.authorityStillCurrent(session.id, admission))) {
            return this.interruptedTurnResult(session.id, sessionWithUser, 'decompose', {
              usage: err.usage,
              ...(err.tokensConsumed > 0 ? { tokensConsumed: err.tokensConsumed } : {}),
            });
          }
          throw err;
        }
        // A provider can settle with a fatal protocol/credential error after
        // the admitted controller has already been replaced. Authority loss
        // wins that race: the successor must see the typed 409 contract, not
        // an unrelated 5xx from work owned by the stale controller.
        if (!(await this.authorityStillCurrent(session.id, admission))) {
          return this.interruptedTurnResult(session.id, sessionWithUser, 'decompose');
        }
        if (classifyDecomposerError(err) === 'fatal') {
          throw err;
        }
        // Transient — synthesize a refuse, session stays active.
        decomposed = {
          kind: 'refuse',
          refuseReason: 'agent layer temporarily unavailable; please retry',
          tokensConsumed: 0,
        };
      }
    }

    // v2-#4 Q.1.e — cost-tracking. Persist a usage_records row per
    // decompose() call that returns a `usage` block.
    //
    // Billing-integrity hardening: this cost row is the ONLY input to
    // sumMonthlySpendCents, which is the ONLY enforcement of the
    // bundled-LLM monthly soft-cap. A silently-dropped row makes the cap
    // stop advancing → uncapped upstream cost. So the write is RETRIED a
    // bounded number of times; the turn never breaks (the deliberate
    // product intent), but a final failure is logged LOUDLY (logger.error
    // with accountId + turn cost) so a stuck cap is visible in alerting
    // rather than failing silently.
    if (this.deps.usageRecorder !== undefined && decomposed.usage !== undefined) {
      await this.recordUsageRowWithRetry(
        this.deps.usageRecorder,
        {
          accountId: session.accountId,
          driftstackSessionId: sessionWithUser.driftstackSessionId ?? null,
          agentSessionId: session.id,
          decomposeResultKind: decomposed.kind,
          usage: decomposed.usage,
          tokensConsumed: decomposed.tokensConsumed,
          now: args.now ?? new Date(),
          // Arc 1 sub-slice 6.4 (v2-#6) — forward the route-resolved
          // key source so the recorder writes the right record_type.
          ...(args.keySource !== undefined ? { keySource: args.keySource } : {}),
        },
        { accountId: session.accountId, agentSessionId: session.id, label: 'decompose' },
      );
    }

    // Arc 7 obs.3 — bump the driftstack_agent_decompose_total counter
    // labelled by result-kind. Best-effort: a stray bug here must not
    // break the turn. (See METRIC_NAMES.agentDecomposeTotal for the
    // catalog entry.) #130 — skip on a consequential-approval RESUME: no
    // decompose() ran, so counting it would inflate the plan bucket.
    if (resumePlan === null) {
      try {
        this.deps.metrics?.inc(METRIC_NAMES.agentDecomposeTotal, { result_kind: decomposed.kind });
      } catch {
        // Swallow; metrics are best-effort.
      }
    }

    // Decomposition can be slow. A customer close may commit while it is in
    // flight, so account for the upstream call above, then re-read the durable
    // lifecycle before ANY debit, result append, SSE or browser execution.
    // Every later mutation is independently active-only as a second fence —
    // EXCEPT the cost row, which is deliberately NOT authority-gated. The
    // provider has already been paid by the time we get here, so that spend is
    // recorded ABOVE this re-read (and above the settled-error re-read) and both
    // call sites below say so: account the work exactly once whether the answer
    // is published, sanitized to empty, fenced by a new controller, or lost to a
    // transcript-storage failure. Gating it would make a superseded turn stop
    // advancing sumMonthlySpendCents, and nothing would raise.
    if (!(await this.authorityStillCurrent(session.id, admission))) {
      // The provider response is already consumed. Preserve its usage record
      // above and debit it while the row remains active, but do not publish a
      // model result or begin browser work under a superseded control lane.
      if (decomposed.tokensConsumed > 0) {
        try {
          await this.debitTokensIfActive(session.id, decomposed.tokensConsumed);
        } catch {
          // Accounting failure is observable through its storage alerting, but
          // cannot let stale-controller work replace the required authority 409.
        }
      }
      return this.interruptedTurnResult(session.id, sessionWithUser, 'decompose', {
        ...(decomposed.usage !== undefined ? { usage: decomposed.usage } : {}),
        ...(decomposed.tokensConsumed > 0 ? { tokensConsumed: decomposed.tokensConsumed } : {}),
      });
    }

    // Always debit the decomposer's tokens (even on refuse — the input was
    // processed), but never mutate accounting after a terminal winner.
    // Budget-exhausted refusals charge 0 per the AgentDecomposer contract.
    let postDebitSession = sessionWithUser;
    if (decomposed.tokensConsumed > 0) {
      const debited = await this.debitTokensIfActive(session.id, decomposed.tokensConsumed);
      if (debited === null) {
        return this.interruptedTurnResult(session.id, sessionWithUser, 'decompose', {
          ...(decomposed.usage !== undefined ? { usage: decomposed.usage } : {}),
          tokensConsumed: decomposed.tokensConsumed,
        });
      }
      postDebitSession = debited;
    }

    if (!(await this.authorityStillCurrent(session.id, admission))) {
      return this.interruptedTurnResult(session.id, postDebitSession, 'decompose', {
        ...(decomposed.usage !== undefined ? { usage: decomposed.usage } : {}),
        ...(decomposed.tokensConsumed > 0 ? { tokensConsumed: decomposed.tokensConsumed } : {}),
      });
    }

    // Q.3 — atomic session close on budget exhaustion. Two paths trip:
    //   1. The decomposer returned a budget-exhausted refusal
    //      (decompose() pre-call check refused before any LLM call).
    //   2. The debit took the remaining budget to exactly 0 (the LLM
    //      call ran; actual usage zeroed the remaining budget).
    // In either case the next turn would short-circuit on the
    // `session.status !== 'active'` branch, but closing here means
    // the customer's CURRENT turn returns a definitive signal — they
    // don't have to attempt another turn before learning the session
    // is dead.
    const isBudgetExhaustedRefusal =
      decomposed.kind === 'refuse' &&
      decomposed.refuseReason === 'token budget exhausted; start a new session';
    const debitZeroedBudget = postDebitSession.tokenBudgetRemaining === 0;
    if (isBudgetExhaustedRefusal || debitZeroedBudget) {
      const closed = await this.deps.sessions.closeWithReasonIfAuthorityRevision(
        session.id,
        admission.authority.revision,
        'budget-exhausted',
      );
      if (closed === null) {
        return this.interruptedTurnResult(session.id, postDebitSession, 'decompose', {
          ...(decomposed.usage !== undefined ? { usage: decomposed.usage } : {}),
          ...(decomposed.tokensConsumed > 0 ? { tokensConsumed: decomposed.tokensConsumed } : {}),
        });
      }
      return {
        kind: 'session-closed',
        reason: closed.closedReason ?? 'budget-exhausted',
        session: closed,
        ...(decomposed.usage !== undefined ? { usage: decomposed.usage } : {}),
        ...(decomposed.tokensConsumed > 0 ? { tokensConsumed: decomposed.tokensConsumed } : {}),
      };
    }

    if (decomposed.kind === 'refuse') {
      const refuseEntry = {
        at,
        role: 'agent' as const,
        body: `refused: ${decomposed.refuseReason}`,
      };
      const updated = await this.appendTranscriptIfAuthorityRevision(
        session.id,
        admission,
        refuseEntry,
      );
      if (updated === null) {
        return this.interruptedTurnResult(session.id, postDebitSession, 'plan-publication', {
          ...(decomposed.usage !== undefined ? { usage: decomposed.usage } : {}),
          ...(decomposed.tokensConsumed > 0 ? { tokensConsumed: decomposed.tokensConsumed } : {}),
        });
      }
      if (!(await this.authorityStillCurrent(session.id, admission))) {
        return this.interruptedTurnResult(session.id, updated, 'plan-publication', {
          ...(decomposed.usage !== undefined ? { usage: decomposed.usage } : {}),
          ...(decomposed.tokensConsumed > 0 ? { tokensConsumed: decomposed.tokensConsumed } : {}),
        });
      }
      this.deps.eventBus?.publish({
        agentSessionId: session.id,
        index: updated.transcript.length - 1,
        entry: refuseEntry,
      });
      return { kind: 'refuse', decomposer: decomposed, session: updated };
    }

    if (decomposed.kind === 'clarify') {
      const clarifyEntry = {
        at,
        role: 'agent' as const,
        body: `clarify: ${decomposed.clarifyingQuestion}`,
      };
      const updated = await this.appendTranscriptIfAuthorityRevision(
        session.id,
        admission,
        clarifyEntry,
      );
      if (updated === null) {
        return this.interruptedTurnResult(session.id, postDebitSession, 'plan-publication', {
          ...(decomposed.usage !== undefined ? { usage: decomposed.usage } : {}),
          ...(decomposed.tokensConsumed > 0 ? { tokensConsumed: decomposed.tokensConsumed } : {}),
        });
      }
      if (!(await this.authorityStillCurrent(session.id, admission))) {
        return this.interruptedTurnResult(session.id, updated, 'plan-publication', {
          ...(decomposed.usage !== undefined ? { usage: decomposed.usage } : {}),
          ...(decomposed.tokensConsumed > 0 ? { tokensConsumed: decomposed.tokensConsumed } : {}),
        });
      }
      this.deps.eventBus?.publish({
        agentSessionId: session.id,
        index: updated.transcript.length - 1,
        entry: clarifyEntry,
      });
      return { kind: 'clarify', decomposer: decomposed, session: updated };
    }

    // Plan path — execute against the attached driftstack session if
    // present; otherwise the executor runs against a synthetic id (the
    // stub doesn't care, but the wired executor will 400 without a
    // real session). The dashboard chat-UI is responsible for
    // attaching a driftstack session before letting the customer
    // request plan-actionable tasks.
    const targetSessionId = sessionWithUser.driftstackSessionId ?? 'unattached';
    // Publish the plan BEFORE the first dispatch: the browser warm-up alone can
    // run into double-digit seconds, and a customer who can see the list of
    // steps that is about to run is not waiting on an unexplained spinner.
    // Bound to a const: the callback below outlives the narrowing TypeScript
    // applies to the `let decomposed`, so reading `.intents` inside it would
    // not compile against the union.
    let plannedIntents = decomposed.intents;
    // P1 — every intent ATTEMPTED this turn, across the first plan and any
    // re-plan. The transcript entry carries this rather than the first plan
    // alone, so the recipe/intent_log consumers see what actually ran.
    const attemptedIntents: AgentIntent[] = [...plannedIntents];
    let announcedExecuting = false;
    // Both progress index spaces are offset by the results ALREADY accumulated,
    // so a re-planned suffix continues the customer's step list instead of
    // restarting it at 1. Using the same offset for starts and results keeps the
    // two spaces aligned, which is what makes the join downstream well-defined.
    let stepIndexOffset = 0;
    // P3 — ONE element-wait ceiling for the WHOLE TURN, not one per plan run.
    // The executor built its own per-`execute()` budget, which was the same
    // thing as per turn until P1 made one turn run several plans (today up to
    // MAX_PLANNER_CALLS_PER_TURN segments) — at which point the documented
    // ceiling silently became a multiple of itself. "Patience cannot multiply by plan
    // length" has to mean the turn, or the sentence is not true of the product.
    // Unseeded: the executor fills it from its own configured run budget, so the
    // runtime does not carry a copy of a number that lives over there.
    const elementWaitBudget: ElementWaitBudget = { remainingMs: null };
    const runPlan = async (
      plan: Extract<DecomposeResult, { kind: 'plan' }>,
      approvals: ReadonlySet<string> | undefined,
      meta: {
        segment: number;
        status?: PlanStatus;
        repeatGuard?: ExecuteArgs['repeatGuard'];
      },
    ): Promise<ExecutorRunResult> => {
      emitProgress(args.onProgress, {
        kind: 'plan',
        intents: plan.intents,
        total: stepIndexOffset + plan.intents.length,
        // A first segment is announced exactly as a whole plan always was. A
        // later one says where in the turn's step list it starts, because a
        // reader that took `intents[i]` for step `i` would caption the fourth
        // segment's first step with the first segment's.
        ...(meta.segment > 1 ? { offset: stepIndexOffset, segment: meta.segment } : {}),
        ...(meta.status !== undefined ? { status: meta.status } : {}),
      });
      if (!announcedExecuting) {
        emitProgress(args.onProgress, { kind: 'phase', phase: 'starting_browser' });
      }
      return await this.deps.executor.execute({
        onStepStart: (_intent, index): void => {
          // The first dispatch is the real end of the warm-up, so `executing`
          // is announced from here rather than guessed before execute().
          if (!announcedExecuting) {
            announcedExecuting = true;
            emitProgress(args.onProgress, { kind: 'phase', phase: 'executing' });
          }
          emitProgress(args.onProgress, {
            kind: 'step_start',
            index: stepIndexOffset + index,
            total: stepIndexOffset + plan.intents.length,
          });
        },
        sessionId: targetSessionId,
        // #139 — the fleet control-plane executor routes on the AGENT session id
        // (the id the box was dispatched to via sessionAssign + the key on
        // agent_sessions.node_id). driftstackSessionId is NULL for a pure
        // /v1/agent-sessions run, so passing only that stranded every fleet dispatch
        // as `unattached` → "no automation device is running this session". Always
        // thread the agent session id so the control-plane executor can resolve the
        // owning node; the legacy driver-path executor keeps using `sessionId`.
        agentSessionId: session.id,
        plan,
        shouldContinue: authorityMayContinue,
        // B2 — the executor checks it before every dispatch and waits out a step
        // already in flight rather than abandoning it blind.
        signal,
        // P3 — the TURN's element-wait ceiling, shared across every run below.
        elementWaitBudget,
        // P2 — the VALUES, to the executor only. Resolved into the dispatch and
        // nowhere else; the results this returns still carry the placeholders.
        ...(args.credentials !== undefined ? { credentials: args.credentials } : {}),
        ...(approvals !== undefined ? { approvedConsequentialActions: approvals } : {}),
        ...(meta.repeatGuard !== undefined ? { repeatGuard: meta.repeatGuard } : {}),
        ...(args.onStep !== undefined
          ? {
              onStep: (result: IntentResult, index: number): void => {
                args.onStep?.(result, stepIndexOffset + index);
              },
            }
          : {}),
      });
    };

    // Every provider call this TURN has made so far, against
    // MAX_MODEL_CALLS_PER_TURN. An approval resume makes none (it replays a plan
    // the customer already reviewed), so it starts at zero there.
    let modelCalls = resumePlan === null ? 1 : 0;
    // The planning calls among them, against MAX_PLANNER_CALLS_PER_TURN.
    let plannerCalls = modelCalls;

    // B2 — the plan call has settled and been paid for, but nothing has touched
    // the page yet. A Stop that arrived while it was being made ends the turn
    // here, before the first dispatch.
    if (stopRequested(signal)) {
      return endStopped({
        stoppedDuring: 'planning',
        executor: undefined,
        stepsPlanned: plannedIntents.length,
        latest: postDebitSession,
        planAlreadyPublished: false,
        evidence: {
          ...(decomposed.usage !== undefined ? { usage: decomposed.usage } : {}),
          ...(decomposed.tokensConsumed > 0 ? { tokensConsumed: decomposed.tokensConsumed } : {}),
        },
      });
    }
    let executorResult = await runPlan(decomposed, verifiedConsequentialApprovals, {
      segment: 1,
      ...(decomposed.status !== undefined ? { status: decomposed.status } : {}),
    });

    // ── B1 — LOOK, PLAN AS FAR AS YOU CAN SEE, ACT, LOOK AGAIN — IN ONE TURN ──
    //
    // ONE loop, entered for two reasons that used to be two code paths:
    //   · `replan`   — a step FAILED on something that provably did not happen
    //     (P1). The turn looks at the page and plans the remainder itself.
    //   · `continue` — every step SUCCEEDED and the planner had said these steps
    //     were only as far as it could see. Before this the turn simply ended
    //     there: the first plan of a chat is made blind, is rightly cautious
    //     (go there, wait, look), all of it works — and the task is not done.
    //     Re-planning fired only after a failure, so it never fired, and the
    //     customer typed "continue" for a task a person would call one request.
    // A plan with NO status takes neither branch on success, which is exactly
    // what a plan did before the field existed.
    //
    // ⛔ WHAT BOUNDS IT, AND THE SEPARATE FAILURE EACH ONE PREVENTS:
    //   · MAX_PLANNER_CALLS_PER_TURN — the loop as a whole. A planner that says
    //     `continue` forever cannot run forever.
    //   · MAX_REPLANS_PER_TURN — the FAILURES within it. A model that keeps
    //     failing is not rescued by having planner calls left.
    //   · MAX_MODEL_CALLS_PER_TURN − 1 — the turn's total provider calls, one
    //     short, so the last call is always the read-back's. Arithmetically
    //     implied by the planner-call ceiling at today's values and kept for the
    //     reason its own comment gives: a fence against the next call someone
    //     adds to a turn, not a second gate.
    //   · MAX_TURN_WALL_CLOCK_MS — TIME, which no call count bounds, measured
    //     from the top of the turn (the first planning call included).
    //   · REPLAN_MIN_BUDGET_TOKENS, re-read EVERY iteration — never START a call
    //     this session's remaining budget cannot cover. (A `> 0` check is what
    //     let an earlier version of the read-back overspend a near-empty balance.)
    //   · NO PROGRESS — the same page, the same plan, again. A loop that taps the
    //     same thing forever is this design's own failure mode, so it is named.
    //   · An IDENTICAL plan after a failure ends the loop: it fails the same way.
    //   · A STEP THAT ALREADY RAN IS NOT RE-RUN ON A PAGE THAT HAS NOT MOVED. See
    //     `admitSegment`: checked against everything that succeeded THIS TURN, by
    //     what each step DOES rather than how it is spelled — a fourth segment
    //     that re-emits the first segment's Send is the same duplicate order,
    //     three segments further away, whatever `value` it carries this time.
    //
    // ⛔ AND THREE THINGS IT MUST NOT BECOME:
    //   · It never goes round after a CONSEQUENTIAL HALT. That is a human
    //     decision in progress, not a wall to route around, and a loop that
    //     planned past it would be a way to reach a purchase without the
    //     confirmation. Each later segment also runs with NO approvals, so the
    //     gate is re-applied in full against every step of every segment, and an
    //     approval given for one segment can never pay for a step in another.
    //   · It never goes round after an OUTCOME-UNKNOWN failure. Looking at the
    //     page does not tell us whether the click landed; `isReplannableFailure`
    //     is an allowlist and `unknown` is not on it.
    //   · It never loops an approval RESUME. The customer approved a specific
    //     reviewed plan; planning onward from it would execute something they
    //     did not see.
    let replans = 0;
    let segment = 1;
    // The results of the LAST run only. `executorResult` is the MERGE of every
    // run this turn, which is right for the customer's step list and wrong for
    // any index into the plan that is currently running — see
    // `resumeFromIntentIndex` below, where using the merged length sent an
    // approval back into a plan the re-plan had abandoned.
    let lastRunResults = executorResult.results;
    let lastRun = executorResult;
    // How many intents of `attemptedIntents` precede the plan now running.
    let intentOffset = 0;
    // What the planner said about the segment that just ran.
    let lastStatus: PlanStatus | undefined = decomposed.status;
    // True once ANY segment carried a status: this turn is driven by a planner
    // that speaks the loop, which is what lets the read-back stop inferring
    // "they wanted an answer" from whether a plan happened to end in a capture.
    let plannerSpeaksLoop = decomposed.status !== undefined;
    // The page as the planner was shown it when it produced the segment that
    // just ran, for the no-progress check. Undefined for a blind first plan.
    let observationBehindLastPlan: string | undefined = firstPlanObservation;
    // Why the loop stopped short of `done`, when it did — see TurnLoopStopReason.
    let loopStopped: TurnLoopStopReason | undefined;
    // A question or a refusal the planner answered a LATER segment with. The
    // steps that already ran stand; this is what the customer is told next.
    let plannerHandedBack: string | undefined;
    let plannerHandedBackKind: 'clarify' | 'refuse' | undefined;
    // How many times running the planner has re-issued the SAME moving-only plan.
    let sameMovingPlanRepeats = 0;
    // Every step that SUCCEEDED this turn, with the page on either side of its
    // segment — what `admitSegment` judges a repeat against.
    const ranSteps: Array<RanStep & { segment: number }> = [];
    const noteRan = (run: ExecutorRunResult, ranInSegment: number, pageBefore?: string): void => {
      for (const r of run.results) {
        if (r.kind !== 'success') continue;
        const targets = run.tapTargets?.get(r);
        ranSteps.push({
          intent: r.intent,
          ...(targets !== undefined ? { targets } : {}),
          pageBefore,
          pageAfter: undefined,
          segment: ranInSegment,
        });
      }
    };
    noteRan(executorResult, 1, firstPlanObservation);
    // B2 — set when the loop ended because the customer pressed Stop, to what the
    // turn was doing when it noticed.
    let stoppedDuring: AgentTurnStopPhase | undefined =
      executorResult.stopped === true ? 'executing' : undefined;
    for (;;) {
      if (resumePlan !== null) break;
      if (executorResult.authorityLost === true) break;
      if (stoppedDuring !== undefined) break;
      if (executorResult.awaitingConfirmation === true) break;
      // ⛔ `continue` IS ASKED FIRST. A segment whose only ✗ is a best-effort wait
      // RAN TO ITS END (`segmentRanToItsEnd`), and a planner that said `continue`
      // is owed the next look. Asked second, that timed-out wait read as a
      // FAILURE: it spent one of the two recoveries, and three of them ended a
      // healthy turn at three planning calls with no sentence and no "not
      // finished" line for the next turn — a column of ticks over half a task,
      // the exact ending the stop sentences exist to prevent. A plan with no
      // status keeps the P1 reading: its timed-out trailing wait is a re-plan.
      const cause: 'continue' | 'replan' | null =
        lastStatus === 'continue' && segmentRanToItsEnd(lastRun)
          ? 'continue'
          : !lastRun.ok && isReplannableFailure(lastRun)
            ? 'replan'
            : null;
      if (cause === null) break;
      // B2 — the turn was about to go round again; a Stop that landed after the
      // last step of the segment prevents the next look and the next plan call.
      // Checked only AFTER `cause`: a turn whose work was already finished is
      // not "stopped" by a Stop that arrived as it finished — the read-back
      // check after the loop decides whether anything is left to cut short.
      if (stopRequested(signal)) {
        stoppedDuring = 'planning';
        break;
      }
      // The bounds. A `replan` that runs into one ends the way a failed turn
      // always has — the ✗ row is the message. A `continue` that runs into one
      // would end on a column of ticks over an unfinished task, so it says why.
      const stopFor = (reason: TurnLoopStopReason): void => {
        if (cause === 'continue') loopStopped = reason;
      };
      if (cause === 'replan' && replans >= MAX_REPLANS_PER_TURN) break;
      if (
        plannerCalls >= MAX_PLANNER_CALLS_PER_TURN ||
        modelCalls >= MAX_MODEL_CALLS_PER_TURN - 1
      ) {
        stopFor('planner_call_limit');
        break;
      }
      if (this.nowMs() - turnStartedAtMs >= MAX_TURN_WALL_CLOCK_MS) {
        stopFor('wall_clock');
        break;
      }
      if (postDebitSession.tokenBudgetRemaining < REPLAN_MIN_BUDGET_TOKENS) {
        stopFor('budget_floor');
        break;
      }
      // ⛔ NOTHING IN THIS LOOP MAY THROW OUT OF THE TURN. By now steps have RUN —
      // possibly a submit — and the plan entry that records them is written
      // AFTER the loop. A storage blip that escaped from here rejected the turn
      // with the transcript holding only the customer's message: they retry, the
      // retry finds no record of browser work, plans blind, and sends the form
      // again. The authority check already fails closed without throwing, the
      // look and the usage row swallow their own errors, and the two debits
      // below are guarded for this reason.
      if (!(await this.authorityStillCurrent(session.id, admission))) break;
      segment += 1;
      emitProgress(args.onProgress, { kind: 'phase', phase: 'reading_page', segment, cause });
      const pageNow = await this.observeForReplan(session.id, authorityMayContinue, signal);
      // B2 — the look is cut short by Stop; the plan call after it must not start.
      if (stopRequested(signal)) {
        stoppedDuring = 'planning';
        break;
      }
      for (const done of ranSteps) {
        if (done.pageAfter === undefined && done.segment === segment - 1) done.pageAfter = pageNow;
      }
      emitProgress(args.onProgress, { kind: 'phase', phase: 'planning', segment, cause });
      const turnProgress: TurnProgress = {
        segment,
        plannerCallsRemaining: Math.max(0, MAX_PLANNER_CALLS_PER_TURN - plannerCalls - 1),
        stepsSoFar: describeStepsSoFar(executorResult),
      };
      let replanned: DecomposeResult;
      try {
        replanned = await this.deps.decomposer.decompose({
          task: args.userMessage,
          archetype: turnArchetype,
          history: sessionWithUser.transcript,
          budgetTokensRemaining: postDebitSession.tokenBudgetRemaining,
          model: sessionWithUser.model,
          turnProgress,
          ...(cause === 'replan' ? { priorFailure: describeExecutorStop(executorResult) } : {}),
          ...(pageNow !== undefined ? { observation: pageNow } : {}),
          ...(args.credentials !== undefined
            ? { credentialRefs: credentialRefsFor(args.credentials) }
            : {}),
          ...(args.byokApiKey !== undefined ? { byokAnthropicApiKey: args.byokApiKey } : {}),
          shouldContinue: authorityMayContinue,
          signal,
        });
      } catch (err) {
        if (stopRequested(signal)) {
          // B2 — a later segment's plan call cut short by Stop. Its row is kept
          // like every other call's (the turn's flat price is already on the
          // first), and the steps that ran stand.
          modelCalls += 1;
          plannerCalls += 1;
          const debitedAfterAbort = await this.accountForAbortedCall({
            session,
            driftstackSessionId: sessionWithUser.driftstackSessionId ?? null,
            evidence: abortedCallEvidence(err, sessionWithUser.model),
            args,
            label: 'replan',
            flatChargeAlreadyPosted: true,
          });
          if (debitedAfterAbort !== null) postDebitSession = debitedAfterAbort;
          stoppedDuring = 'planning';
          break;
        }
        // ⛔ A SETTLED CALL IS BILLABLE WHETHER OR NOT WE COULD USE IT.
        // AgentDecomposerSettledError exists to say exactly that: the provider
        // responded and consumed tokens, and only the strict content codec
        // rejected what came back. Breaking without accounting would drop the
        // usage row AND the token debit for real upstream spend — and this is
        // the MORE likely site for it, not the less, because a later segment's
        // prompt carries untrusted page text, which is the input most able to
        // steer a model into content the codec refuses. The first decompose
        // handles this the same way; see its AgentDecomposerSettledError branch.
        if (err instanceof AgentDecomposerSettledError) {
          modelCalls += 1;
          plannerCalls += 1;
          await this.accountForExtraDecompose(
            session,
            sessionWithUser.driftstackSessionId ?? null,
            {
              kind: 'refuse',
              refuseReason: '',
              usage: err.usage,
              tokensConsumed: err.tokensConsumed,
            },
            args,
          );
          if (err.tokensConsumed > 0) {
            // Best-effort, as the read-back's debit is: the spend is already on
            // its usage row, and see the note at the top of the loop.
            const debitedAfterSettled = await this.debitTokensIfActive(
              session.id,
              err.tokensConsumed,
            ).catch(() => null);
            if (debitedAfterSettled !== null) postDebitSession = debitedAfterSettled;
          }
        }
        // Another segment is an improvement on stopping, never a new way to fail
        // a turn whose steps already ran. Any decomposer error ends the loop and
        // the turn reports what it actually achieved.
        stopFor('planner_unavailable');
        break;
      }
      modelCalls += 1;
      plannerCalls += 1;
      // The provider has settled. Account for it exactly as the read-back's
      // second call is accounted for: a row EVERY time, so per-turn telemetry
      // and the audit trail see all of a turn's calls.
      //
      // ⛔ WHAT THIS ROW DOES NOT DO. The bundled monthly cap sums
      // `metadata.cost_usd_cents`, and this row posts ZERO there
      // (bundledFlatCostAlreadyPosted) because the bundled price is flat PER
      // TURN, not per call — the same split the #140 read-back row already uses.
      // So the cap advances once per turn however many calls the turn made. That
      // is a deliberate pricing shape, not an accounting gap, and it is the
      // reason a turn that can now make up to MAX_MODEL_CALLS_PER_TURN calls
      // needs its flat price re-derived against that worst case rather than
      // against the one-call turn it was set for. Flagged in the summary.
      await this.accountForExtraDecompose(
        session,
        sessionWithUser.driftstackSessionId ?? null,
        replanned,
        args,
      );
      // A debit that THROWS is not a debit that says "session no longer active"
      // (null): the first is storage failing under us, the second is an answer.
      // Neither may run the new segment — its call is recorded on the usage row
      // above but not yet paid for out of this chat's budget — and only the
      // first needs a sentence, because the steps on screen are all ticks.
      let debited: AgentSessionRecord | null;
      try {
        debited =
          replanned.tokensConsumed > 0
            ? await this.debitTokensIfActive(session.id, replanned.tokensConsumed)
            : postDebitSession;
      } catch {
        stopFor('planner_unavailable');
        break;
      }
      if (debited === null) break;
      postDebitSession = debited;
      if (!(await this.authorityStillCurrent(session.id, admission))) break;
      // B2 — paid for, and not run: the customer stopped the turn while this
      // segment was being planned.
      if (stopRequested(signal)) {
        stoppedDuring = 'planning';
        break;
      }
      if (replanned.kind !== 'plan') {
        // Shown the page, the planner asked something or declined. After a
        // `continue` that is the turn's message to the customer — dropping it
        // would end on a column of ticks with the question unasked. After a
        // FAILURE it stays as it was: the ✗ row is the message.
        if (cause === 'continue') {
          plannerHandedBack =
            replanned.kind === 'clarify' ? replanned.clarifyingQuestion : replanned.refuseReason;
          plannerHandedBackKind = replanned.kind;
        }
        break;
      }
      if (replanned.status !== undefined) plannerSpeaksLoop = true;
      if (replanned.intents.length === 0) {
        // "Nothing left to do." Only a `done` may say it with no steps; anything
        // else with no steps is a planner with nothing to offer.
        if (replanned.status !== 'done') stopFor('planner_unavailable');
        lastStatus = replanned.status;
        break;
      }
      // THE SAME PLAN AGAIN, compared by what its steps DO (`samePlan`). After a
      // failure it fails the same way. After a `continue`, on a page that is not
      // known to have changed, it is the loop's own failure mode — going in
      // circles — and is named as that.
      const pageNotKnownToHaveChanged =
        pageNow === undefined || pageNow === observationBehindLastPlan;
      const identicalPlan = samePlan(replanned.intents, plannedIntents);
      if (identicalPlan && cause === 'replan') break;
      if (identicalPlan && pageNotKnownToHaveChanged) {
        // ⛔ EXCEPT ONE MORE SCROLL. "The page did not change" is not evidence a
        // scroll achieved nothing: the look is a digest of the DOCUMENT, and a
        // scroll moves the VIEWPORT. Content that renders only once it is
        // scrolled INTO VIEW is the ordinary case — measured live (2026-09-18): a
        // first 600px scroll fell short of a lazy price grid, the planner rightly
        // asked for the same scroll again, and the turn stopped as "going in
        // circles" one scroll before the prices appeared. So a plan that acts on
        // nothing AND SCROLLS may be repeated ONCE; a second repeat is circles.
        // A plan that only waits or captures has no such excuse — the same run
        // showed `[wait, capture]` repeated on an unchanged page, which is the
        // dithering this check is for — so it is stopped the first time.
        const actsOnNothing = replanned.intents.every((i) => !repeatMayDuplicateSiteEffect(i));
        const scrolls = replanned.intents.some(
          (i) => i.kind === 'scroll' || (i.kind === 'interact' && i.action === 'scroll'),
        );
        if (actsOnNothing && scrolls && sameMovingPlanRepeats < 1) {
          sameMovingPlanRepeats += 1;
        } else {
          stopFor('no_progress');
          break;
        }
      } else {
        sameMovingPlanRepeats = 0;
      }
      // ⛔ RUN WHAT MAY RUN, NOT THE WHOLE RETURNED PLAN. A model asked to carry on
      // routinely re-emits the steps that already worked — it is describing the
      // task, not the remainder — and handing that straight to the executor
      // clicks Send a second time. `admitSegment` decides, against everything
      // that succeeded THIS TURN and the page each of those steps was planned on.
      const admitted = admitSegment({
        cause,
        planned: replanned.intents,
        ran: ranSteps,
        pageNow,
      });
      if (!admitted.admitted) {
        stopFor(admitted.reason);
        break;
      }
      const suffix = admitted.intents;
      stepIndexOffset += lastRunResults.length;
      intentOffset += plannedIntents.length;
      plannedIntents = suffix;
      attemptedIntents.push(...suffix);
      observationBehindLastPlan = pageNow;
      lastStatus = replanned.status;
      // ⛔ NO APPROVALS. A later segment reaching a purchase must stop for a
      // human exactly as the first plan would have.
      // The segment's steps are judged again, tap by tap, once the device has
      // said what each tap lands on — against the steps of EARLIER segments
      // only: `ranSteps` gains this segment's steps after it has run.
      const ranBeforeThisSegment = [...ranSteps];
      const nextRun = await runPlan({ ...replanned, intents: suffix }, undefined, {
        segment,
        ...(replanned.status !== undefined ? { status: replanned.status } : {}),
        repeatGuard: (intent, targets) =>
          repeatRefusedAtTarget({ cause, intent, targets, ran: ranBeforeThisSegment, pageNow }),
      });
      lastRunResults = nextRun.results;
      lastRun = nextRun;
      noteRan(nextRun, segment, pageNow);
      executorResult = mergeExecutorRuns(executorResult, nextRun);
      if (cause === 'replan') replans += 1;
      if (nextRun.stopped === true) stoppedDuring = 'executing';
      if (nextRun.repeatRefused !== undefined) {
        // Set for BOTH causes, unlike `stopFor`: this run ended on no ✗ row of its
        // own (nothing was sent for the refused tap), so without the sentence a
        // re-planned turn would end on ticks over an unfinished task.
        loopStopped = nextRun.repeatRefused;
        break;
      }
    }

    if (
      executorResult.authorityLost === true ||
      !(await this.authorityStillCurrent(session.id, admission))
    ) {
      return this.interruptedTurnResult(session.id, postDebitSession, 'execution', {
        ...(decomposed.usage !== undefined ? { usage: decomposed.usage } : {}),
        ...(decomposed.tokensConsumed > 0 ? { tokensConsumed: decomposed.tokensConsumed } : {}),
        executor: executorResult,
      });
    }

    // B2 — the customer stopped the turn. The steps that ran are its record; no
    // read-back follows, because the customer asked for the work to stop.
    if (stoppedDuring !== undefined) {
      return endStopped({
        stoppedDuring,
        executor: executorResult,
        stepsPlanned: stepIndexOffset + plannedIntents.length,
        latest: postDebitSession,
        planAlreadyPublished: false,
        evidence: {
          ...(decomposed.usage !== undefined ? { usage: decomposed.usage } : {}),
          ...(decomposed.tokensConsumed > 0 ? { tokensConsumed: decomposed.tokensConsumed } : {}),
        },
      });
    }

    // Q.5.c — persist the plan's structured intents on the
    // transcript entry so recipes can assemble a non-empty
    // intent_log without re-running the decomposer. Backwards-
    // compatible: existing consumers reading `body` keep working;
    // recipe consumers iterate `intents` instead.
    const transcriptEntry = runResultToTranscriptEntry(executorResult, at);
    // Executor results are ordered one-for-one with the plan prefix. A
    // confirmation halt is always its final result, so results.length - 1 is
    // the exact first unexecuted intent. Persist it with the reviewed plan: an
    // approval must not replay the successful prefix (scroll/type/toggle/etc.).
    //
    // ⛔ TWO INDEX SPACES, AND THEY ONLY COINCIDE WHEN NOTHING RE-PLANNED.
    // The resume slices `attemptedIntents` (every intent of every plan this
    // turn), so the index has to be in THAT space: `intentOffset` counts the
    // intents of the earlier plans and `lastRunResults` is the current plan's
    // own results. Reading the MERGED `executorResult.results` instead makes the
    // index too small by exactly the intents an abandoned plan never executed —
    // so approving a purchase would first replay steps from the plan the
    // re-plan deliberately walked away from, and then hand the approval
    // signature to a longer list than the customer reviewed.
    const resumeFromIntentIndex =
      executorResult.awaitingConfirmation === true &&
      lastRunResults.length > 0 &&
      lastRunResults.at(-1)?.kind === 'confirmation_required'
        ? intentOffset + lastRunResults.length - 1
        : undefined;
    // B1 — the turn's closing line, for the NEXT turn's planner. A column of ✓
    // lines reads as a finished task, and "continue" typed after it would be
    // planned as a new one; this is what says the work is half done. It rides in
    // the plan entry's own body rather than in an entry of its own, so the
    // per-turn transcript reserve (three entries) is exactly what it was.
    const turnNotice =
      plannerHandedBack !== undefined
        ? sanitizeTranscriptText(plannerHandedBack)
        : loopStopped !== undefined
          ? TURN_LOOP_STOP_SENTENCES[loopStopped]
          : undefined;
    const closingLine =
      plannerHandedBack !== undefined
        ? `(stopped part-way to ask the customer: ${sanitizeTranscriptText(plannerHandedBack)})`
        : loopStopped !== undefined
          ? `(the task is NOT finished — ${TURN_LOOP_STOP_SENTENCES[loopStopped]})`
          : undefined;
    const planEntry = {
      ...transcriptEntry,
      ...(closingLine !== undefined
        ? {
            body:
              transcriptEntry.body.length > 0
                ? `${transcriptEntry.body}\n${closingLine}`
                : closingLine,
          }
        : {}),
      // P1 — everything ATTEMPTED this turn, first plan plus any re-plan, so the
      // persisted intent_log is the record of what ran rather than of what was
      // first proposed.
      intents: attemptedIntents,
      ...(resumeFromIntentIndex !== undefined ? { resumeFromIntentIndex } : {}),
    };
    const updated = await this.appendTranscriptIfAuthorityRevision(
      session.id,
      admission,
      planEntry,
    );
    if (updated === null) {
      return this.interruptedTurnResult(session.id, postDebitSession, 'plan-publication', {
        ...(decomposed.usage !== undefined ? { usage: decomposed.usage } : {}),
        ...(decomposed.tokensConsumed > 0 ? { tokensConsumed: decomposed.tokensConsumed } : {}),
        executor: executorResult,
      });
    }
    if (!(await this.authorityStillCurrent(session.id, admission))) {
      return this.interruptedTurnResult(session.id, updated, 'plan-publication', {
        ...(decomposed.usage !== undefined ? { usage: decomposed.usage } : {}),
        ...(decomposed.tokensConsumed > 0 ? { tokensConsumed: decomposed.tokensConsumed } : {}),
        executor: executorResult,
      });
    }
    this.deps.eventBus?.publish({
      agentSessionId: session.id,
      index: updated.transcript.length - 1,
      entry: planEntry,
    });

    // #140 read-and-report — if the model chose to CAPTURE (it wanted to observe
    // the result) and the plan ran, read the page text and answer the customer's
    // original question from it, appended as a follow-up agent turn (so "get the
    // IP" returns the actual IP, not just a screenshot). Best-effort + feature-
    // gated: skipped unless the executor can observe + the decomposer can answer +
    // there is an LLM key + remaining budget. Wrapped so the read-back can NEVER
    // fail the turn (the plan already succeeded + is recorded). The observed page
    // text is framed UNTRUSTED inside answerFromObservation and NEVER enters the
    // transcript — only the model's own answer does (correctly agent-framed).
    let sessionAfter = updated;
    let latestReadbackEvidence:
      | { usage?: DecomposeUsage; tokensConsumed?: number; executor: ExecutorRunResult }
      | undefined;
    // The published read-back answer, hoisted out of the try below so the turn
    // result can carry it to the caller instead of leaving it in the transcript.
    let publishedAnswer: string | undefined;
    const observe = this.deps.executor.observe?.bind(this.deps.executor);
    const answerFromObservation = this.deps.decomposer.answerFromObservation?.bind(
      this.deps.decomposer,
    );
    const mayReadBack = await this.authorityStillCurrent(session.id, admission);
    // P5 — SPLIT INTO "DID THEY ASK?" AND "COULD WE?". The nine conjuncts used
    // to be one `if`, so a customer who asked a question and hit any of the
    // other eight got SILENCE — the work done, nothing said. Asking is the
    // customer's half and it is now computed on its own, so that when one of the
    // capability conjuncts blocks the answer we can say which one did instead of
    // returning nothing and letting them conclude the agent ignored them.
    //
    // ⛔ READ OFF `attemptedIntents`, NOT THE FIRST PLAN. A turn whose first plan
    // died and whose RE-PLAN carried the capture would otherwise answer neither
    // way: no answer, and no sentence saying why — the exact P5 silence, walked
    // back in through P1's door. Everything else about the turn (the transcript
    // entry, the persisted intent log) already reads what was attempted.
    //
    // B5 — AND WHEN THE PLANNER SPEAKS THE LOOP, THE CAPTURE IS NOT THE SIGNAL.
    // "The plan ended in a capture" was a proxy for "the model wanted to look at
    // the result". A loop planner looks after EVERY segment and may finish on a
    // `done` with no steps at all (the confirmation page was already showing),
    // so the proxy would silently withhold the answer on exactly the turns that
    // went best. There the customer's wording decides on its own. A turn the
    // planner handed back part-way has its message already, and gets no second.
    const askedForInformation =
      executorResult.ok &&
      plannerHandedBack === undefined &&
      (plannerSpeaksLoop || attemptedIntents.some((i) => i.kind === 'capture')) &&
      asksForInformation(args.userMessage);
    // Why this stays keyed on the capability list and not on a catch-all: every
    // branch here has a DIFFERENT repair for the customer (top up the session,
    // add a key, try again), so a single "could not read the page" would be
    // honest about the outcome and useless about the fix.
    //
    // ⛔ THE READ-BACK IS A MODEL CALL AND IT COUNTS AS ONE. Until it did,
    // `modelCalls` only ever counted plan calls, so MAX_MODEL_CALLS_PER_TURN was
    // arithmetically the re-plan ceiling wearing a different name and could
    // never bind. Counting the call here is what makes it a real ceiling over
    // the turn's TOTAL provider calls, which is what its own comment claims and
    // what the next call added to a turn will be measured against.
    const modelCallsExhausted = modelCalls >= MAX_MODEL_CALLS_PER_TURN;
    let readbackUnavailable: string | undefined = !askedForInformation
      ? undefined
      : observe === undefined || answerFromObservation === undefined
        ? 'Reading the page back is not available in this chat, so I can only report the steps above.'
        : args.byokApiKey === undefined
          ? 'I could not read the page back to answer, because this chat has no AI key configured for it.'
          : updated.tokenBudgetRemaining < READBACK_MIN_BUDGET_TOKENS
            ? "I did the steps above, but there was not enough of this chat's AI budget left to read the page back and answer. Start a new chat and ask again."
            : modelCallsExhausted
              ? 'I finished the steps above, but this task took enough working-out that I ran out of room to read the page back and answer in the same message. Ask me again and I will read it.'
              : undefined;
    if (
      askedForInformation &&
      mayReadBack &&
      observe !== undefined &&
      answerFromObservation !== undefined &&
      args.byokApiKey !== undefined &&
      updated.tokenBudgetRemaining >= READBACK_MIN_BUDGET_TOKENS &&
      !modelCallsExhausted
    ) {
      // B2 — the steps have all run and been published; what a Stop can still
      // cut short is the read-back. The plan entry already says what ran, so the
      // stopped ending adds only the line that says the question went unanswered.
      const stopBeforeAnswer = (
        during: AgentTurnStopPhase,
        latest: AgentSessionRecord,
      ): Promise<RunTurnResult> =>
        endStopped({
          stoppedDuring: during,
          executor: executorResult,
          stepsPlanned: stepIndexOffset + plannedIntents.length,
          latest,
          planAlreadyPublished: true,
          evidence: {
            ...(decomposed.usage !== undefined ? { usage: decomposed.usage } : {}),
            ...(decomposed.tokensConsumed > 0 ? { tokensConsumed: decomposed.tokensConsumed } : {}),
          },
        });
      if (stopRequested(signal)) return stopBeforeAnswer('reading_page', sessionAfter);
      // Counted here rather than only checked, so the ceiling keeps meaning
      // "calls this turn has made" for whatever is added below it next.
      modelCalls += 1;
      // B2 — true only while the answer call itself is outstanding. A throw
      // from anything else in this block (the page read, a publication after the
      // answer settled and was already accounted) is not a model call cut short,
      // and must not get a usage row of its own.
      let answerInFlight = false;
      // What the stopped ending names as interrupted: the answer, once asked for.
      let readbackStopPhase: AgentTurnStopPhase = 'reading_page';
      try {
        emitProgress(args.onProgress, { kind: 'phase', phase: 'reading_page' });
        const observation = await observe(session.id, authorityMayContinue, signal);
        if (!(await this.authorityStillCurrent(session.id, admission))) {
          return this.interruptedTurnResult(session.id, sessionAfter, 'observation', {
            ...(decomposed.usage !== undefined ? { usage: decomposed.usage } : {}),
            ...(decomposed.tokensConsumed > 0 ? { tokensConsumed: decomposed.tokensConsumed } : {}),
            executor: executorResult,
          });
        }
        // B2 — a read cut short by Stop returns null like a failed one; it must
        // not be reported as "could not read the page".
        if (stopRequested(signal)) return await stopBeforeAnswer('reading_page', sessionAfter);
        if (observation === null || observation.trim().length === 0) {
          // P5 — the one gate that is not knowable in advance. The plan ran and
          // the page gave us nothing readable back, so the customer's question
          // has no source. Saying that is strictly better than silence: it tells
          // them the steps happened and the answer did not, which is the truth.
          readbackUnavailable =
            'I finished the steps above, but could not read the page back afterwards, so I cannot answer from it.';
        } else {
          emitProgress(args.onProgress, { kind: 'phase', phase: 'answering' });
          answerInFlight = true;
          readbackStopPhase = 'answering';
          const answer = await answerFromObservation({
            task: args.userMessage,
            observation,
            // B5 — the read-back reads the page the loop ENDED on, and when the
            // loop ended early that is not the page the task was heading for.
            // Saying so is what lets the answer be "I did not get that far"
            // instead of a confident reading of the wrong page.
            ...(loopStopped !== undefined ? { taskUnfinished: true } : {}),
            budgetTokensRemaining: sessionAfter.tokenBudgetRemaining,
            byokAnthropicApiKey: args.byokApiKey,
            model: sessionAfter.model,
            shouldContinue: authorityMayContinue,
            signal,
          });
          answerInFlight = false;
          latestReadbackEvidence = {
            ...(answer.usage !== undefined ? { usage: answer.usage } : {}),
            ...(answer.tokensConsumed > 0 ? { tokensConsumed: answer.tokensConsumed } : {}),
            executor: executorResult,
          };
          // The provider has settled. Account that work exactly once whether
          // the optional answer is published, sanitized to empty, fenced by a
          // new controller, or suppressed by a transcript-storage failure.
          if (this.deps.usageRecorder !== undefined && answer.usage !== undefined) {
            await this.recordUsageRowWithRetry(
              this.deps.usageRecorder,
              {
                accountId: session.accountId,
                driftstackSessionId: sessionWithUser.driftstackSessionId ?? null,
                agentSessionId: session.id,
                decomposeResultKind: 'plan',
                usage: answer.usage,
                tokensConsumed: answer.tokensConsumed,
                now: args.now ?? new Date(),
                ...(args.keySource !== undefined ? { keySource: args.keySource } : {}),
                // Second row of THIS turn — the turn's flat bundled charge was
                // already posted by the decompose row.
                bundledFlatCostAlreadyPosted: true,
              },
              { accountId: session.accountId, agentSessionId: session.id, label: 'readback' },
            );
          }
          if (answer.tokensConsumed > 0) {
            try {
              const debited = await this.debitTokensIfActive(session.id, answer.tokensConsumed);
              if (debited !== null) sessionAfter = debited;
            } catch {
              /* debit best-effort — the spend is already recorded above */
            }
          }
          if (!(await this.authorityStillCurrent(session.id, admission))) {
            return this.interruptedTurnResult(session.id, sessionAfter, 'readback', {
              ...(answer.usage !== undefined ? { usage: answer.usage } : {}),
              ...(answer.tokensConsumed > 0 ? { tokensConsumed: answer.tokensConsumed } : {}),
              executor: executorResult,
            });
          }
          // The observed page text is UNTRUSTED and the answer is a MODEL PARAPHRASE
          // of it, so sanitize before it lands as history the next turn reads: strip
          // C0/C1 control chars (no forged transcript lines — the answer becomes a
          // role:'agent' entry that buildMessages replays) + cap length. Same guard
          // the sibling executor-summary path uses (post-ship audit finding).
          const answerBody = sanitizeTranscriptText(answer.answer);
          if (answerBody.length > 0) {
            // Publish before exposing the answer, but always account for provider
            // work that already settled. A DB throw suppresses the optional
            // read-back response; it cannot erase real upstream spend from the
            // monthly soft-cap or token budget.
            const answerEntry = { at, role: 'agent' as const, body: answerBody };
            const appendedAnswer = await this.appendTranscriptIfAuthorityRevision(
              session.id,
              admission,
              answerEntry,
            );
            if (appendedAnswer === null) {
              // The model answer was consumed even though the revision guard
              // correctly suppressed its publication. Settlement was already
              // accounted above; expose nothing under the successor controller.
              return this.interruptedTurnResult(session.id, sessionAfter, 'readback', {
                ...(answer.usage !== undefined ? { usage: answer.usage } : {}),
                ...(answer.tokensConsumed > 0 ? { tokensConsumed: answer.tokensConsumed } : {}),
                executor: executorResult,
              });
            }
            sessionAfter = appendedAnswer;
            if (!(await this.authorityStillCurrent(session.id, admission))) {
              return this.interruptedTurnResult(session.id, sessionAfter, 'readback', {
                ...(answer.usage !== undefined ? { usage: answer.usage } : {}),
                ...(answer.tokensConsumed > 0 ? { tokensConsumed: answer.tokensConsumed } : {}),
                executor: executorResult,
              });
            }
            this.deps.eventBus?.publish({
              agentSessionId: session.id,
              index: sessionAfter.transcript.length - 1,
              entry: answerEntry,
            });
            // Publication succeeded under a still-current controller, so this
            // answer is the turn's. ⛔ It is NOT streamed here: the turn can
            // still lose authority at the finalize check below and return an
            // interrupted result that deliberately carries no answer — which
            // would leave a subscriber holding text the body withholds, the
            // exact leak under a successor controller the surrounding code
            // exists to prevent. The emit happens once that check has passed.
            publishedAnswer = answerBody;
          } else {
            // The answer path ran and produced nothing publishable (an empty
            // reply, or one that sanitised down to nothing). Same customer-
            // visible outcome as never reaching it, so it gets the same honest
            // sentence rather than silence.
            readbackUnavailable =
              'I finished the steps above, but could not read the page back afterwards, so I cannot answer from it.';
          }
        }
      } catch (error) {
        if (error instanceof AgentDecomposerContinuationDeniedError) {
          return this.interruptedTurnResult(session.id, sessionAfter, 'readback', {
            ...(decomposed.usage !== undefined ? { usage: decomposed.usage } : {}),
            ...(decomposed.tokensConsumed > 0 ? { tokensConsumed: decomposed.tokensConsumed } : {}),
            executor: executorResult,
          });
        }
        if (stopRequested(signal) && !answerInFlight) {
          // B2 — Stop was pending when something other than the answer call
          // threw: no model call was cut short here, so there is no row to add.
          return await stopBeforeAnswer(readbackStopPhase, sessionAfter);
        }
        if (stopRequested(signal)) {
          // B2 — the answer call cut short by Stop: its row and debit, like any
          // other call that started, then the stopped ending.
          const debitedAfterAbort = await this.accountForAbortedCall({
            session,
            driftstackSessionId: sessionWithUser.driftstackSessionId ?? null,
            evidence: abortedCallEvidence(error, sessionAfter.model),
            args,
            label: 'readback',
            flatChargeAlreadyPosted: true,
          });
          return await stopBeforeAnswer('answering', debitedAfterAbort ?? sessionAfter);
        }
        if (error instanceof AgentDecomposerSettledError) {
          latestReadbackEvidence = {
            usage: error.usage,
            ...(error.tokensConsumed > 0 ? { tokensConsumed: error.tokensConsumed } : {}),
            executor: executorResult,
          };
          if (this.deps.usageRecorder !== undefined) {
            await this.recordUsageRowWithRetry(
              this.deps.usageRecorder,
              {
                accountId: session.accountId,
                driftstackSessionId: sessionWithUser.driftstackSessionId ?? null,
                agentSessionId: session.id,
                decomposeResultKind: 'plan',
                usage: error.usage,
                tokensConsumed: error.tokensConsumed,
                now: args.now ?? new Date(),
                ...(args.keySource !== undefined ? { keySource: args.keySource } : {}),
                // Second row of THIS turn — the turn's flat bundled charge was
                // already posted by the decompose row.
                bundledFlatCostAlreadyPosted: true,
              },
              { accountId: session.accountId, agentSessionId: session.id, label: 'readback' },
            );
          }
          if (error.tokensConsumed > 0) {
            try {
              const debited = await this.debitTokensIfActive(session.id, error.tokensConsumed);
              if (debited !== null) sessionAfter = debited;
            } catch {
              /* debit best-effort — settled spend is already recorded above */
            }
          }
          if (!(await this.authorityStillCurrent(session.id, admission))) {
            return this.interruptedTurnResult(session.id, sessionAfter, 'readback', {
              usage: error.usage,
              ...(error.tokensConsumed > 0 ? { tokensConsumed: error.tokensConsumed } : {}),
              executor: executorResult,
            });
          }
        }
        // Read-back is additive — never fail the turn on it. But P5: it must not
        // be silent either. The plan result still stands; the customer is told
        // that the answer half did not, instead of being left to guess.
        readbackUnavailable =
          'I finished the steps above, but the step that reads the page back and answers did not complete. The steps above are what ran.';
      }
    }

    if (!(await this.authorityStillCurrent(session.id, admission))) {
      return this.interruptedTurnResult(
        session.id,
        sessionAfter,
        'finalize',
        latestReadbackEvidence ?? {
          ...(decomposed.usage !== undefined ? { usage: decomposed.usage } : {}),
          ...(decomposed.tokensConsumed > 0 ? { tokensConsumed: decomposed.tokensConsumed } : {}),
          executor: executorResult,
        },
      );
    }

    // P5 — SAY SO WHEN THERE IS NO ANSWER. "I did the steps but could not read
    // the page back to you because X" is a far better answer than nothing, and
    // nothing is what a blocked read-back used to return. Published exactly the
    // way an answer is — one agent transcript entry, on the same event bus — so
    // every surface that already renders the answer renders this too, with no
    // new channel to keep in sync.
    //
    // ⛔ IT SITS AFTER THE FINALIZE AUTHORITY CHECK, and that position is the
    // point. Every interrupted return above deliberately carries no answer; a
    // sentence published before those checks would put this turn's words into a
    // successor controller's chat — the exact leak the answer path is already
    // ordered to prevent. Best-effort by the same rule as the read-back itself:
    // a storage failure here cannot fail a turn whose plan succeeded.
    if (publishedAnswer === undefined && readbackUnavailable !== undefined) {
      const unavailableEntry = { at, role: 'agent' as const, body: readbackUnavailable };
      try {
        const appended = await this.appendTranscriptIfAuthorityRevision(
          session.id,
          admission,
          unavailableEntry,
        );
        if (appended === null) {
          readbackUnavailable = undefined;
        } else {
          sessionAfter = appended;
          this.deps.eventBus?.publish({
            agentSessionId: session.id,
            index: sessionAfter.transcript.length - 1,
            entry: unavailableEntry,
          });
        }
      } catch {
        readbackUnavailable = undefined;
      }
    } else {
      readbackUnavailable = undefined;
    }

    // Authority held all the way through, so the answer is this turn's to
    // publish. Streamed here — still ahead of the response body a subscriber
    // would otherwise wait for — and never before the check above.
    if (publishedAnswer !== undefined) {
      emitProgress(args.onProgress, { kind: 'answer', answer: publishedAnswer });
    }
    // Same position and same reason as the answer: past the finalize check, so a
    // successor controller's chat never receives this turn's words.
    if (turnNotice !== undefined) {
      emitProgress(args.onProgress, { kind: 'notice', notice: turnNotice });
    }
    return {
      kind: 'plan-executed',
      decomposer: decomposed,
      executor: executorResult,
      session: sessionAfter,
      ...(publishedAnswer !== undefined ? { answer: publishedAnswer } : {}),
      ...(readbackUnavailable !== undefined ? { readbackUnavailable } : {}),
      ...(turnNotice !== undefined ? { notice: turnNotice } : {}),
      // Only a turn whose planner spoke the loop, or that went round at all,
      // reports it: a legacy single-plan turn returns exactly what it always did.
      ...(plannerSpeaksLoop || segment > 1
        ? {
            loop: {
              segments: segment,
              plannerCalls,
              replans,
              ...(lastStatus !== undefined ? { finalStatus: lastStatus } : {}),
              ...(loopStopped !== undefined ? { stopped: loopStopped } : {}),
              ...(plannerHandedBack !== undefined ? { handedBack: true } : {}),
              ...(plannerHandedBackKind !== undefined
                ? { handedBackKind: plannerHandedBackKind }
                : {}),
            },
          }
        : {}),
    };
  }
}

/**
 * Q.1.b — classify a thrown decomposer error as transient or fatal.
 *
 * Transient (return refuse, session stays active):
 *   - Anthropic 5xx after the decomposer's internal retry (message
 *     pattern `Anthropic API 5\d\d`)
 *   - Network errors after retry (e.g. ECONNRESET, fetch failed)
 *
 * Fatal (re-throw → route 502):
 *   - Anthropic 4xx (credential / quota / validation)
 *   - Malformed response (missing text content / non-JSON body /
 *     unknown discriminator kind / missing required fields)
 *   - Missing API key configuration
 *   - Any non-Error throw (defensive: treat as fatal so it surfaces
 *     to Sentry rather than masquerading as a customer-facing refuse)
 */
export function classifyDecomposerError(err: unknown): 'transient' | 'fatal' {
  if (!(err instanceof Error)) return 'fatal';
  const msg = err.message;
  // Anthropic 5xx after retry → transient
  if (/Anthropic API 5\d\d/.test(msg)) return 'transient';
  // Anthropic 429 (rate-limit) / 408 (request-timeout) / 425 (too-early) → transient,
  // NOT fatal: these are throttle/transient upstream signals (esp. 429 when concurrent
  // chat turns push the shared key over its org rate limit at peak), so degrade to a
  // retryable refuse + keep the session alive — NOT a hard 500. MUST precede the
  // 4xx→fatal branch below (which would otherwise swallow 429). callWithRetry also
  // now retries 429. (529 overloaded already matches the 5xx branch above.)
  if (/Anthropic API (429|408|425)/.test(msg)) return 'transient';
  // Anthropic 4xx → fatal (credential / validation / bad-request)
  if (/Anthropic API 4\d\d/.test(msg)) return 'fatal';
  // Malformed Anthropic response → fatal
  if (
    /missing text content|not valid JSON|not a JSON object|response (?:envelope|content|usage|field .+ exceeded \d+ characters)|unknown result kind|intents (?:was not an array|exceeded \d+ entries)|missing clarifyingQuestion|missing refuseReason|response body exceeded \d+ bytes/i.test(
      msg,
    )
  ) {
    return 'fatal';
  }
  // Missing API key configuration → fatal (route should have caught
  // this; if we got here, bootstrap wiring is wrong)
  if (/no Anthropic API key/i.test(msg)) return 'fatal';
  // Default: anything else (network errors, fetch rejections,
  // timeouts) → transient
  return 'transient';
}

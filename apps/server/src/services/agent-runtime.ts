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

import { isDeepStrictEqual } from 'node:util';
import type {
  AgentDecomposer,
  DecomposeResult,
  DecomposeUsage,
  TranscriptEntry,
} from './agent-decomposer.js';
import {
  AgentDecomposerContinuationDeniedError,
  AgentDecomposerSettledError,
} from './agent-decomposer.js';
import type { AgentExecutor, ExecutorRunResult } from './agent-executor.js';
import { runResultToTranscriptEntry, sanitizeTranscriptText } from './agent-executor.js';
import type {
  AgentSessionAuthoritySnapshot,
  AgentSessionRecord,
  AgentSessionsRepo,
} from './agent-sessions.js';
import type { AgentSessionEventBus } from './agent-session-event-bus.js';
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
   * W443/W445 — consequential-action signatures the customer approved on a
   * prior turn (the executor halted with `confirmation_required`). Threaded to
   * the executor so the re-planned consequential action dispatches instead of
   * halting again. The route maps the request's {category, matched_text} pairs
   * to signatures via `consequentialSignature`.
   */
  approvedConsequentialActions?: ReadonlySet<string>;
  /** Route-admitted control lane. Production captures this before any
   * credential, budget, or provider work so a mode change cannot reinterpret
   * the same request. Direct/test callers may omit it; the runtime then admits
   * exactly the current durable lane itself. */
  admission?: AgentTurnAdmission;
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
  archetype: string;
  /** Per-owner-account AI turns allowed concurrently across distinct agent
   *  sessions. Manual transcript-only turns do not consume a slot. Default 3. */
  maxConcurrentTurnsPerAccount?: number;
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
}

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
const READ_INTENT_RE =
  /\b(get|find|read|extract|scrape|fetch|show|tell|list|report|look\s?up|lookup|what|whats|which|when|where|who|how\s+(?:many|much|long|old|far|big))\b/i;

// #140 — only fire the read-back when the session has enough budget to cover a
// FULL answer call (~MAX_OBSERVATION_CHARS=20k input chars ≈ ~5k tokens +
// ANSWER_MAX_OUTPUT_TOKENS=512). A coarse `> 0` gate let a near-empty balance run
// a full ~5.5k-token call that debitTokens then floored to 0 — a silent
// per-session budget-cap overspend (post-ship audit finding). Below this, skip
// the read-back: the customer still gets the plan result, no overspend.
const READBACK_MIN_BUDGET_TOKENS = 6_000;

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

  constructor(private readonly deps: AgentRuntimeDeps) {
    const limit = deps.maxConcurrentTurnsPerAccount ?? 3;
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error('maxConcurrentTurnsPerAccount must be a positive safe integer');
    }
    this.maxConcurrentTurnsPerAccount = limit;
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
    for (let attempt = 1; attempt <= SPEND_RECORD_MAX_ATTEMPTS; attempt++) {
      try {
        await recorder.record(recordArgs);
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
    try {
      // Use the SAME session snapshot that decided slot ownership. Re-fetching
      // here would let a concurrent manual→AI mode change bypass the account
      // slot after the earlier manual-mode check.
      return await this.runExclusiveTurn(args, session, admission);
    } finally {
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
  ): Promise<RunTurnResult> {
    const at = (args.now ?? new Date()).toISOString();
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
    // manual turn appends one. The 128KiB AI output reserve comfortably bounds
    // the 2,048-token plan response, capped executor summaries/intents, and the
    // 512-token read-back answer. Same-session turn serialization above makes
    // this preflight exact in the current singleton runtime.
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
      try {
        decomposed = await this.deps.decomposer.decompose({
          task: args.userMessage,
          archetype: this.deps.archetype,
          history: sessionWithUser.transcript,
          budgetTokensRemaining: sessionWithUser.tokenBudgetRemaining,
          // 6.c / #15 — the session's picked Claude 4.x model drives the
          // Anthropic call + the per-model cost-to-serve rate.
          model: sessionWithUser.model,
          ...(args.byokApiKey !== undefined ? { byokAnthropicApiKey: args.byokApiKey } : {}),
          shouldContinue: authorityMayContinue,
        });
      } catch (err) {
        if (err instanceof AgentDecomposerContinuationDeniedError) {
          return this.interruptedTurnResult(session.id, sessionWithUser, 'decompose');
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
    // Every later mutation is independently active-only as a second fence.
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
    const executorResult = await this.deps.executor.execute({
      sessionId: targetSessionId,
      // #139 — the fleet control-plane executor routes on the AGENT session id
      // (the id the box was dispatched to via sessionAssign + the key on
      // agent_sessions.node_id). driftstackSessionId is NULL for a pure
      // /v1/agent-sessions run, so passing only that stranded every fleet dispatch
      // as `unattached` → "no automation device is running this session". Always
      // thread the agent session id so the control-plane executor can resolve the
      // owning node; the legacy driver-path executor keeps using `sessionId`.
      agentSessionId: session.id,
      plan: decomposed,
      shouldContinue: authorityMayContinue,
      ...(verifiedConsequentialApprovals !== undefined
        ? { approvedConsequentialActions: verifiedConsequentialApprovals }
        : {}),
    });

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
    const resumeFromIntentIndex =
      executorResult.awaitingConfirmation === true &&
      executorResult.results.length > 0 &&
      executorResult.results.at(-1)?.kind === 'confirmation_required'
        ? executorResult.results.length - 1
        : undefined;
    const planEntry = {
      ...transcriptEntry,
      intents: decomposed.intents,
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
    const observe = this.deps.executor.observe?.bind(this.deps.executor);
    const answerFromObservation = this.deps.decomposer.answerFromObservation?.bind(
      this.deps.decomposer,
    );
    const mayReadBack = await this.authorityStillCurrent(session.id, admission);
    if (
      executorResult.ok &&
      mayReadBack &&
      observe !== undefined &&
      answerFromObservation !== undefined &&
      args.byokApiKey !== undefined &&
      updated.tokenBudgetRemaining >= READBACK_MIN_BUDGET_TOKENS &&
      decomposed.intents.some((i) => i.kind === 'capture') &&
      READ_INTENT_RE.test(args.userMessage)
    ) {
      try {
        const observation = await observe(session.id, authorityMayContinue);
        if (!(await this.authorityStillCurrent(session.id, admission))) {
          return this.interruptedTurnResult(session.id, sessionAfter, 'observation', {
            ...(decomposed.usage !== undefined ? { usage: decomposed.usage } : {}),
            ...(decomposed.tokensConsumed > 0 ? { tokensConsumed: decomposed.tokensConsumed } : {}),
            executor: executorResult,
          });
        }
        if (observation !== null && observation.trim().length > 0) {
          const answer = await answerFromObservation({
            task: args.userMessage,
            observation,
            budgetTokensRemaining: sessionAfter.tokenBudgetRemaining,
            byokAnthropicApiKey: args.byokApiKey,
            model: sessionAfter.model,
            shouldContinue: authorityMayContinue,
          });
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
        // Read-back is additive — never fail the turn on it.
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

    return {
      kind: 'plan-executed',
      decomposer: decomposed,
      executor: executorResult,
      session: sessionAfter,
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

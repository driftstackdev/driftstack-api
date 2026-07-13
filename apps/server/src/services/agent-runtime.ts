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

import type {
  AgentDecomposer,
  DecomposeResult,
  DecomposeUsage,
  TranscriptEntry,
} from './agent-decomposer.js';
import type { AgentExecutor, ExecutorRunResult } from './agent-executor.js';
import { runResultToTranscriptEntry, sanitizeTranscriptText } from './agent-executor.js';
import type { AgentSessionRecord, AgentSessionsRepo } from './agent-sessions.js';
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
  }): Promise<void>;
}

export interface AgentRuntimeDeps {
  decomposer: AgentDecomposer;
  executor: AgentExecutor;
  sessions: AgentSessionsRepo;
  archetype: string;
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

// #130 — reconstruct the plan the customer is APPROVING from the transcript so a
// consequential-approval turn re-runs the reviewed plan instead of re-decomposing.
// Re-decomposing on approval would (a) charge a SECOND flat $0.10 bundled row + burn
// 2x the token budget for ONE logical task, and (b) let the non-deterministic re-plan
// DRIFT from what the customer reviewed (a same-phrase/different-target action could
// be greenlit without re-review — the known v1.1 gate limitation, now live-reachable).
// Plan turns persist their structured `intents` on the transcript entry (see the
// plan-path `planEntry`). Resume is deliberately bound to the IMMEDIATELY preceding
// agent entry and its explicit `awaitingConfirmation` marker. Scanning backward to
// any structured plan would replay a completed/stale plan; forwarding a grant when
// no marked plan exists would let a caller pre-authorize a newly decomposed action
// without ever seeing the confirmation halt. Returned as a plan-kind result with
// tokensConsumed 0 and NO usage, so the runtime writes no cost row + no token debit
// (the resume is free). Returns null for a fresh, completed, stale, or malformed plan.
function reconstructHaltedPlan(
  transcript: ReadonlyArray<TranscriptEntry>,
): Extract<DecomposeResult, { kind: 'plan' }> | null {
  // runTurn appends the current approval user entry before reaching here, so
  // the only plan it may authorize is exactly one entry earlier.
  const pending = transcript.at(-2);
  const intents = pending?.intents;
  if (
    pending?.role !== 'agent' ||
    pending.awaitingConfirmation !== true ||
    intents === undefined ||
    intents.length === 0
  ) {
    return null;
  }
  return { kind: 'plan', intents, tokensConsumed: 0 };
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class AgentRuntime {
  constructor(private readonly deps: AgentRuntimeDeps) {}

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
    const at = (args.now ?? new Date()).toISOString();
    const session = await this.deps.sessions.get(args.agentSessionId);
    if (session === null) {
      throw new Error(`AgentSession ${args.agentSessionId} not found`);
    }
    if (session.status !== 'active') {
      // Closed/paused sessions return a short-circuit result. The
      // caller (route handler) maps this to a 409 Conflict — the
      // chat UI prompts the customer to start a new agent session.
      return {
        kind: 'session-closed',
        reason: session.closedReason ?? `session ${session.status}`,
        session,
      };
    }

    // Arc 2 sub-slice 8.6 (v2-#8) — manual mode pass-through. Record
    // the customer's user_message as actor='operator' on the transcript
    // (no decompose / executor / token debit; the gui-client drives
    // intents directly via the gui_control plane). Returns a distinct
    // result kind so the route maps to a 200 'logged' response.
    if (session.mode === 'manual') {
      const operatorEntry = {
        at,
        role: 'operator' as const,
        body: args.userMessage,
      };
      const updated = await this.deps.sessions.appendTranscript(session.id, operatorEntry);
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
    // Use the append's row-locked return as the exact history snapshot for this
    // turn. A separate get can observe a later concurrent append, mis-attribute
    // the SSE index, and bind an approval to the wrong user turn.
    const sessionWithUser = await this.deps.sessions.appendTranscript(session.id, userEntry);
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
        });
      } catch (err) {
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

    // Always debit the decomposer's tokens (even on refuse —
    // the input was processed). Budget-exhausted refusals charge
    // 0 per the AgentDecomposer contract.
    let postDebitSession = sessionWithUser;
    if (decomposed.tokensConsumed > 0) {
      postDebitSession = await this.deps.sessions.debitTokens(
        session.id,
        decomposed.tokensConsumed,
      );
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
      await this.deps.sessions.closeWithReason(session.id, 'budget-exhausted');
    }

    if (decomposed.kind === 'refuse') {
      const refuseEntry = {
        at,
        role: 'agent' as const,
        body: `refused: ${decomposed.refuseReason}`,
      };
      const updated = await this.deps.sessions.appendTranscript(session.id, refuseEntry);
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
      const updated = await this.deps.sessions.appendTranscript(session.id, clarifyEntry);
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
      ...(verifiedConsequentialApprovals !== undefined
        ? { approvedConsequentialActions: verifiedConsequentialApprovals }
        : {}),
    });

    // Q.5.c — persist the plan's structured intents on the
    // transcript entry so recipes can assemble a non-empty
    // intent_log without re-running the decomposer. Backwards-
    // compatible: existing consumers reading `body` keep working;
    // recipe consumers iterate `intents` instead.
    const transcriptEntry = runResultToTranscriptEntry(executorResult, at);
    const planEntry = {
      ...transcriptEntry,
      intents: decomposed.intents,
    };
    const updated = await this.deps.sessions.appendTranscript(session.id, planEntry);
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
    const observe = this.deps.executor.observe?.bind(this.deps.executor);
    const answerFromObservation = this.deps.decomposer.answerFromObservation?.bind(
      this.deps.decomposer,
    );
    if (
      executorResult.ok &&
      observe !== undefined &&
      answerFromObservation !== undefined &&
      args.byokApiKey !== undefined &&
      updated.tokenBudgetRemaining >= READBACK_MIN_BUDGET_TOKENS &&
      decomposed.intents.some((i) => i.kind === 'capture') &&
      READ_INTENT_RE.test(args.userMessage)
    ) {
      try {
        const observation = await observe(session.id);
        if (observation !== null && observation.trim().length > 0) {
          const answer = await answerFromObservation({
            task: args.userMessage,
            observation,
            budgetTokensRemaining: sessionAfter.tokenBudgetRemaining,
            byokAnthropicApiKey: args.byokApiKey,
            model: sessionAfter.model,
          });
          // The observed page text is UNTRUSTED and the answer is a MODEL PARAPHRASE
          // of it, so sanitize before it lands as history the next turn reads: strip
          // C0/C1 control chars (no forged transcript lines — the answer becomes a
          // role:'agent' entry that buildMessages replays) + cap length. Same guard
          // the sibling executor-summary path uses (post-ship audit finding).
          const answerBody = sanitizeTranscriptText(answer.answer);
          if (answerBody.length > 0) {
            // Ordering matters (post-ship audit): APPEND FIRST — the customer must
            // SEE the answer before we bill it. If the append throws (rare DB error)
            // the outer catch makes the read-back a no-op → no charge for an unseen
            // answer. Only after it's durably stored do we RECORD the spend (soft-cap
            // input) + DEBIT the budget, EACH best-effort so neither skips the other.
            const answerEntry = { at, role: 'agent' as const, body: answerBody };
            sessionAfter = await this.deps.sessions.appendTranscript(session.id, answerEntry);
            this.deps.eventBus?.publish({
              agentSessionId: session.id,
              index: sessionAfter.transcript.length - 1,
              entry: answerEntry,
            });
            if (this.deps.usageRecorder !== undefined && answer.usage !== undefined) {
              // Same retry + loud-log discipline as the decompose row (audit #9):
              // this read-back row is ALSO a real bundled-LLM cost that feeds the
              // monthly soft-cap, so a silent single-shot drop would undercount the
              // cap with no alert. recordUsageRowWithRetry never throws.
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
                },
                { accountId: session.accountId, agentSessionId: session.id, label: 'readback' },
              );
            }
            if (answer.tokensConsumed > 0) {
              try {
                sessionAfter = await this.deps.sessions.debitTokens(
                  session.id,
                  answer.tokensConsumed,
                );
              } catch {
                /* debit best-effort — the spend is already recorded above */
              }
            }
          }
        }
      } catch {
        // Read-back is additive — never fail the turn on it.
      }
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
    /missing text content|not valid JSON|not a JSON object|unknown kind:|intents was not an array|missing clarifyingQuestion|missing refuseReason/i.test(
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

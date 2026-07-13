// Increment-2 — ControlPlaneAgentExecutor: the control-plane AgentExecutor.
//
// Chains the pure data-path pieces into a plan runner:
//   for each AgentIntent in the plan:
//     agentIntentToDispatch (verb → intentName+params, or typed-unsupported)
//       → serializeIntentDispatch (base64 wire envelope)
//       → IntentDispatcher.dispatch (the correlator → WSS → IntentResult)
//       → intentResultToCustomer (ParsedIntentResult → customer IntentResult)
//     accumulate; HALT on the first failure (matches the AgentExecutor contract).
//
// This is the CORRECT-LAYER successor to RealAgentExecutor (agent-executor.ts),
// which dispatched to the local driver — the architecture-superseded path
// (agent-session intents dispatch over the control-plane WSS by intentName, not
// the server driver; see docs/internal/cross-agent-control-plane-contract.md).
//
// Depends only on an injected `IntentDispatcher` — so it's unit-testable with a
// mock dispatcher. #139 go-live: WIRED into bootstrap (gated on
// FLEET_CONTROL_PLANE_ENABLED) via FleetSessionRoutingDispatcher, which routes
// each intent to the correlator of the node the session was dispatched to
// (agent_sessions.node_id → registry). Without the flag, bootstrap keeps the
// StubAgentExecutor (demo/test path). The dispatcher fails honestly when no box
// is connected — never a fake success.
//
// Never throws (AgentExecutor contract): a mapping miss, an encode error, and a
// dispatch failure (the dispatcher itself never rejects) all surface as a
// `kind:'failure'` IntentResult.

import { randomUUID } from 'node:crypto';
import type {
  AgentExecutor,
  ExecuteArgs,
  ExecutorRunResult,
  IntentResult,
} from './agent-executor.js';
import { consequentialHalt } from './agent-executor.js';
import { agentIntentToDispatch } from './agent-intent-to-dispatch.js';
import { intentResultToCustomer } from './agent-intent-result.js';
import { serializeIntentDispatch, type ParsedIntentResult } from './harness-control-codec.js';
import type { IntentDispatch, HarnessIntentName } from '../schemas/harness-control-protocol.js';

/** The dispatch port the executor needs — IntentDispatchCorrelator implements
 *  it. dispatch() must never reject (resolve with a failure ParsedIntentResult
 *  on timeout / no-session / drop). */
export interface IntentDispatcher {
  dispatch(dispatch: IntentDispatch): Promise<ParsedIntentResult>;
}

/** doc-132 §5.3 slice 3 — bounded auto-retry of transient failures. */
export interface AutoRetryOptions {
  /** Extra attempts AFTER the first, for a step whose failure diagnosis is
   *  `retryable`. Default 2 → up to 3 total attempts per intent. 0 disables. */
  maxRetries?: number;
  /** Backoff between attempts (ms). Default 400. */
  retryDelayMs?: number;
  /** Retries reserved for a `intent_session_not_established` failure — the box
   *  fork is still COLD-STARTING its WebDriver (~7-10s). Longer + patient so the
   *  first intent after a just-created session doesn't give up before the
   *  browser is ready. Default 8. */
  sessionEstablishMaxRetries?: number;
  /** Backoff between session-establish retries (ms). Default 1500 → 8×1500 = 12s
   *  covers the cold start. */
  sessionEstablishRetryDelayMs?: number;
  /** #140 read-back deadline (ms). observe() dispatches get_page_source whose
   *  own per-intent budget is the full 30s; this shorter cap bounds the latency a
   *  hung/slow box can add to a turn whose plan ALREADY succeeded. Default 10000. */
  observeTimeoutMs?: number;
  /** Injectable sleep so tests run instantly. Default: real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 400;
// Browser cold-start: the box fork takes ~7-10s to spawn + establish its
// per-session WebDriver server. The FIRST intent after a just-created session
// (e.g. the founder immediately sends "go to X") can beat it →
// `intent_session_not_established`. 8 × 1500ms = 12s patiently covers the warmup
// without hanging a genuinely dead session too long.
const DEFAULT_SESSION_ESTABLISH_MAX_RETRIES = 8;
const DEFAULT_SESSION_ESTABLISH_RETRY_DELAY_MS = 1500;
// #140 read-back deadline. get_page_source on a healthy box returns in <2s; a
// hung box would otherwise burn the full 30s dispatch budget AFTER the plan has
// already succeeded + been recorded. 10s cleanly separates "alive but slow"
// (returns well under) from "hung" (never returns) so the read-back degrades to
// "no answer, plan result stands" fast instead of freezing the turn.
const DEFAULT_OBSERVE_TIMEOUT_MS = 10_000;
export class ControlPlaneAgentExecutor implements AgentExecutor {
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly sessionEstablishMaxRetries: number;
  private readonly sessionEstablishRetryDelayMs: number;
  private readonly observeTimeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly dispatcher: IntentDispatcher,
    /** intentId generator — injectable for deterministic tests. */
    private readonly genIntentId: () => string = () => `int_${randomUUID()}`,
    opts: AutoRetryOptions = {},
  ) {
    this.maxRetries = Math.max(0, opts.maxRetries ?? DEFAULT_MAX_RETRIES);
    this.retryDelayMs = Math.max(0, opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
    this.sessionEstablishMaxRetries = Math.max(
      0,
      opts.sessionEstablishMaxRetries ?? DEFAULT_SESSION_ESTABLISH_MAX_RETRIES,
    );
    this.sessionEstablishRetryDelayMs = Math.max(
      0,
      opts.sessionEstablishRetryDelayMs ?? DEFAULT_SESSION_ESTABLISH_RETRY_DELAY_MS,
    );
    this.observeTimeoutMs = Math.max(0, opts.observeTimeoutMs ?? DEFAULT_OBSERVE_TIMEOUT_MS);
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async execute(args: ExecuteArgs): Promise<ExecutorRunResult> {
    const results: IntentResult[] = [];
    const approved = new Set(args.approvedConsequentialActions ?? []);
    // #139 — dispatch on the AGENT session id (the box + agent_sessions.node_id
    // routing key). Fall back to `sessionId` only if the runtime didn't thread it
    // (legacy callers) — never dispatch on the `unattached` sentinel.
    const dispatchSessionId = args.agentSessionId ?? args.sessionId;
    for (const intent of args.plan.intents) {
      // 0. W443/W445 consequential-action gate — halt (WITHOUT dispatching) on a
      //    purchase / payment / account-deletion the customer hasn't approved this
      //    run. Identical gate to Stub/RealAgentExecutor: the go-live swap must NOT
      //    silently drop it (a real box would otherwise execute the action for
      //    real). The customer approves → the plan re-runs with the signature in
      //    approvedConsequentialActions.
      const halt = consequentialHalt(intent, approved);
      if (halt) {
        results.push(halt);
        return { results, ok: false, awaitingConfirmation: true };
      }

      // 1. Map the customer verb → harness intentName + params (or unsupported).
      const mapped = agentIntentToDispatch(intent);
      if (!mapped.ok) {
        results.push({ kind: 'failure', intent, reason: mapped.reason });
        // #139 — a best-effort `wait` that can't even be MAPPED (e.g. the model
        // emits `selector_visible` with no selector) must NOT abort the plan and
        // lose the steps after it (the customer's screenshot), mirroring the
        // dispatch-failure exemption below. Any OTHER unmappable intent still halts.
        if (intent.kind === 'wait') continue;
        break;
      }

      // 2-4. Dispatch (with bounded auto-retry) + map the result back.
      const result = await this.runIntent(
        dispatchSessionId,
        intent,
        mapped.intentName,
        mapped.params,
      );
      results.push(result);
      // #139 — halt-on-first-failure, EXCEPT a `wait`: a wait is a best-effort
      // synchronization hint (the decomposer inserts idle-settles that a navigate
      // already covers). A wait timing out must NOT abort the plan and lose the
      // steps after it (e.g. the customer's screenshot) — if a later action truly
      // depends on the awaited state, that action fails on its own with a clearer
      // reason. Any non-wait failure still halts.
      if (result.kind === 'failure' && intent.kind !== 'wait') break;
    }

    return { results, ok: results.every((r) => r.kind === 'success') };
  }

  /**
   * #140 read-and-report — dispatch a `get_page_source` against the live session
   * and return its text for the answer pass. Best-effort: any failure (no
   * session, dispatch error, over-cap `result_too_large`, empty source) returns
   * null so the runtime falls back to the plan result — the read-back never fails
   * a turn. Uses the same dispatcher + fresh intentId as a normal intent.
   */
  async observe(sessionId: string): Promise<string | null> {
    let dispatch: IntentDispatch;
    try {
      dispatch = serializeIntentDispatch({
        sessionId,
        intentId: this.genIntentId(),
        intentName: 'get_page_source',
        params: {},
      });
    } catch {
      return null;
    }
    // Bound the read-back latency: the plan already succeeded + was recorded, so
    // a hung box must not stretch the turn to the full 30s dispatch budget. Race
    // the dispatch against a shorter deadline; on timeout we return null (no
    // answer, plan result stands). get_page_source is read-only, so a late
    // in-flight response we've stopped awaiting is harmlessly dropped.
    const observed = this.dispatcher
      .dispatch(dispatch)
      .then((parsed) => (parsed.success ? extractPageText(parsed.outputData) : null))
      .catch(() => null);
    const timedOut = this.sleep(this.observeTimeoutMs).then((): string | null => null);
    return Promise.race([observed, timedOut]);
  }

  /**
   * One intent, with bounded auto-retry of RETRYABLE transient failures
   * (doc-132 §5.3). Most `retryable` diagnoses prove the intent did NOT take
   * effect, so re-dispatching cannot double-apply a side effect:
   *   - a WebDriver failure on an `interact` (category element_not_found, etc.)
   *     means the atomic WebDriver command errored WITHOUT performing the
   *     action — the tap/type never landed, so a retry is safe;
   *   - a page-load / condition / capture failure is inherently side-effect-free.
   *
   * EXCEPTION (do NOT retry): a `session_error` on an intent that changes page
   * state or human pacing (`interact`, relative `scroll`, or
   * `behavioral_pause`).
   * That category is synthesized by the dispatch correlator for a dispatch
   * TIMEOUT and a control-connection DROP (failAll) as well as a genuine
   * no-session — and in the timeout/drop cases the intent was already
   * transmitted to the harness, so the action MAY have executed and only its
   * ack was lost. Each retry uses a FRESH intentId with no harness-side dedup,
   * so blindly retrying a tap/type/press here would double-apply it (a
   * double-submit — exactly what an approved consequential action must never
   * become; approval is not idempotency). A top-level scroll is also relative,
   * while behavioral_pause may scroll through content and always controls the
   * dwell timeline; replaying either produces extra movement or a robotic
   * double-pause. We cannot distinguish "never sent" from "sent, executed, ack
   * lost" at this layer, so we fail safe: surface the failure on the first
   * attempt and let the agent/customer re-issue explicitly. Replay-safe kinds
   * (navigate to the same URL, wait, capture) stay retryable on session_error.
   *
   * Non-retryable failures (invalid request, over-cap result) and encode errors
   * are deterministic — surfaced on the first attempt, never retried. Each
   * attempt gets a fresh intentId (a new dispatch to correlate).
   */
  private async runIntent(
    sessionId: string,
    intent: ExecuteArgs['plan']['intents'][number],
    intentName: HarnessIntentName,
    params: Record<string, unknown>,
  ): Promise<IntentResult> {
    let result: IntentResult = { kind: 'failure', intent, reason: 'no dispatch attempt made' };
    // Two independent budgets: the short general retryable-failure budget, and a
    // longer PATIENT budget reserved for a cold-starting session (see below).
    let retryAttempt = 0;
    let establishAttempt = 0;
    for (;;) {
      // Serialize to the base64 wire envelope (fresh intentId per attempt).
      // Re-validates params; should not fail (agentIntentToDispatch already
      // validated), but the executor must never throw — a guard converts any
      // encode error to a (non-retried) failure.
      let dispatch: IntentDispatch;
      try {
        dispatch = serializeIntentDispatch({
          sessionId,
          intentId: this.genIntentId(),
          intentName,
          params,
        });
      } catch (err) {
        return {
          kind: 'failure',
          intent,
          reason: err instanceof Error ? err.message : 'failed to encode intent dispatch',
        };
      }

      // Dispatch over the control plane; the dispatcher never rejects (failure
      // → a failure ParsedIntentResult).
      const parsed = await this.dispatcher.dispatch(dispatch);
      result = intentResultToCustomer(intent, parsed);
      if (result.kind !== 'failure') return result;

      // BROWSER COLD-START — `intent_session_not_established` means the box fork's
      // per-session WebDriver isn't up yet (~7-10s spawn). Unlike a dispatch-timeout
      // session_error (transmitted-but-unacked → MAY have executed), a
      // not-established result means NO session existed to run the command →
      // DEFINITELY side-effect-free → safe to retry patiently for ANY intent kind
      // (including a side-effecting interact). Give it the long establish budget so
      // the FIRST intent after a just-created session waits for the warmup instead
      // of giving up (founder: "it gave up because the browser takes a while to
      // launch"). Read the raw errorCode (not the coarser diagnosis category, which
      // lumps this with dispatch_error).
      if (
        parsed.errorCode === 'intent_session_not_established' &&
        establishAttempt < this.sessionEstablishMaxRetries
      ) {
        establishAttempt++;
        await this.sleep(this.sessionEstablishRetryDelayMs);
        continue;
      }

      // A session_error on a gesture/pacing intent MAY have already executed
      // (dispatch-timeout / connection-drop are transmitted-but-unacked), and a
      // retry uses a fresh intentId with no harness dedup → could double-apply a
      // control, relative scroll, reading-scroll, or dwell. Fail safe: don't
      // auto-retry those classes. See the method doc above.
      // (session_not_established is handled ABOVE — it's the not-executed subset.)
      const maybeAlreadyApplied =
        result.diagnosis?.category === 'session_error' &&
        (intent.kind === 'interact' ||
          intent.kind === 'scroll' ||
          intent.kind === 'behavioral_pause');
      // #139 — a `wait_for` already has its OWN internal timeout (timeout_seconds);
      // retrying a timed-out wait just re-waits the same duration for the same
      // still-false condition — pure latency (3×5s), never a different outcome. So
      // a wait is single-shot (except a genuine transport session_error, which is a
      // dispatch problem, not a condition timeout — that still retries here).
      const isRedundantWaitRetry =
        intent.kind === 'wait' && result.diagnosis?.category === 'condition_not_met';
      const shouldRetry =
        result.diagnosis?.retryable === true &&
        !maybeAlreadyApplied &&
        !isRedundantWaitRetry &&
        retryAttempt < this.maxRetries;
      if (!shouldRetry) return result;
      retryAttempt++;
      await this.sleep(this.retryDelayMs);
    }
  }
}

/**
 * #140 — defensive extraction of the page-source text from a `get_page_source`
 * result's outputData. The exact key is A3-confirmed pending (bus 2026-07-07) —
 * handle the raw-string form + the common object shapes so the wiring works
 * regardless of the final key. Returns null for an empty/absent source.
 */
export function extractPageText(outputData: unknown): string | null {
  if (typeof outputData === 'string') return outputData.length > 0 ? outputData : null;
  if (typeof outputData === 'object' && outputData !== null) {
    const o = outputData as Record<string, unknown>;
    for (const key of ['source', 'pageSource', 'html', 'content', 'text']) {
      const v = o[key];
      if (typeof v === 'string' && v.length > 0) return v;
    }
  }
  return null;
}

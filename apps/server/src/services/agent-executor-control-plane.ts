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
  /** Injectable sleep so tests run instantly. Default: real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 400;
const EMPTY_APPROVED: ReadonlySet<string> = new Set<string>();

export class ControlPlaneAgentExecutor implements AgentExecutor {
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly dispatcher: IntentDispatcher,
    /** intentId generator — injectable for deterministic tests. */
    private readonly genIntentId: () => string = () => `int_${randomUUID()}`,
    opts: AutoRetryOptions = {},
  ) {
    this.maxRetries = Math.max(0, opts.maxRetries ?? DEFAULT_MAX_RETRIES);
    this.retryDelayMs = Math.max(0, opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async execute(args: ExecuteArgs): Promise<ExecutorRunResult> {
    const results: IntentResult[] = [];
    const approved = args.approvedConsequentialActions ?? EMPTY_APPROVED;
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
      if (result.kind === 'failure') break; // halt-on-first-failure
    }

    return { results, ok: results.every((r) => r.kind === 'success') };
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
   * EXCEPTION (do NOT retry): a `session_error` on a side-effecting `interact`.
   * That category is synthesized by the dispatch correlator for a dispatch
   * TIMEOUT and a control-connection DROP (failAll) as well as a genuine
   * no-session — and in the timeout/drop cases the intent was already
   * transmitted to the harness, so the action MAY have executed and only its
   * ack was lost. Each retry uses a FRESH intentId with no harness-side dedup,
   * so blindly retrying a tap/type/press here would double-apply it (a
   * double-submit — exactly what an approved consequential action must never
   * become; approval is not idempotency). We cannot distinguish "never sent"
   * from "sent, executed, ack lost" at this layer, so we fail safe: surface the
   * failure on the first attempt and let the agent/customer re-issue explicitly.
   * Read-only / idempotent kinds (navigate to the same URL, wait, capture,
   * scroll, behavioral_pause) stay retryable on session_error — a double-apply
   * there is harmless.
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
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
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

      // A session_error on a side-effecting interact MAY have already executed
      // (dispatch-timeout / connection-drop are transmitted-but-unacked), and a
      // retry uses a fresh intentId with no harness dedup → would double-apply.
      // Fail safe: don't auto-retry that one class. See the method doc above.
      const maybeAlreadyApplied =
        result.kind === 'failure' &&
        result.diagnosis?.category === 'session_error' &&
        intent.kind === 'interact';
      const shouldRetry =
        result.kind === 'failure' &&
        result.diagnosis?.retryable === true &&
        !maybeAlreadyApplied &&
        attempt < this.maxRetries;
      if (!shouldRetry) return result;
      await this.sleep(this.retryDelayMs);
    }
    return result;
  }
}

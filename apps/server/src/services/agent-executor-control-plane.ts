// Increment-2 — ControlPlaneAgentExecutor: the control-plane AgentExecutor.
//
// Chains the pure data-path pieces into a plan runner:
//   for each AgentIntent in the plan:
//     agentIntentToDispatch (verb → intentName+params, or typed-unsupported)
//       → serializeIntentDispatch (base64 wire envelope)
//       → IntentDispatcher.dispatch (the correlator → WSS → IntentResult)
//       → intentResultToCustomer (ParsedIntentResult → customer IntentResult)
//     accumulate; HALT on the first failure, EXCEPT a failed `wait` (#139),
//     which is best-effort and does not abort the plan.
//
// V-1099 — this line read "HALT on the first failure (matches the
// AgentExecutor contract)" in the file that implements the exception, forty
// lines above `if (result.result.kind === 'failure' && intent.kind !== 'wait')`.
// The contract in agent-executor.ts now records the exception too, so the
// parenthetical is true again by being unnecessary.
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
  ElementWaitBudget,
  ExecuteArgs,
  ExecutorRunResult,
  IntentResult,
} from './agent-executor.js';
import {
  consequentialHalt,
  executionMayContinue,
  substituteCredentials,
} from './agent-executor.js';
import { agentIntentToDispatch } from './agent-intent-to-dispatch.js';
import { intentReplayMayDuplicateEffect, intentResultToCustomer } from './agent-intent-result.js';
import type { SessionCaptureStore } from './session-capture-store.js';

/** #7 — pull a screenshot's inline bytes out of a capture intent's harness result
 *  (ScreenshotResultSchema: { screenshot_b64, format }). Defensive: a malformed /
 *  missing payload returns null and the capture just carries no fetchable image. */
function readScreenshot(outputData: unknown): { b64: string; format: 'png' | 'jpeg' } | null {
  if (typeof outputData !== 'object' || outputData === null) return null;
  const o = outputData as Record<string, unknown>;
  const b64 = o.screenshot_b64;
  if (typeof b64 !== 'string' || b64.length === 0) return null;
  return { b64, format: o.format === 'jpeg' ? 'jpeg' : 'png' };
}
import { serializeIntentDispatch, type ParsedIntentResult } from './harness-control-codec.js';
import type { IntentDispatch, HarnessIntentName } from '../schemas/harness-control-protocol.js';

/** The dispatch port the executor needs — IntentDispatchCorrelator implements
 *  it. dispatch() must never reject (resolve with a failure ParsedIntentResult
 *  on timeout / no-session / drop). */
export interface IntentDispatcher {
  dispatch(dispatch: IntentDispatch): Promise<ParsedIntentResult>;
}

interface RunIntentOutcome {
  /** A result may already have settled before authority was revoked. Retain it
   * as redacted partial evidence, but never publish it as a normal turn. */
  result: IntentResult | null;
  authorityLost: boolean;
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
  /** P3 — how long ONE step may wait for a selector that was not on the page
   *  yet. See {@link DEFAULT_ELEMENT_APPEAR_WAIT_MS} for where the number comes
   *  from. 0 disables the element wait and restores the pre-P3 behaviour. */
  elementAppearWaitMs?: number;
  /** P3 — total element-wait time ONE execute() run may spend across all its
   *  steps. See {@link DEFAULT_ELEMENT_WAIT_RUN_BUDGET_MS}. */
  elementWaitRunBudgetMs?: number;
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

// ── P3 patience ──────────────────────────────────────────────────────
// WHY A SEPARATE BUDGET FROM `retryDelayMs`. `intent_element_not_found` is not a
// transient transport fault, it is a statement about the PAGE: the selector
// resolved against a DOM that does not contain the element YET. Re-dispatching
// the same lookup three times 400ms apart spends 800ms of patience and then
// reports "no element matched" about a control that renders at 2500ms — the
// measured death of the eval's F3 task, and the shape of "it gave up" the owner
// reported. The two budgets answer different questions and must not share a
// number.
//
// WHERE 5000ms COMES FROM. Largest Contentful Paint is the published field
// threshold for when a page's main content is on screen: ≤2500ms at p75 is
// "good" and >4000ms is "poor". The old 800ms gave up before even a GOOD page
// had painted. 5000ms covers the whole good + needs-improvement band plus the
// device round trip, so a page a real person would call "fine, a bit slow" is
// inside the budget and a page nobody would wait for is not.
const DEFAULT_ELEMENT_APPEAR_WAIT_MS = 5_000;
// WHY A RUN-WIDE CEILING. Per-step patience alone multiplies: an 8-intent plan
// where every selector is wrong would add 8 × 5s before failing, and a failing
// page must not take forever (that is the same complaint from the other side).
// 15s = three full waits — enough for the realistic case (a slow page costs the
// wait once or twice), and a hard stop for the pathological one. Past the
// ceiling a missing element fails immediately, exactly as it did before P3.
const DEFAULT_ELEMENT_WAIT_RUN_BUDGET_MS = 15_000;

export class ControlPlaneAgentExecutor implements AgentExecutor {
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly sessionEstablishMaxRetries: number;
  private readonly sessionEstablishRetryDelayMs: number;
  private readonly observeTimeoutMs: number;
  private readonly elementAppearWaitMs: number;
  private readonly elementWaitRunBudgetMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly dispatcher: IntentDispatcher,
    /** intentId generator — injectable for deterministic tests. */
    private readonly genIntentId: () => string = () => `int_${randomUUID()}`,
    opts: AutoRetryOptions = {},
    /** #7 — where a screenshot capture's bytes are stashed (minting the captureId
     *  put on the result). Optional: absent → captures still succeed, just with no
     *  fetchable image (the pre-#7 behaviour), so existing callers/tests are intact. */
    private readonly captureStore?: SessionCaptureStore,
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
    // ⛔ CLAMPED TO WHAT THE DEVICE CAN ACTUALLY BE ASKED FOR. `wait_for` takes
    // whole SECONDS, so the mapper drops a sub-second timeout and the device
    // falls back to its own 30s default — a setting of 500ms would have bought
    // a THIRTY-second wait while the run ceiling was debited 500ms, i.e. a
    // number meant to reduce patience multiplying it sixtyfold. Round a positive
    // sub-second value up to the smallest expressible wait so the budget debits
    // what is actually spent; 0 still means "disabled".
    const requestedAppearWaitMs = Math.max(
      0,
      opts.elementAppearWaitMs ?? DEFAULT_ELEMENT_APPEAR_WAIT_MS,
    );
    this.elementAppearWaitMs =
      requestedAppearWaitMs > 0 ? Math.max(1_000, requestedAppearWaitMs) : 0;
    this.elementWaitRunBudgetMs = Math.max(
      0,
      opts.elementWaitRunBudgetMs ?? DEFAULT_ELEMENT_WAIT_RUN_BUDGET_MS,
    );
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async execute(args: ExecuteArgs): Promise<ExecutorRunResult> {
    const results: IntentResult[] = [];
    // Record a result AND surface it as live progress in one place, so every
    // push (halt / unmappable / dispatched) streams to a subscribed caller as it
    // lands rather than only in the final ExecutorRunResult. Best-effort: a
    // throwing/slow onStep must never abort or block the run.
    const emitStep = (r: IntentResult): void => {
      results.push(r);
      try {
        args.onStep?.(r, results.length - 1);
      } catch {
        /* a broken progress handler must not affect execution */
      }
    };
    const approved = new Set(args.approvedConsequentialActions ?? []);
    // P3 — the element-wait ceiling, shared by every step so the extra patience
    // cannot multiply by plan length. Mutated by runIntent. The RUNTIME owns one
    // per turn and threads it here (see ExecuteArgs.elementWaitBudget), because a
    // turn now runs up to three plans and a per-run ceiling would be three
    // ceilings. An unseeded or absent budget is filled from this executor's own
    // configured run budget, so a caller never has to know the number.
    const elementWaitBudget: ElementWaitBudget = args.elementWaitBudget ?? { remainingMs: null };
    elementWaitBudget.remainingMs ??= this.elementWaitRunBudgetMs;
    // #139 — dispatch on the AGENT session id (the box + agent_sessions.node_id
    // routing key). Fall back to `sessionId` only if the runtime didn't thread it
    // (legacy callers) — never dispatch on the `unattached` sentinel.
    const dispatchSessionId = args.agentSessionId ?? args.sessionId;
    for (const [planIndex, intent] of args.plan.intents.entries()) {
      if (!(await executionMayContinue(args.shouldContinue))) {
        return { results, ok: false, authorityLost: true };
      }
      // 0. W443/W445 consequential-action gate — halt (WITHOUT dispatching) on a
      //    purchase / payment / account-deletion the customer hasn't approved this
      //    run. Identical gate to Stub/RealAgentExecutor: the go-live swap must NOT
      //    silently drop it (a real box would otherwise execute the action for
      //    real). The customer approves → the plan re-runs with the signature in
      //    approvedConsequentialActions.
      const halt = consequentialHalt(intent, approved);
      if (halt) {
        emitStep(halt);
        return { results, ok: false, awaitingConfirmation: true };
      }
      // Announce the step BEFORE it runs — but AFTER the safety gate above.
      // ⛔ Announcing first told the customer the agent was doing the very thing
      // the gate was blocking ("Tapping Buy now…" beside an unanswered Approve),
      // which is untrue in the one place being untrue costs the most. Keyed on
      // the PLAN index, not results.length, so the marker lines up with the plan
      // list the customer is looking at even where a result is skipped. Same
      // best-effort contract as emitStep: a broken handler cannot stall a dispatch.
      try {
        args.onStepStart?.(intent, planIndex);
      } catch {
        /* a broken progress handler must not affect execution */
      }

      // 0.5. P2 — resolve credential placeholders into the value the DEVICE
      //      gets. `intent` (the placeholder form) is what every result below
      //      carries, so the secret reaches the dispatch and nothing else.
      const substitution = substituteCredentials(intent, args.credentials);
      if (!substitution.ok) {
        emitStep({
          kind: 'failure',
          intent,
          // Names the missing credential, never a value — and the customer-
          // facing repair is real: they can add it.
          reason:
            substitution.why === 'not_held'
              ? `this step needs a saved credential named "${substitution.unresolved}", and this chat does not have one`
              : `this step tried to put the saved credential "${substitution.unresolved}" somewhere it cannot be used safely, so it was not sent`,
          diagnosis: { category: 'invalid_request', retryable: false },
        });
        break;
      }
      const dispatchIntent = substitution.intent;

      // 1. Map the customer verb → harness intentName + params (or unsupported).
      const mapped = agentIntentToDispatch(dispatchIntent);
      if (!mapped.ok) {
        emitStep({ kind: 'failure', intent, reason: mapped.reason });
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
        args.shouldContinue,
        elementWaitBudget,
      );
      if (result.result !== null) emitStep(result.result);
      if (result.authorityLost) return { results, ok: false, authorityLost: true };
      if (result.result === null) return { results, ok: false };
      // #139 — halt-on-first-failure, EXCEPT a `wait`: a wait is a best-effort
      // synchronization hint (the decomposer inserts idle-settles that a navigate
      // already covers). A wait timing out must NOT abort the plan and lose the
      // steps after it (e.g. the customer's screenshot) — if a later action truly
      // depends on the awaited state, that action fails on its own with a clearer
      // reason. Any non-wait failure still halts.
      if (result.result.kind === 'failure' && intent.kind !== 'wait') break;
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
  async observe(
    sessionId: string,
    shouldContinue?: ExecuteArgs['shouldContinue'],
  ): Promise<string | null> {
    if (!(await executionMayContinue(shouldContinue))) return null;
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
    if (!(await executionMayContinue(shouldContinue))) return null;
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
    const result = await Promise.race([observed, timedOut]);
    if (!(await executionMayContinue(shouldContinue))) return null;
    return result;
  }

  /**
   * P1 — the same read as {@link observe}, digested for PLANNING rather than for
   * answering. One dispatch, then {@link summarizePageForPlanning}; null
   * whenever observe() returns null, so a page that cannot be read degrades to
   * "plan without it" exactly as before.
   */
  async observeDigest(
    sessionId: string,
    shouldContinue?: ExecuteArgs['shouldContinue'],
  ): Promise<string | null> {
    const source = await this.observe(sessionId, shouldContinue);
    if (source === null) return null;
    const digest = summarizePageForPlanning(source);
    return digest.length > 0 ? digest : null;
  }

  /**
   * P3 — dispatch ONE `wait_for` for `selector`, through the SAME mapper the
   * plan's own waits go through (so the predicate the box evaluates is the one
   * that is already under test, not a second hand-built copy that can drift).
   *
   * Returns 'appeared' only on a successful wait. Every other outcome — an
   * unmappable selector, an encode error, a dispatch failure, the wait timing
   * out — is 'absent': the caller then surfaces the original element-not-found
   * failure, which is the honest reading in all of them.
   */
  private async waitForElement(
    sessionId: string,
    selector: string,
    timeoutMs: number,
    shouldContinue: ExecuteArgs['shouldContinue'],
  ): Promise<'appeared' | 'absent' | 'authority_lost'> {
    if (!(await executionMayContinue(shouldContinue))) return 'authority_lost';
    const mapped = agentIntentToDispatch({
      kind: 'wait',
      condition: 'selector_visible',
      selector,
      timeoutMs,
    });
    if (!mapped.ok) return 'absent';
    // ⛔ THE VERB ON THE WIRE IS A LITERAL, NOT `mapped.intentName`. The device
    // has no allowlist of its own, so what keeps a request from steering the
    // control plane into a verb it never meant to send is that every emit site
    // names its verb in source (pinned by the-control-plane-never-dispatches-
    // a-verb-it-does-not-hard-code). The mapper is used here for the PARAMS —
    // the visibility predicate under test — and is only ASKED to agree on the
    // verb. If it ever stops agreeing, the wait fails closed and the caller
    // surfaces the original element-not-found, rather than this site quietly
    // dispatching whatever the mapper now returns.
    if (mapped.intentName !== 'wait_for') return 'absent';
    let dispatch: IntentDispatch;
    try {
      dispatch = serializeIntentDispatch({
        sessionId,
        intentId: this.genIntentId(),
        intentName: 'wait_for',
        params: mapped.params,
      });
    } catch {
      return 'absent';
    }
    const parsed = await this.dispatcher.dispatch(dispatch);
    if (!(await executionMayContinue(shouldContinue))) return 'authority_lost';
    return parsed.success ? 'appeared' : 'absent';
  }

  /**
   * One intent, with bounded auto-retry of RETRYABLE transient failures
   * (doc-132 §5.3). Read-only capture failures remain recoverable.
   *
   * EXCEPTION (do NOT retry): the harness's coarse `intent_dispatch_error` or
   * `intent_webdriver_failed` on an intent that changes page state or human
   * pacing (`navigate`, `interact`, relative `scroll`, or `behavioral_pause`). A
   * dispatch timeout/drop may lose the acknowledgement after execution, and an
   * HTTP WebDriver response can likewise fail after the browser applied the request.
   * Composite typing/scrolling can also fail after a partial prefix. Each retry
   * uses a FRESH intentId with no harness-side dedup, so it could double-submit,
   * duplicate text/keys, add movement, or replay a dwell. We cannot distinguish
   * "not applied" from "applied, response lost" at this layer, so these failures
   * are surfaced on the first attempt with outcome-unknown guidance.
   * `intent_session_not_established` remains the proven-not-executed subset and
   * is handled before this fence with its patient cold-start retry budget.
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
    shouldContinue: ExecuteArgs['shouldContinue'],
    elementWaitBudget: ElementWaitBudget = { remainingMs: 0 },
  ): Promise<RunIntentOutcome> {
    let result: IntentResult | null = null;
    // Two independent budgets: the short general retryable-failure budget, and a
    // longer PATIENT budget reserved for a cold-starting session (see below).
    let retryAttempt = 0;
    let establishAttempt = 0;
    // P3 — at most ONE element wait per step. A second would be re-asking a
    // question the first already answered with the page's own timeout.
    let elementWaitUsed = false;
    for (;;) {
      // Re-check on EVERY attempt, including after either retry sleep. A close
      // that wins while the box is cold or a retry backs off stops the suffix
      // before a fresh intentId is minted or another external dispatch starts.
      if (!(await executionMayContinue(shouldContinue))) {
        return { result, authorityLost: true };
      }
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
          result: {
            kind: 'failure',
            intent,
            reason: err instanceof Error ? err.message : 'failed to encode intent dispatch',
          },
          authorityLost: false,
        };
      }

      // Dispatch over the control plane; the dispatcher never rejects (failure
      // → a failure ParsedIntentResult).
      const parsed = await this.dispatcher.dispatch(dispatch);
      result = intentResultToCustomer(intent, parsed);
      // #7 — a successful screenshot returns its bytes inline in parsed.outputData.
      // Stash them in the capture store (kept OUT of the encrypted transcript) and
      // put only the minted captureId on the result, so the GUI can fetch + show the
      // image via GET .../captures/:id rather than the transcript carrying the bytes.
      if (
        result.kind === 'success' &&
        intent.kind === 'capture' &&
        intent.capture === 'screenshot' &&
        this.captureStore !== undefined
      ) {
        const shot = readScreenshot(parsed.outputData);
        if (shot !== null) {
          result = {
            ...result,
            captureId: this.captureStore.put(sessionId, shot.b64, shot.format),
          };
        }
      }
      if (!(await executionMayContinue(shouldContinue))) {
        return { result, authorityLost: true };
      }
      if (result.kind !== 'failure') return { result, authorityLost: false };

      // BROWSER COLD-START — `intent_session_not_established` means the box fork's
      // per-session WebDriver isn't up yet (~7-10s spawn). Unlike a dispatch-timeout
      // session_error (transmitted-but-unacked → MAY have executed), a
      // not-established result means NO session existed to run the command →
      // DEFINITELY side-effect-free → safe to retry patiently for ANY intent kind
      // (including a side-effecting interact). Give it the long establish budget so
      // the FIRST intent after a just-created session waits for the warmup instead
      // of giving up (founder: "it gave up because the browser takes a while to
      // launch"). Read the raw errorCode because only this specific refusal proves
      // the request never reached page execution.
      if (
        parsed.errorCode === 'intent_session_not_established' &&
        establishAttempt < this.sessionEstablishMaxRetries
      ) {
        establishAttempt++;
        await this.sleep(this.sessionEstablishRetryDelayMs);
        continue;
      }

      // P3 PATIENCE — the element was not on the page. That is a statement about
      // the PAGE, not about the transport, so the answer is to WAIT FOR THE
      // ELEMENT rather than to re-ask the same question on a fixed 400ms
      // cadence. One `wait_for` on the same selector returns the moment the
      // element renders (a fast page pays almost nothing) and gives up at the
      // budget (a page that will never render it pays it once). `element_not_found`
      // proves the lookup ran and the intent did NOT execute, so the retry after
      // a successful wait cannot double-apply anything — the same reasoning that
      // already makes this code retryable.
      //
      // ⛔ A FAILED WAIT ENDS THE STEP. Returning the ORIGINAL element-not-found
      // failure keeps the customer-facing reason about the thing that is
      // actually wrong (the selector matched nothing) instead of renaming it as
      // a wait timeout, and it stops the step from spending the general retry
      // budget re-confirming an answer the wait just gave.
      const waitSelector = selectorOf(intent);
      if (
        parsed.errorCode === 'intent_element_not_found' &&
        waitSelector !== null &&
        !elementWaitUsed &&
        this.elementAppearWaitMs > 0 &&
        elementWaitBudget.remainingMs !== null &&
        elementWaitBudget.remainingMs >= this.elementAppearWaitMs
      ) {
        elementWaitUsed = true;
        elementWaitBudget.remainingMs -= this.elementAppearWaitMs;
        const appeared = await this.waitForElement(
          sessionId,
          waitSelector,
          this.elementAppearWaitMs,
          shouldContinue,
        );
        if (appeared === 'authority_lost') return { result, authorityLost: true };
        if (appeared === 'appeared') continue;
        return { result, authorityLost: false };
      }

      // A coarse dispatch or WebDriver failure on a gesture/pacing intent MAY
      // have already executed, and a retry uses a fresh intentId with no harness
      // dedup. Fail safe: don't auto-retry those classes. The mapper uses the
      // same predicate for both coarse ambiguous codes so customer guidance and
      // executor behavior agree. Proven pre-execution refusal codes remain
      // retryable and do not enter this fence.
      // (session_not_established is handled ABOVE — it's the not-executed subset.)
      const maybeAlreadyApplied =
        intentReplayMayDuplicateEffect(intent) &&
        (parsed.errorCode === 'intent_webdriver_failed' ||
          parsed.errorCode === 'intent_dispatch_error');
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
      if (!shouldRetry) return { result, authorityLost: false };
      retryAttempt++;
      await this.sleep(this.retryDelayMs);
    }
  }
}

// ── P1 page digest ───────────────────────────────────────────────────
//
// WHY A DIGEST AND NOT THE PAGE. `get_page_source` returns the document. A real
// one is tens to hundreds of kilobytes of markup, styling and script — the model
// would pay for all of it, most of a context window would be spent on things
// nothing can be planned against, and the handful of facts a plan actually needs
// (what can I tap, what can I type into, where do the links go) would be buried.
//
// WHERE THE BUDGET COMES FROM. The planning call already carries a ~2.5k-token
// system prompt plus the session transcript. 4,000 characters is roughly 1,000
// tokens — about a tenth of a typical turn's input — and at ~60 characters a row
// it holds ~60 interactive elements. Sixty is past the actionable surface of any
// page a person navigates by hand: pages with more than that are navigation
// indexes, where the first sixty in document order are the header, the primary
// nav and the start of the content — the part a plan targets.
const MAX_PAGE_DIGEST_CHARS = 4_000;
const MAX_PAGE_DIGEST_ELEMENTS = 60;

/** One interactive element, as the planner sees it: how to address it, what it
 *  is, and what it says. Nothing else is plannable. */
interface DigestedElement {
  selector: string;
  kind: string;
  text: string;
}

const INTERACTIVE_TAG_RE =
  /<(a|button|input|select|textarea|summary)\b([^>]*)>([\s\S]*?)<\/\1>|<(input|select|textarea)\b([^>]*)\/?>/gi;
const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*"([^"]*)"/g;
const TITLE_RE = /<title\b[^>]*>([\s\S]*?)<\/title>/i;

/** Attributes as a plain map. Single-quoted and unquoted forms are skipped
 *  deliberately: a selector built from a half-parsed attribute is worse than no
 *  selector, because the model would plan against it and the dispatch would
 *  fail somewhere that looks like the page's fault. */
function readAttributes(raw: string): Map<string, string> {
  const attrs = new Map<string, string>();
  ATTR_RE.lastIndex = 0;
  for (let m = ATTR_RE.exec(raw); m !== null; m = ATTR_RE.exec(raw)) {
    const name = m[1];
    const value = m[2];
    if (name !== undefined && value !== undefined) attrs.set(name.toLowerCase(), value);
  }
  return attrs;
}

/** Strip tags and collapse whitespace — the element's visible label. */
function visibleText(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * ⛔ P1/P2 — AN ELEMENT THE DIGEST MUST NOT DESCRIBE AT ALL.
 *
 * A `hidden` input is not interactive: nothing can tap it and nothing can type
 * into it, so it fails this digest's own contract ("what can I tap, what can I
 * type into, where do the links go"). It is also where a page keeps its CSRF
 * token, its session id and its flow state — values that would otherwise travel
 * into a planning prompt, a provider request and a provider log. Both reasons
 * point the same way, so it never earns a row.
 */
function isHiddenInput(tag: string, attrs: Map<string, string>): boolean {
  return tag === 'input' && attrs.get('type')?.toLowerCase() === 'hidden';
}

/**
 * ⛔ P1/P2 — THE LABEL OF A FIELD, NEVER ITS CONTENTS.
 *
 * `value` is what the CUSTOMER (or the site) put in the box: an email already
 * typed into a login form, a password a manager auto-filled, a one-time code. It
 * describes no structure a plan could be written against — the model needs to
 * know the box is there and what it is for, which is exactly what a placeholder,
 * an aria-label or the associated label text says.
 *
 * So `value` is not read here, by ANY branch. That is the whole defence: an
 * exclusion list ("skip password, skip token…") is a guess about naming, and the
 * first field named `pw2` or `secret_answer` defeats it silently. Reading a
 * label and never a value cannot be defeated by a name nobody predicted.
 */
function labelTextFor(inner: string, attrs: Map<string, string>): string {
  return (
    visibleText(inner) ||
    attrs.get('placeholder') ||
    attrs.get('aria-label') ||
    attrs.get('title') ||
    ''
  );
}

/**
 * The most SPECIFIC stable CSS selector the markup supports, in the order a
 * person would pick one: a test id, then an id, then name, then an href or
 * aria-label match. Returns null when nothing addressable is present — an
 * element the plan could not target is not worth a row in the budget.
 */
function selectorFor(tag: string, attrs: Map<string, string>): string | null {
  const testId = attrs.get('data-testid');
  if (testId !== undefined && testId.length > 0) return `[data-testid="${testId}"]`;
  const id = attrs.get('id');
  if (id !== undefined && id.length > 0) return `#${id}`;
  const name = attrs.get('name');
  if (name !== undefined && name.length > 0) return `${tag}[name="${name}"]`;
  const href = attrs.get('href');
  if (tag === 'a' && href !== undefined && href.length > 0) return `a[href="${href}"]`;
  const label = attrs.get('aria-label');
  if (label !== undefined && label.length > 0) return `[aria-label="${label}"]`;
  const type = attrs.get('type');
  if (tag === 'input' && type !== undefined && type.length > 0) return `input[type="${type}"]`;
  return null;
}

/**
 * P1 — turn a raw page source into the BOUNDED digest of interactive elements a
 * plan can be written against.
 *
 * ⛔ THE RESULT IS UNTRUSTED DATA. Every string in it is page-controlled, so the
 * caller frames it as data and never as instructions — the same stance the
 * read-back path already takes with the page text.
 *
 * ⛔ AND IT CARRIES NO FIELD CONTENTS. Every row is (selector · kind · label):
 * the digest reads placeholders, aria-labels and link/button text, and never an
 * input's `value`. It is the same invariant P2 holds on the other side — the
 * credential reaches the dispatch and nothing else — and it would be worthless
 * if the page route then read the filled password field back into the prompt.
 * `hidden` inputs are dropped outright. See {@link labelTextFor}.
 *
 * Degrades rather than disappears: a source with no recognisable markup (a text
 * -only page, or a device that returns rendered text) yields no element rows, so
 * the bounded visible text is returned instead. Returning nothing there would
 * tell the planner "the page is empty", which is a different and false claim.
 */
export function summarizePageForPlanning(
  source: string,
  maxChars: number = MAX_PAGE_DIGEST_CHARS,
  maxElements: number = MAX_PAGE_DIGEST_ELEMENTS,
): string {
  const lines: string[] = [];
  const title = TITLE_RE.exec(source)?.[1];
  if (title !== undefined) {
    const clean = visibleText(title);
    if (clean.length > 0) lines.push(`page: ${clean.slice(0, 120)}`);
  }
  const elements: DigestedElement[] = [];
  INTERACTIVE_TAG_RE.lastIndex = 0;
  for (let m = INTERACTIVE_TAG_RE.exec(source); m !== null; m = INTERACTIVE_TAG_RE.exec(source)) {
    if (elements.length >= maxElements) break;
    const tag = (m[1] ?? m[4] ?? '').toLowerCase();
    if (tag.length === 0) continue;
    const attrs = readAttributes(m[2] ?? m[5] ?? '');
    if (isHiddenInput(tag, attrs)) continue;
    const selector = selectorFor(tag, attrs);
    if (selector === null) continue;
    const text = labelTextFor(m[3] ?? '', attrs);
    elements.push({ selector, kind: tag, text: text.slice(0, 80) });
  }
  for (const el of elements) {
    lines.push(
      el.text.length > 0
        ? `${el.selector} · ${el.kind} · "${el.text}"`
        : `${el.selector} · ${el.kind}`,
    );
  }
  if (elements.length === 0) {
    const text = visibleText(source);
    if (text.length === 0) return lines.join('\n').slice(0, maxChars);
    lines.push(text);
  }
  const digest = lines.join('\n');
  return digest.length > maxChars ? digest.slice(0, maxChars) : digest;
}

/**
 * P3 — the selector an intent needs to EXIST on the page, or null.
 *
 * Scoped to `interact` deliberately. A `wait` already carries its own timeout,
 * so waiting again for the selector it just waited for buys nothing; every other
 * verb either has no selector or does not depend on one being present.
 */
function selectorOf(intent: ExecuteArgs['plan']['intents'][number]): string | null {
  if (intent.kind !== 'interact') return null;
  const selector = intent.selector;
  return typeof selector === 'string' && selector.length > 0 ? selector : null;
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

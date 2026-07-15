// Increment-2 — IntentDispatch correlator + per-intent timeout.
//
// The transport-agnostic CORE of the (gated) /v1/fleet/events WSS sender: it
// owns the request/response correlation + timeout state machine, built to the
// contract A3 settled in bus W106 (2026-06-05). The live socket binding (the WS
// route that calls `send` + feeds `onResultFrame`/`onSessionError`) is the only
// part still gated on the fleet_nodes migration + key provisioning; this core is
// pure logic over an injected transport, so it's unit-testable now and slots
// straight under the socket when it lands.
//
// Contract (A3 W106 — harness IntentExecutor):
//   - Correlate IntentResult → IntentDispatch by `intentId`. For a LIVE session
//     the harness emits EXACTLY ONE IntentResult per dispatch (echoes intentId);
//     never zero, never two.
//   - Unknown/inactive session → the harness emits an errored SessionStatus
//     (detail "intent_dispatch_no_session: <intentName>"), NOT an IntentResult →
//     FAST-FAIL the in-flight dispatch for that session (don't wait the timeout).
//   - Connection drop mid-intent → no result, not replayed → the timeout covers it.
//   - Per-intent timeout = producer execution budget + 15s transport slack.
//     Explicit post-action waits and aggregate behavioral pacing can legally
//     consume 300s; search/login compose TWO such phases; navigation/history
//     has a 55s WebDriver budget. fill_form/scroll still lack a producer-wide
//     wall fence (documented residual below). Only remaining short intents use
//     the 30s base.
//
// dispatch() ALWAYS resolves with a ParsedIntentResult (success or a synthesized
// failure) — it never rejects — so the executor gets a uniform result per intent.
// The executor runs intents SEQUENTIALLY (halt-on-failure), so there is at most
// one in-flight dispatch per session, which makes the by-session fast-fail
// unambiguous even though the SessionStatus names the intentName, not the intentId.

import {
  IntentResultHeaderSchema,
  HARNESS_BEHAVIORAL_PAUSE_CAP_MS,
  HARNESS_WAIT_FOR_CAP_SECONDS,
  type IntentDispatch,
  type HarnessIntentName,
} from '../schemas/harness-control-protocol.js';
import { parseIntentResult, type ParsedIntentResult } from './harness-control-codec.js';

/** The (gated) WS socket binding implements this; tests pass a recording stub. */
export interface DispatchTransport {
  /** Fire-and-forget send of a dispatch frame; the result returns via onResultFrame. */
  send(dispatch: IntentDispatch): void;
}

export const DISPATCH_TIMEOUT_BASE_MS = 30_000;
export const DISPATCH_TIMEOUT_SLACK_MS = 15_000;
export const DISPATCH_NAVIGATION_BUDGET_MS = 55_000;

const SINGLE_CAP_LONG_INTENTS = new Set<HarnessIntentName>([
  'click',
  'send_keys',
  'behavioral_pause',
  'wait_for',
]);

const COMPOSITE_LONG_INTENTS = new Set<HarnessIntentName>(['search', 'login']);

// Provisional bounded loss detectors, NOT claimed producer maxima. fill_form
// applies the typing wall independently per field and scroll has no top-level
// fence across slow successful flick calls before pause_after. Runtime
// activation therefore remains blocked on a harness-wide per-intent wall-clock
// fence + cancellation semantics; until then these prevent an unbounded lost
// reply while acknowledging a legal extreme operation could outlive the timer.
const UNFENCED_COMPOSITE_INTENTS = new Set<HarnessIntentName>(['fill_form', 'scroll']);

const NAVIGATION_INTENTS = new Set<HarnessIntentName>(['navigate', 'back', 'forward']);

/** Per-intent loss-detection deadline. Proved bounded classes use the live
 *  producer budget plus transport slack; fill_form/scroll use the explicitly
 *  provisional bound above until the producer supplies a whole-intent fence.
 *  Short operations stay fail-fast instead of inheriting a blanket long timer. */
export function dispatchTimeoutMs(intentName: HarnessIntentName): number {
  if (COMPOSITE_LONG_INTENTS.has(intentName)) {
    return (
      HARNESS_BEHAVIORAL_PAUSE_CAP_MS +
      HARNESS_WAIT_FOR_CAP_SECONDS * 1000 +
      DISPATCH_TIMEOUT_SLACK_MS
    );
  }
  if (SINGLE_CAP_LONG_INTENTS.has(intentName)) {
    const capMs =
      intentName === 'wait_for'
        ? HARNESS_WAIT_FOR_CAP_SECONDS * 1000
        : HARNESS_BEHAVIORAL_PAUSE_CAP_MS;
    return Math.max(DISPATCH_TIMEOUT_BASE_MS, capMs + DISPATCH_TIMEOUT_SLACK_MS);
  }
  if (UNFENCED_COMPOSITE_INTENTS.has(intentName)) {
    return HARNESS_BEHAVIORAL_PAUSE_CAP_MS + DISPATCH_TIMEOUT_SLACK_MS;
  }
  if (NAVIGATION_INTENTS.has(intentName)) {
    return DISPATCH_NAVIGATION_BUDGET_MS + DISPATCH_TIMEOUT_SLACK_MS;
  }
  return DISPATCH_TIMEOUT_BASE_MS;
}

interface PendingDispatch {
  resolve: (result: ParsedIntentResult) => void;
  timer: ReturnType<typeof setTimeout>;
  sessionId: string;
  intentName: HarnessIntentName;
}

function synthFailure(
  sessionId: string,
  intentId: string,
  errorCode: ParsedIntentResult['errorCode'],
  errorMessage: string,
): ParsedIntentResult {
  return { sessionId, intentId, success: false, durationMs: 0, errorCode, errorMessage };
}

export class IntentDispatchCorrelator {
  private readonly pending = new Map<string, PendingDispatch>();

  constructor(private readonly transport: DispatchTransport) {}

  /** Send a dispatch and resolve when its IntentResult arrives, the session
   *  fast-fails, or the per-intent timeout elapses. Never rejects. */
  dispatch(d: IntentDispatch): Promise<ParsedIntentResult> {
    return new Promise<ParsedIntentResult>((resolve) => {
      const ms = dispatchTimeoutMs(d.intentName);
      const timer = setTimeout(() => {
        this.settle(
          d.intentId,
          synthFailure(
            d.sessionId,
            d.intentId,
            'intent_dispatch_error',
            `dispatch timed out after ${ms}ms`,
          ),
        );
      }, ms);
      this.pending.set(d.intentId, {
        resolve,
        timer,
        sessionId: d.sessionId,
        intentName: d.intentName,
      });
      try {
        this.transport.send(d);
      } catch (err) {
        // The transport's send is `socket.send(...)`, which throws synchronously
        // when the WS isn't OPEN (e.g. a dispatch racing a remote close into
        // CLOSING, before the route's 'close' handler unregisters). Settle a
        // uniform failure rather than letting this Promise REJECT — the executor
        // contract is that dispatch() never rejects — and so the timer + pending
        // entry don't leak (settle clears + deletes them).
        this.settle(
          d.intentId,
          synthFailure(
            d.sessionId,
            d.intentId,
            'intent_dispatch_error',
            `dispatch send failed: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      }
    });
  }

  /** Feed an inbound frame expected to be an IntentResult. Non-IntentResult
   *  frames are ignored; a malformed outputData settles a typed failure. */
  onResultFrame(frame: unknown): void {
    // Route on the three bounded identity fields BEFORE parsing the full
    // envelope or decoding outputData. Unknown ids and cross-session echoes are
    // untrusted traffic for some other request and must consume no payload work.
    const header = IntentResultHeaderSchema.safeParse(frame);
    if (!header.success) return;
    const target = this.pending.get(header.data.intentId);
    if (target === undefined) return;

    // Cross-session spoof guard — a shared fleet connection carries every
    // session on the node, so a misrouted / id-echoed IntentResult whose
    // sessionId disagrees with the pending dispatch it would settle must NOT
    // resolve another session's in-flight intent with this frame's page output
    // (DOM / screenshot / extracted text → a cross-account data leak). Mirrors
    // the identical guard the six sibling request-correlators already carry
    // (cookies / download / navigate-history / upload / set-cookies /
    // trim-profile). Drop the frame but LEAVE the pending entry so the
    // legitimate result — or the per-intent timeout — still settles it.
    if (target.sessionId !== header.data.sessionId) return;

    let parsed: ParsedIntentResult;
    try {
      parsed = parseIntentResult(frame, target.intentName);
    } catch {
      // Once the id/session pair is authenticated by pending state, malformed
      // envelope/base64/JSON or a wrong-intent success is terminal for this
      // request. Settle deterministically rather than waiting for its timeout.
      parsed = synthFailure(
        header.data.sessionId,
        header.data.intentId,
        'intent_dispatch_error',
        'malformed IntentResult result shape or outputData',
      );
    }
    this.settle(header.data.intentId, parsed);
  }

  /** Feed an errored SessionStatus. Fast-fails the in-flight dispatch for the
   *  session when it's the no-session error (sequential execution ⇒ ≤1 in-flight). */
  onSessionError(sessionId: string, detail: string): void {
    if (!detail.startsWith('intent_dispatch_no_session')) return;
    for (const [intentId, p] of this.pending) {
      if (p.sessionId === sessionId) {
        this.settle(
          intentId,
          synthFailure(sessionId, intentId, 'intent_session_not_established', detail),
        );
      }
    }
  }

  /** Fail every in-flight dispatch (e.g. the control connection dropped). */
  failAll(errorMessage: string): void {
    for (const [intentId, p] of this.pending) {
      this.settle(
        intentId,
        synthFailure(p.sessionId, intentId, 'intent_dispatch_error', errorMessage),
      );
    }
  }

  /** Number of in-flight dispatches (test/inspection helper). */
  inFlight(): number {
    return this.pending.size;
  }

  private settle(intentId: string, result: ParsedIntentResult): void {
    const p = this.pending.get(intentId);
    if (!p) return; // already settled (timeout/result race, or unknown id) — idempotent
    clearTimeout(p.timer);
    this.pending.delete(intentId);
    p.resolve(result);
  }
}

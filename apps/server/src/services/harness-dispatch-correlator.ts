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
//   - Per-intent timeout = max(30s, cap + 15s): behavioral_pause / wait_for can
//     run to their 300s caps, everything else is sub-second-to-a-few-seconds.
//
// dispatch() ALWAYS resolves with a ParsedIntentResult (success or a synthesized
// failure) — it never rejects — so the executor gets a uniform result per intent.
// The executor runs intents SEQUENTIALLY (halt-on-failure), so there is at most
// one in-flight dispatch per session, which makes the by-session fast-fail
// unambiguous even though the SessionStatus names the intentName, not the intentId.

import {
  IntentResultEnvelopeSchema,
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

/** Per-intent dispatch timeout = max(30s, harness cap + 15s slack). Only
 *  behavioral_pause + wait_for exceed the 30s base (they self-cap at 300s). */
export function dispatchTimeoutMs(intentName: HarnessIntentName): number {
  if (intentName === 'behavioral_pause') {
    return Math.max(
      DISPATCH_TIMEOUT_BASE_MS,
      HARNESS_BEHAVIORAL_PAUSE_CAP_MS + DISPATCH_TIMEOUT_SLACK_MS,
    );
  }
  if (intentName === 'wait_for') {
    return Math.max(
      DISPATCH_TIMEOUT_BASE_MS,
      HARNESS_WAIT_FOR_CAP_SECONDS * 1000 + DISPATCH_TIMEOUT_SLACK_MS,
    );
  }
  return DISPATCH_TIMEOUT_BASE_MS;
}

interface PendingDispatch {
  resolve: (result: ParsedIntentResult) => void;
  timer: ReturnType<typeof setTimeout>;
  sessionId: string;
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
      this.pending.set(d.intentId, { resolve, timer, sessionId: d.sessionId });
      this.transport.send(d);
    });
  }

  /** Feed an inbound frame expected to be an IntentResult. Non-IntentResult
   *  frames are ignored; a malformed outputData settles a typed failure. */
  onResultFrame(frame: unknown): void {
    const env = IntentResultEnvelopeSchema.safeParse(frame);
    if (!env.success) return; // not an IntentResult — caller routes other frame types
    let parsed: ParsedIntentResult;
    try {
      parsed = parseIntentResult(env.data);
    } catch {
      // Valid envelope but malformed base64/JSON outputData — surface as a typed
      // dispatch failure rather than crashing the receive loop.
      parsed = synthFailure(
        env.data.sessionId,
        env.data.intentId,
        'intent_dispatch_error',
        'malformed IntentResult outputData',
      );
    }
    this.settle(parsed.intentId, parsed);
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

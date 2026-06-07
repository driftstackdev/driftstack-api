// Increment-2 — result mapper: harness ParsedIntentResult → the customer-facing
// IntentResult (api-types). The symmetric companion to agent-intent-to-dispatch:
//
//   AgentIntent --agentIntentToDispatch--> {intentName,params}
//             --serializeIntentDispatch--> IntentDispatch --[WSS]-->
//   IntentResultEnvelope --parseIntentResult--> ParsedIntentResult
//             --intentResultToCustomer--> IntentResult  (← this file)
//
// Pure + transport-agnostic. The AgentExecutor v2 calls this to turn each
// harness result back into the typed `IntentResult` surfaced on the
// /v1/agent-sessions/{id}/message turn result. `summary` (success) and `reason`
// (failure) are the customer-facing copy — derived here from the harness
// outputData (shapes per docs/internal/harness-intent-contract.md) and the
// A3-locked error codes. captureId is intentionally NOT set: the harness returns
// screenshot/source inline in outputData, and minting a stored captureId is a
// (later) storage-side concern, not a pure mapping — success still carries a
// descriptive summary.

import type { AgentIntent, IntentResult } from '@driftstack/api-types';
import type { ParsedIntentResult } from './harness-control-codec.js';
import type { HarnessErrorCode } from '../schemas/harness-control-protocol.js';

/** Map a decoded harness result + its originating intent → customer IntentResult. */
export function intentResultToCustomer(
  intent: AgentIntent,
  parsed: ParsedIntentResult,
): IntentResult {
  if (parsed.success) {
    return { kind: 'success', intent, summary: summarize(intent, parsed.outputData) };
  }
  return { kind: 'failure', intent, reason: failureReason(parsed.errorCode, parsed.errorMessage) };
}

// ── success summary ───────────────────────────────────────────────────
function summarize(intent: AgentIntent, outputData: unknown): string {
  switch (intent.kind) {
    case 'navigate': {
      const url = readString(outputData, 'url');
      return url !== null ? `navigated to ${url}` : 'navigated';
    }
    case 'interact':
      return summarizeInteract(intent);
    case 'wait':
      return intent.condition === 'selector_visible' && intent.selector !== undefined
        ? `condition met: ${intent.selector} visible`
        : 'wait condition met';
    case 'capture':
      return summarizeCapture(intent);
    case 'scroll': {
      // W173 — surface the harness's distance clamp, mirroring the existing
      // `capped`/`timeout_capped` flags. The harness clamps scroll distance to
      // [0, 15000] and reports `distance_capped: true` in outputData when the
      // requested distance_px actually hit that clamp (A3 bus W218). Read it
      // defensively (absent/non-bool → not capped) so this is forward-compatible
      // with the harness adding the field; the value is appended, never the cap
      // magnitude (that constant lives harness-side — don't duplicate it).
      const capped = readBool(outputData, 'distance_capped') ? ' (capped)' : '';
      return intent.amount_px !== undefined
        ? `scrolled ${intent.direction} ${intent.amount_px}px${capped}`
        : `scrolled ${intent.direction}${capped}`;
    }
    case 'behavioral_pause':
      return intent.reading_word_count !== undefined
        ? `paused to read ~${intent.reading_word_count} words`
        : intent.duration_ms !== undefined
          ? `paused ${intent.duration_ms}ms`
          : 'paused';
  }
}

function summarizeInteract(intent: Extract<AgentIntent, { kind: 'interact' }>): string {
  switch (intent.action) {
    case 'tap':
      return intent.selector !== undefined ? `tapped ${intent.selector}` : 'tapped';
    case 'type':
      return intent.selector !== undefined ? `typed into ${intent.selector}` : 'typed text';
    case 'scroll':
      return 'scrolled';
    case 'swipe':
      return 'swiped';
  }
}

function summarizeCapture(intent: Extract<AgentIntent, { kind: 'capture' }>): string {
  switch (intent.capture) {
    case 'screenshot':
      return 'captured screenshot';
    case 'dom_snapshot':
      return 'captured DOM snapshot';
    case 'pdf':
      return 'captured PDF';
  }
}

// ── failure reason ────────────────────────────────────────────────────
// Base copy per A3-locked error code + the harness's own message when present.
// The harness is internal infra (A3 controls these strings); the message for
// e.g. intent_missing_parameter names the param, and webdriver errors name the
// failing selector/url — both actionable + non-secret. Cap the appended message
// so an unexpectedly long harness string can't bloat the row.
const ERROR_BASE: Record<HarnessErrorCode, string> = {
  intent_session_not_established: 'the browser session was not established for this action',
  intent_not_implemented: 'this action is not supported by the browser session',
  intent_missing_parameter: 'a required parameter was missing',
  intent_invalid_parameter: 'a parameter was invalid',
  intent_webdriver_failed: 'the browser failed to perform this action',
  intent_dispatch_error: 'the action could not be dispatched',
};
const MAX_MESSAGE_LEN = 200;

function failureReason(code: HarnessErrorCode | undefined, message: string | undefined): string {
  const base = code !== undefined ? ERROR_BASE[code] : 'the action failed';
  const msg = message?.trim();
  if (msg !== undefined && msg.length > 0) {
    const capped = msg.length > MAX_MESSAGE_LEN ? `${msg.slice(0, MAX_MESSAGE_LEN)}…` : msg;
    return `${base}: ${capped}`;
  }
  return base;
}

/** Read a string field from an unknown decoded outputData object, or null. */
function readString(obj: unknown, key: string): string | null {
  if (typeof obj === 'object' && obj !== null && key in obj) {
    const v = (obj as Record<string, unknown>)[key];
    if (typeof v === 'string') return v;
  }
  return null;
}

/** Read a boolean field from an unknown decoded outputData object; false when
 *  absent or non-boolean (forward-compatible with optional harness flags). */
function readBool(obj: unknown, key: string): boolean {
  if (typeof obj === 'object' && obj !== null && key in obj) {
    const v = (obj as Record<string, unknown>)[key];
    if (typeof v === 'boolean') return v;
  }
  return false;
}

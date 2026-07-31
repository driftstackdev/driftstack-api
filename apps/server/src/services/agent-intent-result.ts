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

import type {
  AgentIntent,
  FailureDiagnosis,
  FailureDiagnosisCategory,
  IntentResult,
} from '@driftstack/api-types';
import type { ParsedIntentResult } from './harness-control-codec.js';
import type { HarnessErrorCode } from '../schemas/harness-control-protocol.js';
import { redactText } from '../lib/redact-url.js';

// Result summaries and failure reasons cross two customer-data boundaries: the
// message response and the encrypted agent transcript. Harness output is
// internal, but it can reflect a final redirect URL, WebDriver diagnostic, or
// page-controlled text. Bound it before redaction (the wire schema already caps
// errorMessage at 1,000 chars, but success output is less constrained), redact
// credential-shaped material, then bound again because replacement markers can
// expand the string.
const RESULT_TEXT_INPUT_MAX_LENGTH = 4096;
const RESULT_SUMMARY_MAX_LENGTH = 512;

function safeResultText(value: string, maxLength: number): string {
  const bounded = value.slice(0, RESULT_TEXT_INPUT_MAX_LENGTH);
  return redactText(bounded).slice(0, maxLength);
}

/**
 * Intent kinds whose replay CANNOT duplicate an effect, each with the reason.
 *
 * This is an allowlist rather than a blocklist, and the direction is the whole
 * point. Listing the effectful kinds means an intent kind added later is
 * classified "safe to replay" by omission, and the executor will auto-retry it
 * after an ambiguous WebDriver or dispatch failure — the exact failure class
 * that cannot distinguish "never applied" from "applied, result lost". For a
 * product that drives a real browser on a customer's behalf, that is a second
 * form submission, a second purchase, a second transfer. Listing the SAFE kinds
 * instead means a new kind is effectful until someone says otherwise.
 *
 * Both entries are read-only or self-limiting: a capture reads page state, and a
 * wait carries its own internal timeout, so replaying either changes nothing
 * about the page.
 */
const REPLAY_SAFE_INTENT_KINDS: ReadonlySet<AgentIntent['kind']> = new Set(['capture', 'wait']);

/**
 * A navigation or browser mutation can commit before its result is lost. The
 * harness and correlator intentionally use coarse failure codes that cannot
 * distinguish that case from a pre-application failure, so replaying these
 * intents with a fresh id could repeat navigation, an action, relative movement,
 * or human pacing. Keep this shared with the executor so customer retry guidance
 * and automatic replay can never disagree.
 *
 * Fails safe on an unrecognised kind: unknown means "may duplicate". Today's
 * union is classified identically to the previous explicit list — this changes
 * nothing now and changes the default for whatever is added next.
 */
export function intentReplayMayDuplicateEffect(intent: AgentIntent): boolean {
  return !REPLAY_SAFE_INTENT_KINDS.has(intent.kind);
}

/** Map a decoded harness result + its originating intent → customer IntentResult. */
export function intentResultToCustomer(
  intent: AgentIntent,
  parsed: ParsedIntentResult,
): IntentResult {
  if (parsed.success) {
    return { kind: 'success', intent, summary: summarize(intent, parsed.outputData) };
  }
  return {
    kind: 'failure',
    intent,
    reason: failureReason(intent, parsed.errorCode, parsed.errorMessage),
    diagnosis: diagnose(intent, parsed.errorCode),
  };
}

// ── success summary ───────────────────────────────────────────────────
function summarize(intent: AgentIntent, outputData: unknown): string {
  switch (intent.kind) {
    case 'navigate': {
      const url = readString(outputData, 'url');
      return url !== null
        ? safeResultText(`navigated to ${url}`, RESULT_SUMMARY_MAX_LENGTH)
        : 'navigated';
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
      // `capped`/`timeout_capped` flags. The harness emits `distance_capped` in
      // outputData (always present, A3 bus W219 / harness 84b85529): `true` ONLY
      // when the requested distance_px exceeded the 15000px UPPER clamp and was
      // capped to 15000 — i.e. the customer asked to scroll FARTHER than allowed.
      // A negative/non-finite request clamps to 0 with `distance_capped:false`
      // (a no-op, not a "cap"), so " (capped)" fires only on the genuinely-useful
      // over-distance signal. Read defensively (absent/non-bool → not capped); the
      // cap magnitude is never duplicated here (that constant lives harness-side).
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
    case 'press':
      return intent.value !== undefined ? `pressed ${intent.value}` : 'pressed key';
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
  intent_script_failed: 'the browser script for this action was invalid',
  intent_dispatch_error: 'the action could not be dispatched',
  intent_deadline_exceeded:
    'the action exceeded its whole-intent deadline and the browser session was terminated — start a new session; do not retry against this session',
  // A1 `driftstack@16a94d0e5` — this code now has TWO harness emitters with
  // DIFFERENT node state: exit-unconfirmed keeps a process-lifetime same-id
  // tombstone and discards the in-progress profile, while lost-captured-browser
  // installs no tombstone, discards no profile and ends no session. The old
  // copy asserted "this session is permanently fenced", which is a MECHANISM
  // claim true of only the first. Both are non-retryable for this session, so
  // the guidance is unchanged and only the unprovable mechanism is dropped.
  intent_deadline_cleanup_unconfirmed:
    'the action exceeded its whole-intent deadline and browser cleanup could not be confirmed — start a new session and do not retry against this session',
  // A3 W227 — the harness caps inline result output at 8 MiB; an over-cap
  // result is a terminal client error (narrow the selector / paginate).
  result_too_large: 'the result was too large to return — narrow the selector or paginate',
  session_paused: 'the browser session is paused — resume it before retrying this action',
  session_intent_in_flight:
    'the browser session is still processing another action — wait, then retry this action',
};

// doc-132 §5.3 auto-debug (deterministic slice) — specialize the generic
// WebDriver failure by intent kind. Mutating/pacing intents use the stronger
// outcome-unknown copy below because a coarse failure does not prove that the
// action or pacing failed before application. Read-only/replay-tolerant kinds
// retain their narrower actionable guidance.
const WEBDRIVER_FAILED_BY_KIND: Partial<Record<AgentIntent['kind'], string>> = {
  wait: 'the wait condition was never met — the expected state may not occur on this page',
  capture: "the browser couldn't capture the page",
};

const BROWSER_COMMAND_OUTCOME_UNKNOWN =
  'the browser action or pacing may have taken effect even though its result was not confirmed — inspect the current page before deciding whether to try another action';

// doc-132 §5.3 — the machine-readable companion to the prose `reason`. Same
// deterministic inputs (error code + intent kind), so the two can never
// disagree. `retryable` is the automation-facing hint: true only when replaying
// the SAME step automatically is considered safe. False covers both requests
// that must change (bad params, unsupported action, over-cap result) and
// outcome-unknown actions whose current page state must be inspected first.
const WEBDRIVER_CATEGORY_BY_KIND: Partial<Record<AgentIntent['kind'], FailureDiagnosisCategory>> = {
  wait: 'condition_not_met',
  capture: 'capture_failed',
};

function diagnose(intent: AgentIntent, code: HarnessErrorCode | undefined): FailureDiagnosis {
  switch (code) {
    case 'intent_webdriver_failed': {
      const outcomeUnknown = intentReplayMayDuplicateEffect(intent);
      return {
        category: outcomeUnknown
          ? 'unknown'
          : (WEBDRIVER_CATEGORY_BY_KIND[intent.kind] ?? 'unknown'),
        retryable: !outcomeUnknown,
      };
    }
    case 'intent_dispatch_error':
      return intentReplayMayDuplicateEffect(intent)
        ? { category: 'unknown', retryable: false }
        : { category: 'session_error', retryable: true };
    case 'intent_session_not_established':
    case 'session_paused':
    case 'session_intent_in_flight':
      return { category: 'session_error', retryable: true };
    case 'intent_deadline_exceeded':
    case 'intent_deadline_cleanup_unconfirmed':
      return { category: 'session_error', retryable: false };
    case 'intent_missing_parameter':
    case 'intent_invalid_parameter':
    case 'intent_not_implemented':
    case 'intent_script_failed':
      return { category: 'invalid_request', retryable: false };
    case 'result_too_large':
      return { category: 'result_too_large', retryable: false };
    case undefined:
      return { category: 'unknown', retryable: false };
  }
}

const MAX_MESSAGE_LEN = 200;

function failureReason(
  intent: AgentIntent,
  code: HarnessErrorCode | undefined,
  message: string | undefined,
): string {
  const base =
    code === 'intent_webdriver_failed' || code === 'intent_dispatch_error'
      ? intentReplayMayDuplicateEffect(intent)
        ? BROWSER_COMMAND_OUTCOME_UNKNOWN
        : code === 'intent_webdriver_failed'
          ? (WEBDRIVER_FAILED_BY_KIND[intent.kind] ?? ERROR_BASE.intent_webdriver_failed)
          : ERROR_BASE.intent_dispatch_error
      : code !== undefined
        ? ERROR_BASE[code]
        : 'the action failed';
  const msg = message?.trim();
  if (msg !== undefined && msg.length > 0) {
    const redacted = safeResultText(msg, MAX_MESSAGE_LEN);
    const capped =
      msg.length > MAX_MESSAGE_LEN ? `${redacted.slice(0, MAX_MESSAGE_LEN - 1)}…` : redacted;
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

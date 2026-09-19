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
} from '@driftstack/api-types';
// The executor's IntentResult, NOT the api-types one. The published api-types
// IntentResult admits ANY category string, because a reader must accept one
// newer than itself. What this server BUILDS is only ever a listed category, so
// the builders below are typed against the closed FailureDiagnosis: a category
// missing from FailureDiagnosisCategorySchema is a compile error here, and every
// result still fits the published type (closed is a subset of open).
import type { IntentResult } from './agent-executor.js';
import type { ParsedIntentResult } from './harness-control-codec.js';
import {
  HARNESS_TAP_REFUSAL_REASONS,
  type HarnessErrorCode,
  type HarnessTapRefusalReason,
} from '../schemas/harness-control-protocol.js';
import { redactText } from '../lib/redact-url.js';
import { sliceWithoutSplittingSurrogate } from '../lib/bounded-text.js';

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
  // Surrogate-safe cuts: see sliceWithoutSplittingSurrogate. A plain slice here
  // returns half an emoji, which reaches the customer as U+FFFD.
  const bounded = sliceWithoutSplittingSurrogate(value, RESULT_TEXT_INPUT_MAX_LENGTH);
  return sliceWithoutSplittingSurrogate(redactText(bounded), maxLength);
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
    // P4 — AN ERROR PAGE IS NOT A SUCCESSFUL NAVIGATION. The device reports a
    // navigate that reached an HTTP error as a SUCCESS carrying the status, so
    // without this branch the step is green, the plan continues, and the task
    // dies several steps later at a selector that was never going to exist on a
    // 404. Surfacing it HERE puts the failure on the step that actually went
    // wrong, which is the only place a customer (or a re-plan) can act on it.
    const errorPage = navigateErrorStatus(intent, parsed.outputData);
    if (errorPage !== null) {
      return {
        kind: 'failure',
        intent,
        reason: errorPage.reason,
        // Not retryable: the same URL returns the same status, so replaying it
        // spends the budget to be told the same thing. The page needs to
        // change, not the request.
        diagnosis: { category: 'page_load_failed', retryable: false },
      };
    }
    // Sanitise at the BOUNDARY, not in each producer. `summarize` interpolates
    // `intent.selector` / `intent.value` — customer- and decomposer-supplied, and
    // bounded only by the dispatch schema's HARNESS_SCRIPT_MAX_CHARS (262_144),
    // which is 512x the RESULT_SUMMARY_MAX_LENGTH this file declares. Only the
    // navigate path passed through safeResultText, so a selector reached the
    // message response and the encrypted transcript unbounded and unredacted.
    // Applying it here covers every branch, including ones added later, and is
    // idempotent for the navigate path that already sanitises internally.
    return {
      kind: 'success',
      intent,
      summary: safeResultText(summarize(intent, parsed.outputData), RESULT_SUMMARY_MAX_LENGTH),
    };
  }
  // Read BEFORE the per-code table: the legacy form of this refusal arrives as
  // `intent_webdriver_failed`, which on an interact is otherwise the
  // outcome-unknown class — and a refusal the device made before tapping is
  // the opposite of outcome-unknown. The device's message is not appended: it
  // describes the refusal in the device's terms, not the customer's.
  const refusal = tapRefusalOf(parsed);
  if (refusal !== null) return tapRefusalResult(intent, refusal);
  return {
    kind: 'failure',
    intent,
    reason: failureReason(intent, parsed.errorCode, parsed.errorMessage),
    diagnosis: diagnose(intent, parsed.errorCode),
  };
}

// ── P4 navigate error pages ───────────────────────────────────────────

/**
 * The lowest status the site itself is reporting as a problem. 4xx and 5xx are
 * the two bands where the document that loaded is the site's error page rather
 * than the page that was asked for. 3xx never reaches here as a final status —
 * the browser has already followed it — and a 2xx is the ordinary case.
 */
const HTTP_ERROR_STATUS_FLOOR = 400;

/**
 * Customer-safe copy per status band. Says what the SITE did and what it means
 * for the task; never names any internal component, and never speculates about
 * a cause we did not observe.
 */
function navigateErrorCopy(status: number): string {
  if (status === 404 || status === 410) {
    return `that address does not exist on the site (it returned ${String(status)}) — the page may have moved, or the link may be wrong`;
  }
  if (status === 401 || status === 403) {
    return `the site refused to show that page (${String(status)}) — it may require signing in first`;
  }
  if (status === 429) {
    return 'the site asked us to slow down (429) — it is rate-limiting requests right now';
  }
  if (status >= 500) {
    return `the site reported an error for that page (${String(status)}) — this is a problem on their side`;
  }
  return `the site returned ${String(status)} for that address instead of the page`;
}

/**
 * P4 — an ADDITIVE read of the optional navigate `http_status`.
 *
 * Returns null — meaning "behave exactly as before" — for every non-navigate
 * intent, for a device that sends no status at all, and for any status the site
 * is not reporting as a problem. An absent field is NO OPINION, never an
 * implied failure: that is what keeps an older device's behaviour unchanged.
 */
function navigateErrorStatus(
  intent: AgentIntent,
  outputData: unknown,
): { status: number; reason: string } | null {
  if (intent.kind !== 'navigate') return null;
  const status = readNumber(outputData, 'http_status');
  if (status === null || status < HTTP_ERROR_STATUS_FLOOR) return null;
  return { status, reason: navigateErrorCopy(status) };
}

// ── success summary ───────────────────────────────────────────────────
function summarize(intent: AgentIntent, outputData: unknown): string {
  switch (intent.kind) {
    case 'navigate': {
      // Owner: "the AI says it worked when the page failed to load." The harness
      // resolves a navigate that never finished loading as a SUCCESS carrying
      // `loadedAtTimeout: true` (harness-control-protocol.ts:484), and this
      // summary used to read a bare "navigated to <url>" — a green check
      // asserting a completed load that nobody measured. Surface the flag, the
      // way `distance_capped` is surfaced for scroll.
      //
      // ⚠️ The suffix is the load-bearing half, so it is reserved OUT of the
      // truncation budget rather than appended after it: a long URL must lose
      // its own tail, never the words that say the page did not finish.
      const url = readString(outputData, 'url');
      const unfinished = readBool(outputData, 'loadedAtTimeout')
        ? ' (page never finished loading)'
        : '';
      if (url === null) return `navigated${unfinished}`;
      return (
        safeResultText(`navigated to ${url}`, RESULT_SUMMARY_MAX_LENGTH - unfinished.length) +
        unfinished
      );
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

// ── a covered control ─────────────────────────────────────────────────
//
// A native tap activates whatever is UNDER the tap point. When a banner, a
// dialog or a sticky bar sits over the control the plan named, the thing that
// would be activated is not the thing the plan asked for — so the tap is not
// made, and the step fails in words the customer can act on. Two producers
// share this copy: the executor's own look before a tap (see
// agent-executor-control-plane.ts) and the device refusing a click whose tap
// point is covered.
//
// ⛔ CUSTOMER COPY. It says what is on the page and that nothing happened. It
// never names how that was found out.

/**
 * The prefix A3's click refusal ALWAYS carries while the dedicated code is not
 * yet emitted (the legacy form: `intent_webdriver_failed` + this message). A
 * refusal, not an ambiguous failure: the device checked BEFORE tapping, so the
 * click provably did not happen.
 */
export const LEGACY_ELEMENT_COVERED_MESSAGE_PREFIX = 'element occluded at the tap point:';

/** The longest cover label quoted back — a banner's whole text is not a name. */
const COVER_LABEL_MAX_LENGTH = 60;

/** What a perceive element `type` is called in a sentence. */
function controlNoun(type: string | undefined): string {
  switch (type) {
    case 'button':
    case 'link':
    case 'checkbox':
    case 'image':
      return type;
    case 'radio':
      return 'option';
    case 'select':
      return 'menu';
    case 'input':
    case 'textarea':
      return 'field';
    default:
      return 'control';
  }
}

const ELEMENT_COVERED_REASON_UNNAMED =
  'something on the page is covering this control, so nothing was tapped — it may need to be closed or dismissed first';

/** What did NOT happen, in the customer's words: a typed step's first act is
 *  a tap on the field, and it is the typing they asked for. */
function nothingHappened(action: 'tap' | 'type'): string {
  return action === 'type' ? 'nothing was typed' : 'nothing was tapped';
}

/**
 * The sentence for a covered control. `coverLabel` is the page's own name for
 * what is on top (a cookie banner's "Accept all cookies"), quoted so the
 * customer — and the next plan — can see which thing to close. Page-controlled,
 * so it is collapsed to one line, bounded and redacted like every other
 * page-influenced string on a result.
 */
export function elementCoveredReason(
  coverLabel?: string,
  targetType?: string,
  action: 'tap' | 'type' = 'tap',
): string {
  const noun = controlNoun(targetType);
  // eslint-disable-next-line no-control-regex
  const oneLine = (coverLabel ?? '').replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029\s]+/g, ' ');
  const trimmed = oneLine.trim();
  if (trimmed.length === 0) {
    return noun === 'control' && action === 'tap'
      ? ELEMENT_COVERED_REASON_UNNAMED
      : `something on the page is covering this ${noun}, so ${nothingHappened(action)} — it may need to be closed or dismissed first`;
  }
  const bounded =
    trimmed.length > COVER_LABEL_MAX_LENGTH
      ? `${sliceWithoutSplittingSurrogate(trimmed, COVER_LABEL_MAX_LENGTH - 1).trimEnd()}…`
      : trimmed;
  return safeResultText(
    `“${bounded}” is covering this ${noun}, so ${nothingHappened(action)} — it may need to be closed or dismissed first`,
    RESULT_SUMMARY_MAX_LENGTH,
  );
}

/** The failure a covered control produces. Not retryable as the same step: the
 *  cover is still there. Re-plannable: nothing was tapped, so a new look can
 *  find the cover and close it (see REPLANNABLE_FAILURE_CATEGORIES). */
export function elementCoveredResult(
  intent: AgentIntent,
  coverLabel?: string,
  targetType?: string,
): Extract<IntentResult, { kind: 'failure' }> {
  return {
    kind: 'failure',
    intent,
    reason: elementCoveredReason(
      coverLabel,
      targetType,
      intent.kind === 'interact' && intent.action === 'type' ? 'type' : 'tap',
    ),
    diagnosis: { category: 'element_covered', retryable: false },
  };
}

/**
 * A tap the device REFUSED before touching the page (click `require_unoccluded`,
 * A3 V-3358; and send_keys' focus tap, V-3360, where it also typed nothing),
 * and why.
 *
 *  covered     something else is at the tap point — every occlusion reason,
 *              and a reason this build does not know: the device still said
 *              the point is not on the target, and reading it as covered is
 *              the direction in which nothing is tapped by mistake
 *  target_gone `target_not_resolved` — the element went away between the look
 *              and the tap. Not a cover: this is the element-not-found path
 *  unverified  `occlusion_check_unavailable` — the check could not run and the
 *              device failed closed. Not a cover either: nothing is known to
 *              be on top, only that nothing could be confirmed
 *
 * `reason` is the device's own word when it is one of the closed set, and
 * null otherwise, so a counter keyed on it stays a closed label set.
 */
export type TapRefusal = {
  kind: 'covered' | 'target_gone' | 'unverified';
  reason: HarnessTapRefusalReason | null;
};

const TAP_REFUSAL_REASONS: ReadonlySet<string> = new Set(HARNESS_TAP_REFUSAL_REASONS);

function isTapRefusalReason(said: string): said is HarnessTapRefusalReason {
  return TAP_REFUSAL_REASONS.has(said);
}

/**
 * Read a refused tap off a result — the dedicated code, or the legacy code
 * with its fixed message prefix — or null when the result is anything else.
 *
 * ⛔ THE REASON IS READ BEFORE THE REFUSAL IS CALLED A COVER. A bare prefix
 * match used to answer "covered" for every refusal, and two of them are not
 * covers: an element that went away, and a check that could not run. Filing
 * those as "something is covering this button" would send the customer — and
 * the next plan — looking for a banner that is not there.
 */
export function tapRefusalOf(parsed: ParsedIntentResult): TapRefusal | null {
  const message = (parsed.errorMessage ?? '').trim();
  const prefixed = message.startsWith(LEGACY_ELEMENT_COVERED_MESSAGE_PREFIX);
  const refused =
    parsed.errorCode === 'intent_element_occluded' ||
    (parsed.errorCode === 'intent_webdriver_failed' && prefixed);
  if (!refused) return null;
  const said = prefixed ? message.slice(LEGACY_ELEMENT_COVERED_MESSAGE_PREFIX.length).trim() : '';
  const reason = isTapRefusalReason(said) ? said : null;
  switch (reason) {
    case 'target_not_resolved':
      return { kind: 'target_gone', reason };
    // ⛔ "COULD NOT CHECK" IS NOT "COVERED". A tap point outside the viewport, or
    // one where nothing at all was hit, is a refusal because the device could not
    // VERIFY the tap — not evidence that something sits on top of the control.
    // Filing them as covered would tell the customer (and the next plan) to look
    // for a banner that is not there. The native element path checks BEFORE its
    // own scroll, so an off-screen control is refused there as outside-viewport;
    // that is a verification gap, reported as one.
    case 'occlusion_check_unavailable':
    case 'tap_point_outside_viewport':
    case 'nothing_hit':
      return { kind: 'unverified', reason };
    case 'hit_is_not_target_or_descendant':
    case 'covered_at_enclosing_shadow_level':
    case null:
      return { kind: 'covered', reason };
    default: {
      // A reason added to the closed set without a decision here is a build
      // error, not a refusal read as whatever the fall-through says.
      const _exhaustive: never = reason;
      void _exhaustive;
      return { kind: 'covered', reason: null };
    }
  }
}

/** The customer's result for a refused tap. Nothing was tapped in any case. */
function tapRefusalResult(
  intent: AgentIntent,
  refusal: TapRefusal,
): Extract<IntentResult, { kind: 'failure' }> {
  switch (refusal.kind) {
    case 'covered':
      return elementCoveredResult(intent);
    case 'target_gone':
      // Word for word what a tap on a selector that matches nothing gets: the
      // element is not there now, and the step is handled as exactly that.
      return elementNotFoundResult(intent);
    case 'unverified':
      return targetUnverifiedResult(intent);
    default: {
      const _exhaustive: never = refusal.kind;
      void _exhaustive;
      return elementCoveredResult(intent);
    }
  }
}

/**
 * The sentence for a tap that was not made because the device could not
 * confirm, at the moment of tapping, that it would land on the control.
 *
 * ⛔ CUSTOMER COPY: it says nothing was tapped and that the page can be looked
 * at again. It never says how the tap was checked, and it does not claim a
 * cover it has no evidence of.
 */
export const TARGET_UNVERIFIED_REASON =
  'nothing was tapped, because it could not be confirmed that the tap would land on this control — the page may need to be looked at again first';

/**
 * The same, for a typed step: the device checks the tap that focuses the field
 * (send_keys `require_unoccluded`), and a refused focus tap types NOTHING. It is
 * the typing the customer asked for, so that is what it says did not happen.
 */
export const TARGET_UNVERIFIED_TYPING_REASON =
  'nothing was typed, because it could not be confirmed that the typing would reach this field — the page may need to be looked at again first';

/** Not retryable as the same step: the same check on the same page is the
 *  same answer. Re-plannable: nothing was tapped or typed, so a fresh look is
 *  safe. */
export function targetUnverifiedResult(
  intent: AgentIntent,
): Extract<IntentResult, { kind: 'failure' }> {
  return {
    kind: 'failure',
    intent,
    reason:
      intent.kind === 'interact' && intent.action === 'type'
        ? TARGET_UNVERIFIED_TYPING_REASON
        : TARGET_UNVERIFIED_REASON,
    diagnosis: { category: 'target_unverified', retryable: false },
  };
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
  intent_element_not_found: 'no element on the page matched this selector',
  intent_webdriver_failed: 'the browser failed to perform this action',
  intent_page_load_failed:
    'the page failed to load — retry the URL; the browser session is still usable, so do not restart it',
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
  intent_element_occluded: ELEMENT_COVERED_REASON_UNNAMED,
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
    case 'intent_element_not_found':
      // RETRYABLE, and this is the whole point of splitting it out of
      // intent_invalid_parameter. The selector parsed and the lookup ran, so the
      // intent did NOT execute — replaying it cannot double-apply anything. And
      // the commonest cause is timing: the page was still settling, or the
      // element appears after an interaction. `element_not_found` already exists
      // in the public category union, documented as "target element
      // missing/hidden/not yet loaded"; until now nothing produced it for an
      // interact. Bounded by the executor's own maxRetries, so a selector that
      // genuinely matches nothing still fails after a fixed number of attempts
      // rather than looping.
      return { category: 'element_not_found', retryable: true };
    case 'intent_page_load_failed':
      // A3 #8 — the navigate reached the browser and the load ERRORED (proxy /
      // DNS / TLS / HTTP). RETRYABLE: a load has no side effect to double-apply,
      // so replaying the SAME url is safe, and the session stays usable — retry
      // the URL, do NOT re-establish the session (that is what the old
      // success-on-error path could never say).
      return { category: 'page_load_failed', retryable: true };
    case 'intent_missing_parameter':
    case 'intent_invalid_parameter':
    case 'intent_not_implemented':
    case 'intent_script_failed':
      return { category: 'invalid_request', retryable: false };
    case 'result_too_large':
      return { category: 'result_too_large', retryable: false };
    case 'intent_element_occluded':
      // Normally answered by elementCoveredResult before this table is read;
      // kept exhaustive so the code can never fall through to `unknown`.
      return { category: 'element_covered', retryable: false };
    case undefined:
      return { category: 'unknown', retryable: false };
  }
}

/**
 * The failure a tap gets when the device's own resolver finds nothing for its
 * selector — word for word what the click itself would have come back with, so a
 * step that failed before its click reads exactly like one that failed on it.
 */
export function elementNotFoundResult(
  intent: AgentIntent,
): Extract<IntentResult, { kind: 'failure' }> {
  return {
    kind: 'failure',
    intent,
    reason: ERROR_BASE.intent_element_not_found,
    diagnosis: diagnose(intent, 'intent_element_not_found'),
  };
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
      msg.length > MAX_MESSAGE_LEN
        ? `${sliceWithoutSplittingSurrogate(redacted, MAX_MESSAGE_LEN - 1)}…`
        : redacted;
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

/** Read a finite number field from an unknown decoded outputData object, or
 *  null. Non-finite and non-numeric values read as ABSENT rather than as 0 — a
 *  0 here would compare below the error floor and silently assert "fine". */
function readNumber(obj: unknown, key: string): number | null {
  if (typeof obj === 'object' && obj !== null && key in obj) {
    const v = (obj as Record<string, unknown>)[key];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
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

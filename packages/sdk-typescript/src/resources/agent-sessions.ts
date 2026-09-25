// AgentSessionsResource — typed methods for /v1/agent-sessions/*.
//
// An agent session is a browser that the AI drives for you. The methods mirror
// the API routes:
//   create(body?, opts?)                  start a session
//   get(id) / list(query?) / iterate()    read sessions
//   message(id, userMessage, opts?)       send one task and wait for its outcome
//   getCapture(id, captureId)             fetch a screenshot the agent took
//   transcript(id, opts?)                 read the conversation, then follow it live
//   stop(id)                              stop the task that is running
//   close(id)                             end the session
//   setMode / setEgress / sendInputEvent / takeover / handback /
//   livekitToken / resume                 live control of a running session
//
// AI-backed operations depend on the deployment's configured BYOK or
// bundled-LLM provider. Deployments without one return the stable
// FeatureUnavailableError; the remaining session surface stays available.

import type { PaginationQueryInput } from '@driftstack/api-types';
import type { EventStreamFrame, HttpClient } from '../http.js';
import { iteratePaginated } from '../pagination.js';

/**
 * One input event for {@link AgentSessionsResource.sendInputEvent}. Mirrors the
 * API's `InputEvent` schema: pointer, keyboard, wheel and touch events, plus a
 * `ping` for measuring latency.
 */
export type InputEvent =
  | { type: 'mouseMove'; x: number; y: number }
  | { type: 'mouseDown'; x: number; y: number; button: 0 | 1 | 2 }
  | { type: 'mouseUp'; x: number; y: number; button: 0 | 1 | 2 }
  | { type: 'keyDown'; key: string; modifiers?: readonly string[] }
  | { type: 'keyUp'; key: string; modifiers?: readonly string[] }
  | { type: 'wheel'; x: number; y: number; deltaX: number; deltaY: number }
  // Touch events, in the device's CSS pixels.
  | { type: 'tap'; x: number; y: number }
  | { type: 'touchStart'; x: number; y: number; touchId: number }
  | { type: 'touchMove'; x: number; y: number; touchId: number }
  | { type: 'touchEnd'; x: number; y: number; touchId: number }
  | { type: 'swipe'; x1: number; y1: number; x2: number; y2: number; durationMs: number }
  | { type: 'ping'; timestamp: number };

/**
 * The result of an egress swap. Only `'ok'` means the egress changed; every
 * other status leaves the session exactly as it was, with `reason` saying why.
 * `apply_point` is present on success and is `null` when the device accepted
 * the swap without confirming when it takes effect.
 */
export interface AgentSessionEgressResult {
  status: 'ok' | 'unavailable' | 'timeout' | 'error';
  apply_point?: 'next_navigation' | 'immediate' | null;
  reason?: string;
}

/** Response of POST /v1/agent-sessions/:id/input-event. A discriminated union —
 *  callers MUST branch on `kind`:
 *
 *  - `'pair-mode-takeover-fired'` — the first input event in a pair-mode
 *    session whose AI is driving asked for a takeover. `pair_mode_state`
 *    carries the new state (typically `takeover-pending` or `takeover-queued`).
 *  - `'forwarded'` — reserved for an event sent straight to the browser, with
 *    the measured `duration_ms`. No deployment forwards input events, so this
 *    variant never arrives and `if (res.kind === 'forwarded')` is dead code.
 */
export type SendInputEventResponse =
  | {
      kind: 'pair-mode-takeover-fired';
      pair_mode_state: { kind: string; [k: string]: unknown };
    }
  | {
      kind: 'forwarded';
      /** Time the API spent delivering the event, in ms (NOT round-trip). */
      duration_ms: number;
    };

/**
 * Live-video join info, optionally returned on session-create
 * + always returned by POST /v1/agent-sessions/:id/livekit-token.
 * Use these fields with `livekit-client`'s `Room.connect(ws_url,
 * token)`. Token TTL is 24h; re-mint via the dedicated /livekit-
 * token endpoint after expiry.
 */
export interface LiveKitInfo {
  ws_url: string;
  room: string;
  token: string;
  participant_identity: string;
  expires_at: string;
}

export interface AgentSession {
  id: string;
  account_id: string;
  driftstack_session_id: string | null;
  /**
   * Lifecycle state as the API reports it.
   *
   * `'provisioning'` means the session exists and its browser is still starting
   * (for example a VPN tunnel is connecting or an egress is resolving), so it
   * cannot run anything yet. It already counts toward your plan's concurrent-
   * session limit. Treat it as "running, not ready": poll `get(id)` until it
   * reads `'active'` before sending a message, and do not treat it as finished.
   * `provisioning_detail` below says which step it is on.
   *
   * `'paused'` is reserved. A session held up by a bot check still reads
   * `'active'`; see {@link AgentSessionsResource.resume}.
   */
  status: 'provisioning' | 'active' | 'paused' | 'closed';
  /**
   * Why the session ended, once it has. Examples: `'customer-closed'` (you
   * closed it), `'budget-exhausted'` (its token budget ran out),
   * `'transcript-limit'` (its conversation history is full) and
   * `'exit_ip_changed'` (see `stop_on_exit_ip_change`). Other values mean it
   * could not start or was ended by Driftstack. An open set: new values can
   * appear, so treat one you do not recognise as "ended".
   */
  closed_reason: string | null;
  /** Why the session is still provisioning (e.g. 'vpn_egress_active'); null once active; absent on older servers. */
  provisioning_detail?: string | null;
  token_budget_total: number;
  token_budget_remaining: number;
  transcript_length: number;
  /**
   * ISO-8601 time the session left `active`. Distinct from `updated_at`, which
   * moves on every message. `null` while the session is active.
   */
  closed_at: string | null;
  /** The team member who created the session; `null` when the API key is not tied to one. */
  created_by_user_id: string | null;
  /**
   * How the session is driven, chosen at create: `'ai'` (the default), `'manual'`
   * or `'pair'`. Change it with {@link AgentSessionsResource.setMode}.
   */
  mode: 'manual' | 'ai' | 'pair';
  /**
   * The Claude model the AI runs for this session (set at create; defaults to
   * 'claude-sonnet-5'). Every earlier id stays accepted so older sessions still
   * read back.
   */
  model:
    | 'claude-opus-5'
    | 'claude-sonnet-5'
    | 'claude-opus-4-8'
    | 'claude-opus-4-7'
    | 'claude-sonnet-4-6'
    | 'claude-haiku-4-5';
  /** Whether the session stops when its exit IP changes (set at create; default false). */
  stop_on_exit_ip_change: boolean;
  /**
   * Pair-mode state. `null` when mode != 'pair'; otherwise
   * `{kind: 'ai-driving' | 'takeover-pending' | ...}`, which says whether a
   * person is mid-takeover.
   */
  pair_mode_state: { kind: string; [k: string]: unknown } | null;
  created_at: string;
  updated_at: string;
  /**
   * Live-video join info. Returned on create when live video is available for
   * the session; absent on the GET shape. Mint one at any time with
   * {@link AgentSessionsResource.livekitToken}.
   */
  livekit?: LiveKitInfo;
  /**
   * Whether the browser behind this session is still reporting in. Distinct
   * from `status`, which stays `'active'` until the session is closed even if
   * its browser has stopped — it reports `'provisioning'` only before a browser
   * first serves, never again afterwards. `state` is the browser's latest state
   * (or `null` = "seen but no live state"); `fresh` is whether that report is
   * recent enough to trust. Absent when nothing has been reported — treat
   * absent as "unknown", never as "dead".
   */
  liveness?: { state: 'active' | 'provisioning' | 'idle' | 'terminating' | null; fresh: boolean };
  /**
   * Latest report of what this live session can do. Absent until reported (and
   * on closed sessions). A false `manual_input_available` means the video is
   * view-only; blank/failed and dead_proxy are explicit degraded states, not
   * successful input/video. `default_connection_down` is `dead_proxy` for a
   * session with no proxy of its own: the connection Driftstack provides stopped
   * carrying traffic, and there is nothing on your side to fix.
   */
  capability_report?: {
    timestamp: string;
    manual_input_available: boolean | null;
    streaming_state: 'provisioning' | 'live' | 'blank' | 'failed' | null;
    egress_state: 'live' | 'dead_proxy' | 'default_connection_down' | null;
    proxy_kind: 'socks5' | 'openvpn' | 'wireguard';
    proxy_udp_supported: boolean;
    transport_mode_requested: 'h2-only' | 'h2-and-h3';
    transport_mode_active: 'h2-only' | 'h2-and-h3';
    safeguards_passed: boolean;
    /**
     * The live exit identity this session's traffic leaves through, and the IPs
     * its WebRTC candidates surface. Each is `null` until reported (NOT
     * OBSERVED), never read as "no exit".
     */
    exit_ip: string | null;
    exit_country: string | null;
    exit_timezone: string | null;
    webrtc_candidate_ips: string[] | null;
    observed_at: string | null;
  };
  /**
   * The largest file, in bytes, one upload to this session can carry right now.
   * Each device takes a file up to its own size, so this can be smaller than the
   * 64 MiB per-file maximum. Returned by `get` while the session is running on a
   * connected device; absent means not known.
   */
  upload_max_file_bytes?: number;
  /** Latest launch or runtime failure reported for this session. */
  error_event?: {
    timestamp: string;
    code: string;
    severity: 'info' | 'warn' | 'error' | 'fatal';
    summary: string;
    detail: string | null;
    customer_actionable: boolean;
    retryable: boolean;
  } | null;
}

/**
 * GET /v1/agent-sessions envelope — newest-first, cursor-paginated. The standard
 * `{ data, has_more, next_cursor }` shape shared by sessions / recipes /
 * crypto-orders.
 */
export interface AgentSessionsListPage {
  data: AgentSession[];
  has_more: boolean;
  next_cursor: string | null;
}

export interface CreateAgentSessionRequest {
  driftstack_session_id?: string;
  /**
   * Continue a FINISHED chat: the named session's transcript is carried into
   * the new session, so the agent still has the conversation. The source must
   * be owned (404 otherwise) and closed (409 while it is still active).
   * Omit for an ordinary session with no history.
   */
  continue_from_agent_session_id?: string;
  /**
   * Tokens the AI may spend over the whole session. Defaults to 100,000; at
   * most 10,000,000. When it runs out the session closes with `closed_reason`
   * `'budget-exhausted'` and the message that ran it out returns a 409
   * `ConflictError` whose `sessionStatus` is `'closed'`.
   */
  token_budget?: number;
  /**
   * How the session is driven. Defaults to 'ai': the AI plans and runs each
   * message you send. 'manual' records each message without running it, for a
   * person driving the browser. 'pair' lets a person take over from the AI.
   */
  mode?: 'manual' | 'ai' | 'pair';
  /**
   * The Claude model the AI runs for this session. Defaults to 'claude-sonnet-5'
   * when omitted; 'claude-haiku-4-5' is the cheapest and fastest. Opus models
   * ('claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7') run only on your own
   * Anthropic key: when the session would run on Driftstack's included AI, the
   * API refuses them with a 403 `ForbiddenError` whose `requiresOwnKey`
   * is true. Every 4.x id stays accepted for back-compat.
   */
  model?:
    | 'claude-opus-5'
    | 'claude-sonnet-5'
    | 'claude-opus-4-8'
    | 'claude-opus-4-7'
    | 'claude-sonnet-4-6'
    | 'claude-haiku-4-5';
  /**
   * Attach a saved profile (a persistent browser identity — cookies,
   * localStorage, etc.) so the session resumes that profile's stored state and
   * saves changes back when it ends. Must reference a profile your account owns
   * (an unknown or not-owned id returns 404). A profile can have one live
   * session at a time: a second create returns a 409 ProfileInUseError naming
   * the live one. Omit for a stateless session.
   */
  profile_id?: string;
  /**
   * Route the session through one of your account proxies (manage them at
   * `/v1/account/me/proxies`). Must reference a proxy your account owns (an
   * unknown or not-owned id returns 404). The proxy is tested before launch; a
   * failed test returns a 422 ProxyValidationFailedError. Omit for the default
   * egress.
   */
  proxy_id?: string;
  /**
   * Skip the pre-launch proxy test for this launch only — for a proxy you know
   * works but the test reports as unreachable. Omit to run the test.
   */
  skip_proxy_probe?: boolean;
  /**
   * A start page for the browser. Must be an absolute http(s) URL; `file:`,
   * `javascript:`, `data:` schemes are rejected (400). For an AI task, also put
   * the URL in your message: the agent navigates from what you ask, so the task
   * does not depend on the start page.
   */
  initial_url?: string;
  /**
   * Explicit geolocation override for the session. By default the device's
   * `navigator.geolocation` is derived from the proxy exit IP, so its reported
   * location automatically matches the session's apparent network location —
   * for most sessions you should NOT set this. Supply it only when you know
   * the proxy's true physical location better than IP geolocation does.
   * Coordinates that diverge from the proxy exit country make the session's
   * fingerprint internally inconsistent (a detection signal). `latitude`
   * -90..90, `longitude` -180..180, `accuracy` in meters (omit for the
   * device default).
   */
  geolocation?: { latitude: number; longitude: number; accuracy?: number };
  /**
   * End the session if its exit IP changes mid-run. When true, the first exit IP
   * seen for the session is remembered and the session stops the moment a later
   * report shows a different one (`closed_reason` `'exit_ip_changed'`) — a proxy
   * that silently rotates its exit under a running session stops it rather than
   * carrying on from a new apparent location. Omit → false.
   */
  stop_on_exit_ip_change?: boolean;
}

export type AgentIntent =
  | { kind: 'navigate'; url: string }
  | {
      kind: 'interact';
      action: 'tap' | 'type' | 'scroll' | 'swipe' | 'press';
      selector?: string;
      value?: string;
      /** True on a `type` step whose value is sensitive (a card number, a
       *  one-time code, a PIN); such values are withheld from the response. */
      sensitive?: boolean;
    }
  | { kind: 'wait'; condition: 'idle' | 'selector_visible'; selector?: string; timeoutMs?: number }
  | { kind: 'capture'; capture: 'screenshot' | 'dom_snapshot' | 'pdf' }
  | { kind: 'scroll'; direction: 'up' | 'down'; amount_px?: number }
  | { kind: 'behavioral_pause'; duration_ms?: number; reading_word_count?: number };

/**
 * What kind of consequential action a step was about to take when the agent
 * stopped to ask for your approval. A `confirmation_required` result names it;
 * approve by sending the next message with `approveConsequentialActions` (see
 * {@link AgentSessionsResource.message}). The values listed are the ones this
 * SDK version knows; the type also admits any other string, so a category newer
 * than this SDK still type-checks and can be passed straight back.
 */
export type ConsequentialActionCategory =
  | 'purchase'
  | 'payment'
  | 'account_deletion'
  // `string & {}` rather than `string`, so editors still suggest the values above.
  | (string & {});

/**
 * Per-turn usage/cost block. Attached by the server on every Claude-backed
 * message response (`decomposer_kind: 'claude'`); deterministic turns set
 * `decomposer_kind: 'deterministic'` with token/cost fields absent. Surface it
 * as a "$0.0023 · 145 tok · <model>" badge; render '—' when undefined.
 */
export interface AgentUsage {
  decomposer_kind: 'claude' | 'deterministic';
  anthropic_input_tokens?: number;
  anthropic_output_tokens?: number;
  cost_usd_cents?: number;
  model?: string;
}

/** Machine-readable failure diagnosis. `reason` is the
 *  human-facing copy; `diagnosis` is the structured companion an automation can
 *  branch on without string-matching prose. `retryable: true` means automatic
 *  replay of the same step is considered safe; false means never auto-replay.
 *  A false result can require a corrected request, or it can mean the prior
 *  action's outcome is unknown and current state must be inspected. Optional:
 *  older servers omit it. */
export interface AgentFailureDiagnosis {
  /** What kind of failure this was. The values listed are the ones this SDK
   *  version knows; new categories are added over time, so the type also admits
   *  any other string. Treat a value you do not recognise as `'unknown'`, and
   *  give an exhaustive `switch` a `default` branch. */
  category:
    | 'element_not_found'
    | 'page_load_failed'
    | 'condition_not_met'
    | 'capture_failed'
    | 'scroll_failed'
    | 'session_error'
    | 'invalid_request'
    | 'result_too_large'
    | 'element_covered'
    | 'target_unverified'
    | 'unknown'
    // `string & {}` rather than `string`: a bare `string` would absorb the
    // literals above and editors would stop suggesting them.
    | (string & {});
  retryable: boolean;
}

/** Something worth knowing about a step that SUCCEEDED. Absent means there is
 *  nothing to report.
 *
 *  `'http_error_status'` — a navigation reached the site and the site answered
 *  with an HTTP status of 400 or above (`status`). The page that loaded may be
 *  the site's error page, a page asking to sign in or to complete a
 *  verification step first, or the whole page served under that status; the
 *  step's `summary` says the same in words. The step still succeeded: decide
 *  from the page what to do next.
 *
 *  The kinds listed are the ones this SDK version knows. New kinds are added
 *  over time, so the type also admits any other string: treat one you do not
 *  recognise as a note, and read `summary`. */
export interface AgentStepWarning {
  kind:
    | 'http_error_status'
    // `string & {}` rather than `string`: a bare `string` would absorb the
    // literal above and editors would stop suggesting it.
    | (string & {});
  /** For `'http_error_status'`: the HTTP status the site answered with. */
  status?: number;
}

export type AgentIntentResult =
  | {
      kind: 'success';
      intent: AgentIntent;
      summary: string;
      captureId?: string;
      warning?: AgentStepWarning;
    }
  | { kind: 'failure'; intent: AgentIntent; reason: string; diagnosis?: AgentFailureDiagnosis }
  // The agent stopped BEFORE a consequential action (a purchase, a payment, an
  // account deletion) and is waiting for your approval; the step did not run.
  // Approve by sending the next message with this result's {category,
  // matchedText} in `message(id, msg, { approveConsequentialActions: [...] })`.
  | {
      kind: 'confirmation_required';
      intent: AgentIntent;
      category: ConsequentialActionCategory;
      matchedText: string;
    };

/**
 * Why a turn ended before the task was finished — the one-word form of the
 * `notice` sentence, for a program that cannot read English prose.
 *
 * ⛔ OPEN. `(string & {})` keeps the known values in editor completions while
 * still admitting a value a newer server has and this SDK does not: a turn that
 * learns a new way to end must not make an older program fail to typecheck (or,
 * worse, throw) on a response that is perfectly valid.
 */
export type AgentNoticeReason =
  | 'step_limit'
  | 'time_limit'
  | 'budget_low'
  | 'no_progress'
  | 'repeated_step'
  | 'ai_unavailable'
  | 'page_unreadable'
  | 'question'
  | 'declined'
  | (string & {});

export type AgentMessageResponse =
  | {
      kind: 'plan-executed';
      session: AgentSession;
      /** Every step the turn attempted, in order, across every plan it made.
       *  Read each step's outcome from `results`, which carries the step it ran
       *  as `results[i].intent`; the two arrays need not line up by index —
       *  `intents` is longer when a plan was abandoned part-way, because the
       *  steps that did not run have no result. */
      intents: ReadonlyArray<AgentIntent>;
      /** Every step that ran, in order. */
      results: ReadonlyArray<AgentIntentResult>;
      /**
       * True when the last planned steps ran without a failure and without
       * stopping for approval. False if a step failed OR the turn stopped on a
       * `confirmation_required` result (check `results`). It does not by itself
       * mean the task is finished — check `notice` — and a turn that recovered
       * from a failed step can be true with that failure still in `results`.
       */
      ok: boolean;
      /**
       * The agent's answer to the question the turn asked ("what is my IP?"),
       * read back from the page the plan landed on. Present only when a
       * read-back ran and produced one; a turn that only acts (navigate, tap,
       * screenshot) has no answer and omits the field.
       */
      answer?: string;
      /**
       * Why there is no `answer`, when the message asked for information and
       * none could be produced: one sentence, in plain words. Never present
       * together with `answer`, and absent on a message that only asked for
       * actions. Open text — show it, do not match on it. Absent on older
       * servers.
       */
      answer_unavailable?: string;
      /**
       * Present when the turn ended before the task was finished — it reached a
       * limit on steps, time or budget, or stopped rather than repeat itself —
       * or when the agent asked you something part-way through. One or two
       * sentences saying what to do next; when it asks for "continue", send that
       * as the next message to carry on from the current page. Absent when the
       * task finished or a step failed.
       */
      notice?: string;
      /**
       * The same ending as `notice`, in one word you can branch on. Present
       * whenever `notice` is, and never without it.
       *
       * - `'step_limit'` — the task needs more steps than one message runs.
       *   Send "continue".
       * - `'time_limit'` — the message was taking too long. Send "continue".
       * - `'budget_low'` — too little of the session's AI budget is left. Start
       *   a new session and carry on there.
       * - `'no_progress'` — the page stopped changing and the next step would
       *   have repeated one that changed nothing. Put it in front of a person:
       *   `notice` asks what to try instead.
       * - `'repeated_step'` — the next step would have repeated an action that
       *   already ran, which could do it twice. Check the page, then send
       *   "continue" if it is safe.
       * - `'ai_unavailable'` — the next steps could not be worked out just now.
       *   Send "continue" to try again.
       * - `'page_unreadable'` — the page could not be read to plan the next
       *   step. Send "continue" to try again.
       * - `'question'` — the agent asked you something part-way. `notice` is
       *   the question; send your answer as the next message.
       * - `'declined'` — the agent stopped rather than carry on. A person
       *   should decide what to do.
       *
       * ⛔ OPEN: a turn can end a way this SDK has never heard of, so the type
       * admits any string. Match the values you know and fall back to showing
       * `notice`. Absent on older servers.
       */
      notice_reason?: AgentNoticeReason;
      usage?: AgentUsage;
    }
  | {
      kind: 'clarify';
      session: AgentSession;
      clarifying_question: string;
      usage?: AgentUsage;
    }
  | {
      /** The agent will not do this. A refuse can also mean the AI was briefly
       *  unavailable; the session stays active and you can send the message
       *  again. */
      kind: 'refuse';
      session: AgentSession;
      refuse_reason: string;
      usage?: AgentUsage;
    }
  | {
      /**
       * The turn was stopped with {@link AgentSessionsResource.stop} and ended
       * where it was asked to. `results` are the steps that ran, in order —
       * including one that was already running when the stop arrived, with its
       * real result, or a failure saying its outcome could not be confirmed
       * (check the page before repeating it). `intents` are the steps that ran,
       * never the ones that were still to come. `notice` is one sentence saying
       * how far the turn got. The session accepts the next message as soon as
       * this response arrives.
       */
      kind: 'stopped';
      session: AgentSession;
      intents: ReadonlyArray<AgentIntent>;
      results: ReadonlyArray<AgentIntentResult>;
      /** Always false: a stopped turn did not finish its task. */
      ok: false;
      notice: string;
      /** What the turn was doing when it noticed the stop. */
      stopped_during: 'planning' | 'executing' | 'reading_page' | 'answering';
      usage?: AgentUsage;
    }
  | {
      /**
       * A `'manual'`-mode session recorded the message without running it: no
       * plan, no steps. A person drives the browser in this mode.
       */
      kind: 'logged-manual';
      session: AgentSession;
    };

/**
 * How long one `message()` call waits by default: 50 minutes. A turn stops
 * planning new steps after about three minutes, but the steps it has already
 * planned run to the end and the answer may still be read back after them, so a
 * rare turn runs far longer. The stream's keep-alives hold the connection open
 * meanwhile; this is the absolute limit, not an idle timeout.
 */
export const AGENT_MESSAGE_STREAM_TIMEOUT_MS = 50 * 60_000;

/**
 * Payload of each `step` event on a turn's stream: the step's 0-based position
 * in the final `results`, and its result.
 */
export interface AgentStepEvent {
  index: number;
  result: AgentIntentResult;
}

/** A screenshot fetched with {@link AgentSessionsResource.getCapture}. */
export interface AgentCapture {
  /** `'image/png'` or `'image/jpeg'` — which one this screenshot is. */
  contentType: string;
  /** The image itself. Write it to a file as-is. */
  bytes: Uint8Array;
}

/**
 * One entry of a session's conversation. `role` is who wrote it: `'user'` (a
 * message you sent), `'agent'` (the AI's outcome) or `'operator'` (a message
 * recorded by a `'manual'`-mode session). `body` is always plain text, never
 * JSON. `intents` is present on an agent entry whose plan ran; sensitive typed
 * values are withheld from it. Entries can carry other fields too; ignore any
 * you do not recognise.
 */
export interface AgentTranscriptEntry {
  role: 'user' | 'agent' | 'operator' | (string & {});
  body: string;
  /** ISO-8601 time the entry was written. */
  at: string;
  intents?: ReadonlyArray<AgentIntent>;
  [k: string]: unknown;
}

/** One item yielded by {@link AgentSessionsResource.transcript}: the entry and
 *  its 0-based position in the conversation. Pass the last `index` you saw as
 *  `lastEventId` to carry on from there. */
export interface AgentTranscriptEvent {
  index: number;
  entry: AgentTranscriptEntry;
}

/** The `transcript.entry` frames of a stream, as events. The set of event names
 *  is open: a frame that is not a transcript entry, or does not look like one,
 *  is skipped, never an error. */
async function* transcriptEvents(
  frames: AsyncGenerator<EventStreamFrame, void, void>,
): AsyncGenerator<AgentTranscriptEvent, void, void> {
  for await (const frame of frames) {
    if (frame.type !== 'transcript.entry') continue;
    const data = frame.data as { index?: unknown; entry?: unknown } | null;
    if (
      data === null ||
      typeof data !== 'object' ||
      typeof data.index !== 'number' ||
      typeof data.entry !== 'object' ||
      data.entry === null
    ) {
      continue;
    }
    yield { index: data.index, entry: data.entry as AgentTranscriptEntry };
  }
}

export class AgentSessionsResource {
  constructor(private readonly http: HttpClient) {}

  /**
   * Start an agent session. Returns it as soon as it exists; while `status` is
   * `'provisioning'` its browser is still starting, so poll `get(id)` until it
   * reads `'active'` before sending a message (a `'closed'` status means it
   * could not start — read `closed_reason`).
   *
   * `idempotencyKey` (recommended) makes a retried create return the first
   * session instead of starting a second one.
   *
   * `byokApiKey` is your own Anthropic API key, sent as the
   * `x-byok-anthropic-api-key` header. Create only uses it to decide whether an
   * Opus model is allowed (Opus runs only on your own key); send it on every
   * `message()` too. The SDK never logs it.
   *
   * Errors: 429 ConcurrencyLimitError (your plan's concurrent-session limit is
   * reached), 409 ProfileInUseError (the profile already has a live session),
   * 409 StorageQuotaExceededError, 422 ProxyValidationFailedError, 403
   * ForbiddenError (the plan has no AI, or an Opus model without your own key —
   * `requiresOwnKey`), 404 NotFoundError (unknown profile, proxy or session to
   * continue from).
   */
  create(
    body: CreateAgentSessionRequest = {},
    opts?: { idempotencyKey?: string; byokApiKey?: string },
  ): Promise<AgentSession> {
    // Stripe-pattern idempotency. Forward as the
    // `Idempotency-Key` request header so retries collapse onto the
    // server's first 201 response. The server-side partial unique
    // index on (account_id, idempotency_key) is what guarantees the
    // dedupe end-to-end; SDK just plumbs the header.
    const headers: Record<string, string> = {
      ...(opts?.idempotencyKey !== undefined ? { 'Idempotency-Key': opts.idempotencyKey } : {}),
      // Skipped when undefined OR empty, like message() below.
      ...(opts?.byokApiKey !== undefined && opts.byokApiKey.length > 0
        ? { 'x-byok-anthropic-api-key': opts.byokApiKey }
        : {}),
    };
    return this.http.request<AgentSession>({
      method: 'POST',
      path: '/v1/agent-sessions',
      body,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    });
  }

  get(id: string): Promise<AgentSession> {
    return this.http.request<AgentSession>({
      method: 'GET',
      path: `/v1/agent-sessions/${encodeURIComponent(id)}`,
    });
  }

  /**
   * List the account's agent sessions, newest first. Cursor-paginated —
   * mirrors the GET /v1/agent-sessions envelope `{ data, has_more, next_cursor }`.
   * Pass a `cursor` (the prior page's `next_cursor`) to page; or use
   * `iterate()` to walk every page automatically.
   */
  list(query: PaginationQueryInput = {}): Promise<AgentSessionsListPage> {
    return this.http.request<AgentSessionsListPage>({
      method: 'GET',
      path: '/v1/agent-sessions',
      query: {
        ...(query.limit !== undefined ? { limit: query.limit } : {}),
        ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
      },
    });
  }

  /**
   * Lazily iterate every agent session for the EFFECTIVE account, walking
   * cursor pages automatically (newest first). See `iteratePaginated` for
   * semantics.
   */
  iterate(opts: { limit?: number } = {}): AsyncGenerator<AgentSession, void, void> {
    return iteratePaginated<AgentSession>((cursor) =>
      this.list({
        ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
        ...(cursor !== null ? { cursor } : {}),
      }),
    );
  }

  /**
   * Send one message — a task or a question — and wait for the outcome. The
   * call streams, so it can take several minutes; it resolves when the turn
   * ends. Returns a discriminated union — callers MUST branch on
   * `kind` before reading the variant-specific fields:
   *
   * - `'plan-executed'` — the steps ran. `answer` is what you asked for, when
   *   you asked for information; `results` has each step's outcome; `notice`,
   *   when present, says why the task is not finished yet, and `notice_reason`
   *   says the same in one word to branch on. A result of kind
   *   `'confirmation_required'` means the agent stopped before a purchase, a
   *   payment or an account deletion and is waiting for your approval.
   * - `'clarify'` — the agent needs more detail; reply with another message.
   * - `'refuse'` — the agent will not do this, or the AI was briefly
   *   unavailable (the session stays active; send it again).
   * - `'stopped'` — you called `stop()`.
   * - `'logged-manual'` — a `'manual'`-mode session recorded the message.
   *
   * `byokApiKey` (optional) is your own Anthropic API
   * key. Forwarded via the
   * `x-byok-anthropic-api-key` request header so callers don't have
   * to construct it by hand. It takes precedence over a stored key and over
   * Driftstack's included AI. NEVER logged by the SDK.
   *
   * `approveConsequentialActions` (optional) approves the actions the previous
   * turn stopped on. Pass the `{ category, matchedText }` of each
   * `confirmation_required` result (the result objects themselves work); the
   * SDK maps each entry to the wire's snake_case `{category, matched_text}`.
   * Send it as the very next message on the session — the stopped steps then
   * continue from where they paused, without planning again. Any other message
   * in between discards the paused steps, and the agent plans afresh.
   *
   * `idempotencyKey` (strongly recommended) identifies this logical turn.
   * Reuse it when retrying after a lost/ambiguous stream so the server replays
   * the durable terminal result instead of executing browser actions twice.
   * A refusal raised BEFORE the turn did any work gives the key back, so the
   * same key runs the turn once the cause is gone: a ConflictError whose
   * `turnInProgress` is true, a RateLimitError (the message rate, or too many
   * AI turns running at once), BundledLlmConsentRequiredError,
   * BundledLlmBudgetExhaustedError, a
   * ForbiddenError about the plan's AI or the model (`requiresOwnKey`), and a
   * ByokAnthropicRequiredError whose `keyRejected` is false. Fix the cause or
   * wait, then send the same request again with the SAME key. So is a
   * ConflictError whose `idempotencyStatus` is `'in_progress'`: the first
   * attempt is still being resolved, and the same key replays its result.
   *
   * Every other answer is final for that key and sending it again replays it —
   * every completed turn, every failure after the turn started, a rejected own
   * key (`keyRejected`), a 500, a `'refuse'` result, and the 409 for a session
   * that is closed or paused. To send one of those again, fix the cause and use
   * a NEW key. Use a new key too whenever the message, session or approvals
   * change.
   *
   * Errors you should expect:
   * - 409 ConflictError — `turnInProgress`: another message is still running
   *   on this session (wait, or `stop()` it); `sessionStatus`: the session is
   *   not active — `'closed'` (`closedReason` says why; start a new one,
   *   optionally with `continue_from_agent_session_id`) or `'paused'`.
   * - 429 RateLimitError — the account's message rate, or too many AI turns
   *   running at once: across your sessions, or on Driftstack's included AI.
   *   No step ran; wait `retryAfterSeconds`, then send the same request again
   *   — the same idempotency key still works (`isRetryable` is true).
   * - 403 ForbiddenError — the plan has no AI, the included AI is not on your
   *   plan, or an Opus model needs your own key (`requiresOwnKey`).
   * - 402 BundledLlmBudgetExhaustedError / BundledLlmConsentRequiredError —
   *   the included AI's budget is used up, or the account has not opted in.
   * - 502 ByokAnthropicRequiredError — the turn has no AI key (a plan that runs
   *   AI only on its own key is answered this way too), or Anthropic refused
   *   your key (`keyRejected`; `keySource` and `keyRejectedReason` say which
   *   key and why). No step ran. Not retryable: fix the key first.
   * - 503 FeatureUnavailableError — you sent an `idempotencyKey` and this
   *   deployment cannot record one, so nothing ran. ⛔ NOT transient: the same
   *   key fails the same way for as long as the deployment is in that state, so
   *   a retry loop never ends. The same message WITHOUT `idempotencyKey` runs
   *   the turn — send it that way only if running the task twice would be safe,
   *   because that is the protection you are giving up.
   */
  message(
    id: string,
    userMessage: string,
    opts?: {
      byokApiKey?: string;
      idempotencyKey?: string;
      /** Absolute transport backstop for the heartbeat-backed turn stream.
       * Defaults to 50 minutes; this is not an idle timeout. */
      timeoutMs?: number;
      approveConsequentialActions?: ReadonlyArray<{
        category: ConsequentialActionCategory;
        matchedText: string;
      }>;
      /**
       * Live-progress callback: invoked once per browser step AS it lands
       * (streamed on the turn's SSE) — BEFORE this promise resolves with the
       * final AgentMessageResponse. `index` is the step's 0-based position in the
       * final `results`, and `result` is the same per-step shape those results
       * carry. Best-effort: omit it and the turn still resolves normally with the
       * complete result; an older server that does not stream steps simply never
       * calls it.
       */
      onStep?: (step: AgentStepEvent) => void;
      /**
       * Every OTHER live frame on the turn's stream, by event name. Today:
       * - `phase` `{ phase, segment?, cause? }` — what the turn is doing now;
       * - `plan` `{ total, intents, labels, offset?, segment?, status? }` — the
       *   steps it is about to run (`offset` is the turn-wide index of the first);
       * - `step_start` `{ index, total, label }` — a step is starting;
       * - `answer` `{ answer }` — the answer, before the turn's final result;
       * - `notice` `{ notice, notice_reason? }` — why the turn is ending before
       *   the task is done, as a sentence and as the one word the final result
       *   carries as `notice_reason`.
       * The final result is always the resolved value, never one of these.
       *
       * ⛔ Treat an unrecognised `type` as nothing at all. The set is open: the
       * server adds progress events without a version bump, and a consumer that
       * throws (or shows an error) on an unknown name breaks itself on a server
       * that is behaving correctly. `data` is likewise unvalidated here.
       */
      onEvent?: (event: { type: string; data: unknown }) => void;
    },
  ): Promise<AgentMessageResponse> {
    const approvals = opts?.approveConsequentialActions;
    const onStep = opts?.onStep;
    const onEvent = opts?.onEvent;
    return this.http.requestEventStream<AgentMessageResponse>(
      {
        method: 'POST',
        path: `/v1/agent-sessions/${encodeURIComponent(id)}/message`,
        timeoutMs: opts?.timeoutMs ?? AGENT_MESSAGE_STREAM_TIMEOUT_MS,
        body: {
          user_message: userMessage,
          // Re-send approved consequential actions in the wire's snake_case
          // shape so the paused steps continue. Omit the field entirely when
          // there are none (matches the route's optional schema; avoids sending
          // an empty array).
          ...(approvals !== undefined && approvals.length > 0
            ? {
                approve_consequential_actions: approvals.map((a) => ({
                  category: a.category,
                  matched_text: a.matchedText,
                })),
              }
            : {}),
        },
        // Skip the header when byokApiKey is undefined OR empty string.
        // Empty would send `x-byok-anthropic-api-key:` on the wire — the
        // server normalises that to absent, but skipping client-side saves
        // the round-trip header and matches the Go SDK's
        // `opts != nil && opts.ByokAPIKey != ""` shape.
        headers: {
          accept: 'text/event-stream',
          ...(opts?.idempotencyKey !== undefined ? { 'Idempotency-Key': opts.idempotencyKey } : {}),
          ...(opts?.byokApiKey !== undefined && opts.byokApiKey.length > 0
            ? { 'x-byok-anthropic-api-key': opts.byokApiKey }
            : {}),
        },
      },
      onStep === undefined
        ? undefined
        : (event) => {
            onStep(event as AgentStepEvent);
          },
      onEvent,
    );
  }

  /**
   * Fetch a screenshot the agent took. A `capture` step's result carries a
   * `captureId`; this returns the image behind it, with its `contentType`
   * (`'image/png'` or `'image/jpeg'`).
   *
   * Screenshots are kept only briefly — at most the 20 most recent per session,
   * and they can be removed once 30 minutes pass without a new one in that
   * session — so fetch one as soon as its turn ends.
   *
   * Errors: 404 NotFoundError — the session is unknown, or no screenshot with
   * this id is kept for it any more.
   */
  async getCapture(id: string, captureId: string): Promise<AgentCapture> {
    const res = await this.http.requestBytes({
      method: 'GET',
      path: `/v1/agent-sessions/${encodeURIComponent(id)}/captures/${encodeURIComponent(captureId)}`,
    });
    return { contentType: res.contentType, bytes: res.bytes };
  }

  /**
   * Read a session's conversation, then follow it live. Yields every entry
   * already in the transcript, oldest first, and then each new entry as it is
   * written — so the loop does not end by itself while the session is open.
   * Stop it by leaving the loop (`break`), or by aborting `signal`; either
   * closes the connection.
   *
   * To read only what is there now, read `transcript_length` with `get(id)`
   * first and leave the loop at `index === transcript_length - 1` (skip the
   * call when it is 0).
   *
   * `lastEventId` resumes: pass the last `index` you saw and the stream starts
   * with the entry after it, so nothing is repeated. The stream ends when the
   * server closes it (your key lost access, or the connection was recycled);
   * call again with `lastEventId` to carry on.
   *
   * `timeoutMs` is the absolute limit on how long one call may stay open
   * (default 50 minutes, the same as `message()`); past it the call throws a
   * TransportError. It is not an idle timeout.
   *
   * Entries are returned as the session recorded them: `body` is free text,
   * and may contain whatever was sent to the agent. Treat the transcript as
   * sensitive.
   *
   * Errors: 404 NotFoundError; 429 RateLimitError — an account may hold at
   * most 10 transcript streams open at once (wait `retryAfterSeconds`).
   */
  transcript(
    id: string,
    opts?: {
      /** Resume after this entry index (the `index` of the last event you saw). */
      lastEventId?: number;
      /** Abort to end the stream from outside the loop. Ends it quietly. */
      signal?: AbortSignal;
      /** Absolute limit for this call, in ms. Defaults to 50 minutes. */
      timeoutMs?: number;
    },
  ): AsyncGenerator<AgentTranscriptEvent, void, void> {
    return transcriptEvents(
      this.http.requestEventFrames(
        {
          method: 'GET',
          path: `/v1/agent-sessions/${encodeURIComponent(id)}/transcript`,
          timeoutMs: opts?.timeoutMs ?? AGENT_MESSAGE_STREAM_TIMEOUT_MS,
          // `!== undefined`, not truthiness: 0 is an index.
          ...(opts?.lastEventId !== undefined
            ? { headers: { 'Last-Event-ID': String(opts.lastEventId) } }
            : {}),
        },
        opts?.signal,
      ),
    );
  }

  /**
   * Set the session's mode. Transitioning INTO 'pair' initializes
   * pair_mode_state to `{kind: 'ai-driving'}`, transitioning OUT
   * clears it to null. Idempotent — a no-op transition returns the
   * existing row (pair_mode_state preserved).
   *
   * Throws `ConflictError` (409) if the session is not 'active'.
   */
  setMode(id: string, mode: 'manual' | 'ai' | 'pair'): Promise<AgentSession> {
    return this.http.request<AgentSession>({
      method: 'POST',
      path: `/v1/agent-sessions/${encodeURIComponent(id)}/mode`,
      body: { mode },
    });
  }

  /**
   * Move a RUNNING session onto a different egress without
   * restarting it. The page keeps its tabs, cookies and scroll
   * position; only the exit changes.
   *
   * ⛔ NOT AVAILABLE YET. No device can change egress on a running
   * session, so this currently returns `{ status: 'unavailable' }`
   * for every call — create a new session with the `proxyId` you
   * want instead. The shapes are stable and will not change when
   * device support lands, so code written against this today keeps
   * working; only the `status` you get back changes.
   *
   * `proxyId` must be a proxy on your own account that has been
   * tested at least once (`account.proxies.test(id)`): the swap
   * carries the exit's MEASURED identity — IP, country, timezone —
   * to the device so the page keeps seeing a consistent origin. An
   * untested proxy has no measured identity to carry, and the
   * response is `status:'unavailable'` rather than a guessed one.
   *
   * `applyPoint` defaults to `'next_navigation'`, which swaps on the
   * next page load and leaves connections in flight alone.
   * `'immediate'` swaps at once and may reset connections mid-page.
   *
   * ⛔ Read `status` before assuming anything moved: only `'ok'`
   * means the egress changed. On `'ok'`, `apply_point` says WHEN —
   * and `null` there means the device accepted the swap but did not
   * confirm the timing, which you should treat as possibly-immediate.
   */
  setEgress(
    id: string,
    proxyId: string,
    applyPoint?: 'next_navigation' | 'immediate',
  ): Promise<AgentSessionEgressResult> {
    return this.http.request<AgentSessionEgressResult>({
      method: 'POST',
      path: `/v1/agent-sessions/${encodeURIComponent(id)}/egress`,
      body: {
        proxy_id: proxyId,
        ...(applyPoint !== undefined ? { apply_point: applyPoint } : {}),
      },
    });
  }

  /**
   * Send one raw input event (pointer, keyboard, wheel or touch) to a manual or
   * pair-mode session.
   *
   * Modifier vocabulary: `keyDown` / `keyUp` `modifiers` arrays MUST use the
   * 4-name set `'cmd' | 'ctrl' | 'shift' | 'option'`. DOM-standard names
   * (`Shift / Control / Alt / Meta`) pass validation but are ignored.
   *
   * No deployment forwards input events to the browser. That does NOT make
   * every call a 503. The response is a discriminated union and one arm is
   * live today:
   *
   * - `'pair-mode-takeover-fired'` (200) — the FIRST input-event in a
   *   mode='pair' session whose `pair_mode_state.kind` is `ai-driving`
   *   asks for a takeover and returns the new state. It forwards
   *   nothing, which is why "no deployment forwards input events" stays
   *   true. `client_id` is REQUIRED on this path.
   * - `'forwarded'` — unreachable: it sits behind the `human-driving`
   *   state, which no request can reach today. Branching on it is dead
   *   code.
   *
   * Everything else throws `FeatureUnavailableError` (503): mode='manual'
   * always, and mode='pair' once the state has left `ai-driving`.
   *
   * Throws `ConflictError` (409) if the session is not 'active', OR is
   * in mode='ai' (input-event requires manual or pair mode), OR the
   * pair-mode state is mid-transition.
   * Throws `ValidationError` (400) when the pair-mode `ai-driving` path
   * is taken without `client_id`.
   */
  sendInputEvent(
    id: string,
    event: InputEvent,
    opts?: { clientId?: string },
  ): Promise<SendInputEventResponse> {
    return this.http.request<SendInputEventResponse>({
      method: 'POST',
      path: `/v1/agent-sessions/${encodeURIComponent(id)}/input-event`,
      body: opts?.clientId !== undefined ? { event, client_id: opts.clientId } : { event },
    });
  }

  /**
   * End the agent session and its browser (sets status=closed; idempotent).
   * Close every session you start — an open session keeps counting toward your
   * plan's concurrent-session limit.
   */
  close(id: string): Promise<void> {
    return this.http.request<void>({
      method: 'DELETE',
      path: `/v1/agent-sessions/${encodeURIComponent(id)}`,
    });
  }

  /**
   * Request a human takeover on a pair-mode agent session. The state machine
   * transitions
   * `ai-driving → takeover-pending` (or `takeover-queued` if the
   * runtime is mid-decompose). Returns the new `pair_mode_state`
   * discriminant so the caller can branch on whether the takeover
   * was queued behind an in-flight turn.
   *
   * Throws `PairModeStateInvalidTransitionError` (409) if the
   * session is not in a state that permits takeover.
   * Throws `ConflictError` (409) if the session is not mode='pair'.
   */
  takeover(
    id: string,
    clientId: string,
  ): Promise<{ pair_mode_state: { kind: string; [k: string]: unknown } }> {
    return this.http.request({
      method: 'POST',
      path: `/v1/agent-sessions/${encodeURIComponent(id)}/takeover`,
      body: { client_id: clientId },
    });
  }

  /**
   * Request a handback from human back to AI on a pair-mode agent session.
   * The state machine
   * transitions `human-driving → handback-pending` (or
   * `handback-queued` if the runtime is mid-decompose).
   *
   * Today no request can move a session into `human-driving`, so this
   * returns the 409 below.
   *
   * Throws `PairModeStateInvalidTransitionError` (409) if the
   * session is not in `human-driving`.
   */
  handback(id: string): Promise<{ pair_mode_state: { kind: string; [k: string]: unknown } }> {
    return this.http.request({
      method: 'POST',
      path: `/v1/agent-sessions/${encodeURIComponent(id)}/handback`,
      body: {},
    });
  }

  /**
   * Mint a fresh live-video token for the agent session's video
   * room. Use this when the `livekit` field on the created session is
   * absent, OR the token has expired — tokens last 24h. The same
   * `LiveKitInfo` shape is returned either way; one type, two paths.
   *
   * Errors (raised as DriftstackError with HTTP-mapped kind):
   *   - 403 — session is closed; can't mint
   *   - 404 — session unknown (or cross-account; existence not leaked)
   *   - 503 — live video is not available for this session right now;
   *           try again later, or contact support if it persists
   */
  livekitToken(id: string): Promise<LiveKitInfo> {
    return this.http.request<LiveKitInfo>({
      method: 'POST',
      path: `/v1/agent-sessions/${encodeURIComponent(id)}/livekit-token`,
    });
  }

  /**
   * Resume an agent session that paused on a detected bot check (a CAPTCHA
   * or challenge page), once you've resolved it (e.g. in the live view). The
   * session's `status` stays `'active'` while it is paused; the
   * `session.challenge_detected` webhook tells you it happened. Pass
   * `challenge_id` (from that webhook) to target a specific challenge; omit it
   * for a manual override resume.
   *
   * Returns 202 `{ status: 'resume_requested', session_id }`.
   *   - 404 — session unknown (or cross-account; existence not leaked)
   *   - 409 — session not active (terminal sessions can't be resumed)
   */
  resume(
    id: string,
    body: { challenge_id?: string } = {},
  ): Promise<{ status: 'resume_requested'; session_id: string }> {
    return this.http.request({
      method: 'POST',
      path: `/v1/agent-sessions/${encodeURIComponent(id)}/resume`,
      body,
    });
  }

  /**
   * Stop the session's running turn. Returns as soon as the stop is requested;
   * it does not wait for the turn to wind down. The turn ends on its own
   * `message()` call, which resolves with `kind: 'stopped'` (or, if it was
   * already finishing, its ordinary result) — that response, not this one, is
   * the signal that the session will accept the next message. Because
   * `message()` waits, call this from a timer or another task.
   *
   * A step that was already running when the stop arrived is allowed to finish
   * (for a short, bounded time) so its result is known; nothing is started after it.
   *
   * Returns 202 `{ status: 'stop_requested', session_id }` when a turn was
   * running, 200 `{ status: 'no_turn_running', session_id }` when none was.
   * Safe to call again.
   *   - 404 — session unknown (or cross-account; existence not leaked)
   *   - 503 FeatureUnavailableError — when its `stopUnconfirmed` is true, the
   *     stop could not be confirmed just now and the turn may still be running:
   *     call `stop()` again. (`isRetryable` is false for this class, because
   *     the same 503 without the flag means AI is not enabled and calling again
   *     would not help; the SDK does not retry `stop()` by itself.)
   */
  stop(id: string): Promise<{ status: 'stop_requested' | 'no_turn_running'; session_id: string }> {
    return this.http.request({
      method: 'POST',
      path: `/v1/agent-sessions/${encodeURIComponent(id)}/stop`,
      body: {},
    });
  }
}

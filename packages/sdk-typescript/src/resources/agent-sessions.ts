// AgentSessionsResource — typed methods for /v1/agent-sessions/*.
//
// Four methods mirror the route handlers:
//   create({ token_budget?, driftstack_session_id? })
//   get(id)
//   message(id, user_message)
//   close(id)
//   setEgress(id, proxyId, applyPoint?)
//
// AI-backed operations depend on the deployment's configured BYOK or
// bundled-LLM provider. Deployments without one return the stable
// FeatureUnavailableError; the remaining session surface stays available.

import type { PaginationQueryInput } from '@driftstack/api-types';
import type { HttpClient } from '../http.js';
import { iteratePaginated } from '../pagination.js';

/**
 * Slice 4 (Wave 29-NNN ARC 3) — LK.6 InputEvent wire shape mirrored
 * from `@driftstack/api-types` InputEventSchema. The 7 variants map
 * 1:1 onto the Mac harness's CGEvent dispatch.
 */
export type InputEvent =
  | { type: 'mouseMove'; x: number; y: number }
  | { type: 'mouseDown'; x: number; y: number; button: 0 | 1 | 2 }
  | { type: 'mouseUp'; x: number; y: number; button: 0 | 1 | 2 }
  | { type: 'keyDown'; key: string; modifiers?: readonly string[] }
  | { type: 'keyUp'; key: string; modifiers?: readonly string[] }
  | { type: 'wheel'; x: number; y: number; deltaX: number; deltaY: number }
  // Touch vocab (2026-06-08 product directive; device-CSS px; harness owns dynamics).
  // Lock-step with packages/api-types InputEventSchema + the gui-client copy.
  | { type: 'tap'; x: number; y: number }
  | { type: 'touchStart'; x: number; y: number; touchId: number }
  | { type: 'touchMove'; x: number; y: number; touchId: number }
  | { type: 'touchEnd'; x: number; y: number; touchId: number }
  | { type: 'swipe'; x1: number; y1: number; x2: number; y2: number; durationMs: number }
  | { type: 'ping'; timestamp: number };

/**
 * P-17 — the discriminated result of an egress swap. Only `'ok'` means the
 * egress changed; every other status leaves the session exactly as it was, with
 * `reason` saying why. `apply_point` is present on success and is `null` when
 * the device accepted the swap without confirming when it takes effect.
 */
export interface AgentSessionEgressResult {
  status: 'ok' | 'unavailable' | 'timeout' | 'error';
  apply_point?: 'next_navigation' | 'immediate' | null;
  reason?: string;
}

/** Slice 4 + Slice 5 response envelope for POST /v1/agent-sessions/
 *  :id/input-event. Discriminated union — callers MUST branch on
 *  `kind`:
 *
 *  - `'pair-mode-takeover-fired'` — first input-event in a pair-mode
 *    `ai-driving` session triggered the takeover-request transition.
 *    `pair_mode_state` carries the new state machine kind (typically
 *    `takeover-pending` or `takeover-queued`).
 *  - `'forwarded'` — reserved for direct harness dispatch, carrying
 *    the measured `duration_ms`. No deployment forwards input events,
 *    for two separate reasons: the harness-forward path throws
 *    unconditionally, and the one code path that does build this reply
 *    sits behind a pair-mode state nothing can reach. So the variant is
 *    UNREACHABLE and `if (res.kind === 'forwarded')` is dead code.
 */
export type SendInputEventResponse =
  | {
      kind: 'pair-mode-takeover-fired';
      pair_mode_state: { kind: string; [k: string]: unknown };
    }
  | {
      kind: 'forwarded';
      /** Server-side dispatch latency in ms (NOT round-trip). */
      duration_ms: number;
    };

/**
 * LK.5 — LiveKit join info, optionally returned on session-create
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
  status: 'active' | 'paused' | 'closed';
  closed_reason: string | null;
  token_budget_total: number;
  token_budget_remaining: number;
  transcript_length: number;
  /**
   * v2-#19 — wall-clock ISO-8601 timestamp the session transitioned out
   * of `active` status. Distinct from `updated_at`, which moves on every
   * transcript append. `null` while the session is active.
   */
  closed_at: string | null;
  /**
   * v2-#35 — team-RBAC attribution. `null` when the auth context is
   * account-scoped (no specific team-member id resolvable). Populated
   * once V-298 team-membership auth threads a resolved user id through.
   */
  created_by_user_id: string | null;
  /**
   * Arc 2 sub-slice 8.5 (v2-#8) — operational mode chosen at create-
   * time. Server-side default is 'ai' for backward compat. Updated
   * by POST /v1/agent-sessions/:id/mode (Slice 3, Wave 29-NNN ARC 3).
   */
  mode: 'manual' | 'ai' | 'pair';
  /**
   * 6.c — the Claude model the AI agent runs for this session
   * (set at create-time; defaults to 'claude-opus-5'). Every earlier id
   * stays accepted for back-compat with sessions created before the bump.
   */
  model:
    | 'claude-opus-5'
    | 'claude-sonnet-5'
    | 'claude-opus-4-8'
    | 'claude-opus-4-7'
    | 'claude-sonnet-4-6'
    | 'claude-haiku-4-5';
  /**
   * Slice 3 (Wave 29-NNN ARC 3) — pair-mode state machine
   * discriminator. `null` when mode != 'pair'; carries the
   * `{kind: 'ai-driving' | 'takeover-pending' | ...}` shape (see
   * services/agent-pair-mode-state.ts for the full state union)
   * when mode='pair'. Dashboard reads this to decide whether the
   * customer is mid-takeover.
   */
  pair_mode_state: { kind: string; [k: string]: unknown } | null;
  created_at: string;
  updated_at: string;
  /**
   * LK.4 — auto-populated on POST /v1/agent-sessions response when a
   * Mac with LiveKit credentials is available + the deployment has
   * LiveKit wiring on (encryption key + fleet repo). Absent on older
   * deployments + on the GET shape. Clients that need a token on
   * pre-LK deployments fall back to POST
   * /v1/agent-sessions/:id/livekit-token (LK.3).
   */
  livekit?: LiveKitInfo;
  /**
   * W2679 — worker-reported per-session liveness, re-based onto the fleet
   * heartbeat. Distinct from `status`, which stays `'active'` until the session
   * is closed even if the worker crashed/never-started. `state` is the latest
   * worker state (or `null` = "seen but no live state"); `fresh` is whether the
   * owning node's beat is recent enough to trust. Absent (field omitted) when
   * the deployment has no fleet control plane OR no beat has reported the
   * session — treat absent as "unknown, trust the binding", never as "dead".
   */
  liveness?: { state: 'active' | 'provisioning' | 'idle' | 'terminating' | null; fresh: boolean };
  /**
   * Latest ownership-validated worker capabilities for this live session.
   * Absent until reported (and on closed sessions). A false
   * `manual_input_available` means the video is view-only; blank/failed and
   * dead_proxy are explicit degraded states, not successful input/video.
   */
  capability_report?: {
    timestamp: string;
    manual_input_available: boolean | null;
    streaming_state: 'provisioning' | 'live' | 'blank' | 'failed' | null;
    egress_state: 'live' | 'dead_proxy' | null;
    proxy_kind: 'socks5' | 'openvpn' | 'wireguard';
    proxy_udp_supported: boolean;
    transport_mode_requested: 'h2-only' | 'h2-and-h3';
    transport_mode_active: 'h2-only' | 'h2-and-h3';
    safeguards_passed: boolean;
  };
  /** Latest ownership-validated harness launch/runtime failure. */
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
 * GET /v1/agent-sessions envelope — newest-first, cursor-paginated. Mirrors
 * the standard `{ data, has_more, next_cursor }` shape shared by sessions /
 * recipes / crypto-orders (was a non-paginated `{ data }` hard-capped at 100,
 * so older sessions were unreachable).
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
  token_budget?: number;
  /**
   * Arc 2 sub-slice 8.5 (v2-#8 AI chat + manual). Defaults to 'ai'
   * (legacy decompose-driven runtime). 'manual' makes runTurn a
   * pass-through so the customer drives intents directly. 'pair'
   * enables the takeover state-machine (sub-slice 8.7).
   */
  mode?: 'manual' | 'ai' | 'pair';
  /**
   * 6.c — the Claude model the AI agent runs for this session.
   * Defaults server-side to 'claude-opus-5' when omitted (the current
   * generation). Picking a cheaper model (Sonnet 5 / Haiku 4.5) lowers
   * cost-to-serve. Every 4.x id stays accepted for back-compat.
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
   * (an unknown or not-owned id returns 404). Omit for a stateless session.
   */
  profile_id?: string;
  /**
   * Route the session through one of your account proxies (manage them at
   * `/v1/account/me/proxies`). Must reference a proxy your account owns (an
   * unknown or not-owned id returns 404). Omit for the default egress.
   */
  proxy_id?: string;
  /**
   * Start URL the remote browser opens on session launch. When supplied,
   * overrides the operator-default start URL. Must be an absolute http(s) URL;
   * `file:`, `javascript:`, `data:` schemes are rejected (400). Omit to use the
   * operator default.
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
}

export type AgentIntent =
  | { kind: 'navigate'; url: string }
  | {
      kind: 'interact';
      action: 'tap' | 'type' | 'scroll' | 'swipe' | 'press';
      selector?: string;
      value?: string;
    }
  | { kind: 'wait'; condition: 'idle' | 'selector_visible'; selector?: string; timeoutMs?: number }
  | { kind: 'capture'; capture: 'screenshot' | 'dom_snapshot' | 'pdf' }
  // Behavioural intents (W140) — map server-side onto the harness scroll /
  // behavioral_pause control-plane intents.
  | { kind: 'scroll'; direction: 'up' | 'down'; amount_px?: number }
  | { kind: 'behavioral_pause'; duration_ms?: number; reading_word_count?: number };

/**
 * Consequential-action category for the human-confirmation safety gate
 * (W443/W445). A `confirmation_required` intent result echoes the matched
 * category + phrase back so the caller can approve the action by re-sending the
 * turn via `message(id, msg, { approveConsequentialActions: [...] })`.
 */
export type ConsequentialActionCategory = 'purchase' | 'payment' | 'account_deletion';

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

/** doc-132 §5.3 — machine-readable failure diagnosis. `reason` is the
 *  human-facing copy; `diagnosis` is the structured companion an automation can
 *  branch on without string-matching prose. `retryable: true` means automatic
 *  replay of the same step is considered safe; false means never auto-replay.
 *  A false result can require a corrected request, or it can mean the prior
 *  action's outcome is unknown and current state must be inspected. Optional:
 *  older servers omit it. */
export interface AgentFailureDiagnosis {
  category:
    | 'element_not_found'
    | 'page_load_failed'
    | 'condition_not_met'
    | 'capture_failed'
    | 'scroll_failed'
    | 'session_error'
    | 'invalid_request'
    | 'result_too_large'
    | 'unknown';
  retryable: boolean;
}

export type AgentIntentResult =
  | { kind: 'success'; intent: AgentIntent; summary: string; captureId?: string }
  | { kind: 'failure'; intent: AgentIntent; reason: string; diagnosis?: AgentFailureDiagnosis }
  // The executor halted BEFORE dispatching a consequential action (purchase /
  // payment / account-deletion) that needs human confirmation. The plan is
  // paused; approve by re-sending the turn with this {category, matchedText}
  // in `message(id, msg, { approveConsequentialActions: [...] })`.
  | {
      kind: 'confirmation_required';
      intent: AgentIntent;
      category: ConsequentialActionCategory;
      matchedText: string;
    };

export type AgentMessageResponse =
  | {
      kind: 'plan-executed';
      session: AgentSession;
      intents: ReadonlyArray<AgentIntent>;
      results: ReadonlyArray<AgentIntentResult>;
      /** True iff every intent succeeded. False if any failed OR the plan
       *  halted on a `confirmation_required` result (check `results`). */
      ok: boolean;
      usage?: AgentUsage;
    }
  | {
      kind: 'clarify';
      session: AgentSession;
      clarifying_question: string;
      usage?: AgentUsage;
    }
  | {
      kind: 'refuse';
      session: AgentSession;
      refuse_reason: string;
      usage?: AgentUsage;
    }
  | {
      /**
       * Arc 2 sub-slice 8.6 (v2-#8) — manual-mode pass-through. The
       * runtime did NOT call the decomposer; the customer's
       * user_message was recorded as a role='operator' transcript
       * entry. No intents, no executor results. Customer's gui-client
       * drives the real actions via the gui_control plane (sub-slice
       * 8.4 mints the per-session key).
       */
      kind: 'logged-manual';
      session: AgentSession;
    };

/** Agent turns may legally contain eight sequential five-minute harness intents.
 * SSE heartbeats keep edge/read-idle timers alive; this absolute client backstop
 * leaves headroom for decompose + optional read-back around that 42-minute plan. */
export const AGENT_MESSAGE_STREAM_TIMEOUT_MS = 50 * 60_000;

export class AgentSessionsResource {
  constructor(private readonly http: HttpClient) {}

  create(
    body: CreateAgentSessionRequest = {},
    opts?: { idempotencyKey?: string },
  ): Promise<AgentSession> {
    // v2-#19 — Stripe-pattern idempotency. Forward as the
    // `Idempotency-Key` request header so retries collapse onto the
    // server's first 201 response. The server-side partial unique
    // index on (account_id, idempotency_key) is what guarantees the
    // dedupe end-to-end; SDK just plumbs the header.
    return this.http.request<AgentSession>({
      method: 'POST',
      path: '/v1/agent-sessions',
      body,
      ...(opts?.idempotencyKey !== undefined
        ? { headers: { 'Idempotency-Key': opts.idempotencyKey } }
        : {}),
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
   * Used by the dashboard's recent-sessions list + the desktop GUI's live
   * "running for" timer (it reads each session's `created_at`). Pass a
   * `cursor` (the prior page's `next_cursor`) to page; or use `iterate()` to
   * walk every page automatically.
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
   * semantics. Replaces the old hard 100-cap — a busy account can now reach
   * its full AI-session history.
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
   * Run one decompose→execute turn against the agent session.
   * Returns a discriminated union — callers MUST branch on
   * `kind` before reading the variant-specific fields.
   *
   * `byokApiKey` (optional) is the customer-supplied Anthropic API
   * key (BYOK Tier-3 LOCKED 2026-05-16). Forwarded via the
   * `x-byok-anthropic-api-key` request header so callers don't have
   * to construct it by hand. NEVER logged by the SDK; the key
   * arrives over TLS to the control plane.
   *
   * `approveConsequentialActions` (optional) approves consequential actions
   * the executor previously halted on (W443/W445). When a prior turn returned a
   * `confirmation_required` intent result, echo its {category, matchedText} back
   * here so the re-planned action dispatches instead of halting again. The SDK
   * maps each entry to the wire's snake_case `{category, matched_text}`.
   *
   * `idempotencyKey` (strongly recommended) identifies this logical turn.
   * Reuse it when retrying after a lost/ambiguous stream so the server replays
   * the durable terminal result instead of executing browser actions twice.
   * Use a new key whenever the message, session, approvals, or explicit BYOK
   * key changes.
   *
   * A closed session returns a 409 ConflictError; the chat UI
   * should prompt the customer to start a new agent session.
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
    },
  ): Promise<AgentMessageResponse> {
    const approvals = opts?.approveConsequentialActions;
    return this.http.requestEventStream<AgentMessageResponse>({
      method: 'POST',
      path: `/v1/agent-sessions/${encodeURIComponent(id)}/message`,
      timeoutMs: opts?.timeoutMs ?? AGENT_MESSAGE_STREAM_TIMEOUT_MS,
      body: {
        user_message: userMessage,
        // W443/W445 — re-send approved consequential actions in the wire's
        // snake_case shape so the executor skips the confirmation halt. Omit
        // the field entirely when there are none (matches the route's optional
        // schema; avoids sending an empty array).
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
      // server normalises that to absent (slice 105 fix), but skipping
      // client-side saves the round-trip header and matches the Go SDK's
      // `opts != nil && opts.ByokAPIKey != ""` shape.
      headers: {
        accept: 'text/event-stream',
        ...(opts?.idempotencyKey !== undefined ? { 'Idempotency-Key': opts.idempotencyKey } : {}),
        ...(opts?.byokApiKey !== undefined && opts.byokApiKey.length > 0
          ? { 'x-byok-anthropic-api-key': opts.byokApiKey }
          : {}),
      },
    });
  }

  /**
   * Slice 3 (Wave 29-NNN ARC 3) — set the session's operational
   * mode. Atomic dual-column write of `mode` + `pair_mode_state`
   * on the server side; transitioning INTO 'pair' initializes
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
   * P-17 — move a RUNNING session onto a different egress without
   * restarting it. The page keeps its tabs, cookies and scroll
   * position; only the exit changes.
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
   * Slice 4 (Wave 29-NNN ARC 3) — forward a raw LK.6 InputEvent to
   * the harness. ManualControlOverlay in the customer dashboard
   * uses this to stream mouse + keyboard + wheel events from a
   * customer's live-preview interaction.
   *
   * Modifier vocabulary (Slice 6 cross-SDK lock 2026-05-20):
   * `keyDown` / `keyUp` `modifiers` arrays MUST use the 4-name set
   * `'cmd' | 'ctrl' | 'shift' | 'option'` (1:1 Quartz CGEventFlags).
   * DOM-standard names (`Shift / Control / Alt / Meta`) round-trip
   * through the schema unchanged but the harness decoder drops them.
   *
   * No deployment forwards input events — the harness transport has no
   * control-plane surface. ⚠️ That does NOT make every call a 503, which
   * is what this comment claimed until V-1987. The response is a
   * discriminated union and one arm is live today:
   *
   * - `'pair-mode-takeover-fired'` (200) — the FIRST input-event in a
   *   mode='pair' session whose `pair_mode_state.kind` is `ai-driving`
   *   fires the takeover-request transition and returns the new state.
   *   It forwards nothing, which is why "no deployment forwards input
   *   events" stays true. Reachable on any normally-booted deployment:
   *   the Redis pair-mode lock it needs is wired unconditionally.
   *   `client_id` is REQUIRED on this path.
   * - `'forwarded'` — genuinely unreachable, for a reason one level
   *   deeper than "no transport": it sits behind the `human-driving`
   *   state, which only a `takeover-grant` transition produces, and
   *   nothing emits that. Branching on it is dead code. See the module
   *   comment above.
   *
   * Everything else reaches the harness-forward path and throws
   * `FeatureUnavailableError` (503): mode='manual' always, and
   * mode='pair' once the state has left `ai-driving`.
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

  /** Close the agent session (sets status=closed; idempotent). */
  close(id: string): Promise<void> {
    return this.http.request<void>({
      method: 'DELETE',
      path: `/v1/agent-sessions/${encodeURIComponent(id)}`,
    });
  }

  /**
   * Arc 2 sub-slice 8.9 (v2-#8) — request a human takeover on a
   * pair-mode agent session. The state machine transitions
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
   * Arc 2 sub-slice 8.9 (v2-#8) — request a handback from human
   * back to AI on a pair-mode agent session. The state machine
   * transitions `human-driving → handback-pending` (or
   * `handback-queued` if the runtime is mid-decompose).
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
   * LK.3 — mint a fresh LiveKit JWT for the agent session's video
   * room. Use this when the auto-populated `livekit` field on
   * session-create is absent (pre-LK deployment, OR the token TTL
   * has expired — tokens are 24h). The same `LiveKitInfo` shape
   * is returned either way; one type, two paths.
   *
   * Errors (raised as DriftstackError with HTTP-mapped kind):
   *   - 403 — session is closed; can't mint
   *   - 404 — session unknown (or cross-account; existence not leaked)
   *   - 503 — no Mac registered LiveKit yet, OR the stored Mac
   *           secret can't be decrypted (operator action — re-run
   *           POST /v1/mac-nodes/register)
   */
  livekitToken(id: string): Promise<LiveKitInfo> {
    return this.http.request<LiveKitInfo>({
      method: 'POST',
      path: `/v1/agent-sessions/${encodeURIComponent(id)}/livekit-token`,
    });
  }

  /**
   * W474 — resume an agent session the harness auto-paused on a detected
   * bot-challenge (DataDome / Arkose / PerimeterX / …), once you've resolved
   * the challenge (e.g. in the live view). Best-effort dispatch to the node
   * running the session. Pass `challenge_id` (from the
   * `session.challenge_detected` webhook) to target a specific challenge;
   * omit it for a manual override resume.
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
}

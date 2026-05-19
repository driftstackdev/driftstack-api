// AgentSessionsResource — typed methods for /v1/agent-sessions/*
// (AI-CHAT route surface landed in commit 611ddc8f).
//
// Four methods mirror the route handlers:
//   create({ token_budget?, driftstack_session_id? })
//   get(id)
//   message(id, user_message)
//   close(id)
//
// The activation gate on the server (route registers as 503 stub
// until the LLM key path is enabled for the deployment) means callers
// should expect FeatureUnavailableError until AI chat ships. SDK
// surface is stable so dashboard + e2e tests can compile against it now.

import type { HttpClient } from '../http.js';

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
}

export interface CreateAgentSessionRequest {
  driftstack_session_id?: string;
  token_budget?: number;
  /**
   * Arc 2 sub-slice 8.5 (v2-#8 AI chat + manual). Defaults to 'ai'
   * (legacy decompose-driven runtime). 'manual' makes runTurn a
   * pass-through so the customer drives intents directly. 'pair'
   * enables the takeover state-machine (sub-slice 8.7).
   */
  mode?: 'manual' | 'ai' | 'pair';
}

export type AgentIntent =
  | { kind: 'navigate'; url: string }
  | {
      kind: 'interact';
      action: 'tap' | 'type' | 'scroll' | 'swipe';
      selector?: string;
      value?: string;
    }
  | { kind: 'wait'; condition: 'idle' | 'selector_visible'; selector?: string; timeoutMs?: number }
  | { kind: 'capture'; capture: 'screenshot' | 'dom_snapshot' | 'pdf' };

export type AgentIntentResult =
  | { kind: 'success'; intent: AgentIntent; summary: string; captureId?: string }
  | { kind: 'failure'; intent: AgentIntent; reason: string };

export type AgentMessageResponse =
  | {
      kind: 'plan-executed';
      session: AgentSession;
      intents: ReadonlyArray<AgentIntent>;
      results: ReadonlyArray<AgentIntentResult>;
      ok: boolean;
    }
  | {
      kind: 'clarify';
      session: AgentSession;
      clarifying_question: string;
    }
  | {
      kind: 'refuse';
      session: AgentSession;
      refuse_reason: string;
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
   * A closed session returns a 409 ConflictError; the chat UI
   * should prompt the customer to start a new agent session.
   */
  message(
    id: string,
    userMessage: string,
    opts?: { byokApiKey?: string },
  ): Promise<AgentMessageResponse> {
    return this.http.request<AgentMessageResponse>({
      method: 'POST',
      path: `/v1/agent-sessions/${encodeURIComponent(id)}/message`,
      body: { user_message: userMessage },
      // Skip the header when byokApiKey is undefined OR empty string.
      // Empty would send `x-byok-anthropic-api-key:` on the wire — the
      // server normalises that to absent (slice 105 fix), but skipping
      // client-side saves the round-trip header and matches the Go SDK's
      // `opts != nil && opts.ByokAPIKey != ""` shape.
      ...(opts?.byokApiKey !== undefined && opts.byokApiKey.length > 0
        ? { headers: { 'x-byok-anthropic-api-key': opts.byokApiKey } }
        : {}),
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
}

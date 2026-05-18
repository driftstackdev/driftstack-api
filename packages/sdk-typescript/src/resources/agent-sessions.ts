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
  created_at: string;
  updated_at: string;
}

export interface CreateAgentSessionRequest {
  driftstack_session_id?: string;
  token_budget?: number;
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
      ...(opts?.byokApiKey !== undefined
        ? { headers: { 'x-byok-anthropic-api-key': opts.byokApiKey } }
        : {}),
    });
  }

  /** Close the agent session (sets status=closed; idempotent). */
  close(id: string): Promise<void> {
    return this.http.request<void>({
      method: 'DELETE',
      path: `/v1/agent-sessions/${encodeURIComponent(id)}`,
    });
  }
}

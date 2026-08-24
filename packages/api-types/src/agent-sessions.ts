import { z } from 'zod';
import { AgentModelSchema } from './agent-models.js';
import { LiveKitInfoSchema } from './livekit.js';

const AGENT_PAGE_STATE_ID_MAX_LENGTH = 256;
const AGENT_PAGE_STATE_URL_MAX_LENGTH = 8192;
const AGENT_PAGE_STATE_TEXT_MAX_LENGTH = 4096;

/**
 * Agent (AI-chat) session resource — the read shape returned by
 * `POST /v1/agent-sessions` (201), `GET /v1/agent-sessions` (each list
 * row), and `GET /v1/agent-sessions/{id}`. It mirrors the apps/server
 * route's `PublicAgentSession` interface field-for-field; a route-parity
 * drift guard pins the two in lockstep so the OpenAPI spec, SDK codegen,
 * and the route serialization can never diverge.
 *
 * Before this schema existed the OpenAPI responses for those endpoints
 * were `z.object({})` (empty), leaving the entire AI-chat resource
 * untyped for codegen consumers (Pydantic / Go structs / TS types).
 *
 * `model` is sourced from {@link AgentModelSchema} so a new or renamed
 * Claude model flows through automatically; `livekit` reuses the
 * canonical {@link LiveKitInfoSchema} (auto-populated on create when a
 * Mac with LiveKit credentials is available, absent otherwise).
 */
export const AgentSessionSchema = z.object({
  id: z.string(),
  account_id: z.string(),
  driftstack_session_id: z.string().nullable(),
  status: z.string(),
  closed_reason: z.string().nullable(),
  token_budget_total: z.number().int(),
  token_budget_remaining: z.number().int(),
  transcript_length: z.number().int(),
  closed_at: z.string().nullable(),
  created_by_user_id: z.string().nullable(),
  mode: z.enum(['manual', 'ai', 'pair']),
  model: AgentModelSchema,
  pair_mode_state: z.object({ kind: z.string() }).passthrough().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  livekit: LiveKitInfoSchema.optional(),
  // A2 W2679 — worker-reported per-session liveness, re-based onto the fleet
  // Heartbeat.activeSessionStates map (NOT the `status` lifecycle, which stays
  // 'active' until DELETE/sweep even when the worker crashed). `state` is the
  // latest worker state (or null = "store wired + session seen but no live
  // state"); `fresh` is whether the owning node's beat is recent enough to
  // trust. OMITTED entirely when the liveness store isn't wired (prod has no
  // fleet control plane) OR no beat has reported the session — meaning
  // "unknown → trust the binding", NEVER "dead". Optional so older clients
  // ignore it.
  liveness: z
    .object({
      state: z.enum(['active', 'provisioning', 'idle', 'terminating']).nullable(),
      fresh: z.boolean(),
    })
    .optional(),
  /** Latest ownership-validated harness capability state for this live agent
   * session. Omitted until the worker reports it and on closed sessions. */
  capability_report: z
    .object({
      timestamp: z.string(),
      manual_input_available: z.boolean().nullable(),
      streaming_state: z.enum(['provisioning', 'live', 'blank', 'failed']).nullable(),
      egress_state: z.enum(['live', 'dead_proxy']).nullable(),
      proxy_kind: z.enum(['socks5', 'openvpn', 'wireguard']),
      proxy_udp_supported: z.boolean(),
      transport_mode_requested: z.enum(['h2-only', 'h2-and-h3']),
      transport_mode_active: z.enum(['h2-only', 'h2-and-h3']),
      safeguards_passed: z.boolean(),
    })
    .optional(),
  /** Latest ownership-validated harness launch/runtime failure. */
  error_event: z
    .object({
      timestamp: z.string().min(1).max(64),
      code: z.string().regex(/^[a-z][a-z0-9_]{0,127}$/),
      severity: z.enum(['info', 'warn', 'error', 'fatal']),
      summary: z.string().max(4096),
      detail: z
        .string()
        .max(16 * 1024)
        .nullable()
        .describe('Null when the server has nothing to add beyond `summary`.'),
      customer_actionable: z
        .boolean()
        .describe('Whether a human can do anything about this failure.'),
      retryable: z.boolean().describe('Whether repeating the same call is worth trying.'),
    })
    .nullable()
    .optional()
    .describe(
      'The most recent harness launch or runtime failure recorded for this session. Null when the session has not reported one.',
    ),
});

export type AgentSession = z.infer<typeof AgentSessionSchema>;

/**
 * Agent-session live page-state — the body of `GET /v1/agent-sessions/{id}/
 * page-state` (W650 / A3 W1254 / W2730). Distinct from the DRIVER session's
 * `state.page_state` ({@link import('./sessions.js').PageStateSchema}, a 3-state
 * lifecycle): this is the AGENT/simulator view the box reports over the fleet
 * control plane, so it carries the 4th `stalled` state (A3 W2845 — a
 * frozen-but-alive renderer) and the apps/server `SessionPageState` store shape
 * field-for-field.
 *
 * `title` is nullable (NOT optional): the box may emit a title-only change frame
 * on ANY state, and the store always normalizes an absent title to null, so the
 * response key is always present. `tabId` is the forward-compat per-tab
 * attribution (A3 contract pending — see the server PageStateFrameSchema); the
 * store carries it as null until the box sends it, so it's `nullable().optional()`
 * here (older clients that never read it are unaffected).
 *
 * `error` is the relaxed harness shape (`kind` lenient — A3 emits net|timeout;
 * `http_status` is never emitted, so it's not modelled here). Mirrors the
 * gui-client `AgentPageState` so a later coordinated pass can import this in
 * place of the local interface (gui-client scope — not done here).
 */
export const AgentPageStateSchema = z.object({
  state: z.enum(['loading', 'loaded', 'errored', 'stalled']),
  url: z.string().max(AGENT_PAGE_STATE_URL_MAX_LENGTH).nullable(),
  title: z.string().max(AGENT_PAGE_STATE_TEXT_MAX_LENGTH).nullable(),
  tabId: z.string().min(1).max(AGENT_PAGE_STATE_ID_MAX_LENGTH).nullable().optional(),
  error: z
    .object({
      kind: z.string().min(1).max(AGENT_PAGE_STATE_ID_MAX_LENGTH),
      message: z.string().max(AGENT_PAGE_STATE_TEXT_MAX_LENGTH),
    })
    .nullable(),
});
export type AgentPageState = z.infer<typeof AgentPageStateSchema>;

/**
 * `GET /v1/agent-sessions/{id}/page-state` response envelope: `page_state` is
 * null until the box has reported a frame (or the fleet control plane is absent).
 */
export const AgentPageStateResponseSchema = z.object({
  page_state: AgentPageStateSchema.nullable(),
});
export type AgentPageStateResponse = z.infer<typeof AgentPageStateResponseSchema>;

/**
 * W393 — POST /v1/agent-sessions/:id/resume body. Resume a session the harness
 * auto-paused on a detected bot-challenge (after the customer resolves it).
 * `challenge_id` (optional) correlates to the `session.challenge_detected` the
 * customer is responding to: present → the harness validates it against the
 * active challenge (stale id → the session stays paused); absent → a manual
 * override resume.
 */
export const ResumeSessionRequestSchema = z
  .object({
    challenge_id: z.string().min(1).optional(),
  })
  .strict();
export type ResumeSessionRequest = z.infer<typeof ResumeSessionRequestSchema>;

/**
 * W474 — POST /v1/agent-sessions/:id/resume response. The resume is a
 * best-effort dispatch to the node running the session (inert unless the fleet
 * control plane is wired), so the route returns 202 Accepted with the request
 * acknowledgement rather than the post-resume session state.
 */
export const ResumeSessionResponseSchema = z
  .object({
    status: z.literal('resume_requested'),
    session_id: z.string(),
  })
  .strict();
export type ResumeSessionResponse = z.infer<typeof ResumeSessionResponseSchema>;

import { z } from 'zod';
import { AgentModelSchema } from './agent-models.js';
import { LiveKitInfoSchema } from './livekit.js';

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
});

export type AgentSession = z.infer<typeof AgentSessionSchema>;

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

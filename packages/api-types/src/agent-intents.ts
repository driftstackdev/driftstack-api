import { z } from 'zod';

/**
 * A single structured intent the agent decomposer emits — the closed
 * verb vocabulary (navigate / interact / wait / capture) that maps 1:1
 * onto the `/v1/sessions/:id/{navigate,interact,wait,capture}` driver
 * routes. The agent cannot invent new verbs. Mirrors the route's
 * `AgentIntent` union (apps/server/src/services/agent-decomposer.ts); a
 * drift guard pins the member `kind`s in lockstep.
 *
 * Surfaced on the typed `intents` array of the `POST /v1/agent-sessions/
 * {id}/message` plan-executed turn result (was `z.object({})`).
 */
export const AgentIntentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('navigate'), url: z.string() }),
  z.object({
    kind: z.literal('interact'),
    action: z.enum(['tap', 'type', 'scroll', 'swipe']),
    selector: z.string().optional(),
    value: z.string().optional(),
  }),
  z.object({
    kind: z.literal('wait'),
    condition: z.enum(['idle', 'selector_visible']),
    selector: z.string().optional(),
    timeoutMs: z.number().int().optional(),
  }),
  z.object({
    kind: z.literal('capture'),
    capture: z.enum(['screenshot', 'dom_snapshot', 'pdf']),
  }),
]);

export type AgentIntent = z.infer<typeof AgentIntentSchema>;

/**
 * The executor's per-intent result. Mirrors the route's `IntentResult`
 * union (apps/server/src/services/agent-executor.ts). Surfaced on the
 * typed `results` array of the message plan-executed turn result.
 */
export const IntentResultSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('success'),
    intent: AgentIntentSchema,
    summary: z.string(),
    captureId: z.string().optional(),
  }),
  z.object({
    kind: z.literal('failure'),
    intent: AgentIntentSchema,
    reason: z.string(),
  }),
]);

export type IntentResult = z.infer<typeof IntentResultSchema>;

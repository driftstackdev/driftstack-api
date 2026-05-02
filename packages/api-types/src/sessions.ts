import { z } from 'zod';
import {
  ApiKeyIdSchema,
  AccountIdSchema,
  Iso8601Schema,
  SessionEventIdSchema,
  SessionIdSchema,
} from './common.js';

// ───────────────────────────────────────────────────────────────────────────
// Session resource
// ───────────────────────────────────────────────────────────────────────────

export const SessionStatusSchema = z.enum(['creating', 'ready', 'busy', 'destroyed', 'errored']);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const ArchetypeSchema = z
  .string()
  .regex(/^[a-z0-9_]+$/, { message: 'archetype slug is lowercase alphanumeric + underscores' })
  .min(3)
  .max(60);

export const SessionSchema = z.object({
  id: SessionIdSchema,
  account_id: AccountIdSchema,
  api_key_id: ApiKeyIdSchema,
  status: SessionStatusSchema,
  archetype: ArchetypeSchema,
  label: z.string().nullable(),
  metadata: z.record(z.unknown()).nullable(),
  created_at: Iso8601Schema,
  updated_at: Iso8601Schema,
  last_state_at: Iso8601Schema.nullable(),
  destroyed_at: Iso8601Schema.nullable(),
});

export type Session = z.infer<typeof SessionSchema>;

// ───────────────────────────────────────────────────────────────────────────
// Create session
// ───────────────────────────────────────────────────────────────────────────

export const CreateSessionRequestSchema = z.object({
  archetype: ArchetypeSchema.optional(),
  label: z.string().max(120).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;

export const CreateSessionResponseSchema = SessionSchema;
export type CreateSessionResponse = z.infer<typeof CreateSessionResponseSchema>;

// ───────────────────────────────────────────────────────────────────────────
// Navigate
// ───────────────────────────────────────────────────────────────────────────

export const NavigateRequestSchema = z.object({
  url: z.string().url(),
  // Per-call timeout (ms); default applied server-side.
  timeout_ms: z.number().int().min(1000).max(120_000).optional(),
  // Wait policy after navigation completes.
  wait_until: z.enum(['load', 'domcontentloaded', 'networkidle']).default('load'),
});

export type NavigateRequest = z.infer<typeof NavigateRequestSchema>;

export const NavigateResponseSchema = z.object({
  url: z.string().url(),
  status: z.number().int().min(100).max(599),
  // Final URL (may differ from request after redirects).
  final_url: z.string().url(),
  duration_ms: z.number().int().nonnegative(),
});

export type NavigateResponse = z.infer<typeof NavigateResponseSchema>;

// ───────────────────────────────────────────────────────────────────────────
// Interact
// ───────────────────────────────────────────────────────────────────────────

export const InteractActionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('tap'),
    selector: z.string().min(1),
    // Optional offset within the element (px).
    offset: z.object({ x: z.number().int(), y: z.number().int() }).optional(),
  }),
  z.object({
    kind: z.literal('type'),
    selector: z.string().min(1),
    text: z.string().max(10_000),
    // ms between keystrokes; mock driver respects bounds, real driver clamps.
    delay_ms: z.number().int().min(0).max(500).optional(),
  }),
  z.object({
    kind: z.literal('scroll'),
    selector: z.string().min(1).optional(),
    delta_x: z.number().int().default(0),
    delta_y: z.number().int().default(0),
  }),
  z.object({
    kind: z.literal('press'),
    key: z.string().min(1).max(20),
  }),
]);

export type InteractAction = z.infer<typeof InteractActionSchema>;

export const InteractRequestSchema = z.object({
  action: InteractActionSchema,
  timeout_ms: z.number().int().min(100).max(60_000).optional(),
});

export type InteractRequest = z.infer<typeof InteractRequestSchema>;

export const InteractResponseSchema = z.object({
  ok: z.literal(true),
  duration_ms: z.number().int().nonnegative(),
});

export type InteractResponse = z.infer<typeof InteractResponseSchema>;

// ───────────────────────────────────────────────────────────────────────────
// Wait
// ───────────────────────────────────────────────────────────────────────────

export const WaitConditionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('selector'), selector: z.string().min(1) }),
  z.object({ kind: z.literal('selector_hidden'), selector: z.string().min(1) }),
  z.object({ kind: z.literal('url_matches'), pattern: z.string().min(1) }),
  z.object({ kind: z.literal('time'), ms: z.number().int().min(0).max(60_000) }),
]);

export type WaitCondition = z.infer<typeof WaitConditionSchema>;

export const WaitRequestSchema = z.object({
  condition: WaitConditionSchema,
  timeout_ms: z.number().int().min(100).max(120_000).optional(),
});

export type WaitRequest = z.infer<typeof WaitRequestSchema>;

export const WaitResponseSchema = z.object({
  satisfied: z.boolean(),
  duration_ms: z.number().int().nonnegative(),
});

export type WaitResponse = z.infer<typeof WaitResponseSchema>;

// ───────────────────────────────────────────────────────────────────────────
// Get state
// ───────────────────────────────────────────────────────────────────────────

export const SessionStateSchema = z.object({
  url: z.string().url().nullable(),
  title: z.string().nullable(),
  // Serialised cookies (driver-controlled shape).
  cookies: z.array(z.record(z.unknown())),
  // Local storage snapshot.
  local_storage: z.record(z.string()),
  captured_at: Iso8601Schema,
});

export type SessionState = z.infer<typeof SessionStateSchema>;

// ───────────────────────────────────────────────────────────────────────────
// Capture (screenshot / DOM / etc.)
// ───────────────────────────────────────────────────────────────────────────

export const CaptureKindSchema = z.enum(['screenshot', 'dom_snapshot', 'pdf']);
export type CaptureKind = z.infer<typeof CaptureKindSchema>;

export const CaptureRequestSchema = z.object({
  kind: CaptureKindSchema,
  // For screenshots: full-page or viewport.
  full_page: z.boolean().default(false),
});

export type CaptureRequest = z.infer<typeof CaptureRequestSchema>;

export const CaptureResponseSchema = z.object({
  kind: CaptureKindSchema,
  // base64 for binary captures, raw text for DOM snapshots.
  data: z.string(),
  encoding: z.enum(['base64', 'utf8']),
  byte_size: z.number().int().nonnegative(),
  duration_ms: z.number().int().nonnegative(),
});

export type CaptureResponse = z.infer<typeof CaptureResponseSchema>;

// ───────────────────────────────────────────────────────────────────────────
// Session events (for audit / debugging)
// ───────────────────────────────────────────────────────────────────────────

export const SessionEventTypeSchema = z.enum([
  'created',
  'navigated',
  'interacted',
  'waited',
  'state_captured',
  'screenshot_captured',
  'destroyed',
  'errored',
]);

export const SessionEventSchema = z.object({
  id: SessionEventIdSchema,
  session_id: SessionIdSchema,
  type: SessionEventTypeSchema,
  payload: z.record(z.unknown()).nullable(),
  duration_ms: z.number().int().nonnegative().nullable(),
  created_at: Iso8601Schema,
});

export type SessionEvent = z.infer<typeof SessionEventSchema>;

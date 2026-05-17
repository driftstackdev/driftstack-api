import { z } from 'zod';
import {
  ApiKeyIdSchema,
  AccountIdSchema,
  Iso8601Schema,
  SessionEventIdSchema,
  SessionIdSchema,
} from './common.js';
import { EgressCapabilitiesSchema } from './egress.js';

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

/**
 * V-169 — session purpose drives harness configuration in the WebKit
 * driver (per AFP Layer 1 design from Agent 1's Phase 3 work; see
 * `docs/architecture/afp-harness-configuration.md` once Agent 1 lands
 * the cross-reference doc).
 *
 * Semantics:
 * - `production_customer` (default): ephemeral context +
 *   `_resourceLoadStatisticsEnabled=YES`. ATFP fires per iOS per-site
 *   logic. This is what every paying-customer session uses.
 * - `cumulative_rig_validation`: persistent context, NOT ephemeral.
 *   ATFP doesn't fire (matches the V-179 baseline rig). Used by Agent 1
 *   to validate that the static-fingerprint surface remains
 *   bit-identical across releases.
 * - `test_domain_probe`: ephemeral context on tracker-context URLs.
 *   ATFP fires deterministically. Used by Agent 1 for adversarial
 *   validation against detection vendors.
 *
 * The MockDriver accepts the field but doesn't act on it (the WebKit
 * driver is where the harness branching lives). Production customer
 * sessions use the default; the other two purposes are reserved for
 * internal validation tools and not part of the customer-facing API
 * contract today.
 */
export const SessionPurposeSchema = z.enum([
  'production_customer',
  'cumulative_rig_validation',
  'test_domain_probe',
]);
export type SessionPurpose = z.infer<typeof SessionPurposeSchema>;
export const DEFAULT_SESSION_PURPOSE: SessionPurpose = 'production_customer';

export const SessionSchema = z.object({
  id: SessionIdSchema,
  account_id: AccountIdSchema,
  api_key_id: ApiKeyIdSchema,
  status: SessionStatusSchema,
  archetype: ArchetypeSchema,
  /** V-169 — harness purpose; defaults to `production_customer`. */
  purpose: SessionPurposeSchema,
  label: z.string().nullable(),
  metadata: z.record(z.unknown()).nullable(),
  /**
   * Harness-reported SOCKS5 egress capabilities (migration 0045 +
   * cross-agent contract 7d5992d9). Null until the harness emits the
   * `egress.capability_report` event after proxy wire-up; non-SOCKS5
   * sessions stay null permanently. Shape pinned by
   * `EgressCapabilitiesSchema` in `./egress.ts`.
   */
  egress_capabilities: EgressCapabilitiesSchema.nullable(),
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
  /** V-169 — harness purpose; defaults to `production_customer`. */
  purpose: SessionPurposeSchema.optional(),
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
/** Caller-side shape: fields with server-side defaults are optional. */
export type NavigateRequestInput = z.input<typeof NavigateRequestSchema>;

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

// Customer-facing InteractAction is intent-only per L-001 — coordinate
// primitives (tap_at, tap.offset, etc.) live on the gui_control plane,
// not here. See docs/locked-decisions.md.
export const InteractActionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('tap'),
    selector: z.string().min(1),
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
/** Caller-side shape: fields with server-side defaults are optional. */
export type CaptureRequestInput = z.input<typeof CaptureRequestSchema>;

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

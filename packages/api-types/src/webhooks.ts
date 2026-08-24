import { z } from 'zod';
import { Iso8601Schema, PrefixedId } from './common.js';

export const WebhookEndpointIdSchema = PrefixedId('whk');
export type WebhookEndpointId = z.infer<typeof WebhookEndpointIdSchema>;

export const WebhookDeliveryIdSchema = PrefixedId('wdl');

export const WebhookEventTypeSchema = z.enum([
  'session.completed',
  'session.failed',
  'api_key.revoked',
  // Arc 5 EGRESS eg.7 (v2-#3) — fires when the harness emits an
  // `egress.capability_report` event for a SOCKS5 session and the
  // control plane ingests it (eg.2 wires the listener; this event
  // fans out to customer webhook endpoints). Payload mirrors
  // EgressCapabilitiesSchema so subscribers can branch on
  // udp_associate / dns_remote_resolve / warnings without a GET.
  'session.egress_capability_changed',
  // V-356 — synthetic test event, sent only via POST
  // /v1/webhooks/:id/test. Customers cannot subscribe to it
  // (UpdateSubscriptionsSchema rejects it) — the endpoint dispatches
  // a one-off delivery regardless of subscription, so the customer
  // can verify their handler before relying on it for real events.
  'test.ping',
  // 2026-05-22 — V-666 crypto-order events. Fired by
  // CryptoOrdersService.applyIpnStatus on the
  // pending/confirming/partial → paid|failed terminal transitions.
  // Subscribable; see SubscribableWebhookEventTypeSchema below.
  'crypto.order.paid',
  'crypto.order.failed',
  // W393 — challenge-handling. Fired when the harness ChallengeDetector flags a
  // bot-check (DataDome/Arkose/PerimeterX/AWS-WAF/GeeTest/…) on a session and the
  // control plane relays it. The harness auto-pauses; the customer resolves the
  // challenge (e.g. in the live view) then resumes. Payload: { session_id,
  // challenge_id, challenge: { type, confidence, detail? } }. Subscribable.
  'session.challenge_detected',
  // A3 W1364 / 2026-06-12 — profile save-back failed at session TEARDOWN
  // (serialize/seal/too-large/upload). Terminal — no retry path — and the
  // session itself stays succeeded; this informs customers relying on
  // persisted profile state that the next restore will be stale. Payload:
  // { session_id, profile_id, reason, detail? }. Subscribable.
  'session.profile_save_failed',
]);
export type WebhookEventType = z.infer<typeof WebhookEventTypeSchema>;

/**
 * V-356 — events the customer is allowed to subscribe to. Excludes
 * `test.ping`, which is only ever emitted via the explicit test
 * endpoint (subscribing to it would be meaningless — the test
 * endpoint dispatches regardless of subscription).
 *
 */
export const SubscribableWebhookEventTypeSchema = z.enum([
  'session.completed',
  'session.failed',
  'api_key.revoked',
  // Arc 5 EGRESS eg.7 — subscribable so customers can hook
  // proxy-health visibility into their own observability surface.
  'session.egress_capability_changed',
  // 2026-05-22 — V-666 crypto-order events. Subscribable so
  // customers integrating /v1/billing/crypto-checkout can react
  // to terminal state transitions in their own accounting system.
  'crypto.order.paid',
  'crypto.order.failed',
  // W393 — challenge-handling. Subscribable so customers wire challenge alerts
  // into their own ops/notification surface (the live view also shows it).
  'session.challenge_detected',
  // A3 W1364 — subscribable so customers persisting profile state can alert on
  // a failed save-back (stale-restore warning) in their own ops surface.
  'session.profile_save_failed',
]);
export type SubscribableWebhookEventType = z.infer<typeof SubscribableWebhookEventTypeSchema>;

export const WebhookDeliveryStatusSchema = z.enum([
  'pending',
  'in_flight',
  'delivered',
  'failed',
  'dlq',
]);
export type WebhookDeliveryStatus = z.infer<typeof WebhookDeliveryStatusSchema>;

// ───────────────────────────────────────────────────────────────────────────
// Endpoint resource
// ───────────────────────────────────────────────────────────────────────────

export const WebhookEndpointSchema = z.object({
  id: WebhookEndpointIdSchema,
  url: z.string().url(),
  secret_prefix: z.string(),
  /** V-359 — populated only during the 24h rotation grace period.
   *  Null when no rotation in flight. */
  prev_secret_prefix: z.string().nullable(),
  /** V-359 — when prev_secret is active, this is the timestamp at
   *  which dual-signing stops. Null when no rotation in flight. */
  rotation_grace_expires_at: Iso8601Schema.nullable(),
  events: z.array(SubscribableWebhookEventTypeSchema),
  description: z.string().nullable(),
  active: z.boolean(),
  consecutive_failures: z.number().int().nonnegative(),
  last_success_at: Iso8601Schema.nullable(),
  last_failure_at: Iso8601Schema.nullable(),
  disabled_at: Iso8601Schema.nullable(),
  /** V-185 — aggregate per-endpoint delivery counts. */
  delivery_counts: z.object({
    delivered: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    dlq: z.number().int().nonnegative(),
  }),
  created_at: Iso8601Schema,
});
export type WebhookEndpoint = z.infer<typeof WebhookEndpointSchema>;

// ───────────────────────────────────────────────────────────────────────────
// Create
// ───────────────────────────────────────────────────────────────────────────

export const CreateWebhookRequestSchema = z.object({
  /**
   * V-1498 — a `regex`, not a `refine`, so the published document carries it.
   *
   * A refine is a runtime predicate JSON Schema cannot express, so the spec
   * described `url` as `{ type: string, format: uri }` and a generated client
   * happily sent `http://` for a 400 it had no way to anticipate. Both customer
   * doc surfaces state the rule in prose — `webhooks/endpoints.md` says "URL must
   * use `https://`" and the marketing page says `http://` is rejected — so the
   * only reader left uninformed was the machine one.
   *
   * Same transformation V-924 and V-1475 applied to the tier fields, for the same
   * stated reason, and behaviour-preserving: `.url()` still runs first, the
   * message is unchanged, and the accepted set is identical.
   */
  url: z
    .string()
    .url()
    .regex(/^https:\/\//, { message: 'Webhook URL must use https://' }),
  // V-356 — only subscribable event types accepted on create. Customers
  // can't subscribe to `test.ping`; that event is only emitted via the
  // POST /v1/webhooks/:id/test endpoint, regardless of subscription.
  events: z.array(SubscribableWebhookEventTypeSchema).min(1).max(10),
  // Accepts null as well as undefined so the dashboard's create form
  // can POST `description: null` for a blank description (the route
  // already normalizes with `body.description ?? null`). Matches the
  // UpdateWebhookRequestSchema, which is .nullable().optional().
  description: z.string().max(200).nullable().optional(),
});
export type CreateWebhookRequest = z.infer<typeof CreateWebhookRequestSchema>;

export const CreateWebhookResponseSchema = WebhookEndpointSchema.extend({
  secret: z.string().describe('Plaintext signing secret. Returned ONCE; not retrievable later.'),
});

// V-359 — POST /v1/webhooks/:id/rotate-secret response. Surfaces the
// fresh plaintext secret ONCE alongside metadata about the grace
// window during which both the old + new secrets are accepted by the
// server's outbound dual-sign.
export const RotateWebhookSecretResponseSchema = z.object({
  id: WebhookEndpointIdSchema,
  secret: z.string().describe('Fresh plaintext signing secret. Returned ONCE.'),
  secret_prefix: z.string(),
  prev_secret_prefix: z
    .string()
    .describe('First chars of the prior secret, kept active during grace.'),
  grace_expires_at: Iso8601Schema.describe(
    'Until this timestamp, every outbound delivery is signed with both the new + old secret so the customer can roll their verifier across infra without dropped deliveries.',
  ),
});
export type RotateWebhookSecretResponse = z.infer<typeof RotateWebhookSecretResponseSchema>;

// ───────────────────────────────────────────────────────────────────────────
// V-351 — Update
// ───────────────────────────────────────────────────────────────────────────

// V-1498 — `url` is a regex here for the same reason as on the create schema
// above: a refine never reaches the published document.
export const UpdateWebhookRequestSchema = z
  .object({
    url: z
      .string()
      .url()
      .regex(/^https:\/\//, { message: 'Webhook URL must use https://' })
      .optional(),
    events: z.array(SubscribableWebhookEventTypeSchema).min(1).max(10).optional(),
    description: z.string().max(200).nullable().optional(),
    active: z.boolean().optional(),
  })
  .refine(
    (v) =>
      v.url !== undefined ||
      v.events !== undefined ||
      v.description !== undefined ||
      v.active !== undefined,
    { message: 'At least one field must be provided.' },
  );
export type UpdateWebhookRequest = z.infer<typeof UpdateWebhookRequestSchema>;
export type CreateWebhookResponse = z.infer<typeof CreateWebhookResponseSchema>;

// ───────────────────────────────────────────────────────────────────────────
// Delivery resource
// ───────────────────────────────────────────────────────────────────────────

export const WebhookDeliverySchema = z.object({
  id: WebhookDeliveryIdSchema,
  webhook_id: WebhookEndpointIdSchema,
  event_id: z.string().uuid(),
  event_type: WebhookEventTypeSchema,
  status: WebhookDeliveryStatusSchema,
  attempts: z.number().int().nonnegative(),
  next_attempt_at: Iso8601Schema,
  last_response_status: z.number().int().nullable(),
  last_response_excerpt: z.string().nullable(),
  last_error: z.string().nullable(),
  delivered_at: Iso8601Schema.nullable(),
  created_at: Iso8601Schema,
});
export type WebhookDelivery = z.infer<typeof WebhookDeliverySchema>;

// ───────────────────────────────────────────────────────────────────────────
// Delivery list query
// ───────────────────────────────────────────────────────────────────────────

export const ListDeliveriesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  // Slice 149 — defensive cap matching slice 117/146/147/148 cursor
  // convention. PaginationQuerySchema in common.ts now caps at 512;
  // this schema doesn't extend the base shape (carries its own
  // status filter) so the cap is duplicated explicitly here.
  cursor: z.string().min(1).max(512).optional(),
  status: WebhookDeliveryStatusSchema.optional(),
});
export type ListDeliveriesQuery = z.infer<typeof ListDeliveriesQuerySchema>;
export type ListDeliveriesQueryInput = z.input<typeof ListDeliveriesQuerySchema>;

import { z } from 'zod';
import { Iso8601Schema, PrefixedId } from './common.js';

export const WebhookEndpointIdSchema = PrefixedId('whk');
export type WebhookEndpointId = z.infer<typeof WebhookEndpointIdSchema>;

export const WebhookDeliveryIdSchema = PrefixedId('wdl');

export const WebhookEventTypeSchema = z.enum([
  'session.completed',
  'session.failed',
  'quota.warning_80pct',
  'quota.exceeded',
  'api_key.revoked',
  // V-356 — synthetic test event, sent only via POST
  // /v1/webhooks/:id/test. Customers cannot subscribe to it
  // (UpdateSubscriptionsSchema rejects it) — the endpoint dispatches
  // a one-off delivery regardless of subscription, so the customer
  // can verify their handler before relying on it for real events.
  'test.ping',
]);
export type WebhookEventType = z.infer<typeof WebhookEventTypeSchema>;

/**
 * V-356 — events the customer is allowed to subscribe to. Excludes
 * `test.ping`, which is only ever emitted via the explicit test
 * endpoint (subscribing to it would be meaningless — the test
 * endpoint dispatches regardless of subscription).
 */
export const SubscribableWebhookEventTypeSchema = z.enum([
  'session.completed',
  'session.failed',
  'quota.warning_80pct',
  'quota.exceeded',
  'api_key.revoked',
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
  events: z.array(WebhookEventTypeSchema),
  description: z.string().nullable(),
  active: z.boolean(),
  consecutive_failures: z.number().int().nonnegative(),
  last_success_at: Iso8601Schema.nullable(),
  last_failure_at: Iso8601Schema.nullable(),
  disabled_at: Iso8601Schema.nullable(),
  created_at: Iso8601Schema,
});
export type WebhookEndpoint = z.infer<typeof WebhookEndpointSchema>;

// ───────────────────────────────────────────────────────────────────────────
// Create
// ───────────────────────────────────────────────────────────────────────────

export const CreateWebhookRequestSchema = z.object({
  url: z
    .string()
    .url()
    .refine((u) => u.startsWith('https://'), {
      message: 'Webhook URL must use https://',
    }),
  // V-356 — only subscribable event types accepted on create. Customers
  // can't subscribe to `test.ping`; that event is only emitted via the
  // POST /v1/webhooks/:id/test endpoint, regardless of subscription.
  events: z.array(SubscribableWebhookEventTypeSchema).min(1).max(10),
  description: z.string().max(200).optional(),
});
export type CreateWebhookRequest = z.infer<typeof CreateWebhookRequestSchema>;

export const CreateWebhookResponseSchema = WebhookEndpointSchema.extend({
  secret: z.string().describe('Plaintext signing secret. Returned ONCE; not retrievable later.'),
});

// ───────────────────────────────────────────────────────────────────────────
// V-351 — Update
// ───────────────────────────────────────────────────────────────────────────

export const UpdateWebhookRequestSchema = z
  .object({
    url: z
      .string()
      .url()
      .refine((u) => u.startsWith('https://'), {
        message: 'Webhook URL must use https://',
      })
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
  cursor: z.string().optional(),
  status: WebhookDeliveryStatusSchema.optional(),
});
export type ListDeliveriesQuery = z.infer<typeof ListDeliveriesQuerySchema>;
export type ListDeliveriesQueryInput = z.input<typeof ListDeliveriesQuerySchema>;

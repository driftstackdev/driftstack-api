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
]);
export type WebhookEventType = z.infer<typeof WebhookEventTypeSchema>;

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
  events: z.array(WebhookEventTypeSchema).min(1).max(10),
  description: z.string().max(200).optional(),
});
export type CreateWebhookRequest = z.infer<typeof CreateWebhookRequestSchema>;

export const CreateWebhookResponseSchema = WebhookEndpointSchema.extend({
  secret: z.string().describe('Plaintext signing secret. Returned ONCE; not retrievable later.'),
});
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

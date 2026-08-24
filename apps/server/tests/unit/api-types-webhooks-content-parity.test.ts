// W434.C — drift guard for packages/api-types/src/webhooks.ts.
// Webhook subscription + delivery schemas. Drift here either lets
// customers subscribe to test.ping (which would fan-out on every
// real delivery, defeating its purpose) or strips the V-359 rotation
// grace-window fields (rotation pipeline silently drops the dual-sign
// metadata customers depend on).
//
//   • WebhookEndpointId = PrefixedId('whk'); WebhookDeliveryId =
//     PrefixedId('wdl').
//   • WebhookEventType full enum: emitted customer events + V-356
//     test.ping (NOT subscribable); silent quota placeholders excluded.
//   • SubscribableWebhookEventType excludes test.ping (V-356
//     rationale).
//   • WebhookDeliveryStatus enum: pending | in_flight | delivered
//     | failed | dlq.
//   • WebhookEndpoint shape: secret_prefix + V-359 prev_secret_prefix
//     + rotation_grace_expires_at; V-185 delivery_counts aggregate.
//   • Create: https-only refine + SubscribableWebhookEventType .min(1)
//     .max(10); plaintext secret returned ONCE.
//   • V-351 Update: at-least-one-field refine.
//   • V-359 RotateWebhookSecretResponse: fresh plaintext + prev
//     prefix + grace_expires_at with .describe rationale.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/api-types/src/webhooks.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W434.C packages/api-types/src/webhooks.ts content parity', () => {
  const body = read(LIB);

  it("imports: z + Iso8601Schema + PrefixedId from './common.js'; WebhookEndpointId = PrefixedId('whk'); WebhookDeliveryId = PrefixedId('wdl')", () => {
    expect(body).toMatch(/import \{ z \} from 'zod';/);
    expect(body).toMatch(/import \{ Iso8601Schema, PrefixedId \} from '\.\/common\.js';/);
    expect(body).toMatch(/export const WebhookEndpointIdSchema = PrefixedId\('whk'\);/);
    expect(body).toMatch(/export const WebhookDeliveryIdSchema = PrefixedId\('wdl'\);/);
  });

  it('WebhookEventType enum begins with emitted session/key events; silent quota placeholders are excluded; V-356 test.ping remains synthetic and not subscribable', () => {
    expect(body).toMatch(
      /export const WebhookEventTypeSchema = z\.enum\(\[\s*\n?\s*'session\.completed',\s*\n?\s*'session\.failed',\s*\n?\s*'api_key\.revoked',/,
    );
    expect(body).not.toMatch(/quota\.warning_80pct|quota\.exceeded/);
    expect(body).toMatch(
      /\/\/ V-356 — synthetic test event, sent only via POST\s*\n?\s*\/\/ \/v1\/webhooks\/:id\/test\. Customers cannot subscribe to it\s*\n?\s*\/\/ \(UpdateSubscriptionsSchema rejects it\) — the endpoint dispatches\s*\n?\s*\/\/ a one-off delivery regardless of subscription, so the customer\s*\n?\s*\/\/ can verify their handler before relying on it for real events\.\s*\n?\s*'test\.ping',/,
    );
  });

  it('V-356 SubscribableWebhookEventType: excludes test.ping; "subscribing to test.ping is meaningless" rationale pinned. 2026-05-22 — V-666 crypto.order.paid + crypto.order.failed added (migration 0064).', () => {
    expect(body).toMatch(
      /\*\s*V-356 — events the customer is allowed to subscribe to\. Excludes\s*\n?\s*\*\s*`test\.ping`, which is only ever emitted via the explicit test\s*\n?\s*\*\s*endpoint \(subscribing to it would be meaningless — the test\s*\n?\s*\*\s*endpoint dispatches regardless of subscription\)\./,
    );
    expect(body).toMatch(/export const SubscribableWebhookEventTypeSchema = z\.enum\(\[/);
    expect(body).toMatch(/'session\.completed',/);
    expect(body).toMatch(/'session\.failed',/);
    expect(body).toMatch(/'api_key\.revoked',/);
    expect(body).toMatch(/'session\.egress_capability_changed',/);
    expect(body).toMatch(/'crypto\.order\.paid',/);
    expect(body).toMatch(/'crypto\.order\.failed',/);
  });

  it('WebhookDeliveryStatus enum: pending | in_flight | delivered | failed | dlq', () => {
    expect(body).toMatch(
      /export const WebhookDeliveryStatusSchema = z\.enum\(\[\s*\n?\s*'pending',\s*\n?\s*'in_flight',\s*\n?\s*'delivered',\s*\n?\s*'failed',\s*\n?\s*'dlq',\s*\n?\s*\]\);/,
    );
  });

  it('WebhookEndpoint shape: id + url + secret_prefix + V-359 prev_secret_prefix nullable + V-359 rotation_grace_expires_at nullable + events + description nullable + active + consecutive_failures + last_success_at + last_failure_at + disabled_at + V-185 delivery_counts aggregate (delivered/failed/dlq) + created_at', () => {
    expect(body).toMatch(/export const WebhookEndpointSchema = z\.object\(\{/);
    expect(body).toMatch(/url: z\.string\(\)\.url\(\),/);
    expect(body).toMatch(/secret_prefix: z\.string\(\),/);
    expect(body).toMatch(
      /\/\*\* V-359 — populated only during the 24h rotation grace period\.\s*\n?\s*\*\s*Null when no rotation in flight\. \*\/\s*\n?\s*prev_secret_prefix: z\.string\(\)\.nullable\(\),/,
    );
    expect(body).toMatch(
      /\/\*\* V-359 — when prev_secret is active, this is the timestamp at\s*\n?\s*\*\s*which dual-signing stops\. Null when no rotation in flight\. \*\/\s*\n?\s*rotation_grace_expires_at: Iso8601Schema\.nullable\(\),/,
    );
    expect(body).toMatch(/events: z\.array\(SubscribableWebhookEventTypeSchema\),/);
    expect(body).toMatch(/consecutive_failures: z\.number\(\)\.int\(\)\.nonnegative\(\),/);
    expect(body).toMatch(
      /\/\*\* V-185 — aggregate per-endpoint delivery counts\. \*\/\s*\n?\s*delivery_counts: z\.object\(\{\s*\n?\s*delivered: z\.number\(\)\.int\(\)\.nonnegative\(\),\s*\n?\s*failed: z\.number\(\)\.int\(\)\.nonnegative\(\),\s*\n?\s*dlq: z\.number\(\)\.int\(\)\.nonnegative\(\),\s*\n?\s*\}\),/,
    );
  });

  it('CreateWebhookRequest: url .refine(starts with https://) + V-356 events SubscribableWebhookEventType .min(1) .max(10) + description max 200 nullable optional; rationale pinned (test.ping not subscribable)', () => {
    expect(body).toMatch(
      // V-1498 — was a `.refine(startsWith('https://'))`. A refine is a runtime
      // predicate JSON Schema cannot express, so the published `url` carried no
      // https constraint at all. Same conversion V-924/V-1475 made to the tier
      // fields, and behaviour-preserving: `.url()` still runs first and the
      // message is unchanged.
      /url: z\s*\n?\s*\.string\(\)\s*\n?\s*\.url\(\)\s*\n?\s*\.regex\(\/\^https:\\\/\\\/\/, \{ message: 'Webhook URL must use https:\/\/' \}\),/,
    );
    expect(body).toMatch(
      /\/\/ V-356 — only subscribable event types accepted on create\. Customers\s*\n?\s*\/\/ can't subscribe to `test\.ping`; that event is only emitted via the\s*\n?\s*\/\/ POST \/v1\/webhooks\/:id\/test endpoint, regardless of subscription\.\s*\n?\s*events: z\.array\(SubscribableWebhookEventTypeSchema\)\.min\(1\)\.max\(10\),/,
    );
    expect(body).toMatch(/description: z\.string\(\)\.max\(200\)\.nullable\(\)\.optional\(\),/);
  });

  it('CreateWebhookResponse: extends WebhookEndpoint + plaintext secret shown ONCE with .describe', () => {
    expect(body).toMatch(
      /export const CreateWebhookResponseSchema = WebhookEndpointSchema\.extend\(\{\s*\n?\s*secret: z\.string\(\)\.describe\('Plaintext signing secret\. Returned ONCE; not retrievable later\.'\),\s*\n?\s*\}\);/,
    );
  });

  it('V-359 RotateWebhookSecretResponse: id + plaintext secret ONCE + secret_prefix + prev_secret_prefix + grace_expires_at; rationale .describe text pinned (dual-sign window for verifier rollout)', () => {
    expect(body).toMatch(
      /\/\/ V-359 — POST \/v1\/webhooks\/:id\/rotate-secret response\. Surfaces the\s*\n?\s*\/\/ fresh plaintext secret ONCE alongside metadata about the grace\s*\n?\s*\/\/ window during which both the old \+ new secrets are accepted by the\s*\n?\s*\/\/ server's outbound dual-sign\./,
    );
    expect(body).toMatch(
      /export const RotateWebhookSecretResponseSchema = z\.object\(\{\s*\n?\s*id: WebhookEndpointIdSchema,\s*\n?\s*secret: z\.string\(\)\.describe\('Fresh plaintext signing secret\. Returned ONCE\.'\),\s*\n?\s*secret_prefix: z\.string\(\),\s*\n?\s*prev_secret_prefix: z\s*\n?\s*\.string\(\)\s*\n?\s*\.describe\('First chars of the prior secret, kept active during grace\.'\),\s*\n?\s*grace_expires_at: Iso8601Schema\.describe\(\s*\n?\s*'Until this timestamp, every outbound delivery is signed with both the new \+ old secret so the customer can roll their verifier across infra without dropped deliveries\.',\s*\n?\s*\),\s*\n?\s*\}\);/,
    );
  });

  it('V-351 UpdateWebhookRequest: all four fields optional (url with https-refine + events 1..10 + description nullable + active) + at-least-one-field .refine', () => {
    expect(body).toMatch(/\/\/ V-351 — Update/);
    expect(body).toMatch(
      /export const UpdateWebhookRequestSchema = z\s*\n?\s*\.object\(\{\s*\n?\s*url: z\s*\n?\s*\.string\(\)\s*\n?\s*\.url\(\)\s*\n?\s*\.regex\(\/\^https:\\\/\\\/\/, \{ message: 'Webhook URL must use https:\/\/' \}\)\s*\n?\s*\.optional\(\),\s*\n?\s*events: z\.array\(SubscribableWebhookEventTypeSchema\)\.min\(1\)\.max\(10\)\.optional\(\),\s*\n?\s*description: z\.string\(\)\.max\(200\)\.nullable\(\)\.optional\(\),\s*\n?\s*active: z\.boolean\(\)\.optional\(\),\s*\n?\s*\}\)\s*\n?\s*\.refine\(\s*\n?\s*\(v\) =>\s*\n?\s*v\.url !== undefined \|\|\s*\n?\s*v\.events !== undefined \|\|\s*\n?\s*v\.description !== undefined \|\|\s*\n?\s*v\.active !== undefined,\s*\n?\s*\{ message: 'At least one field must be provided\.' \},\s*\n?\s*\);/,
    );
  });

  it('WebhookDelivery shape: id + webhook_id + event_id uuid + event_type + status + attempts nonneg int + next_attempt_at + last_response_status nullable int + last_response_excerpt nullable + last_error nullable + delivered_at nullable + created_at', () => {
    expect(body).toMatch(
      /export const WebhookDeliverySchema = z\.object\(\{\s*\n?\s*id: WebhookDeliveryIdSchema,\s*\n?\s*webhook_id: WebhookEndpointIdSchema,\s*\n?\s*event_id: z\.string\(\)\.uuid\(\),\s*\n?\s*event_type: WebhookEventTypeSchema,\s*\n?\s*status: WebhookDeliveryStatusSchema,\s*\n?\s*attempts: z\.number\(\)\.int\(\)\.nonnegative\(\),\s*\n?\s*next_attempt_at: Iso8601Schema,\s*\n?\s*last_response_status: z\.number\(\)\.int\(\)\.nullable\(\),\s*\n?\s*last_response_excerpt: z\.string\(\)\.nullable\(\),\s*\n?\s*last_error: z\.string\(\)\.nullable\(\),\s*\n?\s*delivered_at: Iso8601Schema\.nullable\(\),\s*\n?\s*created_at: Iso8601Schema,\s*\n?\s*\}\);/,
    );
  });

  it('ListDeliveriesQuery: limit coerced int 1..100 default 50 + optional cursor (min-1 max-512 per slice 149) + optional status filter; exports both schema-output and z.input types', () => {
    // Slice 149 added .min(1).max(512) to cursor for defensive cap
    // matching the PaginationQuerySchema cap (slice 148). This
    // schema doesn't extend the base shape (carries its own status
    // filter), so the cap is duplicated explicitly here.
    expect(body).toMatch(
      /export const ListDeliveriesQuerySchema = z\.object\(\{\s*\n?\s*limit: z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.max\(100\)\.default\(50\),\s*\n?\s*\/\/ Slice 149[\s\S]*?cursor: z\.string\(\)\.min\(1\)\.max\(512\)\.optional\(\),\s*\n?\s*status: WebhookDeliveryStatusSchema\.optional\(\),\s*\n?\s*\}\);/,
    );
    expect(body).toMatch(
      /export type ListDeliveriesQuery = z\.infer<typeof ListDeliveriesQuerySchema>;/,
    );
    expect(body).toMatch(
      /export type ListDeliveriesQueryInput = z\.input<typeof ListDeliveriesQuerySchema>;/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});

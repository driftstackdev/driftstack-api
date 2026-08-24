// Admin API contracts. Routes under /v1/admin/* require the admin
// scope (see D-012 + D-025). These schemas describe the public shape
// of admin requests and responses.

import { z } from 'zod';
import { AccountSchema } from './accounts.js';
import { AccountTierSchema, Iso8601Schema } from './common.js';

// ───────────────────────────────────────────────────────────────────────────
// V-218 — continuous validation harness
// ───────────────────────────────────────────────────────────────────────────

export const ValidationScheduleSchema = z.object({
  id: z.string().uuid(),
  archetype_id: z.string(),
  cadence_seconds: z.number().int().positive(),
  enabled: z.boolean(),
  last_run_at: z.string().nullable(),
  next_run_at: z.string(),
  last_run_id: z.string().nullable(),
  reason: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type ValidationSchedule = z.infer<typeof ValidationScheduleSchema>;

export const UpsertValidationScheduleRequestSchema = z.object({
  archetype_id: z.string().min(1),
  cadence_seconds: z
    .number()
    .int()
    .min(60)
    .max(60 * 60 * 24 * 365),
  enabled: z.boolean().optional().default(true),
  reason: z.string().max(500).optional(),
});
export type UpsertValidationScheduleRequest = z.infer<typeof UpsertValidationScheduleRequestSchema>;

export const ListValidationSchedulesResponseSchema = z.object({
  data: z.array(ValidationScheduleSchema),
});
export type ListValidationSchedulesResponse = z.infer<typeof ListValidationSchedulesResponseSchema>;

// ───────────────────────────────────────────────────────────────────────────
// Tier change
// ───────────────────────────────────────────────────────────────────────────

export const ChangeTierRequestSchema = z.object({
  tier: AccountTierSchema,
  /** Optional human-readable reason recorded in the audit row. */
  reason: z.string().max(500).optional(),
});
export type ChangeTierRequest = z.infer<typeof ChangeTierRequestSchema>;

// ───────────────────────────────────────────────────────────────────────────
// Suspend / unsuspend
// ───────────────────────────────────────────────────────────────────────────

export const SuspendAccountRequestSchema = z.object({
  /** Optional reason recorded in the audit row. */
  reason: z.string().max(500).optional(),
});
export type SuspendAccountRequest = z.infer<typeof SuspendAccountRequestSchema>;

export const UnsuspendAccountRequestSchema = z.object({
  reason: z.string().max(500).optional(),
});
export type UnsuspendAccountRequest = z.infer<typeof UnsuspendAccountRequestSchema>;

// GDPR Article 17 — admin-triggered account termination. Same shape as
// SuspendAccountRequestSchema/UnsuspendAccountRequestSchema; the route
// mirrors those two exactly (POST /v1/admin/accounts/:id/delete).
export const DeleteAccountRequestSchema = z.object({
  /** Optional reason recorded in the audit row. */
  reason: z.string().max(500).optional(),
});
export type DeleteAccountRequest = z.infer<typeof DeleteAccountRequestSchema>;

// ───────────────────────────────────────────────────────────────────────────
// V-281 — admin audit-note + refund-record (audit-only)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Records a free-form admin note on the customer's audit log. Operator
 * uses this to attach context the audit log doesn't capture
 * automatically — post-incident summary, customer-support call notes,
 * out-of-band action receipts.
 *
 * Audit-only: never touches billing / sessions / keys. Recording does
 * not produce a side effect on the account state.
 */
export const AddSupportNoteRequestSchema = z.object({
  note: z.string().min(1).max(2000),
});
export type AddSupportNoteRequest = z.infer<typeof AddSupportNoteRequestSchema>;

/**
 * Records that the operator manually issued a refund via the Stripe
 * dashboard. The endpoint does NOT call Stripe. Money movement happens
 * out-of-band; the audit row is the post-action receipt for compliance
 * and customer support follow-up.
 *
 * Per V-280 launch-day-runbook + the founder's tier-3 boundary on
 * direct financial actions.
 */
export const RecordRefundRequestSchema = z.object({
  /** The Stripe charge / payment_intent / invoice id refunded. */
  external_reference: z.string().min(3).max(120),
  /** Refund amount in cents. May be partial. */
  amount_cents: z.number().int().positive(),
  /** Currency ISO 4217; defaults to USD if omitted. */
  currency: z.string().length(3).optional(),
  /** Reason recorded on the audit row + the customer-visible audit slice. */
  reason: z.string().min(1).max(500),
});
export type RecordRefundRequest = z.infer<typeof RecordRefundRequestSchema>;

// ───────────────────────────────────────────────────────────────────────────
// Admin account view (mirrors AccountSchema; returned by mutation endpoints
// so callers see the post-update state without an extra GET).
// ───────────────────────────────────────────────────────────────────────────

export const AdminAccountResponseSchema = AccountSchema;
export type AdminAccountResponse = z.infer<typeof AdminAccountResponseSchema>;

// ───────────────────────────────────────────────────────────────────────────
// Rate-limit override (admin)
// ───────────────────────────────────────────────────────────────────────────

export const SetQuotaOverrideRequestSchema = z.object({
  bucket_key: z.enum(['global', 'sessions:create', 'agent_sessions:message']),
  capacity: z.number().int().min(1).max(1_000_000),
  refill_per_second: z.number().min(0.01).max(100_000),
  duration_seconds: z
    .number()
    .int()
    .min(1)
    .max(86_400 * 30), // up to 30 days
  reason: z.string().max(500).optional(),
});
export type SetQuotaOverrideRequest = z.infer<typeof SetQuotaOverrideRequestSchema>;

export const ClearQuotaOverrideQuerySchema = z.object({
  bucket_key: z.enum(['global', 'sessions:create', 'agent_sessions:message']),
});
export type ClearQuotaOverrideQuery = z.infer<typeof ClearQuotaOverrideQuerySchema>;

export const QuotaOverrideResponseSchema = z.object({
  account_id: z.string(),
  bucket_key: z.string(),
  capacity: z.number().int(),
  refill_per_second: z.number(),
  reason: z.string().nullable(),
  expires_at: Iso8601Schema,
  created_at: Iso8601Schema,
  updated_at: Iso8601Schema,
});
export type QuotaOverrideResponse = z.infer<typeof QuotaOverrideResponseSchema>;

// ───────────────────────────────────────────────────────────────────────────
// Webhook admin (replay / requeue / dlq list)
// ───────────────────────────────────────────────────────────────────────────

export const ListDlqQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  // V-1473 — slice 149's cap. This schema carries its own cursor rather than
  // extending PaginationQuerySchema, which is precisely the case slice 149 exists
  // for, and it was missed: the guard that pins the convention rosters
  // webhooks.ts and accounts.ts and never named this file.
  cursor: z.string().min(1).max(512).optional(),
  // V-512 — optional drill-down by webhook-endpoint id. Customer
  // support workflow: a customer reports "my endpoint is missing
  // events"; admin pulls just that endpoint's DLQ rows without
  // wading through other accounts'.
  endpoint_id: z.string().min(1).max(200).optional(),
});
export type ListDlqQuery = z.infer<typeof ListDlqQuerySchema>;
export type ListDlqQueryInput = z.input<typeof ListDlqQuerySchema>;

// ───────────────────────────────────────────────────────────────────────────
// Admin audit log
// ───────────────────────────────────────────────────────────────────────────

export const AdminAuditActionSchema = z.enum([
  'account.tier_changed',
  'account.suspended',
  'account.unsuspended',
  'webhook_delivery.replayed',
  'webhook_delivery.requeued',
  // hard-delete a DLQ row (migration 0061); the audit entry is the only trace.
  'webhook_delivery.discarded',
  'rate_limit_override.set',
  'rate_limit_override.cleared',
  // V-100: force actions on customer resources.
  'session.destroyed_by_admin',
  'api_key.revoked_by_admin',
  // V-281: customer-support tooling (audit-only).
  'audit_note.added',
  'refund.recorded',
  // V-295a: status-page incident management.
  'incident.created',
  'incident.updated',
  'incident.resolved',
  // admin reopen for false-alarm / regression (migration 0063).
  'incident.reopened',
  // V-295c3-tombstone: status-page email subscriber admin actions.
  'status_subscriber.force_unsubscribed',
  'status_subscriber.purged',
  // admin force-subscribe bypassing double-opt-in (migration 0062).
  'status_subscriber.force_subscribed',
  // LK.2: per-Mac LiveKit credential registration (migration 0057).
  'mac_node.livekit_registered',
  // Fleet-admin (§A5): node-level control action (cordon/uncordon/drain/
  // restart) via POST /v1/mac-nodes/:id/control (migration 0084).
  'mac_node.control',
  // owner price edit — pricing-as-data master-owner cockpit (migration 0068).
  'pricing.updated',
  // Admin-cockpit secrets Phase A slice 2 (migration 0075).
  'secret.created',
  'secret.updated',
  'secret.deleted',
  'secret.revealed',
  // D-025 audit-gap fix (migration 0097) — admin-crypto-orders.ts +
  // admin-validation-harness.ts had zero audit wiring. sweep-expired /
  // apply-ipn / internal-note now audit via crypto_order.*;
  // validation-schedule upsert / remove / trigger via validation_schedule.*.
  'crypto_order.swept',
  'crypto_order.ipn_applied',
  'crypto_order.note_updated',
  'validation_schedule.upserted',
  'validation_schedule.removed',
  'validation_schedule.triggered',
  // GDPR Article 17 — admin-triggered account termination (migration 0094).
  'account.deleted',
]);
export type AdminAuditAction = z.infer<typeof AdminAuditActionSchema>;

export const ListAuditLogQuerySchema = z.object({
  admin_id: z.string().optional(),
  target_id: z.string().optional(),
  action: AdminAuditActionSchema.optional(),
  from: Iso8601Schema.optional(),
  to: Iso8601Schema.optional(),
  // V-521 — admin-side parity with the V-484 customer audit-log
  // filter set. Drill into a single resource (e.g. one webhook
  // delivery) across every admin action that touched it.
  target_resource_id: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(512).optional(),
});
export type ListAuditLogQuery = z.infer<typeof ListAuditLogQuerySchema>;
export type ListAuditLogQueryInput = z.input<typeof ListAuditLogQuerySchema>;

export const AdminAuditLogEntrySchema = z.object({
  id: z.string().uuid(),
  admin_account_id: z.string(),
  admin_key_id: z.string(),
  action: AdminAuditActionSchema,
  target_account_id: z.string().nullable(),
  target_resource_id: z.string().nullable(),
  input_payload: z.record(z.unknown()).nullable(),
  result: z.string(),
  ip_address: z.string().nullable(),
  timestamp: Iso8601Schema,
});
export type AdminAuditLogEntry = z.infer<typeof AdminAuditLogEntrySchema>;

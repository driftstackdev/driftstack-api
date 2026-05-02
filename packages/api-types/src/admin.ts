// Admin API contracts. Routes under /v1/admin/* require the admin
// scope (see D-012 + D-025). These schemas describe the public shape
// of admin requests and responses.

import { z } from 'zod';
import { AccountSchema } from './accounts.js';
import { AccountTierSchema, Iso8601Schema } from './common.js';

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

// ───────────────────────────────────────────────────────────────────────────
// Admin account view (mirrors AccountSchema; returned by mutation endpoints
// so callers see the post-update state without an extra GET).
// ───────────────────────────────────────────────────────────────────────────

export const AdminAccountResponseSchema = AccountSchema;
export type AdminAccountResponse = z.infer<typeof AdminAccountResponseSchema>;

// ───────────────────────────────────────────────────────────────────────────
// Webhook admin (replay / requeue / dlq list)
// ───────────────────────────────────────────────────────────────────────────

export const ListDlqQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
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
  'rate_limit_override.set',
  'rate_limit_override.cleared',
]);
export type AdminAuditAction = z.infer<typeof AdminAuditActionSchema>;

export const ListAuditLogQuerySchema = z.object({
  admin_id: z.string().optional(),
  target_id: z.string().optional(),
  action: AdminAuditActionSchema.optional(),
  from: Iso8601Schema.optional(),
  to: Iso8601Schema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
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

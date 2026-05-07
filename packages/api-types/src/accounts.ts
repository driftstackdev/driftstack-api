import { z } from 'zod';
import { AccountIdSchema, AccountTierSchema, Iso8601Schema } from './common.js';

export const AccountStatusSchema = z.enum(['active', 'suspended', 'deleted']);
export type AccountStatus = z.infer<typeof AccountStatusSchema>;

export const AccountSchema = z.object({
  id: AccountIdSchema,
  email: z.string().email(),
  name: z.string().nullable(),
  tier: AccountTierSchema,
  status: AccountStatusSchema,
  created_at: Iso8601Schema,
  updated_at: Iso8601Schema,
});

export type Account = z.infer<typeof AccountSchema>;

// ───────────────────────────────────────────────────────────────────────────
// V-204 — email notification preferences
// ───────────────────────────────────────────────────────────────────────────

/**
 * Event types the customer can opt out of. Security + financial emails
 * (signup-verification, password-reset, billing-failure, subscription-
 * cancellation, support-ack) are never opt-outable; they're absent
 * from this enum on purpose so the API surface matches the policy.
 */
export const OptOutableEmailEventSchema = z.enum([
  'signup-welcome',
  'session-failed-first',
  'tier-changed',
  'trial-pack-purchased',
  'trial-pack-expired',
  'billing-receipt',
]);
export type OptOutableEmailEvent = z.infer<typeof OptOutableEmailEventSchema>;

export const EmailPreferenceSchema = z.object({
  event_type: OptOutableEmailEventSchema,
  opted_in: z.boolean(),
});
export type EmailPreference = z.infer<typeof EmailPreferenceSchema>;

export const ListEmailPreferencesResponseSchema = z.object({
  data: z.array(EmailPreferenceSchema),
});
export type ListEmailPreferencesResponse = z.infer<typeof ListEmailPreferencesResponseSchema>;

export const SetEmailPreferenceRequestSchema = z.object({
  event_type: OptOutableEmailEventSchema,
  opted_in: z.boolean(),
});
export type SetEmailPreferenceRequest = z.infer<typeof SetEmailPreferenceRequestSchema>;

// ───────────────────────────────────────────────────────────────────────────
// V-216 — customer-facing audit log
// ───────────────────────────────────────────────────────────────────────────

/**
 * Closed enum of customer-visible audit actions. Adding a new event
 * type is a Class A schema migration (additive enum value).
 */
export const AccountAuditActionSchema = z.enum([
  'account.email_verified',
  'account.login',
  'account.logout',
  'account.password_changed',
  'api_key.minted',
  'api_key.revoked',
  'session.created',
  'session.destroyed',
  'profile.created',
  'profile.deleted',
  'subscription.tier_changed',
  'webhook_endpoint.created',
  'webhook_endpoint.deleted',
  // V-281 — admin-recorded notes. Refund recording is audit-only;
  // actual money movement happens via Stripe dashboard manually per
  // the V-280 launch-day runbook. Support notes are free-form
  // operator notes attached to a customer account for post-incident
  // / context-passing visibility.
  'admin.refund_recorded',
  'admin.support_note',
]);
export type AccountAuditAction = z.infer<typeof AccountAuditActionSchema>;

export const AccountAuditActorTypeSchema = z.enum(['customer', 'system', 'staff']);
export type AccountAuditActorType = z.infer<typeof AccountAuditActorTypeSchema>;

export const AccountAuditEntrySchema = z.object({
  id: z.string().uuid(),
  account_id: z.string(),
  actor_type: AccountAuditActorTypeSchema,
  actor_account_id: z.string().nullable(),
  actor_key_id: z.string().nullable(),
  action: AccountAuditActionSchema,
  target_resource_id: z.string().nullable(),
  payload: z.record(z.unknown()).nullable(),
  ip_address: z.string().nullable(),
  user_agent: z.string().nullable(),
  timestamp: Iso8601Schema,
});
export type AccountAuditEntry = z.infer<typeof AccountAuditEntrySchema>;

export const ListAccountAuditLogQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  cursor: z.string().optional(),
  action: AccountAuditActionSchema.optional(),
});
export type ListAccountAuditLogQuery = z.infer<typeof ListAccountAuditLogQuerySchema>;

export const ListAccountAuditLogResponseSchema = z.object({
  data: z.array(AccountAuditEntrySchema),
  next_cursor: z.string().nullable(),
});
export type ListAccountAuditLogResponse = z.infer<typeof ListAccountAuditLogResponseSchema>;

// ───────────────────────────────────────────────────────────────────────────
// V-219 — customer-facing rate-limit view
// ───────────────────────────────────────────────────────────────────────────

export const RateLimitBucketSchema = z.object({
  bucket_key: z.enum(['global', 'sessions:create']),
  capacity: z.number().int().positive(),
  refill_per_second: z.number().positive(),
  /**
   * `'tier_default'` when the value comes from the locked tier table;
   * `'override'` when an admin-set override is currently in effect.
   */
  source: z.enum(['tier_default', 'override']),
  /** Override expiry, if applicable. Null for tier defaults. */
  override_expires_at: z.string().nullable(),
});
export type RateLimitBucket = z.infer<typeof RateLimitBucketSchema>;

export const GetAccountRateLimitsResponseSchema = z.object({
  tier: AccountTierSchema,
  buckets: z.array(RateLimitBucketSchema),
});
export type GetAccountRateLimitsResponse = z.infer<typeof GetAccountRateLimitsResponseSchema>;

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
  // V-304a — first successful session activation milestone email.
  'session-success-first',
  'tier-changed',
  'trial-pack-purchased',
  'trial-pack-expired',
  'billing-receipt',
  // V-304b — 7-days-before-renewal reminder. Driven by Stripe
  // invoice.upcoming webhook.
  'billing-renewal-reminder',
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
// V-352 — PATCH /v1/account/me request shape
// ───────────────────────────────────────────────────────────────────────────

/**
 * V-352 — partial update of self-editable basics. At least one
 * field must be provided. `name` may be set to null to clear; the
 * email-display fallback uses the email address. `timezone` accepts
 * an IANA name (e.g. `Europe/Amsterdam`) or null to clear (UTC fallback).
 */
export const UpdateAccountMeRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120).nullable().optional(),
    timezone: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(
        /^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+$/,
        'Must be an IANA timezone name like "Europe/Amsterdam".',
      )
      .nullable()
      .optional(),
  })
  .refine((v) => v.name !== undefined || v.timezone !== undefined, {
    message: 'At least one field (name or timezone) must be provided.',
  });
export type UpdateAccountMeRequest = z.infer<typeof UpdateAccountMeRequestSchema>;

// ───────────────────────────────────────────────────────────────────────────
// V-352b — POST /v1/account/me/avatar request shape
// ───────────────────────────────────────────────────────────────────────────

/**
 * V-352b — customer-uploaded avatar. The image is sent inline as
 * base64 (no multipart on this control plane). Storage backend is
 * the existing R2 public-snapshot bucket (already disclosed as a
 * sub-processor for status-page snapshots; per V-294 the disclosure
 * scope is updated atomically with this slice to also cover avatars).
 *
 * Cap: 2 MiB raw bytes. The base64 wire size is ~33% larger; the
 * base64 string is bounded at ~2.8 MiB to keep the request body
 * inside Fastify's default JSON body limit.
 */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
export const AVATAR_ALLOWED_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const AvatarContentTypeSchema = z.enum(AVATAR_ALLOWED_CONTENT_TYPES);
export type AvatarContentType = z.infer<typeof AvatarContentTypeSchema>;

export const UploadAvatarRequestSchema = z.object({
  content_type: AvatarContentTypeSchema,
  data_base64: z
    .string()
    .min(4)
    .max(Math.ceil((AVATAR_MAX_BYTES * 4) / 3) + 4)
    .regex(/^[A-Za-z0-9+/=]+$/, 'Must be base64-encoded.'),
});
export type UploadAvatarRequest = z.infer<typeof UploadAvatarRequestSchema>;

// ───────────────────────────────────────────────────────────────────────────
// V-353b — MFA (TOTP) enrollment + verify + recovery codes
// ───────────────────────────────────────────────────────────────────────────

export const MfaStatusResponseSchema = z.object({
  enrolled: z.boolean(),
  enrolled_at: Iso8601Schema.nullable(),
  last_used_at: Iso8601Schema.nullable(),
  unused_recovery_codes: z.number().int().nonnegative(),
});
export type MfaStatusResponse = z.infer<typeof MfaStatusResponseSchema>;

export const StartMfaEnrollmentResponseSchema = z.object({
  otpauth_uri: z.string().describe('otpauth:// URI; render as a QR code'),
  secret_base32: z.string().describe('Manual-entry secret for auth apps that do not scan QR'),
  algorithm: z.literal('SHA1'),
  digits: z.literal(6),
  period_seconds: z.literal(30),
});
export type StartMfaEnrollmentResponse = z.infer<typeof StartMfaEnrollmentResponseSchema>;

export const CompleteMfaEnrollmentRequestSchema = z.object({
  code: z.string().regex(/^\d{6}$/, 'Must be a 6-digit code.'),
});
export type CompleteMfaEnrollmentRequest = z.infer<typeof CompleteMfaEnrollmentRequestSchema>;

export const CompleteMfaEnrollmentResponseSchema = z.object({
  recovery_codes: z.array(z.string()).length(10),
});
export type CompleteMfaEnrollmentResponse = z.infer<typeof CompleteMfaEnrollmentResponseSchema>;

export const RegenerateMfaRecoveryCodesResponseSchema = z.object({
  recovery_codes: z.array(z.string()).length(10),
});
export type RegenerateMfaRecoveryCodesResponse = z.infer<
  typeof RegenerateMfaRecoveryCodesResponseSchema
>;

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
  // V-296 — customer self-service rotation; old key continues for grace
  // period (24h), new key shown once. Audit captures both ids for
  // post-hoc reconstruction.
  'api_key.rotated',
  'session.created',
  'session.destroyed',
  'profile.created',
  'profile.deleted',
  'subscription.tier_changed',
  'webhook_endpoint.created',
  'webhook_endpoint.updated',
  'webhook_endpoint.deleted',
  // V-359 — signing secret rotation. Payload: new_secret_prefix,
  // old_secret_prefix, grace_expires_at (24h default).
  'webhook_endpoint.secret_rotated',
  // V-307 — customer self-service replay of a webhook delivery.
  'webhook_delivery.replayed',
  // V-298f — Team RBAC v1 customer audit entries.
  'team.member_invited',
  'team.invite_accepted',
  'team.member_removed',
  // V-353b — MFA lifecycle. mfa_enrolled fires on successful first
  // verify (not on /enroll, which is reversible). mfa_disabled fires
  // when the customer explicitly disables. recovery_code_used fires
  // each time a code is consumed (login or step-up path).
  'account.mfa_enrolled',
  'account.mfa_disabled',
  'account.recovery_code_used',
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

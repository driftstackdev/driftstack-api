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
 * (signup-verification, password-reset, billing-failure)
 * are never opt-outable; they're absent from this enum on purpose so
 * the API surface matches the policy. (S44 2026-07-07 deleted the
 * never-wired subscription-cancellation + support-ack templates
 * outright.)
 */
export const OptOutableEmailEventSchema = z.enum([
  'signup-welcome',
  'session-failed-first',
  // V-304a — first successful session activation milestone email.
  'session-success-first',
  'tier-changed',
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
/**
 * V-298a — slug shape: lowercase a-z + 0-9 + hyphen, no leading or
 * trailing hyphen, no consecutive hyphens, 3-32 chars total. Mirrors
 * the standard "URL-safe handle" pattern (GitHub usernames, Stripe
 * account ids). Server-side normalisation is deliberately strict: we
 * reject mixed case rather than silently lowercase so customers
 * don't get surprised by what they typed vs what's stored.
 */
export const AccountSlugSchema = z
  .string()
  .min(3)
  .max(32)
  .regex(
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
    'Must be 3-32 chars, lowercase a-z + 0-9 + hyphen, with no leading/trailing hyphen.',
  )
  .refine((s) => !s.includes('--'), {
    message: 'Slug cannot contain consecutive hyphens.',
  });
export type AccountSlug = z.infer<typeof AccountSlugSchema>;

/**
 * V-298b — Stripe-style data-residency region preference. 'us' /
 * 'eu' / 'apac'. Customer-stated; informational. Actual physical
 * region routing of compute / storage is governed by the DPA Annex 3
 * sub-processor list, not this field.
 */
export const AccountRegionSchema = z.enum(['us', 'eu', 'apac']);
export type AccountRegion = z.infer<typeof AccountRegionSchema>;

/**
 * True iff `tz` is a real IANA time-zone name. `Intl.DateTimeFormat` throws a
 * RangeError on an unknown zone, so this is the authoritative check. Replaces
 * an earlier `/^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+$/` regex that was wrong in BOTH
 * directions: it rejected valid single-segment zones ("UTC" / "GMT" / "Japan" /
 * "Singapore") AND accepted non-zones that merely looked like "Area/City"
 * ("Foo/Bar"). Available in every consuming runtime (Node + browsers).
 */
function isValidIanaTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const UpdateAccountMeRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120).nullable().optional(),
    timezone: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .refine(isValidIanaTimeZone, {
        message: 'Must be a valid IANA timezone name like "Europe/Amsterdam" or "UTC".',
      })
      .nullable()
      .optional(),
    // V-298a — readable account handle. Pass null to clear; pass a
    // valid slug to set. Unique-when-set; the server returns 409 if
    // another account already owns the value.
    slug: AccountSlugSchema.nullable().optional(),
    // V-298b — data-residency region preference. Null clears.
    region: AccountRegionSchema.nullable().optional(),
  })
  .refine(
    (v) =>
      v.name !== undefined ||
      v.timezone !== undefined ||
      v.slug !== undefined ||
      v.region !== undefined,
    {
      message: 'At least one field (name, timezone, slug, or region) must be provided.',
    },
  );
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
  // V-355 — a dashboard web session (sign-in) was revoked, either a single
  // device or "sign out everywhere except current". Security-relevant.
  'account.web_session_revoked',
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
  // L4b recycle bin — fires when a trashed profile is restored (deletedAt
  // cleared) via POST /v1/profiles/:id/restore.
  'profile.restored',
  // Anti-abuse — fires when a trashed profile is permanently deleted by the
  // user via DELETE /v1/profiles/:id/purge (frees a cap slot immediately).
  'profile.purged',
  // V-480 — profile import/export. exported fires on GET ../export
  // (read-side audit trail for "who pulled what out"); imported fires
  // on the POST /v1/profiles/import handler when a new profile is
  // minted from an envelope. Both carry the source profile id +
  // source account id from the envelope so customers can reconstruct
  // file-flow lineage post-hoc.
  'profile.exported',
  'profile.imported',
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
  'team.updated',
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
  // v2-#5 Q.1.f — per-turn AI agent layer decompose() events.
  // Operator-only surface: the customer sees the chat plan/refuse/
  // clarify in their dashboard, but the audit trail captures WHICH
  // decomposer (claude vs deterministic), token counts + cost cents
  // (Claude), and the decomposer's result-kind discriminant. Founder
  // verdict Q.1.f 2026-05-17 — audit log emission only; no separate
  // operator UI surface at v1.0.
  'agent.decompose.claude',
  'agent.decompose.deterministic',
  // Arc 4 Wave 2.B sub-slice 8.20 (v2-#8) — pair-mode lifecycle.
  // Each emission carries payload {from, to, client_id?} so the
  // customer audit log surfaces the full state-machine history.
  // 'timeout' fires when the heartbeat-timeout sweep (8.13) auto-
  // handbacks to ai-driving.
  'agent_session.pair_mode.takeover',
  'agent_session.pair_mode.handback',
  'agent_session.pair_mode.timeout',
  // Slice 6 follow-up 2026-05-20 — Slice 3 setMode also lands a
  // customer audit row (manual ↔ ai ↔ pair switches). Payload
  // carries {from, to}; ai→manual / pair→ai is most relevant for
  // incident-investigation queries.
  'agent_session.mode.changed',
  // Slice 6 follow-up 2026-05-20 — agent-session lifecycle (create
  // + destroy). Distinct from session.created / session.destroyed
  // (those audit the underlying driver session). Customers need
  // the agent-layer audit trail to reconstruct "which agent session
  // ran what work" for billing dispute / incident investigation.
  // Payload: created carries {agent_session_id, initial_mode}; destroyed
  // carries {agent_session_id, reason} where reason is the
  // closeWithReason discriminator ('customer-closed' on this route).
  'agent_session.created',
  'agent_session.destroyed',
  // 2026-05-20 — BYOK Anthropic key-management lifecycle (pre-launch
  // blocker per audit-log-coverage audit 2026-05-19). Customer needs
  // to audit who set/cleared/tested their Anthropic credential —
  // it's a customer-controlled secret + a billing-impacting decision.
  // Per Q2 verdict 2026-05-17 the payload carries account_id +
  // timestamp + event kind ONLY; NO key-prefix fingerprint (the
  // plaintext is never persisted beyond the encrypted cipherblob and
  // the audit log must NOT leak any prefix that would help a database
  // reader correlate keys to accounts).
  'account.byok_anthropic_key_set',
  'account.byok_anthropic_key_cleared',
  'account.byok_anthropic_key_tested',
  // 2026-05-20 — saved-proxy lifecycle (pre-launch blocker per
  // audit-log-coverage audit 2026-05-19). Customer needs to audit
  // every proxy config minted under their account — especially for
  // shared-team-RBAC sessions where any admin can mint. Payload
  // carries proxy_id + label + type ('socks5' | 'openvpn' |
  // 'wireguard'); NEVER the secret material (password / private key
  // / .ovpn config). Enum values land NOW so the emit point is ready
  // when EG-API-1.6 wires the storage backend.
  'proxy.created',
  'proxy.updated',
  'proxy.deleted',
  // 2026-05-20 — bundled-LLM consent toggle (audit-coverage Tier 2
  // polish per audit doc 2026-05-19). Customer's consent state is
  // the trigger for switching billing rails between BYOK-required
  // and deployment-fallback. Auditable should be default for any
  // consent change.
  'account.bundled_llm_consent_changed',
  // 2026-05-20 — email-preferences toggle (last Tier 2 polish item
  // from the 2026-05-19 audit-coverage doc; "marginal" classification
  // but trivial to add). Customer-controlled mutation on the
  // opt-in/out flag for each transactional email category. Payload
  // carries event_type + opted_in for post-hoc reconstruction.
  'account.email_preferences_changed',
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
  // Slice 149 — defensive cap matching slice 117/146/147/148 cursor
  // convention; see PaginationQuerySchema in common.ts for the same
  // shape + rationale (512 covers any base64url-encoded pagination
  // token plus headroom).
  cursor: z.string().min(1).max(512).optional(),
  action: AccountAuditActionSchema.optional(),
  // V-484 — additional filters. ISO 8601 dates for from/to (inclusive).
  // Coerced from query strings; Zod's coerce.date() handles
  // YYYY-MM-DD and full ISO 8601 timestamps.
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  actor_type: AccountAuditActorTypeSchema.optional(),
  target_resource_id: z.string().min(1).max(200).optional(),
});
export type ListAccountAuditLogQuery = z.infer<typeof ListAccountAuditLogQuerySchema>;

export const ListAccountAuditLogResponseSchema = z.object({
  data: z.array(AccountAuditEntrySchema),
  next_cursor: z.string().nullable(),
});
export type ListAccountAuditLogResponse = z.infer<typeof ListAccountAuditLogResponseSchema>;

// V-297 — bulk export envelope for GDPR Article 20 portability.
// `format=json` returns this shape; `format=csv` returns text/csv
// (not surfaced through the typed SDK methods — customers wanting
// CSV download in a browser hit the endpoint directly).
export const ExportAccountAuditLogQuerySchema = z.object({
  format: z.enum(['csv', 'json']).optional().default('json'),
});
export type ExportAccountAuditLogQuery = z.infer<typeof ExportAccountAuditLogQuerySchema>;

export const ExportAccountAuditLogResponseSchema = z.object({
  generated_at: Iso8601Schema,
  account_id: z.string(),
  row_count: z.number().int().nonnegative(),
  /** True when the row count hit the 10,000-row server-side ceiling
   *  and older entries were not included. Customers needing the full
   *  history should narrow the date window or use the paginated
   *  /v1/account/audit-log read endpoint. */
  truncated: z.boolean(),
  data: z.array(AccountAuditEntrySchema),
});
export type ExportAccountAuditLogResponse = z.infer<typeof ExportAccountAuditLogResponseSchema>;

// ───────────────────────────────────────────────────────────────────────────
// V-219 — customer-facing rate-limit view
// ───────────────────────────────────────────────────────────────────────────

export const RateLimitBucketSchema = z.object({
  // The customer-read response surface — GET /v1/account/rate-limits
  // returns ALL four enforced buckets (routes/account-rate-limits.ts
  // mirrors TIER_RATE_LIMIT_DEFAULTS so the customer view never hides a
  // limit that's actually applied), including agent_sessions:input_event.
  // NB: the admin write surface (admin.ts SetQuotaOverride/ClearQuotaOverride)
  // stays the 3 override-able keys — input_event has no admin-override path.
  bucket_key: z.enum([
    'global',
    'sessions:create',
    'agent_sessions:message',
    'agent_sessions:input_event',
  ]),
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

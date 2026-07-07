// W436.B — drift guard for packages/api-types/src/accounts.ts.
// V-204 email-preferences + V-216 customer audit log + V-237 PATCH
// /v1/account/me + V-298a slug + V-298b region + V-352b avatar +
// V-353b MFA + V-484/V-297 audit filters/export + V-219 customer
// rate-limit view. Drift here either (a) accidentally adds a
// security/financial email (signup-verify, password-reset, billing-
// failure) to the opt-outable
// enum — customer disables critical comms; or (b) bumps avatar cap
// past Fastify default JSON body limit silently.
//
//   • Account shape (7-field): id + email + name nullable + tier +
//     status + created/updated_at.
//   • AccountStatus enum: active|suspended|deleted.
//   • V-204 OptOutableEmailEvent enum (7 values; signup-welcome /
//     session-first-fail-success / tier-changed / trial-pack-bought-
//     expired / billing-receipt-renewal) + framing pinned that
//     security/financial emails are deliberately absent.
//   • V-352 UpdateAccountMe + V-298a slug + V-298b region.
//   • V-352b avatar upload (2 MiB cap + 3 content-types).
//   • V-353b MFA enrollment + verify + recovery codes (10).
//   • V-216 AccountAuditAction enum (25 values) + V-484 filter set
//     (action + actor_type + from/to + target_resource_id).
//   • V-297 GDPR Article 20 export envelope.
//   • V-219 RateLimitBucket + GetAccountRateLimits response.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/api-types/src/accounts.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W436.B packages/api-types/src/accounts.ts content parity', () => {
  const body = read(LIB);

  it("imports: z + AccountIdSchema/AccountTierSchema/Iso8601Schema from './common.js'", () => {
    expect(body).toMatch(/import \{ z \} from 'zod';/);
    expect(body).toMatch(
      /import \{ AccountIdSchema, AccountTierSchema, Iso8601Schema \} from '\.\/common\.js';/,
    );
  });

  it('AccountStatus enum (active|suspended|deleted) + AccountSchema 7-field shape (id + email + name nullable + tier + status + 2 timestamps)', () => {
    expect(body).toMatch(
      /export const AccountStatusSchema = z\.enum\(\['active', 'suspended', 'deleted'\]\);/,
    );
    expect(body).toMatch(
      /export const AccountSchema = z\.object\(\{\s*\n?\s*id: AccountIdSchema,\s*\n?\s*email: z\.string\(\)\.email\(\),\s*\n?\s*name: z\.string\(\)\.nullable\(\),\s*\n?\s*tier: AccountTierSchema,\s*\n?\s*status: AccountStatusSchema,\s*\n?\s*created_at: Iso8601Schema,\s*\n?\s*updated_at: Iso8601Schema,\s*\n?\s*\}\);/,
    );
  });

  it('V-204 OptOutableEmailEvent framing pinned: security + financial emails (signup-verification / password-reset / billing-failure) NEVER opt-outable — absent on purpose so API surface matches policy. (S44 2026-07-07 founder-approved trim deleted the never-wired subscription-cancellation + support-ack templates from the roster.)', () => {
    expect(body).toMatch(/\/\/ V-204 — email notification preferences/);
    expect(body).toMatch(
      /\*\s*Event types the customer can opt out of\. Security \+ financial emails\s*\n?\s*\*\s*\(signup-verification, password-reset, billing-failure\)\s*\n?\s*\*\s*are never opt-outable; they're absent from this enum on purpose so\s*\n?\s*\*\s*the API surface matches the policy\./,
    );
    expect(body).toMatch(
      /S44 2026-07-07 deleted the\s*\n?\s*\*\s*never-wired subscription-cancellation \+ support-ack templates\s*\n?\s*\*\s*outright\./,
    );
  });

  it('OptOutableEmailEvent enum: 6 values pinned (signup-welcome / session-failed-first / V-304a session-success-first / tier-changed / billing-receipt / V-304b billing-renewal-reminder Stripe invoice.upcoming). Discrete pins (no long \\s* chain) per the catastrophic-backtracking lesson.', () => {
    expect(body).toMatch(/export const OptOutableEmailEventSchema = z\.enum\(\[/);
    expect(body).toMatch(/'signup-welcome',/);
    expect(body).toMatch(/'session-failed-first',/);
    expect(body).toMatch(/\/\/ V-304a — first successful session activation milestone email\./);
    expect(body).toMatch(/'session-success-first',/);
    expect(body).toMatch(/'tier-changed',/);
    expect(body).toMatch(/'billing-receipt',/);
    expect(body).toMatch(/\/\/ V-304b — 7-days-before-renewal reminder\. Driven by Stripe/);
    expect(body).toMatch(/'billing-renewal-reminder',/);
    // Trial-pack values removed with the dead trial_pack lifecycle.
    expect(body).not.toMatch(/'trial-pack-purchased'/);
    expect(body).not.toMatch(/'trial-pack-expired'/);
    expect(body).toMatch(
      /export const EmailPreferenceSchema = z\.object\(\{\s*\n?\s*event_type: OptOutableEmailEventSchema,\s*\n?\s*opted_in: z\.boolean\(\),\s*\n?\s*\}\);/,
    );
  });

  it('V-352 UpdateAccountMe framing + V-298a slug regex (3..32 lowercase a-z+0-9+hyphen no leading/trailing/consecutive) + V-298b region enum us|eu|apac; UpdateAccountMeRequest at-least-one-field refine + IANA timezone Intl-validity refine (2026-06-03: replaced a regex that wrongly rejected single-segment zones like UTC/GMT/Japan AND wrongly accepted non-zones like Foo/Bar)', () => {
    expect(body).toMatch(
      /\*\s*V-352 — partial update of self-editable basics\. At least one\s*\n?\s*\*\s*field must be provided\. `name` may be set to null to clear; the\s*\n?\s*\*\s*email-display fallback uses the email address\. `timezone` accepts\s*\n?\s*\*\s*an IANA name \(e\.g\. `Europe\/Amsterdam`\) or null to clear \(UTC fallback\)\./,
    );
    expect(body).toMatch(
      /\*\s*V-298a — slug shape: lowercase a-z \+ 0-9 \+ hyphen, no leading or\s*\n?\s*\*\s*trailing hyphen, no consecutive hyphens, 3-32 chars total\./,
    );
    expect(body).toMatch(
      /export const AccountSlugSchema = z\s*\n?\s*\.string\(\)\s*\n?\s*\.min\(3\)\s*\n?\s*\.max\(32\)\s*\n?\s*\.regex\(\s*\n?\s*\/\^\[a-z0-9\]\(\?:\[a-z0-9-\]\*\[a-z0-9\]\)\?\$\/,\s*\n?\s*'Must be 3-32 chars, lowercase a-z \+ 0-9 \+ hyphen, with no leading\/trailing hyphen\.',\s*\n?\s*\)\s*\n?\s*\.refine\(\(s\) => !s\.includes\('--'\), \{\s*\n?\s*message: 'Slug cannot contain consecutive hyphens\.',\s*\n?\s*\}\);/,
    );
    expect(body).toMatch(
      /\*\s*V-298b — Stripe-style data-residency region preference\. 'us' \/\s*\n?\s*\*\s*'eu' \/ 'apac'\. Customer-stated; informational\. Actual physical\s*\n?\s*\*\s*region routing of compute \/ storage is governed by the DPA Annex 3\s*\n?\s*\*\s*sub-processor list, not this field\./,
    );
    expect(body).toMatch(/export const AccountRegionSchema = z\.enum\(\['us', 'eu', 'apac'\]\);/);
    expect(body).toMatch(
      /timezone: z\s*\n?\s*\.string\(\)\s*\n?\s*\.trim\(\)\s*\n?\s*\.min\(1\)\s*\n?\s*\.max\(64\)\s*\n?\s*\.refine\(isValidIanaTimeZone, \{\s*\n?\s*message: 'Must be a valid IANA timezone name like "Europe\/Amsterdam" or "UTC"\.',\s*\n?\s*\}\)/,
    );
    // The IANA validity check MUST stay Intl-based (a regex can't correctly
    // accept single-segment zones like UTC/GMT/Japan nor reject non-zones
    // like Foo/Bar). Pin the helper + its Intl.DateTimeFormat impl.
    expect(body).toMatch(
      /function isValidIanaTimeZone\(tz: string\): boolean \{\s*\n?\s*try \{\s*\n?\s*new Intl\.DateTimeFormat\('en-US', \{ timeZone: tz \}\);\s*\n?\s*return true;\s*\n?\s*\} catch \{\s*\n?\s*return false;\s*\n?\s*\}\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /message: 'At least one field \(name, timezone, slug, or region\) must be provided\.',/,
    );
  });

  it('V-352b avatar upload framing pinned: 2 MiB cap + base64 inline + 3 content-types + R2 public-snapshot bucket + V-294 disclosure scope updated atomically; AVATAR_MAX_BYTES + AVATAR_ALLOWED_CONTENT_TYPES + UploadAvatarRequest base64 size cap (Math.ceil((MAX*4)/3)+4)', () => {
    expect(body).toMatch(
      /\*\s*V-352b — customer-uploaded avatar\. The image is sent inline as\s*\n?\s*\*\s*base64 \(no multipart on this control plane\)\. Storage backend is\s*\n?\s*\*\s*the existing R2 public-snapshot bucket \(already disclosed as a\s*\n?\s*\*\s*sub-processor for status-page snapshots; per V-294 the disclosure\s*\n?\s*\*\s*scope is updated atomically with this slice to also cover avatars\)\./,
    );
    expect(body).toMatch(
      /\*\s*Cap: 2 MiB raw bytes\. The base64 wire size is ~33% larger; the\s*\n?\s*\*\s*base64 string is bounded at ~2\.8 MiB to keep the request body\s*\n?\s*\*\s*inside Fastify's default JSON body limit\./,
    );
    expect(body).toMatch(/export const AVATAR_MAX_BYTES = 2 \* 1024 \* 1024;/);
    expect(body).toMatch(
      /export const AVATAR_ALLOWED_CONTENT_TYPES = \['image\/png', 'image\/jpeg', 'image\/webp'\] as const;/,
    );
    expect(body).toMatch(
      /export const UploadAvatarRequestSchema = z\.object\(\{\s*\n?\s*content_type: AvatarContentTypeSchema,\s*\n?\s*data_base64: z\s*\n?\s*\.string\(\)\s*\n?\s*\.min\(4\)\s*\n?\s*\.max\(Math\.ceil\(\(AVATAR_MAX_BYTES \* 4\) \/ 3\) \+ 4\)\s*\n?\s*\.regex\(\/\^\[A-Za-z0-9\+\/=\]\+\$\/, 'Must be base64-encoded\.'\),\s*\n?\s*\}\);/,
    );
  });

  it('V-353b MFA enrollment: status (enrolled + 2 nullable timestamps + unused_recovery_codes nonneg) + start (otpauth + secret_base32 + SHA1 + 6 digits + 30s period literals) + complete (6-digit code regex; response 10 recovery codes) + regenerate recovery codes (10)', () => {
    expect(body).toMatch(
      /export const MfaStatusResponseSchema = z\.object\(\{\s*\n?\s*enrolled: z\.boolean\(\),\s*\n?\s*enrolled_at: Iso8601Schema\.nullable\(\),\s*\n?\s*last_used_at: Iso8601Schema\.nullable\(\),\s*\n?\s*unused_recovery_codes: z\.number\(\)\.int\(\)\.nonnegative\(\),\s*\n?\s*\}\);/,
    );
    expect(body).toMatch(
      /export const StartMfaEnrollmentResponseSchema = z\.object\(\{\s*\n?\s*otpauth_uri: z\.string\(\)\.describe\('otpauth:\/\/ URI; render as a QR code'\),\s*\n?\s*secret_base32: z\.string\(\)\.describe\('Manual-entry secret for auth apps that do not scan QR'\),\s*\n?\s*algorithm: z\.literal\('SHA1'\),\s*\n?\s*digits: z\.literal\(6\),\s*\n?\s*period_seconds: z\.literal\(30\),\s*\n?\s*\}\);/,
    );
    expect(body).toMatch(
      /export const CompleteMfaEnrollmentRequestSchema = z\.object\(\{\s*\n?\s*code: z\.string\(\)\.regex\(\/\^\\d\{6\}\$\/, 'Must be a 6-digit code\.'\),\s*\n?\s*\}\);/,
    );
    expect(body).toMatch(
      /export const CompleteMfaEnrollmentResponseSchema = z\.object\(\{\s*\n?\s*recovery_codes: z\.array\(z\.string\(\)\)\.length\(10\),\s*\n?\s*\}\);/,
    );
    expect(body).toMatch(
      /export const RegenerateMfaRecoveryCodesResponseSchema = z\.object\(\{\s*\n?\s*recovery_codes: z\.array\(z\.string\(\)\)\.length\(10\),\s*\n?\s*\}\);/,
    );
  });

  it('V-216 AccountAuditAction enum framing pinned: closed enum of customer-visible actions; adding new event type is Class A schema migration (additive enum value)', () => {
    expect(body).toMatch(
      /\*\s*Closed enum of customer-visible audit actions\. Adding a new event\s*\n?\s*\*\s*type is a Class A schema migration \(additive enum value\)\./,
    );
  });

  it('V-216 AccountAuditAction key values pinned: account 4-event base + api_key (mint/revoke + V-296 rotate 24h grace) + sessions (created/destroyed) + profiles (created/deleted + V-480 exported/imported source-account+profile lineage) + subscription.tier_changed + webhook_endpoint (CRUD + V-359 secret_rotated) + V-307 webhook_delivery.replayed + V-298f Team RBAC v1 (member_invited/invite_accepted/member_removed) + V-353b MFA lifecycle (mfa_enrolled on first verify / mfa_disabled / recovery_code_used) + V-281 admin (refund_recorded + support_note)', () => {
    expect(body).toMatch(
      /\/\/ V-296 — customer self-service rotation; old key continues for grace\s*\n?\s*\/\/ period \(24h\), new key shown once\. Audit captures both ids for\s*\n?\s*\/\/ post-hoc reconstruction\./,
    );
    expect(body).toMatch(
      /\/\/ V-480 — profile import\/export\. exported fires on GET \.\.\/export\s*\n?\s*\/\/ \(read-side audit trail for "who pulled what out"\); imported fires\s*\n?\s*\/\/ on the POST \/v1\/profiles\/import handler when a new profile is\s*\n?\s*\/\/ minted from an envelope\. Both carry the source profile id \+\s*\n?\s*\/\/ source account id from the envelope so customers can reconstruct\s*\n?\s*\/\/ file-flow lineage post-hoc\./,
    );
    expect(body).toMatch(
      /\/\/ V-359 — signing secret rotation\. Payload: new_secret_prefix,\s*\n?\s*\/\/ old_secret_prefix, grace_expires_at \(24h default\)\./,
    );
    expect(body).toMatch(/'webhook_endpoint\.secret_rotated',/);
    expect(body).toMatch(/\/\/ V-307 — customer self-service replay of a webhook delivery\./);
    expect(body).toMatch(/'webhook_delivery\.replayed',/);
    expect(body).toMatch(
      /\/\/ V-298f — Team RBAC v1 customer audit entries\.\s*\n?\s*'team\.member_invited',\s*\n?\s*'team\.invite_accepted',\s*\n?\s*'team\.member_removed',/,
    );
    expect(body).toMatch(
      /\/\/ V-353b — MFA lifecycle\. mfa_enrolled fires on successful first\s*\n?\s*\/\/ verify \(not on \/enroll, which is reversible\)\./,
    );
    expect(body).toMatch(
      /'account\.mfa_enrolled',\s*\n?\s*'account\.mfa_disabled',\s*\n?\s*'account\.recovery_code_used',/,
    );
    expect(body).toMatch(
      /\/\/ V-281 — admin-recorded notes\. Refund recording is audit-only;\s*\n?\s*\/\/ actual money movement happens via Stripe dashboard manually per\s*\n?\s*\/\/ the V-280 launch-day runbook\. Support notes are free-form\s*\n?\s*\/\/ operator notes attached to a customer account for post-incident\s*\n?\s*\/\/ \/ context-passing visibility\./,
    );
    expect(body).toMatch(/'admin\.refund_recorded',\s*\n?\s*'admin\.support_note',/);
  });

  it('AccountAuditActorType (customer|system|staff) + AccountAuditEntry shape: id uuid + account_id + actor_type + actor_account_id/key_id nullable + action + target_resource_id nullable + payload record nullable + ip_address nullable + user_agent nullable + timestamp', () => {
    expect(body).toMatch(
      /export const AccountAuditActorTypeSchema = z\.enum\(\['customer', 'system', 'staff'\]\);/,
    );
    expect(body).toMatch(
      /export const AccountAuditEntrySchema = z\.object\(\{\s*\n?\s*id: z\.string\(\)\.uuid\(\),\s*\n?\s*account_id: z\.string\(\),\s*\n?\s*actor_type: AccountAuditActorTypeSchema,\s*\n?\s*actor_account_id: z\.string\(\)\.nullable\(\),\s*\n?\s*actor_key_id: z\.string\(\)\.nullable\(\),\s*\n?\s*action: AccountAuditActionSchema,\s*\n?\s*target_resource_id: z\.string\(\)\.nullable\(\),\s*\n?\s*payload: z\.record\(z\.unknown\(\)\)\.nullable\(\),\s*\n?\s*ip_address: z\.string\(\)\.nullable\(\),\s*\n?\s*user_agent: z\.string\(\)\.nullable\(\),\s*\n?\s*timestamp: Iso8601Schema,\s*\n?\s*\}\);/,
    );
  });

  it('V-484 ListAccountAuditLogQuery: limit + cursor + action + from/to coerce.date (handles YYYY-MM-DD + full ISO) + actor_type + target_resource_id 1..200', () => {
    expect(body).toMatch(
      /\/\/ V-484 — additional filters\. ISO 8601 dates for from\/to \(inclusive\)\.\s*\n?\s*\/\/ Coerced from query strings; Zod's coerce\.date\(\) handles\s*\n?\s*\/\/ YYYY-MM-DD and full ISO 8601 timestamps\./,
    );
    // Slice 149 added `.min(1).max(512)` to cursor (same defensive
    // cap pattern as PaginationQuerySchema in common.ts).
    expect(body).toMatch(
      /export const ListAccountAuditLogQuerySchema = z\.object\(\{\s*\n?\s*limit: z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.max\(100\)\.optional\(\)\.default\(50\),\s*\n?\s*\/\/ Slice 149[\s\S]*?cursor: z\.string\(\)\.min\(1\)\.max\(512\)\.optional\(\),\s*\n?\s*action: AccountAuditActionSchema\.optional\(\),/,
    );
    expect(body).toMatch(
      /from: z\.coerce\.date\(\)\.optional\(\),\s*\n?\s*to: z\.coerce\.date\(\)\.optional\(\),/,
    );
    expect(body).toMatch(/actor_type: AccountAuditActorTypeSchema\.optional\(\),/);
    expect(body).toMatch(/target_resource_id: z\.string\(\)\.min\(1\)\.max\(200\)\.optional\(\),/);
    expect(body).toMatch(
      /export const ListAccountAuditLogResponseSchema = z\.object\(\{\s*\n?\s*data: z\.array\(AccountAuditEntrySchema\),\s*\n?\s*next_cursor: z\.string\(\)\.nullable\(\),\s*\n?\s*\}\);/,
    );
  });

  it('V-297 GDPR Article 20 portability framing pinned: format=json returns shape / format=csv text/csv not surfaced through typed SDK methods (browsers hit directly); 10,000-row truncated ceiling; export query default json; export response generated_at + account_id + row_count + truncated + data', () => {
    expect(body).toMatch(
      /\/\/ V-297 — bulk export envelope for GDPR Article 20 portability\.\s*\n?\s*\/\/ `format=json` returns this shape; `format=csv` returns text\/csv\s*\n?\s*\/\/ \(not surfaced through the typed SDK methods — customers wanting\s*\n?\s*\/\/ CSV download in a browser hit the endpoint directly\)\./,
    );
    expect(body).toMatch(
      /export const ExportAccountAuditLogQuerySchema = z\.object\(\{\s*\n?\s*format: z\.enum\(\['csv', 'json'\]\)\.optional\(\)\.default\('json'\),\s*\n?\s*\}\);/,
    );
    expect(body).toMatch(
      /\/\*\* True when the row count hit the 10,000-row server-side ceiling\s*\n?\s*\*\s*and older entries were not included\. Customers needing the full\s*\n?\s*\*\s*history should narrow the date window or use the paginated\s*\n?\s*\*\s*\/v1\/account\/audit-log read endpoint\. \*\//,
    );
    expect(body).toMatch(
      /export const ExportAccountAuditLogResponseSchema = z\.object\(\{\s*\n?\s*generated_at: Iso8601Schema,\s*\n?\s*account_id: z\.string\(\),\s*\n?\s*row_count: z\.number\(\)\.int\(\)\.nonnegative\(\),/,
    );
    expect(body).toMatch(
      /truncated: z\.boolean\(\),\s*\n?\s*data: z\.array\(AccountAuditEntrySchema\),\s*\n?\s*\}\);/,
    );
  });

  it('V-219 RateLimitBucket: bucket_key enum (global|sessions:create|agent_sessions:message|agent_sessions:input_event — the customer-read GET /v1/account/rate-limits returns all four) + capacity positive int + refill_per_second positive + source enum (tier_default|override) + override_expires_at nullable; GetAccountRateLimitsResponse: tier + buckets', () => {
    expect(body).toMatch(/\/\/ V-219 — customer-facing rate-limit view/);
    expect(body).toMatch(
      /export const RateLimitBucketSchema = z\.object\(\{[\s\S]*?bucket_key: z\.enum\(\[\s*\n?\s*'global',\s*\n?\s*'sessions:create',\s*\n?\s*'agent_sessions:message',\s*\n?\s*'agent_sessions:input_event',\s*\n?\s*\]\),\s*\n?\s*capacity: z\.number\(\)\.int\(\)\.positive\(\),\s*\n?\s*refill_per_second: z\.number\(\)\.positive\(\),/,
    );
    expect(body).toMatch(
      /\*\s*`'tier_default'` when the value comes from the locked tier table;\s*\n?\s*\*\s*`'override'` when an admin-set override is currently in effect\./,
    );
    expect(body).toMatch(/source: z\.enum\(\['tier_default', 'override'\]\),/);
    expect(body).toMatch(
      /export const GetAccountRateLimitsResponseSchema = z\.object\(\{\s*\n?\s*tier: AccountTierSchema,\s*\n?\s*buckets: z\.array\(RateLimitBucketSchema\),\s*\n?\s*\}\);/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});

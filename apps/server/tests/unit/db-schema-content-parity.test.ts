// W616 — drift guard for apps/server/src/db/schema.ts (1494 lines).
// The Drizzle schema backbone of every persisted resource. Single
// source of truth for Postgres tables + enums + Row/NewRow types.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/db/schema.ts');

const body = readFileSync(LIB, 'utf8');

describe('W616 apps/server/src/db/schema.ts content parity', () => {
  it('drizzle-orm + drizzle-orm/pg-core imports + pg-core type list (bigint + boolean + index + integer + jsonb + pgEnum + pgTable + primaryKey + text + timestamp + uniqueIndex + uuid) pinned', () => {
    expect(body).toMatch(/^import \{ isNull, sql \} from 'drizzle-orm';$/m);
    expect(body).toMatch(/^import \{$/m);
    expect(body).toMatch(/^\s+bigint,$/m);
    expect(body).toMatch(/^\s+boolean,$/m);
    expect(body).toMatch(/^\s+index,$/m);
    expect(body).toMatch(/^\s+integer,$/m);
    expect(body).toMatch(/^\s+jsonb,$/m);
    expect(body).toMatch(/^\s+pgEnum,$/m);
    expect(body).toMatch(/^\s+pgTable,$/m);
    expect(body).toMatch(/^\s+primaryKey,$/m);
    expect(body).toMatch(/^\s+text,$/m);
    expect(body).toMatch(/^\s+timestamp,$/m);
    expect(body).toMatch(/^\s+uniqueIndex,$/m);
    expect(body).toMatch(/^\s+uuid,$/m);
    expect(body).toMatch(/^\} from 'drizzle-orm\/pg-core';$/m);
  });

  it('8 account/auth/usage/admin pgEnums (account_tier 8-value with free + 3 manual + 3 api + enterprise / account_status 3 / account_region 3 / api_key_scope V-174+V-481 / session_status 5 / session_purpose V-169 3 / session_event_type 9 / usage_record_type 6) pinned', () => {
    expect(body).toMatch(/export const accountTier = pgEnum\('account_tier', \[/);
    expect(body).toMatch(/'free',/);
    expect(body).toMatch(/'solo_manual',/);
    expect(body).toMatch(/'team_manual',/);
    expect(body).toMatch(/'agency_manual',/);
    expect(body).toMatch(/'api_starter',/);
    expect(body).toMatch(/'api_builder',/);
    expect(body).toMatch(/'api_scale',/);
    expect(body).toMatch(/'enterprise',/);
    expect(body).toMatch(
      /export const accountStatus = pgEnum\('account_status', \['active', 'suspended', 'deleted'\]\);/,
    );
    expect(body).toMatch(
      /export const accountRegion = pgEnum\('account_region', \['us', 'eu', 'apac'\]\);/,
    );
    expect(body).toMatch(/export const apiKeyScope = pgEnum\('api_key_scope', \[/);
    expect(body).toMatch(/'admin', \/\/ V-174 compat alias; deprecated after migration window\./);
    expect(body).toMatch(/'account_owner', \/\/ V-174 customer-account control\./);
    expect(body).toMatch(/'driftstack_internal_admin', \/\/ V-174 Driftstack-staff-only\./);
    expect(body).toMatch(/'gui_control',/);
    expect(body).toMatch(/\/\/ V-481 — granular per-resource scopes\./);
    expect(body).toMatch(/'read:sessions',/);
    expect(body).toMatch(/'write:sessions',/);
    expect(body).toMatch(/'admin:billing',/);
    expect(body).toMatch(/'read:audit',/);
    expect(body).toMatch(/export const sessionStatus = pgEnum\('session_status', \[/);
    expect(body).toMatch(/^\s+'creating',$/m);
    expect(body).toMatch(/^\s+'ready',$/m);
    expect(body).toMatch(/^\s+'busy',$/m);
    expect(body).toMatch(/^\s+'destroyed',$/m);
    expect(body).toMatch(/^\s+'errored',$/m);
    expect(body).toMatch(/\/\/ V-169 — sessions\.purpose drives WebKit driver harness selection\./);
    expect(body).toMatch(/export const sessionPurpose = pgEnum\('session_purpose', \[/);
    expect(body).toMatch(/'production_customer',/);
    expect(body).toMatch(/'cumulative_rig_validation',/);
    expect(body).toMatch(/'test_domain_probe',/);
    expect(body).toMatch(/export const sessionEventType = pgEnum\('session_event_type', \[/);
    expect(body).toMatch(/'navigated',/);
    expect(body).toMatch(/'interacted',/);
    expect(body).toMatch(/'gui_input',/);
    expect(body).toMatch(/'state_captured',/);
    expect(body).toMatch(/'screenshot_captured',/);
    expect(body).toMatch(/export const usageRecordType = pgEnum\('usage_record_type', \[/);
    expect(body).toMatch(/'session_minute',/);
    expect(body).toMatch(/'navigate',/);
    expect(body).toMatch(/'state_capture',/);
    expect(body).toMatch(/'screenshot_capture',/);
  });

  it('webhook/admin/subscription/incident/team pgEnums (webhook_event_type with test.ping V-356 + webhook_delivery_status 5 + admin_audit_action D-025 closed enum w/ V-100/281/295a/c3 actions + subscription_status + incident_severity 3 + incident_status 4 + team_role 2) pinned', () => {
    expect(body).toMatch(/export const webhookEventType = pgEnum\('webhook_event_type', \[/);
    expect(body).toMatch(/'session\.completed',/);
    expect(body).toMatch(/'session\.failed',/);
    expect(body).toMatch(/'quota\.warning_80pct',/);
    expect(body).toMatch(/'quota\.exceeded',/);
    expect(body).toMatch(/'api_key\.revoked',/);
    expect(body).toMatch(
      /\/\/ V-356 — synthetic event sent only via POST \/v1\/webhooks\/:id\/test\./,
    );
    expect(body).toMatch(/'test\.ping',/);
    expect(body).toMatch(
      /export const webhookDeliveryStatus = pgEnum\('webhook_delivery_status', \[/,
    );
    expect(body).toMatch(/'pending',/);
    expect(body).toMatch(/'in_flight',/);
    expect(body).toMatch(/'delivered',/);
    expect(body).toMatch(/'failed',/);
    expect(body).toMatch(/'dlq',/);
    expect(body).toMatch(/\/\/ admin_audit_log\.action — closed enum so the schema reflects the/);
    expect(body).toMatch(/\/\/ migration-bearing change\. See D-025\./);
    expect(body).toMatch(/export const adminAuditAction = pgEnum\('admin_audit_action', \[/);
    expect(body).toMatch(/'account\.tier_changed',/);
    expect(body).toMatch(/'account\.suspended',/);
    expect(body).toMatch(/'webhook_delivery\.replayed',/);
    expect(body).toMatch(/'webhook_delivery\.requeued',/);
    expect(body).toMatch(/'rate_limit_override\.set',/);
    expect(body).toMatch(/\/\/ V-100: admin force-actions on customer resources\./);
    expect(body).toMatch(/'session\.destroyed_by_admin',/);
    expect(body).toMatch(/'api_key\.revoked_by_admin',/);
    expect(body).toMatch(/\/\/ V-281: customer-support tooling \(audit-only\)\./);
    expect(body).toMatch(/'audit_note\.added',/);
    expect(body).toMatch(/'refund\.recorded',/);
    expect(body).toMatch(/\/\/ V-295a: status-page incident management\./);
    expect(body).toMatch(/'incident\.created',/);
    expect(body).toMatch(/'incident\.updated',/);
    expect(body).toMatch(/'incident\.resolved',/);
    expect(body).toMatch(/\/\/ V-295c3-tombstone: status-page email subscriber admin actions\./);
    expect(body).toMatch(/'status_subscriber\.force_unsubscribed',/);
    expect(body).toMatch(/'status_subscriber\.purged',/);
    expect(body).toMatch(/export const subscriptionStatus = pgEnum\('subscription_status', \[/);
    expect(body).toMatch(
      /export const incidentSeverity = pgEnum\('incident_severity', \['minor', 'major', 'outage'\]\);/,
    );
    expect(body).toMatch(/export const incidentStatus = pgEnum\('incident_status', \[/);
    expect(body).toMatch(/'investigating',/);
    expect(body).toMatch(/'identified',/);
    expect(body).toMatch(/'monitoring',/);
    expect(body).toMatch(/'resolved',/);
    expect(body).toMatch(/export const teamRole = pgEnum\('team_role', \['member', 'admin'\]\);/);
  });

  it('account-lifecycle tables (accounts + email_verify_tokens + magic_link_tokens + password_reset_tokens) + free-tier default + V-352 timezone + V-082 stripe_customer_id + V-298b accountRegion default us + V-202c first_failure_email_sent_at + V-304a first_success_email_sent_at pinned', () => {
    expect(body).toMatch(/export const accounts = pgTable\(\s*\n\s*'accounts',/);
    expect(body).toMatch(/email: text\('email'\)\.notNull\(\),/);
    expect(body).toMatch(/passwordHash: text\('password_hash'\),/);
    expect(body).toMatch(
      /emailVerifiedAt: timestamp\('email_verified_at', \{ withTimezone: true \}\),/,
    );
    expect(body).toMatch(/tier: accountTier\('tier'\)\.notNull\(\)\.default\('free'\),/);
    expect(body).toMatch(/status: accountStatus\('status'\)\.notNull\(\)\.default\('active'\),/);
    expect(body).toMatch(/authEpoch: integer\('auth_epoch'\)\.notNull\(\)\.default\(0\),/);
    expect(body).toMatch(/stripeCustomerId: text\('stripe_customer_id'\),/);
    expect(body).toMatch(
      /firstFailureEmailSentAt: timestamp\('first_failure_email_sent_at', \{ withTimezone: true \}\),/,
    );
    expect(body).toMatch(
      /firstSuccessEmailSentAt: timestamp\('first_success_email_sent_at', \{ withTimezone: true \}\),/,
    );
    expect(body).toMatch(/timezone: text\('timezone'\),/);
    expect(body).toMatch(/export const emailVerifyTokens = pgTable\(/);
    expect(body).toMatch(/export const magicLinkTokens = pgTable\(/);
    expect(body).toMatch(/export const passwordResetTokens = pgTable\(/);
  });

  it('billing + auth + session-data tables (subscriptions + profiles + profile_snapshots + processed_stripe_events + web_sessions + account_mfa + account_mfa_recovery_codes + api_keys + sessions + session_events + usage_records + rate_limit_buckets) pinned', () => {
    expect(body).toMatch(/export const subscriptions = pgTable\(/);
    expect(body).toMatch(/export const profiles = pgTable\(/);
    expect(body).toMatch(/export const profileSnapshots = pgTable\(/);
    expect(body).toMatch(/export const processedStripeEvents = pgTable\(/);
    expect(body).toMatch(/export const webSessions = pgTable\(/);
    expect(body).toMatch(
      /export const webSessions = pgTable\([\s\S]*?authEpoch: integer\('auth_epoch'\)\.notNull\(\)\.default\(0\),/,
    );
    expect(body).toMatch(/export const accountMfa = pgTable\('account_mfa', \{/);
    expect(body).toMatch(/export const accountMfaRecoveryCodes = pgTable\(/);
    expect(body).toMatch(/export const apiKeys = pgTable\(/);
    expect(body).toMatch(/export const sessions = pgTable\(/);
    expect(body).toMatch(/export const sessionEvents = pgTable\(/);
    expect(body).toMatch(/export const usageRecords = pgTable\(/);
    expect(body).toMatch(/export const rateLimitBuckets = pgTable\(/);
  });

  it('webhook-pipeline tables (webhook_endpoints + webhook_deliveries + webhook_delivery_attempts) + admin/legal/audit-archive (admin_audit_log + rate_limit_overrides + legal_acceptances + audit_archive_runs) + V-218 validation_schedules + V-202d scheduled_jobs pinned', () => {
    expect(body).toMatch(/export const webhookEndpoints = pgTable\(/);
    expect(body).toMatch(/export const webhookDeliveries = pgTable\(/);
    expect(body).toMatch(/export const webhookDeliveryAttempts = pgTable\(/);
    expect(body).toMatch(/export const adminAuditLog = pgTable\(/);
    expect(body).toMatch(/export const rateLimitOverrides = pgTable\(/);
    expect(body).toMatch(/export const legalAcceptances = pgTable\(/);
    expect(body).toMatch(/export const auditArchiveRuns = pgTable\(/);
    expect(body).toMatch(/export const accountEmailPreferences = pgTable\(/);
    expect(body).toMatch(/export const accountAuditLog = pgTable\(/);
    expect(body).toMatch(/V-218 — continuous validation harness schedules\./);
    expect(body).toMatch(/export const validationSchedules = pgTable\(/);
    expect(body).toMatch(
      /V-202d — generic scheduled_jobs table for time-shifted background work\./,
    );
    expect(body).toMatch(/export const scheduledJobs = pgTable\(/);
  });

  it('V-295a/b status-page tables (incidents 2-table shape + incident_updates + system_health_probes 60s poller + V-298a team_members/team_invites V-298 split a→d + V-295c3 status_subscribers double-opt-in + sha256-at-rest tokens) pinned', () => {
    expect(body).toMatch(/V-295a — public-status incidents\./);
    expect(body).toMatch(/\/\/ Two-table shape: `incidents` holds the current state \(severity,/);
    expect(body).toMatch(
      /\/\/ status, resolved_at\) and `incident_updates` holds the chronological/,
    );
    expect(body).toMatch(/export const incidents = pgTable\(/);
    expect(body).toMatch(/export const incidentUpdates = pgTable\(/);
    expect(body).toMatch(/V-295b — health probe history\./);
    expect(body).toMatch(/export const systemHealthProbes = pgTable\(/);
    expect(body).toMatch(/V-298a — team membership \(Team RBAC v1\)\./);
    expect(body).toMatch(/\/\/ V-298 splits:/);
    expect(body).toMatch(/V-298a \(this commit\): tables \+ migration only\./);
    expect(body).toMatch(/V-298b: TeamMembersService \+ invite\/accept routes\./);
    expect(body).toMatch(/V-298c: auth path integration \(member can act as owner per role\)\./);
    expect(body).toMatch(/V-298d: customer-dashboard \/team UI \(currently mock data only\)\./);
    expect(body).toMatch(/export const teamMembers = pgTable\(/);
    expect(body).toMatch(/export const teamInvites = pgTable\(/);
    expect(body).toMatch(
      /uniqueIndex\('team_invites_owner_email_pending_unique'\)[ \t]*(?:\r?\n[ \t]*)?\.on\(t\.ownerAccountId, t\.inviteeEmail\)[ \t]*(?:\r?\n[ \t]*)?\.where\(isNull\(t\.acceptedAt\)\)/,
    );
    expect(body).toMatch(/V-295c3 — public status-page email subscribers\./);
    expect(body).toMatch(/\/\/ Double-opt-in flow:/);
    expect(body).toMatch(/\/\/ Tokens are sha256-hashed at rest \(auth-tokens\.ts pattern\)\./);
    expect(body).toMatch(/export const statusSubscribers = pgTable\(/);
  });

  it('$inferSelect/$inferInsert type aliases (Account + LegalAcceptance + ApiKey + Session + SessionEvent + UsageRecord + RateLimitBucket + WebhookEndpoint + WebhookDelivery + WebhookDeliveryAttemptRow + AdminAuditLogRow + RateLimitOverrideRow + EmailVerifyToken + MagicLinkToken + PasswordResetToken + WebSession + ProcessedStripeEvent + Profile + Subscription + AuditArchiveRun + AccountEmailPreference + AccountAuditLogEntry + ValidationSchedule + ScheduledJob + Incident + IncidentUpdate + SystemHealthProbe + TeamMember + TeamInvite + StatusSubscriber) pinned', () => {
    expect(body).toMatch(/^export type Account = typeof accounts\.\$inferSelect;$/m);
    expect(body).toMatch(/^export type NewAccount = typeof accounts\.\$inferInsert;$/m);
    expect(body).toMatch(
      /^export type LegalAcceptance = typeof legalAcceptances\.\$inferSelect;$/m,
    );
    expect(body).toMatch(/^export type ApiKey = typeof apiKeys\.\$inferSelect;$/m);
    expect(body).toMatch(/^export type Session = typeof sessions\.\$inferSelect;$/m);
    expect(body).toMatch(/^export type SessionEvent = typeof sessionEvents\.\$inferSelect;$/m);
    expect(body).toMatch(/^export type UsageRecord = typeof usageRecords\.\$inferSelect;$/m);
    expect(body).toMatch(
      /^export type RateLimitBucket = typeof rateLimitBuckets\.\$inferSelect;$/m,
    );
    expect(body).toMatch(
      /^export type WebhookEndpoint = typeof webhookEndpoints\.\$inferSelect;$/m,
    );
    expect(body).toMatch(
      /^export type WebhookDelivery = typeof webhookDeliveries\.\$inferSelect;$/m,
    );
    expect(body).toMatch(
      /^export type WebhookDeliveryAttemptRow = typeof webhookDeliveryAttempts\.\$inferSelect;$/m,
    );
    expect(body).toMatch(/^export type AdminAuditLogRow = typeof adminAuditLog\.\$inferSelect;$/m);
    expect(body).toMatch(
      /^export type RateLimitOverrideRow = typeof rateLimitOverrides\.\$inferSelect;$/m,
    );
    expect(body).toMatch(
      /^export type EmailVerifyToken = typeof emailVerifyTokens\.\$inferSelect;$/m,
    );
    expect(body).toMatch(/^export type MagicLinkToken = typeof magicLinkTokens\.\$inferSelect;$/m);
    expect(body).toMatch(
      /^export type PasswordResetToken = typeof passwordResetTokens\.\$inferSelect;$/m,
    );
    expect(body).toMatch(/^export type WebSession = typeof webSessions\.\$inferSelect;$/m);
    expect(body).toMatch(
      /^export type ProcessedStripeEvent = typeof processedStripeEvents\.\$inferSelect;$/m,
    );
    expect(body).toMatch(/^export type Profile = typeof profiles\.\$inferSelect;$/m);
    expect(body).toMatch(/^export type Subscription = typeof subscriptions\.\$inferSelect;$/m);
    expect(body).toMatch(
      /^export type AuditArchiveRun = typeof auditArchiveRuns\.\$inferSelect;$/m,
    );
    expect(body).toMatch(
      /^export type AccountEmailPreference = typeof accountEmailPreferences\.\$inferSelect;$/m,
    );
    expect(body).toMatch(
      /^export type AccountAuditLogEntry = typeof accountAuditLog\.\$inferSelect;$/m,
    );
    expect(body).toMatch(
      /^export type ValidationSchedule = typeof validationSchedules\.\$inferSelect;$/m,
    );
    expect(body).toMatch(/^export type ScheduledJob = typeof scheduledJobs\.\$inferSelect;$/m);
    expect(body).toMatch(/^export type Incident = typeof incidents\.\$inferSelect;$/m);
    expect(body).toMatch(/^export type IncidentUpdate = typeof incidentUpdates\.\$inferSelect;$/m);
    expect(body).toMatch(
      /^export type SystemHealthProbe = typeof systemHealthProbes\.\$inferSelect;$/m,
    );
    expect(body).toMatch(/^export type TeamMember = typeof teamMembers\.\$inferSelect;$/m);
    expect(body).toMatch(/^export type TeamInvite = typeof teamInvites\.\$inferSelect;$/m);
    expect(body).toMatch(
      /^export type StatusSubscriber = typeof statusSubscribers\.\$inferSelect;$/m,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});

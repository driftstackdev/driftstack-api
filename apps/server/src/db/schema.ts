import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// ───────────────────────────────────────────────────────────────────────────
// Enums
// ───────────────────────────────────────────────────────────────────────────

export const accountTier = pgEnum('account_tier', [
  'free',
  'starter',
  'solo',
  'builder',
  'scale',
  'enterprise',
]);

export const accountStatus = pgEnum('account_status', ['active', 'suspended', 'deleted']);

export const apiKeyScope = pgEnum('api_key_scope', ['read', 'write', 'admin', 'gui_control']);

export const sessionStatus = pgEnum('session_status', [
  'creating',
  'ready',
  'busy',
  'destroyed',
  'errored',
]);

export const sessionEventType = pgEnum('session_event_type', [
  'created',
  'navigated',
  'interacted',
  'gui_input',
  'waited',
  'state_captured',
  'screenshot_captured',
  'destroyed',
  'errored',
]);

export const usageRecordType = pgEnum('usage_record_type', [
  'session_minute',
  'navigate',
  'interact',
  'wait',
  'state_capture',
  'screenshot_capture',
]);

export const webhookEventType = pgEnum('webhook_event_type', [
  'session.completed',
  'session.failed',
  'quota.warning_80pct',
  'quota.exceeded',
  'api_key.revoked',
]);

export const webhookDeliveryStatus = pgEnum('webhook_delivery_status', [
  'pending',
  'in_flight',
  'delivered',
  'failed',
  'dlq',
]);

// admin_audit_log.action — closed enum so the schema reflects the
// supported admin operations. Adding a new admin endpoint is a
// migration-bearing change. See D-025.
export const adminAuditAction = pgEnum('admin_audit_action', [
  'account.tier_changed',
  'account.suspended',
  'account.unsuspended',
  'webhook_delivery.replayed',
  'webhook_delivery.requeued',
  'rate_limit_override.set',
  'rate_limit_override.cleared',
]);

// ───────────────────────────────────────────────────────────────────────────
// Tables
// ───────────────────────────────────────────────────────────────────────────

export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    email: text('email').notNull(),
    name: text('name'),
    tier: accountTier('tier').notNull().default('free'),
    status: accountStatus('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [uniqueIndex('accounts_email_unique').on(t.email)],
);

export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    // Human-readable label, e.g. "production" or "ci".
    name: text('name').notNull(),
    // First chars of the plaintext key (e.g. "ds_live_a1b2c3"). Indexed for
    // O(1) lookup; the full key is verified by re-hashing and comparing
    // `keyHash`. Never useful to an attacker on its own.
    keyPrefix: text('key_prefix').notNull(),
    // scrypt-kdf encoded hash of the full key.
    keyHash: text('key_hash').notNull(),
    // Array of scope tokens. Use text[] not jsonb so we can later add
    // GIN indexing or `scope = ANY(scopes)` checks cheaply.
    scopes: apiKeyScope('scopes')
      .array()
      .notNull()
      .default(sql`ARRAY['read','write']::api_key_scope[]`),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    uniqueIndex('api_keys_prefix_unique').on(t.keyPrefix),
    index('api_keys_account_idx').on(t.accountId),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    apiKeyId: uuid('api_key_id')
      .notNull()
      .references(() => apiKeys.id, { onDelete: 'restrict' }),
    // Driver-side opaque identifier (mock returns deterministic ids).
    driverSessionId: text('driver_session_id').notNull(),
    status: sessionStatus('status').notNull().default('creating'),
    // iPhone archetype slug, e.g. "iphone16pro_ios26_4_1". Placeholder until
    // archetype catalogue lands.
    archetype: text('archetype').notNull().default('iphone16pro_ios26_4_1'),
    // Optional client-supplied label.
    label: text('label'),
    // Free-form session metadata supplied by client; bounded at API layer.
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    lastStateAt: timestamp('last_state_at', { withTimezone: true }),
    destroyedAt: timestamp('destroyed_at', { withTimezone: true }),
  },
  (t) => [
    index('sessions_account_idx').on(t.accountId),
    index('sessions_status_idx').on(t.status),
    index('sessions_account_status_idx').on(t.accountId, t.status),
  ],
);

export const sessionEvents = pgTable(
  'session_events',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    type: sessionEventType('type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>(),
    durationMs: integer('duration_ms'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index('session_events_session_idx').on(t.sessionId),
    index('session_events_session_created_idx').on(t.sessionId, t.createdAt),
  ],
);

export const usageRecords = pgTable(
  'usage_records',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    // Nullable: not every usage record ties to a session (e.g. admin actions).
    sessionId: uuid('session_id').references(() => sessions.id, {
      onDelete: 'set null',
    }),
    recordType: usageRecordType('record_type').notNull(),
    // For `session_minute` we record one row per minute; for ops one per call.
    quantity: integer('quantity').notNull().default(1),
    recordedAt: timestamp('recorded_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index('usage_records_account_idx').on(t.accountId),
    index('usage_records_account_period_idx').on(t.accountId, t.recordedAt),
  ],
);

export const rateLimitBuckets = pgTable(
  'rate_limit_buckets',
  {
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    bucketKey: text('bucket_key').notNull(),
    // Snapshotted token count. Live counter lives in Redis.
    tokens: bigint('tokens', { mode: 'number' }).notNull(),
    capacity: bigint('capacity', { mode: 'number' }).notNull(),
    lastRefillAt: timestamp('last_refill_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.bucketKey] })],
);

export const webhookEndpoints = pgTable(
  'webhook_endpoints',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    // Secret stored in plaintext (D-023): the worker needs the plaintext on
    // every signing call, and webhook-signature forgery is a phishing-grade
    // not auth-grade risk. Same posture as Stripe.
    secret: text('secret').notNull(),
    // First 12 chars of the plaintext, for display in lists / logs.
    secretPrefix: text('secret_prefix').notNull(),
    events: webhookEventType('events').array().notNull(),
    description: text('description'),
    active: boolean('active').notNull().default(true),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
    lastFailureAt: timestamp('last_failure_at', { withTimezone: true }),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index('webhook_endpoints_account_idx').on(t.accountId),
    index('webhook_endpoints_active_idx').on(t.accountId, t.active),
  ],
);

export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    webhookId: uuid('webhook_id')
      .notNull()
      .references(() => webhookEndpoints.id, { onDelete: 'cascade' }),
    // Logical event id — same across all deliveries spawned from one event.
    eventId: uuid('event_id').notNull(),
    eventType: webhookEventType('event_type').notNull(),
    payload: jsonb('payload').notNull().$type<Record<string, unknown>>(),
    status: webhookDeliveryStatus('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    lastResponseStatus: integer('last_response_status'),
    // First 4 KB of the response body for debugging. Worker truncates.
    lastResponseExcerpt: text('last_response_excerpt'),
    // Non-HTTP failure reason (timeout, DNS, connection refused, etc.).
    lastError: text('last_error'),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    // Worker poll: claim oldest pending deliveries whose time has come.
    index('webhook_deliveries_worker_idx').on(t.status, t.nextAttemptAt),
    // Per-endpoint history listing.
    index('webhook_deliveries_endpoint_idx').on(t.webhookId, t.createdAt),
    // Event id lookup for dedup / debugging.
    index('webhook_deliveries_event_idx').on(t.eventId),
  ],
);

// admin_audit_log records every admin action (tier change, suspend,
// webhook delivery replay/requeue, rate-limit override). Append-only:
// the service exposes only an insert path and a paginated read; there
// is no UPDATE or DELETE method. Schema enforces nothing here — the
// "no mutate" invariant is upheld by code, not the DB. See D-025.
export const adminAuditLog = pgTable(
  'admin_audit_log',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    // The admin who performed the action.
    adminAccountId: uuid('admin_account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),
    adminKeyId: uuid('admin_key_id')
      .notNull()
      .references(() => apiKeys.id, { onDelete: 'restrict' }),
    action: adminAuditAction('action').notNull(),
    // Account the action was performed against. Nullable for actions
    // that don't target a single account (none today; reserved).
    targetAccountId: uuid('target_account_id').references(() => accounts.id, {
      onDelete: 'set null',
    }),
    // Free-form id of the target resource (e.g., webhook_delivery uuid).
    // Not an FK — the targeted row may be from any table.
    targetResourceId: text('target_resource_id'),
    // Sanitised request body or query — captured by the route handler
    // so the audit row records exactly what the admin asked for.
    inputPayload: jsonb('input_payload').$type<Record<string, unknown>>(),
    // 'success' on the happy path; 'error: <code>' on failures that
    // still produced an audit row (e.g., a 404 when retrying a delivery
    // that no longer exists is still worth recording).
    result: text('result').notNull(),
    // Best-effort client IP (X-Forwarded-For or socket peer). Stored as
    // text so v4/v6/cidr/proxied-list all fit.
    ipAddress: text('ip_address'),
    timestamp: timestamp('timestamp', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    // Filter by admin (who).
    index('admin_audit_log_admin_idx').on(t.adminAccountId, t.timestamp),
    // Filter by target (what was changed).
    index('admin_audit_log_target_idx').on(t.targetAccountId, t.timestamp),
    // Filter by action (what kind of change).
    index('admin_audit_log_action_idx').on(t.action, t.timestamp),
  ],
);

// rate_limit_overrides — temporary per-account rate-limit adjustments
// keyed by bucketKey (e.g., 'global', 'sessions:create'). When present
// and unexpired, supersede the tier defaults at consume time. Set/
// cleared by admin endpoints; auth-cache.invalidateAccount() runs on
// every set/clear so the next auth read picks up the change. See D-025.
export const rateLimitOverrides = pgTable(
  'rate_limit_overrides',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    bucketKey: text('bucket_key').notNull(),
    capacity: integer('capacity').notNull(),
    // Stored as a fixed-point centi-rate so 1/60 (one per minute) and
    // similar fractional values round-trip without float drift. The
    // service multiplies by 0.01 when constructing the bucket config.
    refillPerSecondCenti: integer('refill_per_second_centi').notNull(),
    // Optional human-readable reason captured at set time.
    reason: text('reason'),
    // Override expires when this is in the past; the service treats
    // expired rows as absent. Cleanup is lazy (no cron); rows hang
    // around until an admin re-sets or a periodic sweep removes them.
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    setByKeyId: uuid('set_by_key_id')
      .notNull()
      .references(() => apiKeys.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    // One override per (account, bucket) — re-setting upserts.
    uniqueIndex('rate_limit_overrides_account_bucket_unique').on(t.accountId, t.bucketKey),
    // Filter by account (the consume path).
    index('rate_limit_overrides_account_idx').on(t.accountId),
    // For the sweep query (find expired rows).
    index('rate_limit_overrides_expires_idx').on(t.expiresAt),
  ],
);

// legal_acceptances — audit log of customer acceptance of legal documents
// (ToS, Privacy Policy, DPA, AUP). Each row binds (account, document, version)
// to a content hash + acceptance timestamp; version bumps invalidate prior
// acceptances by referencing a different (document_key, version) row. The
// service layer queries the latest acceptance per (account, document_key)
// and compares against the currently-published version to decide whether
// to force a re-acceptance flow.
//
// Document content lives in `docs/legal/*.md` and is loaded into config at
// server start; content_hash is SHA-256 of the file content at the time of
// acceptance, so post-acceptance edits to the file are detectable.
export const legalAcceptances = pgTable(
  'legal_acceptances',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    // Document key — 'tos' | 'privacy' | 'dpa' | 'aup'. Free-form text rather
    // than a pgEnum to allow new documents without a schema migration.
    documentKey: text('document_key').notNull(),
    // SemVer-shaped version string (e.g. '0.1.0-draft', '1.0.0').
    version: text('version').notNull(),
    // SHA-256 of the document content at acceptance time, lowercase hex.
    contentHash: text('content_hash').notNull(),
    // Optional metadata — IP / user agent at acceptance, captured by the
    // route layer for forensic value.
    acceptedFromIp: text('accepted_from_ip'),
    acceptedUserAgent: text('accepted_user_agent'),
    acceptedAt: timestamp('accepted_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    // Latest-acceptance lookup by (account, document) — the hot read path.
    index('legal_acceptances_account_doc_idx').on(t.accountId, t.documentKey),
    // For audit queries by account.
    index('legal_acceptances_account_idx').on(t.accountId),
    // For audit queries by document version (e.g. "who accepted v0.2.0?").
    index('legal_acceptances_doc_version_idx').on(t.documentKey, t.version),
  ],
);

// ───────────────────────────────────────────────────────────────────────────
// Inferred types (for service / route layers)
// ───────────────────────────────────────────────────────────────────────────

export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;

export type LegalAcceptance = typeof legalAcceptances.$inferSelect;
export type NewLegalAcceptance = typeof legalAcceptances.$inferInsert;

export type ApiKey = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;

export type SessionEvent = typeof sessionEvents.$inferSelect;
export type NewSessionEvent = typeof sessionEvents.$inferInsert;

export type UsageRecord = typeof usageRecords.$inferSelect;
export type NewUsageRecord = typeof usageRecords.$inferInsert;

export type RateLimitBucket = typeof rateLimitBuckets.$inferSelect;
export type NewRateLimitBucket = typeof rateLimitBuckets.$inferInsert;

export type WebhookEndpoint = typeof webhookEndpoints.$inferSelect;
export type NewWebhookEndpoint = typeof webhookEndpoints.$inferInsert;

export type WebhookDelivery = typeof webhookDeliveries.$inferSelect;
export type NewWebhookDelivery = typeof webhookDeliveries.$inferInsert;

export type AdminAuditLogRow = typeof adminAuditLog.$inferSelect;
export type NewAdminAuditLogRow = typeof adminAuditLog.$inferInsert;

export type RateLimitOverrideRow = typeof rateLimitOverrides.$inferSelect;
export type NewRateLimitOverrideRow = typeof rateLimitOverrides.$inferInsert;

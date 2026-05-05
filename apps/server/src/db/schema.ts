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
  'trial_pack',
  'solo_manual',
  'team_manual',
  'agency_manual',
  'api_starter',
  'api_builder',
  'api_scale',
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

// V-169 — sessions.purpose drives WebKit driver harness selection.
// See docs/architecture/afp-harness-configuration.md (Agent 1
// cross-reference, Phase 3 work).
export const sessionPurpose = pgEnum('session_purpose', [
  'production_customer',
  'cumulative_rig_validation',
  'test_domain_probe',
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
  // V-100: admin force-actions on customer resources.
  'session.destroyed_by_admin',
  'api_key.revoked_by_admin',
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
    // scrypt-kdf encoded hash of the account password. Nullable: accounts
    // created via magic-link-only flow have no password set until the user
    // chooses to add one. Set via signup or password-reset confirm.
    passwordHash: text('password_hash'),
    // Set when the account holder confirms ownership of `email` by
    // consuming a single-use email_verify_token. Auth gates that require
    // a verified email check `email_verified_at IS NOT NULL`.
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    tier: accountTier('tier').notNull().default('trial_pack'),
    status: accountStatus('status').notNull().default('active'),
    // V-082 / Workstream D — Stripe customer link. Set at first
    // checkout-session create; remains pinned across tier changes
    // (Stripe customer ID is stable for the lifetime of the account).
    stripeCustomerId: text('stripe_customer_id'),
    // V-082 / ADR-003 — trial-pack mechanics. Set at trial-pack
    // purchase (Checkout success). $0.18/hr decrement debits this
    // counter; 14-day window from `trial_pack_purchased_at`.
    // `trial_pack_redeemed` flips true when this account exits
    // trial state via either subscription start OR credit
    // exhaustion OR window expiry.
    trialPackPurchasedAt: timestamp('trial_pack_purchased_at', { withTimezone: true }),
    trialPackCreditCents: integer('trial_pack_credit_cents'),
    trialPackExpiresAt: timestamp('trial_pack_expires_at', { withTimezone: true }),
    trialPackRedeemed: boolean('trial_pack_redeemed').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [uniqueIndex('accounts_email_unique').on(t.email)],
);

// Single-use tokens for the user-facing auth flow.
//
// All four token tables share the same shape:
//   - `token_hash`: sha256 of the plaintext token. The plaintext is sent
//     once via Postmark, never stored. Lookup-by-hash is constant-time
//     equality and adequate for opaque random tokens (scrypt is reserved
//     for passwords + API keys where the input is user-chosen).
//   - `expires_at`: short TTL (15-30 min for signup verify, 15 min for
//     magic-link, 1h for password reset). Service-layer enforces.
//   - `consumed_at`: set when the token is redeemed; non-null = used.
//     Re-use is rejected at the service boundary.
//   - `requested_from_ip`: best-effort client IP captured at request time
//     for forensic value (rate limiting + abuse review).
//
// Tokens are NOT shared across flows: a magic-link token cannot stand in
// for a password-reset token even if the bytes coincide. Each flow has
// its own table so the verify path checks the right intent.

export const emailVerifyTokens = pgTable(
  'email_verify_tokens',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    requestedFromIp: text('requested_from_ip'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    uniqueIndex('email_verify_tokens_hash_unique').on(t.tokenHash),
    index('email_verify_tokens_account_idx').on(t.accountId),
    index('email_verify_tokens_expires_idx').on(t.expiresAt),
  ],
);

export const magicLinkTokens = pgTable(
  'magic_link_tokens',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    requestedFromIp: text('requested_from_ip'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    uniqueIndex('magic_link_tokens_hash_unique').on(t.tokenHash),
    index('magic_link_tokens_account_idx').on(t.accountId),
    index('magic_link_tokens_expires_idx').on(t.expiresAt),
  ],
);

export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    requestedFromIp: text('requested_from_ip'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    uniqueIndex('password_reset_tokens_hash_unique').on(t.tokenHash),
    index('password_reset_tokens_account_idx').on(t.accountId),
    index('password_reset_tokens_expires_idx').on(t.expiresAt),
  ],
);

// subscriptions — local mirror of the Stripe subscription resource.
// One row per active or recently-past subscription per account; the
// `account_id` is the FK back to the local accounts row, while
// `stripe_subscription_id` is the Stripe-side identifier.
//
// State stays in sync with Stripe via webhook events (V-080 router):
//   - customer.subscription.created → INSERT (or UPDATE if races)
//   - customer.subscription.updated → UPDATE current_period_end / status
//   - customer.subscription.deleted → set status='canceled'
//   - invoice.payment_succeeded     → no-op on this table; usage analytics
//
// Status enum tracks Stripe's status verbatim for fidelity.
export const subscriptionStatus = pgEnum('subscription_status', [
  'incomplete',
  'incomplete_expired',
  'trialing',
  'active',
  'past_due',
  'canceled',
  'unpaid',
  'paused',
]);

export const subscriptions = pgTable(
  'subscriptions',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    stripeSubscriptionId: text('stripe_subscription_id').notNull(),
    stripePriceId: text('stripe_price_id').notNull(),
    /** Tier this subscription corresponds to (mirrors AccountTier enum). */
    tier: accountTier('tier').notNull(),
    status: subscriptionStatus('status').notNull(),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
    cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
    canceledAt: timestamp('canceled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    uniqueIndex('subscriptions_stripe_id_unique').on(t.stripeSubscriptionId),
    index('subscriptions_account_idx').on(t.accountId),
    index('subscriptions_status_idx').on(t.status),
  ],
);

// profiles — persistent customer-defined identity slots that sessions
// are created against. The Manual ladder caps profile count as the
// tier-defining metric (e.g. team_manual = 50 profiles); the API ladder
// also caps profiles to prevent unbounded growth at lower tiers.
//
// V-081 scaffolding: only the metadata fields land here. The actual
// per-profile persistent browser state (cookies, localStorage, IndexedDB)
// flows through the WebKit driver when sessions resume from a profile;
// none of that is stored at the control-plane layer.
//
// Uniqueness: (account_id, name) is unique — profile names are
// human-meaningful identifiers within an account ("aws-staging",
// "instagram-account-1"), not opaque IDs.
export const profiles = pgTable(
  'profiles',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    archetype: text('archetype').notNull().default('iphone16pro_ios18_7_safari26_4'),
    description: text('description'),
    /** Last time a session was created against this profile. Updated by SessionsService at create-time. */
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    uniqueIndex('profiles_account_name_unique').on(t.accountId, t.name),
    index('profiles_account_idx').on(t.accountId),
  ],
);

// processed_stripe_events — append-only idempotency ledger for inbound
// Stripe webhooks. The Stripe `event.id` is unique across the lifetime
// of a Stripe account; we record it here on first successful handling
// and reject duplicates with a 200 OK no-op (Stripe re-delivers events
// up to 3 days after the first attempt). Also stores the event type +
// the raw payload digest so admin debugging can reconstruct what was
// seen without keeping the full body. See V-080.
export const processedStripeEvents = pgTable(
  'processed_stripe_events',
  {
    eventId: text('event_id').primaryKey(),
    eventType: text('event_type').notNull(),
    /** SHA-256 of the raw event payload at the time we processed it. */
    payloadHash: text('payload_hash').notNull(),
    /** Outcome of the handler: 'handled' | 'ignored' | 'error:<short>'. */
    result: text('result').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index('processed_stripe_events_received_idx').on(t.receivedAt),
    index('processed_stripe_events_type_idx').on(t.eventType, t.receivedAt),
  ],
);

// Long-lived browser session tokens — used by the customer dashboard
// + admin panel (when those land). Distinct from API keys: API keys are
// for code; web sessions are for humans in a browser. Same hash pattern
// (sha256 of the opaque random token), TTL controlled by `expires_at`,
// revocation via `revoked_at`.
//
// The session-cookie value is the plaintext token (returned once on
// login / verify-email / magic-link consume / password-reset confirm).
// Re-issued on /v1/auth/refresh: old session row gets `revoked_at`,
// new row issued. `last_used_at` tracked for idle-timeout enforcement.
export const webSessions = pgTable(
  'web_sessions',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    issuedFromIp: text('issued_from_ip'),
    userAgent: text('user_agent'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    uniqueIndex('web_sessions_hash_unique').on(t.tokenHash),
    index('web_sessions_account_idx').on(t.accountId),
    index('web_sessions_expires_idx').on(t.expiresAt),
  ],
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
    // iPhone archetype slug, e.g. "iphone16pro_ios18_7_safari26_4". See
    // packages/api-types/src/common.ts LOCKED_ARCHETYPE_ID +
    // docs/architecture/archetype-naming-convention.md for shape rationale.
    archetype: text('archetype').notNull().default('iphone16pro_ios18_7_safari26_4'),
    // V-169 — harness purpose (drives WebKit driver harness selection).
    purpose: sessionPurpose('purpose').notNull().default('production_customer'),
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

export type EmailVerifyToken = typeof emailVerifyTokens.$inferSelect;
export type NewEmailVerifyToken = typeof emailVerifyTokens.$inferInsert;

export type MagicLinkToken = typeof magicLinkTokens.$inferSelect;
export type NewMagicLinkToken = typeof magicLinkTokens.$inferInsert;

export type PasswordResetToken = typeof passwordResetTokens.$inferSelect;
export type NewPasswordResetToken = typeof passwordResetTokens.$inferInsert;

export type WebSession = typeof webSessions.$inferSelect;
export type NewWebSession = typeof webSessions.$inferInsert;

export type ProcessedStripeEvent = typeof processedStripeEvents.$inferSelect;
export type NewProcessedStripeEvent = typeof processedStripeEvents.$inferInsert;

export type Profile = typeof profiles.$inferSelect;
export type NewProfile = typeof profiles.$inferInsert;

export type Subscription = typeof subscriptions.$inferSelect;
export type NewSubscription = typeof subscriptions.$inferInsert;

// audit_archive_runs (V-163, ADR-006) — ledger of monthly archive
// sweeps that copy 90+ day-old rows from the four audit-shaped
// tables (admin_audit_log / processed_stripe_events / legal_
// acceptances / webhook_deliveries) to R2 as JSONL+gzip and DELETE
// from Postgres. One row per (table_name, window_start) sweep.
export const auditArchiveRuns = pgTable(
  'audit_archive_runs',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tableName: text('table_name').notNull(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    windowEnd: timestamp('window_end', { withTimezone: true }).notNull(),
    rowsArchived: integer('rows_archived').notNull(),
    r2ObjectKey: text('r2_object_key').notNull(),
    sha256Checksum: text('sha256_checksum').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }).notNull(),
    deletedFromPostgres: boolean('deleted_from_postgres').notNull().default(false),
  },
  (t) => [
    index('audit_archive_runs_table_window_idx').on(t.tableName, t.windowStart),
    index('audit_archive_runs_started_idx').on(t.startedAt),
  ],
);

export type AuditArchiveRun = typeof auditArchiveRuns.$inferSelect;
export type NewAuditArchiveRun = typeof auditArchiveRuns.$inferInsert;

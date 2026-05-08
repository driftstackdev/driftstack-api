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

export const apiKeyScope = pgEnum('api_key_scope', [
  'read',
  'write',
  'admin', // V-174 compat alias; deprecated after migration window.
  'account_owner', // V-174 customer-account control.
  'driftstack_internal_admin', // V-174 Driftstack-staff-only.
  'gui_control',
]);

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
  // V-356 — synthetic event sent only via POST /v1/webhooks/:id/test.
  // Emitted regardless of subscription so the customer can verify
  // their handler is reachable + signature-verifies before relying on
  // it for real events. Migration 0032 adds the value to the
  // existing postgres enum.
  'test.ping',
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
  // V-281: customer-support tooling (audit-only).
  'audit_note.added',
  'refund.recorded',
  // V-295a: status-page incident management.
  'incident.created',
  'incident.updated',
  'incident.resolved',
  // V-295c3-tombstone: status-page email subscriber admin actions.
  'status_subscriber.force_unsubscribed',
  'status_subscriber.purged',
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
    // V-202c — set to the wall clock when we send `session-failed-first`
    // to this account. Null until the first session.failed ever; one-shot
    // by design (subsequent failures don't email).
    firstFailureEmailSentAt: timestamp('first_failure_email_sent_at', { withTimezone: true }),
    // V-304a — set when we send the `session-success-first` email after
    // the customer's first successful session completes. One-shot
    // (subsequent sessions don't email; the dashboard takes over).
    firstSuccessEmailSentAt: timestamp('first_success_email_sent_at', { withTimezone: true }),
    // V-352 — IANA timezone name (e.g. "Europe/Amsterdam", "America/Los_Angeles").
    // Used by the dashboard + outbound emails to render timestamps in
    // the customer's local TZ. Optional; falls back to UTC display.
    timezone: text('timezone'),
    // V-352b — R2 key (path within bucketPublic) for the customer's
    // uploaded avatar. Public-readable bucket; route layer surfaces a
    // presigned GET URL on /v1/account/me reads. Null when the customer
    // hasn't uploaded one. R2 sub-processor disclosure already covers
    // avatar storage (privacy.md §3.1; sub-processors.ts).
    avatarR2Key: text('avatar_r2_key'),
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

// V-173 — per-attempt log for webhook deliveries.
// DurableWebhookDeliveryService writes one row per attempt; the
// package's DeliveryRecord.attempts array reads from this table.
// Existing apps/server/src/services/webhooks.ts does not write here
// (different service; coexists during migration window).
export const webhookDeliveryAttempts = pgTable(
  'webhook_delivery_attempts',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    deliveryId: uuid('delivery_id')
      .notNull()
      .references(() => webhookDeliveries.id, { onDelete: 'cascade' }),
    /** 1-indexed attempt number within the delivery's attempt history. */
    attemptNumber: integer('attempt_number').notNull(),
    /** Unix-ms timestamp when this attempt completed. Wide enough for ms precision. */
    completedAtMs: bigint('completed_at_ms', { mode: 'number' }).notNull(),
    /** HTTP status if a response came back; null on transport error / timeout. */
    responseStatus: integer('response_status'),
    /** First ~200 chars of response body for debugging. */
    responseExcerpt: text('response_excerpt'),
    /** Wall-clock duration of this attempt in milliseconds. */
    durationMs: integer('duration_ms').notNull(),
    /** 'success' | 'http_error' | 'transport_error' | 'timeout' (per package contract). */
    outcome: text('outcome').notNull(),
    /** Free-text error reason when outcome != 'success'. */
    errorMessage: text('error_message'),
  },
  (t) => [index('webhook_delivery_attempts_delivery_idx').on(t.deliveryId, t.attemptNumber)],
);

export type WebhookDeliveryAttemptRow = typeof webhookDeliveryAttempts.$inferSelect;
export type NewWebhookDeliveryAttemptRow = typeof webhookDeliveryAttempts.$inferInsert;

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

// V-204 — per-account email notification preferences. Absence of a
// row means opted-in (the default); explicit opt-out writes a row
// with opted_in=false. Steady-state cheap: zero rows per account by
// default.
export const accountEmailPreferences = pgTable(
  'account_email_preferences',
  {
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    eventType: text('event_type').notNull(),
    optedIn: boolean('opted_in').notNull().default(true),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.eventType] }),
    index('account_email_preferences_account_idx').on(t.accountId),
  ],
);

export type AccountEmailPreference = typeof accountEmailPreferences.$inferSelect;
export type NewAccountEmailPreference = typeof accountEmailPreferences.$inferInsert;

// V-216 — customer-facing audit log. Mirrors admin_audit_log shape
// but scoped to a single customer account: customer-initiated actions
// on their own account (mints / revokes / session creates / etc.),
// plus system-initiated events (Stripe webhook handlers, scheduled
// jobs) and any staff actions that touched the account. Append-only:
// the service exposes only an insert path and a paginated read.
export const accountAuditLog = pgTable(
  'account_audit_log',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    /** 'customer' | 'system' | 'staff'. App-layer enforced. */
    actorType: text('actor_type').notNull(),
    actorAccountId: uuid('actor_account_id').references(() => accounts.id, {
      onDelete: 'set null',
    }),
    actorKeyId: uuid('actor_key_id').references(() => apiKeys.id, {
      onDelete: 'set null',
    }),
    action: text('action').notNull(),
    targetResourceId: text('target_resource_id'),
    payload: jsonb('payload').$type<Record<string, unknown>>(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    timestamp: timestamp('timestamp', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index('account_audit_log_account_idx').on(t.accountId, t.timestamp),
    index('account_audit_log_action_idx').on(t.accountId, t.action, t.timestamp),
  ],
);

export type AccountAuditLogEntry = typeof accountAuditLog.$inferSelect;
export type NewAccountAuditLogEntry = typeof accountAuditLog.$inferInsert;

// V-218 — continuous validation harness schedules. One row per
// archetype that should be periodically recaptured + validated. The
// harness worker's processTick() finds rows with next_run_at <= now()
// AND enabled=true, dispatches to RecaptureService.triggerRecapture,
// then updates last_run_at / next_run_at. Cross-repo: actual probe
// execution lands when Agent 1's V-203 Phase 2A vendor probes drop;
// until then, the mock RecaptureService from packages/recapture-
// automation is the dispatch target.
export const validationSchedules = pgTable(
  'validation_schedules',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    archetypeId: text('archetype_id').notNull(),
    cadenceSeconds: integer('cadence_seconds').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }).notNull(),
    lastRunId: text('last_run_id'),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    uniqueIndex('validation_schedules_archetype_unique').on(t.archetypeId),
    index('validation_schedules_due_idx').on(t.enabled, t.nextRunAt),
  ],
);

export type ValidationSchedule = typeof validationSchedules.$inferSelect;
export type NewValidationSchedule = typeof validationSchedules.$inferInsert;

// V-202d — generic scheduled_jobs table for time-shifted background work.
// Trial-pack expiry is the first consumer; future cron-shaped jobs reuse
// the same table by adding a job_type discriminator value + a handler.
export const scheduledJobs = pgTable(
  'scheduled_jobs',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    jobType: text('job_type').notNull(),
    accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'cascade' }),
    payload: jsonb('payload')
      .notNull()
      .default(sql`'{}'::jsonb`)
      .$type<Record<string, unknown>>(),
    runAt: timestamp('run_at', { withTimezone: true }).notNull(),
    lockedBy: text('locked_by'),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    failedAt: timestamp('failed_at', { withTimezone: true }),
    lastError: text('last_error'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index('scheduled_jobs_due_idx').on(t.runAt),
    index('scheduled_jobs_account_type_pending_idx').on(t.accountId, t.jobType),
  ],
);

export type ScheduledJob = typeof scheduledJobs.$inferSelect;
export type NewScheduledJob = typeof scheduledJobs.$inferInsert;

// V-295a — public-status incidents.
//
// Two-table shape: `incidents` holds the current state (severity,
// status, resolved_at) and `incident_updates` holds the chronological
// timeline. The status page renders incidents.public=true; the admin
// surface reads + writes both sides via /v1/admin/incidents/*.

export const incidentSeverity = pgEnum('incident_severity', ['minor', 'major', 'outage']);
export const incidentStatus = pgEnum('incident_status', [
  'investigating',
  'identified',
  'monitoring',
  'resolved',
]);

export const incidents = pgTable(
  'incidents',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    title: text('title').notNull(),
    /** Markdown description; rendered on the status page. */
    description: text('description').notNull(),
    severity: incidentSeverity('severity').notNull(),
    status: incidentStatus('status').notNull().default('investigating'),
    /** Component slugs the incident affects. Free-form text array;
     *  the status page recognises 'api' / 'gui-distribution' /
     *  'stripe' / 'marketing' / 'docs' / 'status' but accepts any. */
    affectedComponents: jsonb('affected_components')
      .notNull()
      .default(sql`'[]'::jsonb`)
      .$type<readonly string[]>(),
    /** When false, the incident is admin-only (e.g. internal triage
     *  before public confirmation). */
    public: boolean('public').notNull().default(true),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    /** Null when the incident was auto-created by the V-295b health
     *  probe poller (no admin actor). Non-null for admin-posted ones. */
    createdByAdminId: uuid('created_by_admin_id').references(() => accounts.id, {
      onDelete: 'restrict',
    }),
    /** Null when auto-created by health probe poller; see above. */
    createdByAdminKeyId: uuid('created_by_admin_key_id').references(() => apiKeys.id, {
      onDelete: 'restrict',
    }),
    /** V-295b — non-null only for auto-created incidents. The probe target
     *  whose 3-consecutive-fail triggered creation (e.g. 'api'). Used by the
     *  poller to find the open auto-incident for auto-resolve. */
    autoProbeTarget: text('auto_probe_target'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index('incidents_started_at_idx').on(t.startedAt),
    index('incidents_public_status_idx').on(t.public, t.status),
    index('incidents_auto_probe_open_idx').on(t.autoProbeTarget, t.status),
  ],
);

export const incidentUpdates = pgTable(
  'incident_updates',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    incidentId: uuid('incident_id')
      .notNull()
      .references(() => incidents.id, { onDelete: 'cascade' }),
    message: text('message').notNull(),
    status: incidentStatus('status').notNull(),
    /** Null when posted by the V-295b auto poller (no admin actor). */
    postedByAdminId: uuid('posted_by_admin_id').references(() => accounts.id, {
      onDelete: 'restrict',
    }),
    /** Null when posted by the V-295b auto poller; see above. */
    postedByAdminKeyId: uuid('posted_by_admin_key_id').references(() => apiKeys.id, {
      onDelete: 'restrict',
    }),
    postedAt: timestamp('posted_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [index('incident_updates_incident_id_idx').on(t.incidentId, t.postedAt)],
);

export type Incident = typeof incidents.$inferSelect;
export type NewIncident = typeof incidents.$inferInsert;
export type IncidentUpdate = typeof incidentUpdates.$inferSelect;
export type NewIncidentUpdate = typeof incidentUpdates.$inferInsert;

// V-295b — health probe history.
//
// Each row is one probe attempt against a configured target (e.g. 'api'
// → http://localhost:3000/health). The poller writes a row every 60s
// and consults the last 3 rows per target for consecutive-fail / pass
// thresholding (auto-create / auto-resolve incidents). Rows older than
// 30 days are pruned by a cleanup tick.
export const systemHealthProbes = pgTable(
  'system_health_probes',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    /** Target identifier — matches incidents.auto_probe_target. */
    target: text('target').notNull(),
    probedAt: timestamp('probed_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    ok: boolean('ok').notNull(),
    latencyMs: integer('latency_ms'),
    /** HTTP status when reachable; null for connection-level failure. */
    httpStatus: integer('http_status'),
    /** Short error message when ok=false; null otherwise. */
    errorMessage: text('error_message'),
  },
  (t) => [index('system_health_probes_target_probed_at_idx').on(t.target, t.probedAt)],
);

export type SystemHealthProbe = typeof systemHealthProbes.$inferSelect;
export type NewSystemHealthProbe = typeof systemHealthProbes.$inferInsert;

// V-298a — team membership (Team RBAC v1).
//
// One account is the "owner" account (the row in `accounts`); team
// membership is modelled as zero-or-more additional accounts joined to
// the owner account with a role. This keeps the auth path uniform —
// every authenticated request still resolves to one accountId — but
// lets multiple humans share that accountId's resources.
//
// Two tables:
//
//   - `team_members`: confirmed membership. (owner_account_id,
//     member_account_id) is the natural unique key. Role drives
//     authorization within the team scope.
//
//   - `team_invites`: pending double-opt-in invites. Generated by an
//     existing team member with `account_owner` scope; consumed by
//     the invitee when they accept. Token-hashed at rest (V-070
//     auth-tokens.ts pattern).
//
// V-298 splits:
//   V-298a (this commit): tables + migration only. No service / route
//     / auth path integration yet — the table shape lands first so
//     future slices can build against a stable schema.
//   V-298b: TeamMembersService + invite/accept routes.
//   V-298c: auth path integration (member can act as owner per role).
//   V-298d: customer-dashboard /team UI (currently mock data only).

export const teamRole = pgEnum('team_role', ['member', 'admin']);

export const teamMembers = pgTable(
  'team_members',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    ownerAccountId: uuid('owner_account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    memberAccountId: uuid('member_account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    role: teamRole('role').notNull().default('member'),
    invitedAt: timestamp('invited_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }).notNull(),
    invitedByAccountId: uuid('invited_by_account_id').references(() => accounts.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    uniqueIndex('team_members_owner_member_unique').on(t.ownerAccountId, t.memberAccountId),
    index('team_members_member_idx').on(t.memberAccountId),
  ],
);

export const teamInvites = pgTable(
  'team_invites',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    ownerAccountId: uuid('owner_account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    inviteeEmail: text('invitee_email').notNull(),
    role: teamRole('role').notNull().default('member'),
    inviteTokenHash: text('invite_token_hash').notNull(),
    inviteExpiresAt: timestamp('invite_expires_at', { withTimezone: true }).notNull(),
    invitedByAccountId: uuid('invited_by_account_id').references(() => accounts.id, {
      onDelete: 'set null',
    }),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    uniqueIndex('team_invites_token_idx').on(t.inviteTokenHash),
    index('team_invites_owner_idx').on(t.ownerAccountId, t.acceptedAt),
    index('team_invites_email_idx').on(t.inviteeEmail),
  ],
);

export type TeamMember = typeof teamMembers.$inferSelect;
export type NewTeamMember = typeof teamMembers.$inferInsert;
export type TeamInvite = typeof teamInvites.$inferSelect;
export type NewTeamInvite = typeof teamInvites.$inferInsert;

// V-295c3 — public status-page email subscribers.
//
// Double-opt-in flow:
//   1. POST /v1/status/subscribe — stores email + confirm_token_hash;
//      sends confirmation email containing the plaintext token.
//   2. GET /v1/status/subscribe/confirm?token=... — sets confirmed_at.
//   3. Each public-incident state change triggers an email to all
//      subscribers where confirmed_at IS NOT NULL AND unsubscribed_at
//      IS NULL.
//   4. GET /v1/status/subscribe/unsubscribe?token=... — sets
//      unsubscribed_at; subsequent incident emails skip the row.
//
// Tokens are sha256-hashed at rest (auth-tokens.ts pattern). Plaintext
// confirm + unsubscribe tokens are sent in the URLs of the respective
// emails and never logged.
//
// Email is the natural primary key. Re-subscribing after unsubscribe
// resets confirmed_at + unsubscribed_at + tokens (same row, fresh
// double-opt-in).
export const statusSubscribers = pgTable(
  'status_subscribers',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    /** Null only when V-295c3-tombstone purge has zeroed the email out
     *  (90d post-unsubscribe per Privacy §3.10). PostgreSQL UNIQUE
     *  allows multiple NULLs, so purged rows coexist. */
    email: text('email').unique(),
    /** sha256 hex of confirm-token plaintext. Null after confirmation. */
    confirmTokenHash: text('confirm_token_hash'),
    confirmExpiresAt: timestamp('confirm_expires_at', { withTimezone: true }),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    /** sha256 hex of unsubscribe-token plaintext. Generated at confirm. */
    unsubscribeTokenHash: text('unsubscribe_token_hash'),
    unsubscribedAt: timestamp('unsubscribed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index('status_subscribers_confirmed_idx').on(t.confirmedAt, t.unsubscribedAt),
    index('status_subscribers_unsub_token_idx').on(t.unsubscribeTokenHash),
    index('status_subscribers_confirm_token_idx').on(t.confirmTokenHash),
  ],
);

export type StatusSubscriber = typeof statusSubscribers.$inferSelect;
export type NewStatusSubscriber = typeof statusSubscribers.$inferInsert;

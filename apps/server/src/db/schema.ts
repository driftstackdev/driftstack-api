import { sql } from 'drizzle-orm';
import {
  bigint,
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

export const apiKeyScope = pgEnum('api_key_scope', ['read', 'write', 'admin']);

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

// ───────────────────────────────────────────────────────────────────────────
// Inferred types (for service / route layers)
// ───────────────────────────────────────────────────────────────────────────

export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;

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

import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  numeric,
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
  'solo_manual',
  'team_manual',
  'agency_manual',
  'api_starter',
  'api_builder',
  'api_scale',
  'enterprise',
]);

export const accountStatus = pgEnum('account_status', ['active', 'suspended', 'deleted']);

// V-298b — Stripe-style region codes per founder Tier-2 verdict
// 2026-05-09. Captures a customer-stated data-residency preference
// for future workload routing. Currently informational; the actual
// physical-region routing of compute / storage is governed by the
// sub-processor list (Hetzner DE, Neon Frankfurt, etc.). Customer
// sets via PATCH /v1/account/me; null when unset.
export const accountRegion = pgEnum('account_region', ['us', 'eu', 'apac']);

// V-667.C Verdict 3 — avatar provenance. Set to 'idp' on first OAuth
// link; flipped to 'user' on user-edit. Once 'user', we never re-pull
// from the IDP. Defined here (vs alongside accountOauthLinks below)
// because the accounts table column references it.
export const accountAvatarSource = pgEnum('account_avatar_source', ['none', 'idp', 'user']);

export const apiKeyScope = pgEnum('api_key_scope', [
  'read',
  'write',
  'admin', // V-174 compat alias; deprecated after migration window.
  'account_owner', // V-174 customer-account control.
  'driftstack_internal_admin', // V-174 Driftstack-staff-only.
  'gui_control',
  // V-481 — granular per-resource scopes. Phase 1 schema only;
  // helper-level enforcement lands in Phase 2. Order: verb:resource.
  'read:sessions',
  'write:sessions',
  'read:profiles',
  'write:profiles',
  'admin:profiles',
  'read:webhooks',
  'write:webhooks',
  'admin:webhooks',
  'read:api-keys',
  'admin:api-keys',
  'read:billing',
  'admin:billing',
  'read:audit',
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
  // v2-#4 Q.1.e — one row per ClaudeAgentDecomposer.decompose() or
  // DeterministicAgentDecomposer.decompose() call. Detail (input/
  // output tokens + cost cents + decomposer_kind) lives in the
  // metadata JSONB column added in migration 0046.
  'agent_decomposer',
  // Arc 1 sub-slice 6.4 (v2-#6) — distinct record type for bundled-LLM
  // turns. Per Q5=A, posted cost is a flat $0.10/turn (10 cents) — the
  // actual upstream Anthropic cost is hidden. Sub-slice 6.5 enforces
  // the soft-cap by summing cost_usd_cents over rows of THIS type for
  // the current calendar month against `accounts.bundled_llm_monthly_cap_usd_cents`.
  'agent_decomposer_bundled',
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
  // Arc 5 EGRESS eg.7 — fires when the harness emits an
  // egress.capability_report event for a SOCKS5 session and the
  // control plane ingests it. Migration 0055 ALTERs the existing
  // pgEnum to add this value.
  'session.egress_capability_changed',
  // 2026-05-22 — V-666 crypto-order webhook events (migration 0064).
  // CryptoOrdersService already emits intents on paid/failed
  // transitions; the bootstrap can finally wire the WebhooksService
  // as the emitter sink now that the enum carries these values.
  'crypto.order.paid',
  'crypto.order.failed',
  // W393 — challenge-handling. Fired when the harness ChallengeDetector flags a
  // bot-check + the control plane relays it. Migration 0070 ALTERs the existing
  // pgEnum to add this value.
  'session.challenge_detected',
  // 2026-06-12 — A3 W1364: profile save-back failure relay (migration 0073).
  // Terminal teardown event; the session stays succeeded.
  'session.profile_save_failed',
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
  // 2026-05-22 — hard-delete a DLQ row (migration 0061). Payload is
  // irrecoverable; the audit-log entry is the only forensic trace.
  'webhook_delivery.discarded',
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
  // 2026-05-22 — admin reopen for false-alarm correction / regression
  // discovery (migration 0063).
  'incident.reopened',
  // V-295c3-tombstone: status-page email subscriber admin actions.
  'status_subscriber.force_unsubscribed',
  'status_subscriber.purged',
  // 2026-05-22 — admin force-subscribe (migration 0062). Bypasses
  // double-opt-in when staff has out-of-band consent.
  'status_subscriber.force_subscribed',
  // LK.2: per-Mac LiveKit credential registration (migration 0057).
  'mac_node.livekit_registered',
  // Fleet-admin (§A5) node control: cordon/uncordon/drain/restart (migration 0084).
  'mac_node.control',
  // owner price edit — pricing-as-data master-owner cockpit (migration 0068).
  'pricing.updated',
  // Admin-cockpit secrets Phase A slice 2 (migration 0075): owner
  // secrets-management lifecycle; `secret.revealed` audits every decrypt.
  'secret.created',
  'secret.updated',
  'secret.deleted',
  'secret.revealed',
  // D-025 audit-gap fix (migration 0097): admin-crypto-orders.ts +
  // admin-validation-harness.ts had zero audit wiring despite the D-025
  // "every /v1/admin/* endpoint writes one row" invariant. sweep-expired /
  // apply-ipn / internal-note now audit via crypto_order.*; validation-
  // schedule upsert / remove / trigger via validation_schedule.*.
  'crypto_order.swept',
  'crypto_order.ipn_applied',
  'crypto_order.note_updated',
  'validation_schedule.upserted',
  'validation_schedule.removed',
  'validation_schedule.triggered',
  // GDPR Article 17 admin-triggered account termination (migration 0094).
  // AccountsAdminService.deleteAccount() records this before returning;
  // mirrors the account.suspended / account.unsuspended audit shape.
  'account.deleted',
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
    // 2026-07-01 security fix (migration 0096) — the DEDUP-canonical
    // form of `email` (see canonicalizeEmailForDedup in
    // services/auth-flows.ts): `+tag` subaddressing stripped for every
    // domain + dots ALSO stripped for gmail.com/googlemail.com only.
    // Computed + stored at INSERT time by both real account-creation
    // paths that go through AuthFlowsRepo.createAccount (password
    // signup + OAuth IDP signup); unique-indexed below (when set) so
    // signup's dedup pre-check is a single race-free lookup that finds
    // a Gmail dot/+tag alias collision regardless of which literal
    // variant was registered first (the earlier per-request
    // literal-column re-lookup only caught "canonical form registered
    // first"). Never displayed/emailed — `email` stays the customer's
    // literal entered address.
    //
    // Nullable (not NOT NULL): a couple of narrow dev/test-only direct-
    // insert paths (db/seed.ts's local dev seed; tests/e2e/helpers/
    // seed.ts's e2e account fixture) insert `accounts` rows without
    // going through AuthFlowsRepo.createAccount and so never populate
    // this column — those rows simply don't participate in canonical-
    // email dedup (harmless: they're not customer signups). See the
    // accounts_slug_unique precedent below for the same nullable-
    // unique-when-set pattern.
    canonicalEmail: text('canonical_email'),
    name: text('name'),
    // scrypt-kdf encoded hash of the account password. Nullable: accounts
    // created via magic-link-only flow have no password set until the user
    // chooses to add one. Set via signup or password-reset confirm.
    passwordHash: text('password_hash'),
    // Set when the account holder confirms ownership of `email` by
    // consuming a single-use email_verify_token. Auth gates that require
    // a verified email check `email_verified_at IS NOT NULL`.
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    tier: accountTier('tier').notNull().default('free'),
    status: accountStatus('status').notNull().default('active'),
    // GDPR Article 17 (migration 0094) — set at admin-triggered deletion
    // time (AccountsAdminService.deleteAccount). Nullable: null for every
    // active/suspended account. Powers the account-deletion-purge-
    // sweeper's 30-day-post-termination BYOK Anthropic key purge
    // (privacy-policy.md §3.5 Customer-Provided Secrets + §9 retention).
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    // V-082 / Workstream D — Stripe customer link. Set at first
    // checkout-session create; remains pinned across tier changes
    // (Stripe customer ID is stable for the lifetime of the account).
    stripeCustomerId: text('stripe_customer_id'),
    // V-202c — set to the wall clock when we send `session-failed-first`
    // to this account. Null until the first session.failed ever; one-shot
    // by design (subsequent failures don't email).
    firstFailureEmailSentAt: timestamp('first_failure_email_sent_at', { withTimezone: true }),
    // V-304a — set when we send the `session-success-first` email after
    // the customer's first successful session completes. One-shot
    // (subsequent sessions don't email; the dashboard takes over).
    firstSuccessEmailSentAt: timestamp('first_success_email_sent_at', { withTimezone: true }),
    // 2026-07-01 security fix — set when Postmark reports its
    // PERMANENT `inactive-recipient` suppression state (prior hard
    // bounce / spam complaint) for one of the 3 security-critical
    // templates (signup-verification / password-reset / oauth-
    // pending-verification) sent to this account. Cleared back to
    // null the next time ANY of those 3 templates sends successfully
    // to this account — see EmailService's AccountEmailDeliveryTracker
    // (services/email.ts). Null = delivery believed healthy (the
    // common case). Powers a support/ops-visible "this customer can't
    // receive password-reset/signup/oauth emails" signal that was
    // previously invisible (only an unlabeled aggregate warn-level
    // counter existed).
    emailDeliveryFailedAt: timestamp('email_delivery_failed_at', { withTimezone: true }),
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
    // V-667.C Verdict 3 — where the current avatar value came from.
    // 'none' = no avatar set, 'idp' = pulled from an OAuth IDP at
    // first-link, 'user' = user edited (via avatar upload or display-
    // name change). User-edited values always win; we never re-pull
    // from the IDP after the first link.
    avatarSource: accountAvatarSource('avatar_source').notNull().default('none'),
    // V-298a — readable account handle. Lowercase a-z + 0-9 + hyphen
    // (no leading/trailing hyphen, 3-32 chars). Unique-when-set across
    // all accounts. Nullable on creation; customer sets via PATCH
    // /v1/account/me. Initial use: stable identifier in support /
    // billing / audit references. URL routing semantics (e.g.
    // dashboard.driftstack.dev/<slug>) is a future slice — founder
    // decides whether slugs become public URL components.
    slug: text('slug'),
    // V-298b — Stripe-style data-residency region preference. Customer
    // sets via PATCH /v1/account/me; null = unset (no preference,
    // workload routes through default infra). Currently informational.
    region: accountRegion('region'),
    // AI-CHAT BYOK Anthropic — per-customer encrypted API key
    // (migration 0041; Tier-3 verdicts LOCKED 2026-05-17). AES-256-GCM
    // via the shared MFA_ENCRYPTION_KEY env var. Encoding:
    // `[12 bytes IV | 16 bytes auth tag | N bytes ciphertext]` in the
    // single bytea so the GCM parameters travel with the ciphertext.
    // NULL = no BYOK key set; runtime resolution falls back to the
    // per-request `x-byok-anthropic-api-key` header → then to the
    // deployment fallback `BYOK_ANTHROPIC_FALLBACK_KEY` env var.
    // Account-owner-only (Q3 verdict); team members may USE the
    // resolved key but cannot SET/CLEAR/TEST it.
    byokAnthropicApiKeyCiphertext: customType<{ data: Buffer; driverData: Buffer }>({
      dataType: () => 'bytea',
    })('byok_anthropic_api_key_ciphertext'),
    byokAnthropicApiKeySetAt: timestamp('byok_anthropic_api_key_set_at', {
      withTimezone: true,
    }),
    byokAnthropicApiKeyLastUsedAt: timestamp('byok_anthropic_api_key_last_used_at', {
      withTimezone: true,
    }),
    // v2-#11 — rotation reminder dedupe. Same pattern as
    // webhook_endpoints.last_reminder_sent_at (v2-#10). Daily job
    // sets this to now() when the 90d-rotation reminder email
    // fires. Reset to null on every key set/rotate (the
    // BYOKAnthropicService.setKey path nulls it out so the next
    // expiry cycle can fire reminders again).
    byokAnthropicApiKeyLastReminderSentAt: timestamp(
      'byok_anthropic_api_key_last_reminder_sent_at',
      { withTimezone: true },
    ),
    // Arc 1 sub-slice 6.1 (v2-#6) — bundled-LLM opt-in flag +
    // monthly soft-cap. Founder verdicts 2026-05-18:
    //   Q4=A — BYOK always wins; bundled-LLM only resolves when no
    //          BYOK is configured (or stored BYOK is past v2-#21
    //          TTL) AND `bundledLlmConsent === true`.
    //   Q3=C — $20 default monthly cap (2000 cents). Soft-cap
    //          enforced server-side per calendar month against
    //          usage_records rows with `source = 'agent_decomposer_bundled'`.
    //          PATCH /v1/account/me/bundled-llm-settings (sub-slice
    //          6.6) lets the customer raise / lower in the [$0,$10,000]
    //          range.
    //   Q5=A — actual upstream Anthropic cost hidden; per-turn cost
    //          recorded at a posted flat rate (sub-slice 6.4).
    bundledLlmConsent: boolean('bundled_llm_consent').notNull().default(false),
    bundledLlmMonthlyCapUsdCents: integer('bundled_llm_monthly_cap_usd_cents')
      .notNull()
      .default(2000),
    // Account-level organization TAXONOMY (2026-06-16) — the empty folders
    // (+icons) and tags a customer defines in the GUI rail before assigning
    // them to a profile. Stored per-account so the taxonomy syncs across
    // machines (was local-only in the GUI's Tauri store). Profile-level
    // folder/tags ASSIGNMENT + icon/note live on the profile row (0076/0078);
    // this is just the not-yet-assigned names. `{}` = empty taxonomy.
    organization: jsonb('organization')
      .$type<{ folders?: { name: string; icon?: string }[]; tags?: string[] }>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    uniqueIndex('accounts_email_unique').on(t.email),
    // 2026-07-01 (migration 0096) — the real race-free backstop behind
    // the signup canonical-email dedup pre-check; see canonicalEmail
    // column comment above. Unique-when-set, same NULLs-are-distinct
    // pattern as accounts_slug_unique just below.
    uniqueIndex('accounts_canonical_email_unique').on(t.canonicalEmail),
    // V-298a — unique-when-set. Postgres treats NULLs as distinct in
    // unique indexes by default, so multiple unset slugs coexist;
    // the constraint only fires once a slug is set.
    uniqueIndex('accounts_slug_unique').on(t.slug),
  ],
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

// pricing — owner-editable per-tier monthly price (pricing-as-data Phase A).
// DB source-of-truth for the internal $ values. The PricingService falls back
// to the TIER_MONTHLY_PRICE_CENTS constant when a tier row is absent, and the
// table is SEEDED from those constants in migration 0067, so the DB equals the
// constants on day one and behaviour is unchanged until the owner edits a price.
// One row per paid AccountTier (tier is the PK).
export const pricing = pgTable('pricing', {
  tier: accountTier('tier').primaryKey(),
  monthlyCents: integer('monthly_cents').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
  /** API key id of the owner who last edited this row (null = seeded default). */
  updatedByKeyId: uuid('updated_by_key_id'),
});

// platform_secrets — admin-cockpit secrets Phase A (founder-locked decision 3):
// DB-backed platform secret store, encrypted at rest with the BYOK blob
// pattern ([12 IV | 16 tag | N ct] AES-256-GCM under the shared
// MFA_ENCRYPTION_KEY). `name` is the stable slug PK; ciphertext is NEVER
// returned by list reads (repo list selects metadata only). Owner-gated
// management + audit ride the routes slice. Migration 0074.
export const platformSecrets = pgTable('platform_secrets', {
  name: text('name').primaryKey(),
  description: text('description'),
  ciphertext: customType<{ data: Buffer; driverData: Buffer }>({
    dataType: () => 'bytea',
  })('ciphertext').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
  /** API key id of the owner who last set this secret (null = never set via API). */
  updatedByKeyId: uuid('updated_by_key_id'),
});

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
    archetype: text('archetype').notNull().default('iphone17_ios18_7_safari26_4'),
    description: text('description'),
    // Organization metadata (2026-06-12) — backend half of the GUI's
    // folders/tags surface; caps enforced at the api-types layer
    // (folder ≤32 chars, ≤12 unique tags ≤24 chars each). NULL folder =
    // unfiled. Account-local organization only — deliberately NOT part
    // of the V-480 export envelope or V-666 transfers (a recipient's
    // folder taxonomy is their own).
    folder: text('folder'),
    tags: jsonb('tags')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    // Per-profile UI organization metadata (2026-06-16) — server-side so it
    // syncs per ACCOUNT, not per machine (was local-only in the GUI's Tauri
    // store). icon = short emoji (NULL = monogram); note = short inline
    // annotation, distinct from the longer create-time `description`.
    icon: text('icon'),
    note: text('note'),
    /** Last time a session was created against this profile. Updated by SessionsService at create-time. */
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    // Per-profile sealed-store size (doc-150 item 5) — the byte count of the
    // last saved sealed blob (LZFSE + AES-GCM-256, opaque to the control
    // plane). Persisted best-effort from the harness `profileSaved` frame's
    // `size_bytes` on each save-back. BIGINT: a sealed store can exceed 2GiB
    // (the 2^31 int ceiling). NULL = never saved / a pre-column row / a harness
    // that didn't emit the field (forward-compat). Surfaced to the customer for
    // per-profile storage + an account-wide total; the 1GB/5GB quota
    // enforcement is doc-150 item 6 (not this slice).
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    /** Last time the harness saved this profile's sealed store back (doc-150 item 5). NULL = never saved. */
    lastSavedAt: timestamp('last_saved_at', { withTimezone: true }),
    // Profile-backed sessions (file 57 key hierarchy): the per-profile DEK,
    // wrapped under the account's TMK — base64([iv|tag|ct]), see
    // lib/profile-key-hierarchy.ts. Nullable: NULL when PROFILE_MASTER_KEY is
    // unset (profiles feature inert) or for rows created before this column.
    // The plaintext DEK is NEVER stored; it's re-derived (unwrapped) at
    // session-assign time to ship to the harness.
    wrappedDek: text('wrapped_dek'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    // L4b recycle bin — soft delete. NULL = live profile; non-NULL = trashed
    // (hidden from list/cap/lookup, restorable, purged by the retention job).
    // The DEK stays wrapped-at-rest while trashed; restore re-exposes it,
    // purge hard-deletes the row. All read paths filter `deletedAt IS NULL`.
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    // Partial unique: a name is only reserved among LIVE profiles, so trashing
    // "shopper" frees the name for a new profile while the trashed row keeps it.
    uniqueIndex('profiles_account_name_unique')
      .on(t.accountId, t.name)
      .where(sql`${t.deletedAt} is null`),
    index('profiles_account_idx').on(t.accountId),
  ],
);

// ARC A — per-account customer proxies. A customer registers their own
// SOCKS5/HTTP proxies here so a session can be dispatched through one
// (session-create `proxy_id`). The password is wrapped under the account TMK
// (base64([iv|tag|ct]), see lib/profile-key-hierarchy.ts wrapAccountSecret) and
// is NEVER returned over the API (responses expose `has_password` only).
// host/port/username are not secret. Was client-only (the GUI Tauri store);
// this is the per-account synced superset.
export const accountProxies = pgTable(
  'account_proxies',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    scheme: text('scheme').notNull().default('socks5'),
    host: text('host').notNull(),
    port: integer('port').notNull(),
    username: text('username'),
    // Proxy password wrapped under the account TMK — base64([iv|tag|ct]).
    // NULL = no password (or PROFILE_MASTER_KEY unset → feature inert). The
    // plaintext is never stored; it's unwrapped server-side only at dispatch.
    wrappedPassword: text('wrapped_password'),
    // OVPN/WG arc (0082) — VPN proxies (scheme openvpn|wireguard). The SECRET
    // payload (the .ovpn config_blob, or the WireGuard private_key) wrapped under
    // the account TMK like wrappedPassword; NULL for socks5/http. Never returned.
    wrappedSecret: text('wrapped_secret'),
    // Non-secret structured VPN fields (WireGuard peer_public_key/endpoint/
    // allowed_ips/dns, OpenVPN username). '{}' for socks5/http rows.
    config: jsonb('config')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [index('account_proxies_account_idx').on(t.accountId)],
);

/**
 * V-312 — profile snapshots. Immutable point-in-time copy of a
 * profile's metadata + state at capture time. Per founder Tier-2
 * verdict 2026-05-09: standard pg_dump / GitHub-commit-SHA model —
 * the parent profile keeps evolving independently; the snapshot is
 * frozen.
 *
 * `parent_profile_id` is ON DELETE SET NULL: snapshots survive a
 * parent-profile delete. `account_id` cascades on account delete
 * (the snapshot is the customer's data; if the customer goes, so
 * does the data).
 *
 * `state_blob` is jsonb. v1 is metadata-only (browser state isn't
 * surfaced through the customer API yet); the column exists so a
 * future driver integration can populate it without a migration.
 */
// V-667.C — OAuth-client (sign-in-with-Google/GitHub) tables. Founder
// verdicts 2026-05-15:
//   1. existing-email-collision → merge-with-verification (60-min
//      single-use token sent to existing email, stored in
//      oauth_pending_links).
//   2. IDP revocation → graceful fallback (last_revoked_at marker,
//      never auto-delete-account).
//   3. avatar/name sync → first-link-only + user-overridable (driven
//      by accounts.avatar_source enum NONE/IDP/USER, defined near the
//      accountRegion enum so the accounts table can reference it).
//
// (provider, provider_sub) is the unique IDP identity; one identity
// maps to exactly one Driftstack account, but an account may have
// multiple links (one per provider).
export const accountOauthLinks = pgTable(
  'account_oauth_links',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    providerSub: text('provider_sub').notNull(),
    /** Email returned by the IDP at link-time; informational only,
     *  the trustworthy email lives on accounts.email. */
    providerEmail: text('provider_email'),
    providerName: text('provider_name'),
    providerAvatarUrl: text('provider_avatar_url'),
    linkedAt: timestamp('linked_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    /** V-667.C Verdict 2 — set when the user revokes Driftstack from
     *  their IDP console + we detect it on next login attempt. The
     *  link row stays so an audit trail survives the revoke. */
    lastRevokedAt: timestamp('last_revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    uniqueIndex('account_oauth_links_provider_sub_idx').on(t.provider, t.providerSub),
    index('account_oauth_links_account_idx').on(t.accountId),
  ],
);

// V-667.C Verdict 1 — collision-flow pending links. When an IDP login
// arrives for an email that already has a password account, we stash a
// row here + email the existing account a confirmation link. The user
// clicks → token consumed → matching account_oauth_links row inserted →
// pending row deleted.
export const oauthPendingLinks = pgTable(
  'oauth_pending_links',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    providerSub: text('provider_sub').notNull(),
    providerEmail: text('provider_email').notNull(),
    providerName: text('provider_name'),
    providerAvatarUrl: text('provider_avatar_url'),
    /** sha256 of the plaintext token sent in the email; plaintext is
     *  never stored. Same pattern as auth_flow_tokens. */
    tokenHash: text('token_hash').notNull(),
    /** Server-side cap: 60 min after row creation. */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    uniqueIndex('oauth_pending_links_token_idx').on(t.tokenHash),
    index('oauth_pending_links_account_idx').on(t.accountId),
    index('oauth_pending_links_expires_idx').on(t.expiresAt),
  ],
);

export const profileSnapshots = pgTable(
  'profile_snapshots',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    parentProfileId: uuid('parent_profile_id').references(() => profiles.id, {
      onDelete: 'set null',
    }),
    /** Customer-set short label, max 120 chars. */
    label: text('label').notNull(),
    description: text('description'),
    /** Captured at snapshot time so a future repin of the parent
     *  profile's archetype doesn't mutate this snapshot's identity. */
    parentArchetype: text('parent_archetype').notNull(),
    parentName: text('parent_name').notNull(),
    /** v1: empty object. Forward-compat slot for future state capture. */
    stateBlob: jsonb('state_blob')
      .notNull()
      .default(sql`'{}'::jsonb`),
    capturedAt: timestamp('captured_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index('profile_snapshots_account_idx').on(t.accountId),
    index('profile_snapshots_parent_idx').on(t.parentProfileId),
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

// C6 — per-billing-email dedup ledger. processed_stripe_events dedups a whole
// event, but it is written AFTER the handler's side effects, so a crash
// between a billing email send and that ledger write — or two concurrent
// Stripe deliveries of the same event (at-least-once delivery) — could send
// the SAME receipt / failure / renewal-reminder email twice. A claim-before-
// send row keyed on (stripe_event_id, kind) makes each billing email fire at
// most once (INSERT ... ON CONFLICT DO NOTHING; the winner sends). Append-only
// + tiny; pruning is a future ops concern, not correctness.
export const billingEmailSends = pgTable(
  'billing_email_sends',
  {
    stripeEventId: text('stripe_event_id').notNull(),
    /** 'billing-receipt' | 'billing-failure' | 'billing-renewal-reminder'. */
    kind: text('kind').notNull(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    claimedAt: timestamp('claimed_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [primaryKey({ columns: [t.stripeEventId, t.kind] })],
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
    // V-353b — timestamp of the most recent successful MFA challenge
    // on this session. Null = never satisfied (or pre-MFA session;
    // sessions issued before MFA enrollment lazily satisfy on first
    // post-enrollment request via the auth path). Step-up gates
    // compare `now - mfa_satisfied_at` against the freshness window.
    mfaSatisfiedAt: timestamp('mfa_satisfied_at', { withTimezone: true }),
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

/**
 * V-353b — TOTP enrollment per account. Absent row = MFA not enrolled.
 * Secret is AES-256-GCM-encrypted at rest with the env-supplied
 * `MFA_ENCRYPTION_KEY` (32 bytes base64). Verifier reads ciphertext +
 * iv + tag, decrypts in memory only, computes the 30s/SHA-1/6-digit
 * RFC-6238 windows around `now`, compares constant-time.
 */
export const accountMfa = pgTable('account_mfa', {
  accountId: uuid('account_id')
    .primaryKey()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  totpSecretCiphertext: text('totp_secret_ciphertext').notNull(),
  totpSecretIv: text('totp_secret_iv').notNull(),
  totpSecretTag: text('totp_secret_tag').notNull(),
  enrolledAt: timestamp('enrolled_at', { withTimezone: true }),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  // TOTP replay defence (migration 0090) — the last successfully-consumed TOTP
  // timestep counter (floor(now/30)). verifyCode rejects any code whose matched
  // counter <= this value so each 30s window is single-use across BOTH the
  // login-challenge and the step-up gate. NULL = no TOTP consumed yet under the
  // guard (pre-deploy enrollments; first verify stamps it).
  lastUsedTotpCounter: bigint('last_used_totp_counter', { mode: 'number' }),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

/**
 * V-353b — single-use recovery codes for MFA recovery. 10 issued at
 * enrollment + on regenerate. `code_hash` = scrypt-kdf of the raw
 * code (same KDF as API keys; raw code shown ONCE at issuance).
 * `used_at` non-null = consumed; subsequent attempts on the same
 * row reject. Regenerate = bulk-mark old rows used + insert 10 new.
 */
export const accountMfaRecoveryCodes = pgTable(
  'account_mfa_recovery_codes',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [index('account_mfa_recovery_codes_account_idx').on(t.accountId)],
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
    // C1 — how this key was provisioned. NULL (the default for every
    // existing row) = an ordinary key. `'cli_device'` = minted by the
    // CLI/GUI device-code (cli-authorize) flow; such keys are barred
    // from account-takeover operations (mint/rotate/revoke keys, MFA,
    // team, Stripe billing, webhook writes, BYOK, web-session nuke) by
    // the device-key deny-gate, so a phished device key cannot establish
    // persistence or drain the account.
    provenance: text('provenance'),
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
    // iPhone archetype slug, e.g. "iphone17_ios18_7_safari26_4". See
    // packages/api-types/src/common.ts LOCKED_ARCHETYPE_ID +
    // docs/architecture/archetype-naming-convention.md for shape rationale.
    archetype: text('archetype').notNull().default('iphone17_ios18_7_safari26_4'),
    // V-169 — harness purpose (drives WebKit driver harness selection).
    purpose: sessionPurpose('purpose').notNull().default('production_customer'),
    // Optional client-supplied label.
    label: text('label'),
    // Free-form session metadata supplied by client; bounded at API layer.
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    // Migration 0045 — harness-reported egress capabilities for SOCKS5
    // sessions per cross-agent contract commit 7d5992d9 (+ EG-WK-1.9
    // 2026-05-17 dns_remote_resolve extension). Nullable; populated
    // async after the proxy is wired. See
    // packages/api-types/src/egress.ts EgressCapabilitiesSchema.
    egressCapabilities: jsonb('egress_capabilities').$type<{
      udp_associate: boolean;
      quic_route: 'proxy' | 'direct' | 'disabled';
      dns_remote_resolve: boolean;
      warnings: string[];
    }>(),
    // Arc 5 EGRESS eg.1 — RAW harness-emitted event payload, kept
    // alongside the derived `egressCapabilities` view. Forensics +
    // schema-evolution safety net: if the harness ships a new field
    // before the SDK schema is extended, the unaltered payload
    // preserves it without a backfill. See migration 0054.
    egressCapabilityReport: jsonb('egress_capability_report').$type<Record<string, unknown>>(),
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
    // v2-#4 Q.1.e — opt-in metadata payload. Currently used by
    // `agent_decomposer` rows to carry input/output tokens + cost
    // cents + decomposer_kind discriminator. See migration 0046 for
    // the documented shape.
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
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
    // V-359 — rotation grace period. When customer rotates the
    // signing secret, the OLD secret moves into `secret_prev` and
    // `secret_prev_expires_at` is set to (now + 24h). During the
    // grace, every outbound delivery is signed twice (`v1=<curr>,
    // v1=<prev>`) so the customer's verifier can accept either while
    // they roll the new secret across their own infra. Worker treats
    // a non-null `secret_prev` with `secret_prev_expires_at > now`
    // as "still in grace"; expired-grace rows are eligible for prev
    // cleanup on the next rotate (lazy expiry — no background sweep).
    secretPrev: text('secret_prev'),
    secretPrevExpiresAt: timestamp('secret_prev_expires_at', { withTimezone: true }),
    // v2-#10 — when the active secret was minted. Drives the 90d
    // rotation reminder banner + email. Reset on every rotate. Backfill
    // on existing rows = now() at migration time (so we don't fire a
    // wave of "rotate now" emails on deploy).
    secretCreatedAt: timestamp('secret_created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    // v2-#10 — dedupe column for the daily rotation-reminder job. Null
    // = never sent. Job sets to now() when it fires the email; queries
    // skip rows whose reminder was sent in the last 7d.
    lastReminderSentAt: timestamp('last_reminder_sent_at', { withTimezone: true }),
    // Arc 3 sub-slice 28.1 (v2-#28) — server-initiated 91-day auto-
    // rotation grace window (Q2=B 7 days). Distinct from
    // secretPrevExpiresAt which is the customer-initiated 24h
    // dual-sign window. Both columns can be set simultaneously in
    // theory; the v2-#20 worker reads secretPrevExpiresAt for the
    // legacy path and sub-slice 28.3 reads this column for the
    // force-rotation path.
    graceWindowEndsAt: timestamp('grace_window_ends_at', { withTimezone: true }),
    // Arc 3 sub-slice 28.1 (v2-#28) — stamped when the 91-day auto-
    // rotation fired. Reset to NULL on the next customer-initiated
    // rotation so the 91-day clock restarts cleanly.
    forceRotatedAt: timestamp('force_rotated_at', { withTimezone: true }),
    // Arc 3 sub-slice 28.5 follow-up (v2-#28) — dedupe column for the
    // 24h-before-grace-expiry last-chance email
    // (sendWebhookSecretGraceExpiring). Distinct from forceRotatedAt
    // (stamps the rotation event) and secretCreatedAt (stamps when
    // the active secret was minted): this stamps when the notice was
    // actually SENT. Null = not yet notified for the current grace
    // window. Reset to NULL on every force-rotation (mirrors
    // lastReminderSentAt) so each new 91-day cycle gets its own
    // notification chance.
    graceExpiringNotifiedAt: timestamp('grace_expiring_notified_at', { withTimezone: true }),
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
    // W415 — the worker claim (run_at <= now AND completed_at IS NULL AND
    // failed_at IS NULL ORDER BY run_at FOR UPDATE SKIP LOCKED) is backed by a
    // PARTIAL index `scheduled_jobs_claim_idx (run_at) WHERE completed_at IS NULL
    // AND failed_at IS NULL` (raw SQL, migration 0071) so the claim stays
    // O(due-unfinished) as finished jobs accumulate. drizzle's index() can't
    // express the partial WHERE — same pattern as the agent_sessions
    // idempotency partial-unique in 0047. (A retention sweep for finished jobs
    // is still an open design decision — see the W415 backlog note.)
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

// V-545.B Phase 2 — per-subscriber per-incident throttle marker.
// One row per (subscriber, incident); IncidentNotificationsService
// consults this before dispatching a `status-incident-updated` email
// to enforce the 1-per-hour cap. Cascade-delete from either side so
// purged subscribers / deleted incidents don't leave orphan rows.
// Forward declaration of statusSubscribers reference resolves at
// table-creation time per Drizzle's lazy FK resolution.
export const incidentUpdateNotifications = pgTable(
  'incident_update_notifications',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    subscriberId: uuid('subscriber_id').notNull(),
    incidentId: uuid('incident_id')
      .notNull()
      .references(() => incidents.id, { onDelete: 'cascade' }),
    lastSentAt: timestamp('last_sent_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    // UNIQUE (subscriber_id, incident_id) — one row per pair. Also
    // serves as the lookup index for the throttle check.
    uniqueIndex('incident_update_notifications_unique_idx').on(t.subscriberId, t.incidentId),
  ],
);

export type IncidentUpdateNotification = typeof incidentUpdateNotifications.$inferSelect;
export type NewIncidentUpdateNotification = typeof incidentUpdateNotifications.$inferInsert;

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

// AI-A.b — agent_sessions persistence (migration 0042; schema LOCKED
// 2026-05-17 per orchestrator handoff post-AUTO #1).
//
// text PK matches the existing InMemoryAgentSessionsRepo's
// `agt_<uuid>` minting pattern; jsonb transcript is the append-only
// growth surface mirrored from `recipes.intent_log`. CHECK constraint
// on `status` over a Postgres enum so future status additions ship as
// a constraint-edit migration. Token-budget invariant (remaining ≤
// total) enforced at the DB layer as belt-and-suspenders against
// concurrent debits drift.
export const agentSessions = pgTable(
  'agent_sessions',
  {
    id: text('id').primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    // Strict FK (2026-06-16) — was loose text; now uuid → sessions(id) ON
    // DELETE SET NULL (the agent session outlives a deleted driver session).
    // The route normalizes ses_<uuid>→uuid + validates account ownership.
    driftstackSessionId: uuid('driftstack_session_id').references(() => sessions.id, {
      onDelete: 'set null',
    }),
    status: text('status').notNull(),
    // jsonb transcript — `ReadonlyArray<TranscriptEntry>` at the
    // service layer; Drizzle returns it as `unknown` so the repo
    // casts on read.
    transcript: jsonb('transcript')
      .notNull()
      .default(sql`'[]'::jsonb`),
    tokenBudgetTotal: integer('token_budget_total').notNull(),
    tokenBudgetRemaining: integer('token_budget_remaining').notNull(),
    closedReason: text('closed_reason'),
    // v2-#9 — idempotency key for POST /v1/agent-sessions (Stripe-
    // pattern; partial unique on (account_id, idempotency_key) when
    // key is non-null).
    idempotencyKey: text('idempotency_key'),
    // v2-#9 — team-RBAC attribution. Nullable; populated when the
    // route layer can resolve the calling user / api-key to an
    // account row.
    createdByUserId: uuid('created_by_user_id').references(() => accounts.id, {
      onDelete: 'set null',
    }),
    // v2-#9 — distinct from updatedAt (which moves on every
    // transcript append). Null for active sessions; set once at
    // transition out of `active` status.
    closedAt: timestamp('closed_at', { withTimezone: true }),
    // Arc 2 sub-slice 8.1 (v2-#8) — AI chat + manual side-by-side.
    // Founder verdicts 2026-05-18:
    //   Q2=C — 24h-TTL short-lived gui_control_key per session.
    //   Q3=A — pair_mode_state stored as JSONB so the state-machine
    //          (sub-slice 8.7) can evolve without further migrations.
    // Existing rows pick up mode='ai' from the CHECK default; SDK
    // surfaces the choice at create-time via mode='manual'|'ai'|'pair'.
    pairModeState: jsonb('pair_mode_state'),
    guiControlKeyExpiresAt: timestamp('gui_control_key_expires_at', { withTimezone: true }),
    guiControlKeyCiphertext: customType<{ data: Buffer; driverData: Buffer }>({
      dataType: () => 'bytea',
    })('gui_control_key_ciphertext'),
    mode: text('mode').notNull().default('ai'),
    // 6.c / #15 (migration 0066; default bumped to Opus 4.8 in 0087) — per-
    // session model picker. Which Claude 4.x model the AI agent runs; drives the
    // per-model cost-to-serve rate via the api-types CLAUDE_MODELS registry. New
    // rows default to 'claude-opus-4-8'; 'claude-opus-4-7' stays accepted for
    // back-compat. SDK/dashboard pick at create-time. CHECK lives in the migration.
    model: text('model').notNull().default('claude-opus-4-8'),
    // 2026-06-19 (migration 0086) — which fleet node this session was
    // dispatched to (the FleetControlRegistry key == the authed JWT iss /
    // config.env NODE_ID, with a uuid fallback for legacy uuid-keyed nodes).
    // Written when the sessionAssign is dispatched; NULL until then (and on
    // every no-fleet-CP / prod row). The worker-disconnect reaper closes a
    // node's status='active' sessions by this pointer when the node drops and
    // doesn't reconnect within the grace window, freeing the harness slot in
    // minutes instead of waiting for the 12h orphan_reap backstop. NOT a FK to
    // fleet_nodes (the registry keys by the human node_id, not the uuid PK).
    nodeId: text('node_id'),
    // 2026-06-25 (migration 0089) — which profile this session is running. Set at
    // create-time when the create body carried a profile_id; NULL on ephemeral
    // (no-profile) sessions and on every pre-column row. ON DELETE SET NULL so the
    // session history survives a profile purge (like driftstack_session_id). The
    // out-of-session profile trim consults this to refuse a trim against a profile
    // bound to a still-active session (avoids a two-writer R2 lost-update race).
    profileId: uuid('profile_id').references(() => profiles.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    // v2-#9 list-by-status index. Matches the dashboard's "active
    // agent-sessions" query plan.
    index('agent_sessions_account_status_created_idx').on(t.accountId, t.status, t.createdAt),
    // 2026-06-19 (migration 0086) — partial index backing the worker-disconnect
    // reaper's hot read ("every still-active session for THIS node"). Mirrors the
    // migration's `WHERE status = 'active'`; stays O(active-for-node) as closed
    // rows accumulate.
    index('agent_sessions_node_id_active_idx')
      .on(t.nodeId)
      .where(sql`${t.status} = 'active'`),
    // 2026-06-25 (migration 0089) — partial index backing the trim guard's hot
    // read ("is there a still-active session for THIS profile?"). Mirrors the
    // migration's `WHERE status = 'active'`; stays O(active-for-profile).
    index('agent_sessions_profile_id_active_idx')
      .on(t.profileId)
      .where(sql`${t.status} = 'active'`),
  ],
);

export type AgentSessionRow = typeof agentSessions.$inferSelect;
export type NewAgentSessionRow = typeof agentSessions.$inferInsert;

// V-820 fleet_nodes — design APPROVED AS WRITTEN 2026-05-17
// (orchestrator handoff post-AUTO #1; migration 0043).
//
// Backs FleetNodeAuthImpl's getPublicKey(nodeId) lookup in production.
// public_key_base64url is the natural-unique 32-byte Ed25519 key
// encoded base64url (44 chars including '=' pad). region +
// hardware_class are free-form text (NOT enums per founder verdict —
// operator-controlled set, CHECK enum feels too rigid). Soft delete
// via revoked_at; revoked rows stay so audit trails survive.
export const fleetNodes = pgTable(
  'fleet_nodes',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    publicKeyBase64Url: text('public_key_base64url').notNull(),
    displayName: text('display_name').notNull(),
    region: text('region').notNull(),
    hardwareClass: text('hardware_class').notNull(),
    registeredAt: timestamp('registered_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revocationReason: text('revocation_reason'),
    // LK.1 — per-Mac LiveKit credentials. All-or-none invariant
    // enforced by the migration's fleet_nodes_livekit_all_or_none
    // CHECK constraint. api_secret stored as AES-256-GCM ciphertext
    // under MFA_ENCRYPTION_KEY (same envelope as BYOK Anthropic +
    // gui_control_key); plaintext is never persisted.
    livekitApiKey: text('livekit_api_key'),
    livekitApiSecretCiphertext: text('livekit_api_secret_ciphertext'),
    livekitWsUrl: text('livekit_ws_url'),
    livekitRegisteredAt: timestamp('livekit_registered_at', { withTimezone: true }),
    // Fleet-admin panel (file-48 §A5; migration 0083): latest per-node
    // telemetry snapshot from the heartbeat (host-health + capacity + uptime +
    // drain + session-outcome tally), overwritten each beat. jsonb (not ~12
    // typed columns) so A3's evolving heartbeat shape needs no migration per
    // field; NULL until the first beat is recorded.
    lastHeartbeat: jsonb('last_heartbeat'),
    // Human-readable node identity (migration 0085) — the harness daemon's JWT
    // `iss` (DRIFTSTACK_MAC_NODE_ID, e.g. "mac-macstadium-us-001"). Auth +
    // heartbeat key by this, not the uuid `id`, so a node connects with its
    // natural config.env NODE_ID. NULL for pre-0085 / identity-less rows.
    nodeId: text('node_id'),
  },
  (t) => [
    uniqueIndex('fleet_nodes_public_key_unique').on(t.publicKeyBase64Url),
    // Partial unique (migration 0085): two real nodes can't share a node_id,
    // but identity-less rows (node_id NULL) don't collide.
    uniqueIndex('fleet_nodes_node_id_unique')
      .on(t.nodeId)
      .where(sql`${t.nodeId} IS NOT NULL`),
    // Partial indexes mirror the migration's WHERE revoked_at IS NULL
    // — Drizzle's `.where()` on `index()` produces the partial clause.
    index('fleet_nodes_region_idx')
      .on(t.region)
      .where(sql`${t.revokedAt} IS NULL`),
    index('fleet_nodes_last_seen_at_idx')
      .on(t.lastSeenAt)
      .where(sql`${t.revokedAt} IS NULL`),
    // LK.1 — scheduler-side hot read for the JWT mint path: any
    // non-revoked Mac in a given region with LiveKit credentials
    // registered. The "with livekit" filter is what keeps Macs
    // that haven't run the LK.2 register endpoint yet out of the
    // JWT mint candidate pool.
    index('fleet_nodes_livekit_registered_idx')
      .on(t.region)
      .where(sql`${t.revokedAt} IS NULL AND ${t.livekitApiKey} IS NOT NULL`),
  ],
);

export type FleetNodeRow = typeof fleetNodes.$inferSelect;
export type NewFleetNodeRow = typeof fleetNodes.$inferInsert;

// AI-B4 recipes (migration 0044). Mirrors agent_sessions PK pattern
// (text 'rec_<uuid>'). intent_log + transcript_snapshot are jsonb
// arrays; the service layer narrows them to ReadonlyArray<AgentIntent>
// + ReadonlyArray<TranscriptEntry> respectively. agent_session_id is
// nullable + ON DELETE SET NULL so the recipe survives agent-session
// cleanup. CHECK constraints on label (1..120) + description (<=2000)
// match the SQL migration; the InMemoryRecipesRepo's
// validateLabelAndDescription enforces the same at the service layer.
export const recipes = pgTable('recipes', {
  id: text('id').primaryKey(),
  accountId: uuid('account_id')
    .notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  agentSessionId: text('agent_session_id').references(() => agentSessions.id, {
    onDelete: 'set null',
  }),
  label: text('label').notNull(),
  description: text('description'),
  intentLog: jsonb('intent_log').notNull(),
  transcriptSnapshot: jsonb('transcript_snapshot')
    .notNull()
    .default(sql`'[]'::jsonb`),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

export type RecipeRow = typeof recipes.$inferSelect;
export type NewRecipeRow = typeof recipes.$inferInsert;

// Wave 29-400 §8.1 — atlas_priority_events. Tracks each Mac-fork-emitted
// probe signature through its auto-learn lifecycle (emitted → queued →
// bs_in_flight → bs_succeeded → atlas_appended; bs_failed / atlas_failed
// terminal). Source for the admin /atlas-priority-queue page (§8.3) +
// /v1/internal/atlas-priority/* endpoints (§8.2). Migration 0058.
export const atlasPriorityEvents = pgTable(
  'atlas_priority_events',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    opSeqSha: text('op_seq_sha').notNull(),
    opSeqBytesB64: text('op_seq_bytes_b64').notNull(),
    canvasW: integer('canvas_w').notNull(),
    canvasH: integer('canvas_h').notNull(),
    // mime nullable post-migration 0059 — getImageData / readPixels
    // emit raw pixel buffers with no MIME type. §2 toBlob path still
    // populates it.
    mime: text('mime'),
    archetypeId: text('archetype_id').notNull(),
    lastFillText: text('last_fill_text'),
    macLen: integer('mac_len'),
    sessionId: text('session_id').notNull(),
    customerId: text('customer_id').notNull(),
    pageUrl: text('page_url').notNull(),
    // §10 forward-compat discriminator — 8 canvas-readback APIs,
    // CHECK-constrained at the DB per migration 0059. Defaults to
    // 'toBlob' so existing rows + §2 callers stay valid.
    api: text('api')
      .notNull()
      .default('toBlob')
      .$type<
        | 'toDataURL'
        | 'toBlob'
        | 'convertToBlob'
        | 'getImageData'
        | 'readPixels'
        | 'transferToImageBitmap'
        | 'captureStream'
        | 'webgpuReadback'
      >(),
    status: text('status')
      .notNull()
      .$type<
        | 'emitted'
        | 'queued'
        | 'bs_in_flight'
        | 'bs_succeeded'
        | 'bs_failed'
        | 'atlas_appended'
        | 'atlas_failed'
      >(),
    emittedAt: timestamp('emitted_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    bsAutomateSessionId: text('bs_automate_session_id'),
    bsStartedAt: timestamp('bs_started_at', { withTimezone: true }),
    bsCompletedAt: timestamp('bs_completed_at', { withTimezone: true }),
    bsErrorReason: text('bs_error_reason'),
    atlasEntryHash: text('atlas_entry_hash'),
    atlasVersion: text('atlas_version'),
    atlasAppendedAt: timestamp('atlas_appended_at', { withTimezone: true }),
    atlasErrorReason: text('atlas_error_reason'),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index('atlas_priority_events_status_emitted_at_idx').on(t.status, t.emittedAt),
    index('atlas_priority_events_customer_emitted_at_idx').on(t.customerId, t.emittedAt),
    index('atlas_priority_events_session_id_idx').on(t.sessionId),
  ],
);

export type AtlasPriorityEventRow = typeof atlasPriorityEvents.$inferSelect;
export type NewAtlasPriorityEventRow = typeof atlasPriorityEvents.$inferInsert;
export type AtlasPriorityEventStatus =
  | 'emitted'
  | 'queued'
  | 'bs_in_flight'
  | 'bs_succeeded'
  | 'bs_failed'
  | 'atlas_appended'
  | 'atlas_failed';
export type AtlasPriorityEventApi =
  | 'toDataURL'
  | 'toBlob'
  | 'convertToBlob'
  | 'getImageData'
  | 'readPixels'
  | 'transferToImageBitmap'
  | 'captureStream'
  | 'webgpuReadback';

// V-666 — crypto checkout orders backing table. CryptoOrdersService
// upserts the full envelope per state transition; the events[] array
// is stored as JSONB so a single getById returns both the current
// state + complete history. Idempotency tracking lives in the service
// layer (in-memory cache); the row itself is a snapshot of
// order_id → state.
export const cryptoOrders = pgTable(
  'crypto_orders',
  {
    orderId: text('order_id').primaryKey(),
    /**
     * Account that placed the order. Nullable for pre-signup checkouts
     * (V-666 supports anonymous flow → claim on signup).
     */
    accountId: uuid('account_id'),
    product: text('product').notNull(),
    priceCents: integer('price_cents').notNull(),
    priceCurrency: text('price_currency').notNull(),
    paymentId: text('payment_id'),
    // Billing-integrity (#1 crypto-denominated amount reconciliation) — the
    // crypto-denominated quote NowPayments returns at createPayment: pay_amount
    // is the amount owed in pay_currency (e.g. 0.0015 BTC), pay_currency the
    // chain/asset. The IPN's `actually_paid` is ALSO in pay_currency, so the
    // paid-vs-short reconciliation must compare against THIS pay_amount, never
    // the FIAT price_amount (incomparable units). Nullable: the stub provider +
    // legacy rows have no minted quote. Both persisted at createPayment so the
    // first IPN can reconcile against them.
    payAmount: numeric('pay_amount', { precision: 38, scale: 18, mode: 'number' }),
    payCurrency: text('pay_currency'),
    // Billing-integrity (#7 cross-instance idempotency) — the scoped
    // idempotency key (`<account_id|_anon>:<Idempotency-Key>`) that minted this
    // order. A UNIQUE index on it makes duplicate same-key checkouts a DB-level
    // no-op (INSERT ... ON CONFLICT), so concurrent / cross-instance / post-
    // restart retries can't mint multiple orders. Null for orders created
    // without an Idempotency-Key (the unique index is partial: WHERE NOT NULL).
    idempotencyKey: text('idempotency_key'),
    status: text('status')
      .notNull()
      .$type<'pending' | 'confirming' | 'paid' | 'failed' | 'partial' | 'cancelled'>(),
    customerNote: text('customer_note'),
    internalNote: text('internal_note'),
    /** V-666.AT — append-only state-transition log; oldest → newest. */
    events: jsonb('events')
      .notNull()
      .default(sql`'[]'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    accountIdx: index('crypto_orders_account_id_idx').on(table.accountId),
    statusIdx: index('crypto_orders_status_idx').on(table.status),
    createdAtIdx: index('crypto_orders_created_at_idx').on(table.createdAt),
    // Billing-integrity (#7) — partial UNIQUE on the scoped idempotency key so
    // a duplicate same-key checkout INSERT conflicts (ON CONFLICT DO NOTHING),
    // making cross-instance / concurrent retries a no-op instead of minting a
    // second order. Partial (WHERE idempotency_key IS NOT NULL) so the many
    // legacy / no-key orders don't collide on a shared NULL.
    idempotencyKeyUnique: uniqueIndex('crypto_orders_idempotency_key_unique')
      .on(table.idempotencyKey)
      .where(sql`${table.idempotencyKey} IS NOT NULL`),
  }),
);

// Audit-1 C1 — persisted crypto tier entitlement with a term. Crypto tier
// activation used to write only accounts.tier (no mirror row, no expiry), so a
// routine Stripe reconcile (which computes the tier from the Stripe
// subscriptions table only) silently wiped a non-refundable crypto-paid tier.
// One row per paid crypto order records what tier it entitles and until when
// (31 days from the paid instant, stacking for a same-tier re-purchase). The
// Stripe reconcile now floors against the highest-ranked UNEXPIRED entitlement,
// and a sweeper downgrades when the last one lapses. orderId is the idempotency
// arbiter (one entitlement per order); no FK to crypto_orders (mirrors that
// table's deliberately loose coupling — orders survive an account purge,
// entitlements cascade with the account).
export const cryptoEntitlements = pgTable(
  'crypto_entitlements',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    orderId: text('order_id').notNull(),
    tier: accountTier('tier').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** null until the sweeper has processed this entitlement's expiry. */
    expiredProcessedAt: timestamp('expired_processed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    uniqueIndex('crypto_entitlements_order_id_unique').on(t.orderId),
    index('crypto_entitlements_account_idx').on(t.accountId),
    // Sweeper hot path — only rows not yet expiry-processed.
    index('crypto_entitlements_expiry_sweep_idx')
      .on(t.expiresAt)
      .where(sql`${t.expiredProcessedAt} IS NULL`),
  ],
);

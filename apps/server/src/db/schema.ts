import { isNull, sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
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
    // 2026-07-01 security fix (migration 0096, provider scope corrected
    // by migration 0102) — the DEDUP-canonical
    // form of `email` (see canonicalizeEmailForDedup in
    // services/auth-flows.ts): `+tag` subaddressing and dots are stripped
    // for gmail.com/googlemail.com only. Other providers retain the exact
    // local part because RFC 5233 aliases are provider-controlled.
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
    // V-590 — credential epoch shared with web_sessions. Password changes
    // increment this value; session mint + authentication require equality so
    // a refresh racing a password-reset sweep cannot create a successor from
    // pre-reset authority.
    authEpoch: integer('auth_epoch').notNull().default(0),
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
    // T-13 (migration 0117) — the instant the customer first completed the
    // "Get set up" onboarding checklist, or NULL for a customer who never has.
    // Set once by PATCH /v1/account/me {onboarding_completed:true} (write-only-
    // when-NULL, never moved, never cleared) and read by GET /v1/account/me so
    // a fresh install of a finished customer skips the first-run card. NULL is
    // the meaningful "never completed" state the first-run gate keys on.
    onboardingCompletedAt: timestamp('onboarding_completed_at', { withTimezone: true }),
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
    //          6.6) lets the customer set it: a NEW value is at most
    //          $100 (2026-09-19); a value stored above that before then
    //          is kept, and may be lowered but never raised. The column
    //          CHECK keeps the old [$0,$10,000] storage bound.
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
    // Migration 0109 — every arm of the retention purge sweeper starts by
    // finding deleted accounts past their cutoff, and nothing indexed either
    // column: each arm full-scanned accounts on every tick to return, in
    // steady state, no rows. Partial so only deleted accounts are stored and
    // maintained, keeping the ordinary signup path free of write
    // amplification.
    index('accounts_deleted_purge_idx')
      .on(t.deletedAt)
      .where(sql`${t.status} = 'deleted' AND ${t.deletedAt} IS NOT NULL`),
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
// Migration 0129 added the period's START, the billing interval, where the start
// came from and when the mirrored plan last changed. They are kept for display
// and for the period backfill. They are NOT what AI credits are granted from:
// a subscription that says "active" has not necessarily been paid for, so
// grants read `billing_invoice_payments` below.
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
    /** When the current period began, as the subscription event said. NULL when it said nothing. */
    currentPeriodStart: timestamp('current_period_start', { withTimezone: true }),
    /** 'month' | 'year' (BILLING_INTERVALS); NULL for a price the configuration does not name. */
    billingInterval: text('billing_interval'),
    /** 'stripe' | 'derived' (PERIOD_START_SOURCES); NULL with no start. */
    periodStartSource: text('period_start_source'),
    /**
     * The event time this row's plan last CHANGED. NULL on a row written before
     * migration 0129 whose plan has not changed since: when it began is unknown.
     */
    tierSince: timestamp('tier_since', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('subscriptions_stripe_id_unique').on(t.stripeSubscriptionId),
    index('subscriptions_account_idx').on(t.accountId),
    index('subscriptions_status_idx').on(t.status),
    check(
      'subscriptions_billing_interval',
      sql`${t.billingInterval} IS NULL OR ${t.billingInterval} IN ('month', 'year')`,
    ),
    check(
      'subscriptions_period_start_source',
      sql`${t.periodStartSource} IS NULL OR ${t.periodStartSource} IN ('stripe', 'derived')`,
    ),
    check(
      'subscriptions_period_order',
      sql`${t.currentPeriodStart} IS NULL OR ${t.currentPeriodEnd} IS NULL OR ${t.currentPeriodStart} < ${t.currentPeriodEnd}`,
    ),
  ],
);

// billing_invoice_payments — one row per PAID Stripe invoice (migration 0129).
//
// A paid invoice is the only evidence that a billing period was paid for: the
// subscription mirror above turns "active" before the renewal's payment is even
// attempted. The row is written from `invoice.payment_succeeded` and
// `invoice.paid`, keyed on the invoice id, BEFORE the receipt email and before
// the zero-amount return, so a $0 invoice is recorded too. Nothing reads it yet.
// A row is written only for an invoice that was PAID: the period backfill
// requires the invoice to say `status: 'paid'` itself, and the webhook refuses
// one that says it is anything else. No CHECK can hold that (the status is not
// stored), so every future writer must.
//
// The period is the invoice LINE's — never the invoice's own top-level period,
// which on a renewal describes the period that just ended.
//   line_kind = 'period'        the subscription's ordinary (non-proration) line
//   line_kind = 'proration_up'  the positive proration line of a paid plan change
//   line_kind = NULL            the invoice could not be tied to a subscription
//                               line: recorded, with no period, covering nothing
// `line_tier` is NULL for a price the configuration does not name.
//
// The CHECKs hold the shape whoever writes: amounts within what was paid, a line
// named whole or not at all, a period that ends after it starts. No trigger and
// no EXCLUDE constraint here; everything the migration creates is mirrored below.
export const billingInvoicePayments = pgTable(
  'billing_invoice_payments',
  {
    stripeInvoiceId: text('stripe_invoice_id').primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    stripeSubscriptionId: text('stripe_subscription_id'),
    billingReason: text('billing_reason'),
    amountPaidMinor: bigint('amount_paid_minor', { mode: 'number' }).notNull(),
    currency: text('currency').notNull(),
    stripePaymentIntentId: text('stripe_payment_intent_id'),
    stripeChargeId: text('stripe_charge_id'),
    /** 'period' | 'proration_up' (BILLING_INVOICE_LINE_KINDS); NULL when no line could be tied. */
    lineKind: text('line_kind'),
    lineStripePriceId: text('line_stripe_price_id'),
    lineTier: accountTier('line_tier'),
    /** 'month' | 'year' (BILLING_INTERVALS). */
    lineInterval: text('line_interval'),
    linePeriodStart: timestamp('line_period_start', { withTimezone: true }),
    linePeriodEnd: timestamp('line_period_end', { withTimezone: true }),
    paidAt: timestamp('paid_at', { withTimezone: true }).notNull(),
    refundedMinor: bigint('refunded_minor', { mode: 'number' }).notNull().default(0),
    disputedMinor: bigint('disputed_minor', { mode: 'number' }).notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index('billing_invoice_payments_coverage_idx')
      .on(t.accountId, t.linePeriodStart, t.linePeriodEnd)
      .where(sql`${t.lineKind} IS NOT NULL`),
    index('billing_invoice_payments_pi_idx')
      .on(t.stripePaymentIntentId)
      .where(sql`${t.stripePaymentIntentId} IS NOT NULL`),
    index('billing_invoice_payments_charge_idx')
      .on(t.stripeChargeId)
      .where(sql`${t.stripeChargeId} IS NOT NULL`),
    check(
      'billing_invoice_payments_amounts',
      sql`${t.amountPaidMinor} >= 0 AND ${t.refundedMinor} BETWEEN 0 AND ${t.amountPaidMinor} AND ${t.disputedMinor} BETWEEN 0 AND ${t.amountPaidMinor}`,
    ),
    check(
      'billing_invoice_payments_line_kind',
      sql`${t.lineKind} IS NULL OR ${t.lineKind} IN ('period', 'proration_up')`,
    ),
    check(
      'billing_invoice_payments_line_shape',
      sql`(${t.lineKind} IS NULL) = (${t.lineTier} IS NULL AND ${t.linePeriodStart} IS NULL AND ${t.linePeriodEnd} IS NULL)`,
    ),
    check(
      'billing_invoice_payments_line_period_known',
      sql`${t.lineKind} IS NULL OR (${t.linePeriodStart} IS NOT NULL AND ${t.linePeriodEnd} IS NOT NULL)`,
    ),
    check(
      'billing_invoice_payments_line_interval',
      sql`${t.lineInterval} IS NULL OR ${t.lineInterval} IN ('month', 'year')`,
    ),
    check(
      'billing_invoice_payments_period',
      sql`${t.linePeriodStart} IS NULL OR ${t.linePeriodEnd} > ${t.linePeriodStart}`,
    ),
  ],
);

export type BillingInvoicePaymentRow = typeof billingInvoicePayments.$inferSelect;

// pricing — owner-editable per-tier monthly price (pricing-as-data Phase A).
// DB source-of-truth for the internal $ values. The PricingService falls back
// to the TIER_MONTHLY_PRICE_CENTS constant when a tier row is absent, and the
// table is SEEDED from those constants in migration 0067, so the DB equals the
// constants on day one and behaviour is unchanged until the owner edits a price.
// One row per paid AccountTier (tier is the PK).
export const pricing = pgTable(
  'pricing',
  {
    tier: accountTier('tier').primaryKey(),
    monthlyCents: integer('monthly_cents').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    /** API key id of the owner who last edited this row (null = seeded default). */
    updatedByKeyId: uuid('updated_by_key_id'),
    /** 0138 — the web session that last edited it, when the owner was signed in
     *  (no FK: the row outlives the session). At most one of the two is set;
     *  written and read through lib/acting-key-columns.ts. */
    updatedByWebSessionId: uuid('updated_by_web_session_id'),
  },
  (t) => [
    check(
      'pricing_at_most_one_actor',
      sql`num_nonnulls(${t.updatedByKeyId}, ${t.updatedByWebSessionId}) <= 1`,
    ),
  ],
);

// platform_secrets — admin-cockpit secrets Phase A (founder-locked decision 3):
// DB-backed platform secret store. Values use an explicit v2 byte prefix plus
// [12 IV | 16 tag | N ct] AES-256-GCM under the shared MFA_ENCRYPTION_KEY, with
// AAD binding each ciphertext to its stable `name` PK and semantic value role.
// Ciphertext is NEVER returned by list reads (repo list selects metadata only).
// Owner-gated management + audit ride the routes slice. Migration 0074 created
// the table; the bounded bootstrap bridge upgrades its prefixless legacy rows.
export const platformSecrets = pgTable(
  'platform_secrets',
  {
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
    /** 0138 — the web session that last set it, when the owner was signed in (no
     *  FK). At most one of the two is set; see lib/acting-key-columns.ts. */
    updatedByWebSessionId: uuid('updated_by_web_session_id'),
  },
  (t) => [
    check(
      'platform_secrets_at_most_one_actor',
      sql`num_nonnulls(${t.updatedByKeyId}, ${t.updatedByWebSessionId}) <= 1`,
    ),
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
    // The column default is tier-blind and is NOT the application's default: since
    // P-15 (2026-09-05) every insert path (profiles AND sessions) resolves the device
    // per tier before it gets here, so this only covers a raw SQL insert that names
    // no archetype.
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
    // T-6 (migration 0116) — the last QUIC verdict a real browsing session
    // measured through THIS proxy, and when. NULL = never measured, which is
    // NOT the same as a measured "no HTTP/3": the client keeps the QUIC mark
    // inferred (never green) until a real 'h3' lands here. Only ever 'h3' or
    // 'h2-only' at the application layer. Written best-effort by the live
    // capabilityReport relay; read by the /proxies list + the /:id/test result.
    quicMeasured: text('quic_measured'),
    quicMeasuredAt: timestamp('quic_measured_at', { withTimezone: true }),
    // N-2 (migration 0119) — the last passive TCP/IP OS fingerprint the CONTROL
    // PLANE observed for THIS proxy's own stack, and when. NULL = never measured,
    // which is NOT the same as a measured "no OS": an absent fingerprint is NOT
    // OBSERVED and must render as "measuring…", never a placeholder OS. The full
    // structured measurement {os, confidence, reason, observed_ip, observed_via}
    // is stored; only the {os, confidence} subset ever crosses to the customer.
    // Written best-effort by the /:id/test route when a SYN was observed (a miss
    // persists nothing); read once at serve time onto the session capability_report.
    osFingerprint: jsonb('os_fingerprint').$type<{
      os: string;
      confidence: string;
      reason: string;
      observed_ip: string;
      observed_via: 'proxy_host' | 'exit_ip';
      // (V-219) The route writes the WHOLE measurement object into this column,
      // these two flags included, and they have been stored ever since the flags
      // existed — the type simply never said so. Optional: a reading written
      // before then has neither, and a reader must treat absent as FALSE. No
      // migration: jsonb needs none, and this declares what the column holds.
      single_host_vantage?: boolean;
      web_port_vantage?: boolean;
    }>(),
    osFingerprintAt: timestamp('os_fingerprint_at', { withTimezone: true }),
    // VPN parity (migration 0120) — the last EXIT IDENTITY a live session OBSERVED
    // through THIS proxy, and when. For a SOCKS5 the desktop client probes the exit
    // from the Mac; for OpenVPN/WireGuard only the fleet can see through the tunnel,
    // so this is the ONLY source of a VPN proxy's location/timezone. Written
    // best-effort by the capabilityReport relay (latest wins) AND by the fleet-vantage
    // proxy Test (`observed_via: 'probe'` — the node probed the exit without a
    // session); read by the /proxies list so the client can show the location and
    // hand the timezone to the next launch. NULL = never observed → render
    // "measuring…", never a placeholder.
    exitObserved: jsonb('exit_observed').$type<{
      ip: string;
      country: string | null;
      timezone: string | null;
      observed_via: 'session' | 'probe';
    }>(),
    exitObservedAt: timestamp('exit_observed_at', { withTimezone: true }),
    // (i) I7 (migration 0122) — WHEN a fleet verdict CONTRADICTED `exitObserved`:
    // the node reached a verdict and the tunnel was down while a stored exit
    // existed. The exit itself is kept (it is still the last thing observed, at
    // its own date); this is the contradiction's date, which the /proxies list
    // surfaces so a client adopting the stored exit on another Mac refuses an
    // observation dated at or before it. Cleared (NULL) by the next exit write —
    // a session's report or a probe that saw an exit — because the tunnel was
    // seen up again. A `not_run` (refusal / could-not-run) measured nothing and
    // never sets it. NULL = never contradicted.
    exitSupersededAt: timestamp('exit_superseded_at', { withTimezone: true }),
    // (migration 0124) — what a proxy TEST last measured about QUIC and UDP
    // through THIS proxy, and when. `quicProbe`: did QUIC relay. `udpProbe`: did
    // the proxy carry UDP. NULL = never measured, which is NOT a measured "no":
    // a stored FALSE is a real negative, and being able to tell the two apart is
    // the whole reason these exist — without it nothing can fill in a missing
    // reading without re-probing a genuine negative forever.
    // ⛔ NOT `quicMeasured` above. That one is "a LIVE SESSION negotiated HTTP/3"
    // and is written by the capabilityReport relay; this is "a Test measured the
    // relay". Two measurements that can honestly disagree, two columns.
    // Written best-effort by the fleet-vantage /:id/test route, ONLY for a leg the
    // node genuinely measured (a skipped leg persists nothing); read by the
    // /proxies list and the /:id/test result.
    quicProbe: boolean('quic_probe'),
    quicProbeAt: timestamp('quic_probe_at', { withTimezone: true }),
    udpProbe: boolean('udp_probe'),
    udpProbeAt: timestamp('udp_probe_at', { withTimezone: true }),
    // ITEM 4 (migration 0123) — when the BACKGROUND freshness refresher last
    // ATTEMPTED this row, success or failure. Both the cooldown clock and the
    // claim: the tick stamps it inside the same statement that selects the row
    // FOR UPDATE SKIP LOCKED, so a second worker can neither claim the row nor
    // find it due again. NULL = never attempted (= due now).
    // ⛔ NOT `updated_at`: a customer relabel or credential rotation bumps that,
    // and an unrelated edit must never schedule a dial through their proxy.
    freshnessAttemptedAt: timestamp('freshness_attempted_at', { withTimezone: true }),
    // ITEM 4 (migration 0123) — consecutive BACKGROUND probe failures, reset to 0
    // by the next success. Nothing customer-facing reads it; it exists only so a
    // SUSTAINED run is distinguishable from one transient miss (the webhooks
    // precedent: recordRetry does not bump consecutive_failures, recordDlq does).
    freshnessConsecutiveFailures: integer('freshness_consecutive_failures').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index('account_proxies_account_idx').on(t.accountId),
    // Matches the freshness due predicate exactly (migration 0123's partial
    // index, scheme IN ('socks5','http') — a VPN row is never refreshed here).
    //
    // ⛔ The `.where()` is the half that used to be missing, and the comment above
    // it asserted the opposite of what the code said: this declared a FULL index
    // while 0123 creates a PARTIAL one. Nothing breaks today (drizzle-kit is not
    // wired, so nothing generates from this file), but this file is the source of
    // truth the moment TD-002 reinstates generation — and schema.ts already
    // records that believing a partial index was full is what produced migration
    // 0071, a duplicate index whose own rationale called a partial index "that
    // full index". Spelled to match the migration's predicate byte for byte.
    index('account_proxies_freshness_due_idx')
      .on(t.freshnessAttemptedAt)
      .where(sql`${t.scheme} IN ('socks5', 'http')`),
  ],
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

// Third-party OAuth 2.0 provider persistence. These tables are deliberately
// separate from account_oauth_links above: links authenticate a Driftstack
// user through Google/GitHub, while these rows let an external application
// obtain a bounded Driftstack API bearer token after customer consent.
// Plaintext client secrets, pending-authorization handles, authorization codes
// and access tokens are never stored. The OAuth store hashes each one-time or
// bearer value before every database write/lookup; only SHA-256 digests land.
export const oauthClients = pgTable(
  'oauth_clients',
  {
    clientId: text('client_id').primaryKey(),
    clientSecretHash: text('client_secret_hash').notNull(),
    redirectUris: text('redirect_uris').array().notNull(),
    label: text('label').notNull(),
    // null means marketplace/global. Deleting a bound account must delete the
    // client; SET NULL would silently widen it into a marketplace client.
    accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    check('oauth_clients_secret_hash_check', sql`${t.clientSecretHash} ~ '^[0-9a-f]{64}$'`),
    index('oauth_clients_account_idx').on(t.accountId),
  ],
);

export const oauthAuthorizations = pgTable(
  'oauth_authorizations',
  {
    authorizationHash: text('authorization_hash').primaryKey(),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: 'cascade' }),
    redirectUri: text('redirect_uri').notNull(),
    state: text('state').notNull(),
    scopes: apiKeyScope('scopes').array().notNull(),
    codeChallenge: text('code_challenge').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    check('oauth_authorizations_hash_check', sql`${t.authorizationHash} ~ '^[0-9a-f]{64}$'`),
    index('oauth_authorizations_client_idx').on(t.clientId),
    index('oauth_authorizations_created_idx').on(t.createdAt),
  ],
);

export const oauthAuthorizationCodes = pgTable(
  'oauth_authorization_codes',
  {
    codeHash: text('code_hash').primaryKey(),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: 'cascade' }),
    redirectUri: text('redirect_uri').notNull(),
    state: text('state').notNull(),
    scopes: apiKeyScope('scopes').array().notNull(),
    codeChallenge: text('code_challenge').notNull(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
  },
  (t) => [
    check('oauth_authorization_codes_hash_check', sql`${t.codeHash} ~ '^[0-9a-f]{64}$'`),
    index('oauth_authorization_codes_client_idx').on(t.clientId),
    index('oauth_authorization_codes_account_idx').on(t.accountId),
    index('oauth_authorization_codes_created_idx').on(t.createdAt),
  ],
);

export const oauthAccessTokens = pgTable(
  'oauth_access_tokens',
  {
    // The same UUID is a backing api_keys authority row. Reusing that
    // identity preserves every existing actor/session foreign-key invariant
    // when an OAuth bearer performs a write, while the oauth_access_tokens
    // row remains the only place its token digest/client binding lives.
    id: uuid('id')
      .primaryKey()
      .references(() => apiKeys.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    scopes: apiKeyScope('scopes').array().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    check('oauth_access_tokens_hash_check', sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`),
    uniqueIndex('oauth_access_tokens_hash_unique').on(t.tokenHash),
    index('oauth_access_tokens_client_idx').on(t.clientId),
    index('oauth_access_tokens_account_idx').on(t.accountId),
    index('oauth_access_tokens_expires_idx').on(t.expiresAt),
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
    // V-590 — account auth_epoch captured at mint. Existing rows migrate at
    // zero alongside accounts, preserving all sessions until the next
    // credential change while making that change an immediate invalidation
    // boundary.
    authEpoch: integer('auth_epoch').notNull().default(0),
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
    // V-726 — which account MINTED this key. For a self-minted key that is the
    // owner; for a team-scoped mint (POST /v1/api-keys with
    // X-Driftstack-Account, admin role) it is the acting MEMBER, while
    // `accountId` stays the owner.
    //
    // Without this there was no link at all between a key and the member who
    // created it, so removing that member left their credential live with full
    // owner authority — a key authenticates as `accountId` and never re-checks
    // the minter's membership (services/auth.ts) — and the owner could not even
    // tell which keys to revoke by hand.
    //
    // ON DELETE SET NULL, not CASCADE: if the member's account is deleted the
    // key must survive (the owner may depend on it) and merely lose its
    // attribution. NULL therefore means "unknown minter", which covers every
    // row written before this column existed.
    createdByAccountId: uuid('created_by_account_id').references(() => accounts.id, {
      onDelete: 'set null',
    }),
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
    // Migration 0111 — partial index backing the team-RBAC "keys created BY this
    // member" read. Mirrors the migration's
    // `WHERE created_by_account_id IS NOT NULL AND revoked_at IS NULL`.
    index('api_keys_account_created_by_idx')
      .on(t.accountId, t.createdByAccountId)
      .where(sql`${t.createdByAccountId} IS NOT NULL AND ${t.revokedAt} IS NULL`),
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
    // The column default is tier-blind and is NOT the application's default: since
    // P-15 (2026-09-05) every insert path (profiles AND sessions) resolves the device
    // per tier before it gets here, so this only covers a raw SQL insert that names
    // no archetype.
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
      // Optional and ABSENT-capable: added after this column already held
      // rows, so an existing row's jsonb blob carries no `safeguards` key at
      // all. NOT migrated — see packages/api-types/src/egress.ts.
      safeguards?: 'passed' | 'failed' | 'unverified';
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
    // 0113 — the audit archive filters on created_at alone.
    index('session_events_created_idx').on(t.createdAt),
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
    // Versioned AES-256-GCM text envelope in production. The repository
    // decrypts only at the worker/service boundary for signing; legacy D-023
    // plaintext rows are readable solely for bounded bootstrap conversion.
    secret: text('secret').notNull(),
    // First 12 chars of the plaintext, for display in lists / logs.
    secretPrefix: text('secret_prefix').notNull(),
    // V-359 — rotation grace period. When customer rotates the
    // signing secret, the OLD encrypted envelope moves into `secret_prev` and
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
    // 0113 — the audit archive filters on created_at alone.
    index('webhook_deliveries_created_idx').on(t.createdAt),
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
    // The API key that acted — or, from 0138, null when the admin was signed in
    // with a web session, which `adminWebSessionId` then names. Exactly one of
    // the two is set (CHECK below); see lib/acting-key-columns.ts.
    adminKeyId: uuid('admin_key_id').references(() => apiKeys.id, { onDelete: 'restrict' }),
    // No FK: the audit row outlives the session it names.
    adminWebSessionId: uuid('admin_web_session_id'),
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
    // 0113 — the audit archive filters on timestamp alone.
    index('admin_audit_log_timestamp_idx').on(t.timestamp),
    check(
      'admin_audit_log_one_actor',
      sql`num_nonnulls(${t.adminKeyId}, ${t.adminWebSessionId}) = 1`,
    ),
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
    // The API key that set it, or (0138) null when a web session did, which
    // `setByWebSessionId` then names (no FK). Exactly one is set.
    setByKeyId: uuid('set_by_key_id').references(() => apiKeys.id, { onDelete: 'restrict' }),
    setByWebSessionId: uuid('set_by_web_session_id'),
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
    check(
      'rate_limit_overrides_one_actor',
      sql`num_nonnulls(${t.setByKeyId}, ${t.setByWebSessionId}) = 1`,
    ),
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
    // 0113 — the audit archive filters on accepted_at alone.
    index('legal_acceptances_accepted_idx').on(t.acceptedAt),
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
    /** 0138 — the web session that acted, when the actor was signed in rather than
     *  using a key (no FK). Never published: the customer's `actor_key_id` stays
     *  null for such a row. At most one of the two is set. */
    actorWebSessionId: uuid('actor_web_session_id'),
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
    check(
      'account_audit_log_at_most_one_actor',
      sql`num_nonnulls(${t.actorKeyId}, ${t.actorWebSessionId}) <= 1`,
    ),
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
    // Both of these are PARTIAL in the database and were declared here as if
    // they covered the whole table. Migration 0021 created them
    // `WHERE completed_at IS NULL AND failed_at IS NULL` precisely so the worker
    // claim (run_at <= now AND completed_at IS NULL AND failed_at IS NULL
    // ORDER BY run_at FOR UPDATE SKIP LOCKED) stays O(due-unfinished) as
    // finished jobs accumulate.
    //
    // The note that used to sit here said drizzle's index() "can't express the
    // partial WHERE". It can, and does — five indexes in this file use
    // `.where()`. Believing otherwise is what produced migration 0071, which
    // added `scheduled_jobs_claim_idx` as a byte-identical second copy of
    // `scheduled_jobs_due_idx` to solve a problem 0021 had already solved; its
    // rationale describes the existing index as "that full index", which it
    // never was. Migration 0112 drops the duplicate.
    index('scheduled_jobs_due_idx')
      .on(t.runAt)
      .where(sql`${t.completedAt} IS NULL AND ${t.failedAt} IS NULL`),
    index('scheduled_jobs_account_type_pending_idx')
      .on(t.accountId, t.jobType)
      .where(sql`${t.completedAt} IS NULL AND ${t.failedAt} IS NULL`),
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
    /** Null when auto-created by health probe poller; see above. From 0138 also
     *  null when the admin was signed in with a web session, which
     *  `createdByAdminWebSessionId` then names (no FK). At most one is set. */
    createdByAdminKeyId: uuid('created_by_admin_key_id').references(() => apiKeys.id, {
      onDelete: 'restrict',
    }),
    createdByAdminWebSessionId: uuid('created_by_admin_web_session_id'),
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
    check(
      'incidents_at_most_one_actor',
      sql`num_nonnulls(${t.createdByAdminKeyId}, ${t.createdByAdminWebSessionId}) <= 1`,
    ),
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
    /** Null when posted by the V-295b auto poller; see above. From 0138 also null
     *  when a web session posted it, which `postedByAdminWebSessionId` names. */
    postedByAdminKeyId: uuid('posted_by_admin_key_id').references(() => apiKeys.id, {
      onDelete: 'restrict',
    }),
    postedByAdminWebSessionId: uuid('posted_by_admin_web_session_id'),
    postedAt: timestamp('posted_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index('incident_updates_incident_id_idx').on(t.incidentId, t.postedAt),
    check(
      'incident_updates_at_most_one_actor',
      sql`num_nonnulls(${t.postedByAdminKeyId}, ${t.postedByAdminWebSessionId}) <= 1`,
    ),
  ],
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
    subscriberId: uuid('subscriber_id')
      .notNull()
      .references(() => statusSubscribers.id, { onDelete: 'cascade' }),
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
// Team RBAC v1 is complete: these tables, TeamMembersService with the
// invite/accept routes, auth-path integration (a member acts as the owner
// account per role), and the customer-dashboard /team UI against /v1/team/*.
//
// V-863 — the per-slice delivery order that used to sit here is gone. It was
// written in the present tense of a single commit ("this commit: tables +
// migration only"), so it aged into a false description of a shipped feature
// and had already been corrected in place once, when its dashboard entry still
// said the UI was mock data. Delivery sequencing is what git history is for.
// What a reader of this file needs is the shape above and whether it is live.

export const teamRole = pgEnum('team_role', ['member', 'admin']);

/**
 * V-1611 #14 — a team as a THING rather than an account id.
 *
 * Before this, `team_members.owner_account_id` and `team_invites.owner_account_id`
 * both pointed at `accounts`, so a team WAS its owner. Two consequences the
 * customer sees: the workspace switcher can only render "Team 3f9a2c1d · admin"
 * because there is no name to show, and one owner can never have two teams.
 *
 * ⚠️ EXPAND PHASE. `owner_account_id` remains on both child tables and remains
 * authoritative; `teamId` below is additive and nullable. Nothing reads it yet.
 * The contract phase — teamId NOT NULL, ownerAccountId dropped — is a separate
 * migration once every reader has moved.
 *
 * ⛔ NO unique constraint on `ownerAccountId`, deliberately: "one owner can
 * never have two teams" is the defect being fixed, so constraining it here
 * would preserve the bug in the schema. The backfill in 0114 is made idempotent
 * by a NOT EXISTS guard instead — verified by running it twice against a seeded
 * database, where the unguarded version turned 3 teams into 6.
 */
export const teams = pgTable(
  'teams',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    name: text('name').notNull(),
    /** Nullable-unique-when-set, mirroring `accounts_slug_unique` exactly.
     *  Whether slugs become public URL components is an open product decision
     *  (see the accounts.slug comment); minting required team slugs here would
     *  quietly settle it. */
    slug: text('slug'),
    ownerAccountId: uuid('owner_account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    uniqueIndex('teams_slug_unique').on(t.slug),
    index('teams_owner_idx').on(t.ownerAccountId),
  ],
);

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
    /** V-1611 #14 — additive forward pointer, backfilled by 0114. NOT yet
     *  authoritative: `ownerAccountId` above is still the source of truth. */
    teamId: uuid('team_id').references(() => teams.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    uniqueIndex('team_members_owner_member_unique').on(t.ownerAccountId, t.memberAccountId),
    index('team_members_member_idx').on(t.memberAccountId),
    index('team_members_team_idx').on(t.teamId),
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
    /** V-1611 #14 — additive forward pointer, backfilled by 0114. NOT yet
     *  authoritative: `ownerAccountId` above is still the source of truth. */
    teamId: uuid('team_id').references(() => teams.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    uniqueIndex('team_invites_token_idx').on(t.inviteTokenHash),
    uniqueIndex('team_invites_owner_email_pending_unique')
      .on(t.ownerAccountId, t.inviteeEmail)
      .where(isNull(t.acceptedAt)),
    index('team_invites_owner_idx').on(t.ownerAccountId, t.acceptedAt),
    index('team_invites_email_idx').on(t.inviteeEmail),
    index('team_invites_team_idx').on(t.teamId),
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
    // 0113 — the V-295c3 purge filters on unsubscribed_at alone. Partial on
    // email IS NOT NULL: rows whose email is already erased are exactly the
    // ones the sweep never needs to see again, and they accumulate forever.
    index('status_subscribers_unsubscribed_purge_idx')
      .on(t.unsubscribedAt)
      .where(sql`${t.email} IS NOT NULL`),
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
    // jsonb transcript — production stores a versioned AES-GCM envelope;
    // bootstrap synchronously CAS-converts legacy plaintext/v1 rows into a
    // purpose/account/session-bound v2 envelope before serving. Ordinary repo
    // reads accept only v2; Drizzle returns jsonb as `unknown` and the repo
    // validates/decrypts it before exposing `ReadonlyArray<TranscriptEntry>`.
    transcript: jsonb('transcript')
      .notNull()
      .default(sql`'[]'::jsonb`),
    tokenBudgetTotal: integer('token_budget_total').notNull(),
    tokenBudgetRemaining: integer('token_budget_remaining').notNull(),
    closedReason: text('closed_reason'),
    // (c) 2026-09-10 — the harness's intermediate `provisioning` detail (e.g.
    // 'vpn_egress_active': tunnel up, browser not attached yet). Set from a
    // `sessionStatus` frame by the owning node, cleared on `active`/terminal.
    provisioningDetail: text('provisioning_detail'),
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
    // 0107 — internal monotonic authority epoch. The DB trigger increments it
    // iff status/mode/pair_mode_state changes, including value-equivalent ABA
    // cycles, while ordinary transcript/accounting writes keep it stable.
    authorityRevision: bigint('authority_revision', { mode: 'number' }).notNull().default(0),
    // 0101 — latest ownership-validated harness errorEvent. The producer emits
    // it after the terminal sessionStatus, so it must outlive process restarts
    // and remain readable on a closed agent session.
    lastErrorEvent: jsonb('last_error_event'),
    guiControlKeyExpiresAt: timestamp('gui_control_key_expires_at', { withTimezone: true }),
    guiControlKeyCiphertext: customType<{ data: Buffer; driverData: Buffer }>({
      dataType: () => 'bytea',
    })('gui_control_key_ciphertext'),
    mode: text('mode').notNull().default('ai'),
    // 6.c / #15 (migration 0066; default bumped to Opus 4.8 in 0087, to Opus 5
    // in 0115, to Sonnet 5 in 0126) — per-session model picker. Which Claude
    // model the AI agent runs; drives the per-model cost-to-serve rate via the
    // api-types CLAUDE_MODELS registry. New rows default to 'claude-sonnet-5'
    // (see DEFAULT_AGENT_MODEL for why not the most capable model); every
    // earlier id stays accepted for back-compat. SDK/dashboard pick at create-time.
    // ⛔ The allowed SET is a CHECK constraint in the migration, not in this
    // file: adding an id to the TypeScript enum without the matching migration
    // makes the database reject it at session-create time in production.
    model: text('model').notNull().default('claude-sonnet-5'),
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
    // T-6 (migration 0116) — which proxy this session was dispatched through,
    // set at dispatch from the create's proxy_id (NULL for an operator-default
    // egress or a session that named no proxy). Deliberately NOT a FK: the proxy
    // may be a device/operator proxy with no account_proxies row, so a stray
    // uuid is allowed and simply matches no row. The capabilityReport relay
    // reads it to attribute a measured QUIC verdict back to the owned proxy.
    proxyId: uuid('proxy_id'),
    // T-26 (migration 0118) — per-session policy: end the session if its exit IP
    // changes mid-run. Set at create-time from the create body's
    // stop_on_exit_ip_change; NOT NULL DEFAULT false so the response field is
    // always a real boolean. The capabilityReport relay enforces it CP-side.
    stopOnExitIpChange: boolean('stop_on_exit_ip_change').notNull().default(false),
    // T-26 (migration 0118) — the FIRST exit IP a stop-on-change session was
    // observed leaving through, remembered on the row so the "did it change"
    // comparison survives a control-plane restart (the in-memory capability
    // store does not). NULL until the first observation / on non-policy rows.
    firstExitIp: text('first_exit_ip'),
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
    // Migration 0042 — the account-scoped list read, and the harness-side
    // lookup-by-driftstack-session. Both partial forms mirror their migration.
    index('agent_sessions_account_id_idx').on(t.accountId),
    index('agent_sessions_active_idx')
      .on(t.status)
      .where(sql`${t.status} = 'active'`),
    index('agent_sessions_driftstack_session_id_idx')
      .on(t.driftstackSessionId)
      .where(sql`${t.driftstackSessionId} IS NOT NULL`),
    // Migration 0047 — the constraint the `idempotencyKey` comment above has
    // always described ("partial unique on (account_id, idempotency_key) when
    // key is non-null") and which the schema never declared. It is what makes a
    // retried POST /v1/agent-sessions return the first session instead of
    // creating a second billable one.
    uniqueIndex('agent_sessions_idempotency_key_unique')
      .on(t.accountId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} IS NOT NULL`),
    check('agent_sessions_authority_revision_nonnegative', sql`${t.authorityRevision} >= 0`),
  ],
);

export type AgentSessionRow = typeof agentSessions.$inferSelect;
export type NewAgentSessionRow = typeof agentSessions.$inferInsert;

// Durable at-most-once receipts for agent message turns (migration 0103).
// The raw idempotency key is account-scoped and bounded by the shared header
// parser. The terminal public response is application-encrypted before bytea
// storage because it can contain customer-authored/model-authored session data.
export const agentTurnReceipts = pgTable(
  'agent_turn_receipts',
  {
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    idempotencyKey: text('idempotency_key').notNull(),
    agentSessionId: text('agent_session_id')
      .notNull()
      .references(() => agentSessions.id, { onDelete: 'cascade' }),
    requestHash: text('request_hash').notNull(),
    state: text('state').notNull(),
    responseStatus: integer('response_status'),
    responseCiphertext: customType<{ data: Buffer; driverData: Buffer }>({
      dataType: () => 'bytea',
    })('response_ciphertext'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.idempotencyKey] }),
    index('agent_turn_receipts_session_created_idx').on(t.agentSessionId, t.createdAt),
    check('agent_turn_receipts_key_length', sql`length(${t.idempotencyKey}) BETWEEN 1 AND 255`),
    check('agent_turn_receipts_request_hash', sql`${t.requestHash} ~ '^[0-9a-f]{64}$'`),
    check('agent_turn_receipts_state', sql`${t.state} IN ('in_progress', 'completed')`),
    check(
      'agent_turn_receipts_terminal_shape',
      sql`(
        ${t.state} = 'in_progress'
        AND ${t.responseStatus} IS NULL
        AND ${t.responseCiphertext} IS NULL
        AND ${t.completedAt} IS NULL
      ) OR (
        ${t.state} = 'completed'
        AND ${t.responseStatus} BETWEEN 100 AND 599
        AND ${t.responseCiphertext} IS NOT NULL
        AND ${t.completedAt} IS NOT NULL
      )`,
    ),
  ],
);

export type AgentTurnReceiptRow = typeof agentTurnReceipts.$inferSelect;
export type NewAgentTurnReceiptRow = typeof agentTurnReceipts.$inferInsert;

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
// AES-GCM envelopes; the repository decrypts and runtime-validates them as
// ReadonlyArray<AgentIntent> + ReadonlyArray<TranscriptEntry> respectively.
// Legacy plaintext arrays are converted in bounded bootstrap batches.
// agent_session_id is
// nullable + ON DELETE SET NULL so the recipe survives agent-session
// cleanup. CHECK constraints on label (1..120) + description (<=2000)
// match the SQL migration; the InMemoryRecipesRepo's
// validateLabelAndDescription enforces the same at the service layer.
export const recipes = pgTable(
  'recipes',
  {
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
  },
  // Migration 0044 — this table was declared with no index block at all, so
  // both of its reads were undeclared. The partial form mirrors the migration.
  (t) => [
    index('recipes_account_id_idx').on(t.accountId),
    index('recipes_agent_session_id_idx')
      .on(t.agentSessionId)
      .where(sql`${t.agentSessionId} IS NOT NULL`),
  ],
);

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
    // Migration 0058 — the dedup triple. Declared as a constraint because that
    // is what the migration writes; it is what stops one re-emitted probe
    // signature entering the auto-learn queue twice.
    unique('atlas_priority_events_dedup_triple_unique').on(t.opSeqSha, t.archetypeId, t.emittedAt),
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
    // V-725 — hash of the request body that minted this order, so a replay
    // served by the DATABASE can tell whether the caller reused the key with a
    // different body. The in-process cache held this already; the DB path did
    // not, and returned "no mismatch" unconditionally — meaning the ops warning
    // that is this contract's whole mitigation could not fire for any replay
    // after a restart or deploy (when the cache is empty and every replay is
    // served from here). Never returned to customers; it is an internal
    // fingerprint, not order data. NULL for rows written before this column
    // existed, and for orders created without an Idempotency-Key — NULL means
    // "unknown", never "matched".
    idempotencyBodyFingerprint: text('idempotency_body_fingerprint'),
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

/**
 * Durable direct-operation resource (slice 1 — schema + fences; no route yet).
 * Design: `docs/internal/durable-direct-operation-design.md`.
 *
 * `POST /v1/sessions/:id/login` and `/search` run to a 600,000 ms producer wall
 * that no default public path survives (nginx `location /` 60 s, proxied edge
 * ~100–120 s, TS SDK 30 s). The producer is not the problem — the RESPONSE is,
 * and a client that disconnects mid-flight leaves a credential submission
 * outcome-unknown, the one state we may never resolve by retrying. So the
 * outcome becomes a row that outlives the connection.
 *
 * The DDL in `0108_session_operations.sql` is authoritative: it carries CHECK
 * constraints (state machine, terminal shape, hash shapes) that Drizzle cannot
 * express here, and a content-parity guard pins the two together.
 */
export const sessionOperations = pgTable(
  'session_operations',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    /**
     * Binds the operation to ONE driver lifetime, so a settled result can never
     * be applied to a successor session that reused the driver id. NOT NULL
     * because fence 3 (terminal CAS) compares against it on every terminal
     * write — a nullable incarnation would silently disable that fence.
     */
    driverIncarnationId: uuid('driver_incarnation_id').notNull(),
    kind: text('kind').notNull().$type<'login' | 'search'>(),
    status: text('status')
      .notNull()
      .default('queued')
      .$type<'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'expired'>(),
    /** sha256 of the `Idempotency-Key` header. The raw key is never stored. */
    idempotencyKeyHash: text('idempotency_key_hash'),
    /** sha256 over the canonicalised request body; same key + different value ⇒ 409. */
    requestFingerprint: text('request_fingerprint').notNull(),
    /** Validated against the strict login/search response union before write. */
    result: jsonb('result').$type<Record<string, unknown>>(),
    /** RFC 7807, redaction-safe only — never a credential or reflected query. */
    error: jsonb('error').$type<Record<string, unknown>>(),
    /** accepted_at + the SAME 600,000 ms producer constant, never a local invention. */
    deadlineAt: timestamp('deadline_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    settledAt: timestamp('settled_at', { withTimezone: true }),
    resultExpiresAt: timestamp('result_expires_at', { withTimezone: true }),
  },
  (t) => [
    // FENCE 1 — at most one LIVE operation per session. Partial, so a session's
    // unbounded settled history never collides while liveness stays exclusive.
    uniqueIndex('session_operations_one_live_per_session')
      .on(t.sessionId)
      .where(sql`${t.status} IN ('queued', 'running')`),
    // FENCE 2 — a retry after a disconnect returns the SAME operation instead of
    // submitting a second set of credentials. Account-scoped and partial.
    uniqueIndex('session_operations_account_idempotency_key')
      .on(t.accountId, t.idempotencyKeyHash)
      .where(sql`${t.idempotencyKeyHash} IS NOT NULL`),
    index('session_operations_account_created_idx').on(t.accountId, t.createdAt),
    index('session_operations_result_expiry_idx')
      .on(t.resultExpiresAt)
      .where(sql`${t.resultExpiresAt} IS NOT NULL`),
  ],
);

// ───────────────────────────────────────────────────────────────────────────
// agent_turn_telemetry — one content-free diagnostics row per AI message request
// ───────────────────────────────────────────────────────────────────────────
//
// ⛔ NO IDENTIFIER AND NO FREE TEXT, ON PURPOSE. There is no account id, no
// session id and no foreign key: a row cannot be joined back to a customer, so
// the table is safe to aggregate and to show an operator. Every text column
// holds a member of a closed union declared in
// services/agent-turn-telemetry.ts, and migration 0125 repeats each union as a
// CHECK constraint — a later edit that tries to store a URL or a task "for
// debugging" fails the insert instead of leaking.
export const agentTurnTelemetry = pgTable(
  'agent_turn_telemetry',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    occurredAt: timestamp('occurred_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    outcome: text('outcome').notNull(),
    deathReason: text('death_reason').notNull(),
    diedStepIndex: integer('died_step_index'),
    diedStepKind: text('died_step_kind'),
    httpStatus: integer('http_status').notNull(),
    transport: text('transport').notNull(),
    model: text('model').notNull(),
    stepsPlanned: integer('steps_planned').notNull(),
    stepsRun: integer('steps_run').notNull(),
    stepsSucceeded: integer('steps_succeeded').notNull(),
    replans: integer('replans').notNull(),
    modelCalls: integer('model_calls').notNull(),
    recoveredAfterReplan: boolean('recovered_after_replan').notNull(),
    durationMs: integer('duration_ms').notNull(),
    timeToFirstProgressMs: integer('time_to_first_progress_ms'),
    planningMs: integer('planning_ms').notNull(),
    startingBrowserMs: integer('starting_browser_ms').notNull(),
    executingMs: integer('executing_ms').notNull(),
    readingPageMs: integer('reading_page_ms').notNull(),
    answeringMs: integer('answering_ms').notNull(),
    inputTokens: integer('input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    cacheReadTokens: integer('cache_read_tokens').notNull(),
    cacheWriteTokens: integer('cache_write_tokens').notNull(),
    estimatedCostMillicents: bigint('estimated_cost_millicents', { mode: 'number' }).notNull(),
    customerStopped: boolean('customer_stopped').notNull(),
    viewerDisconnected: boolean('viewer_disconnected').notNull(),
  },
  (t) => [
    // Every read is a window over time, and so is the retention prune.
    index('agent_turn_telemetry_occurred_at_idx').on(t.occurredAt),
    // The closed lists, restated from migration 0125 so the schema expresses the
    // invariant it relies on. `agent-turn-telemetry-unions-match-the-migration`
    // holds all three statements — source unions, migration, these — together.
    check(
      'agent_turn_telemetry_outcome',
      sql`${t.outcome} IN ('completed', 'failed', 'halted_for_confirmation', 'clarified', 'refused', 'stopped', 'busy_409', 'conflict_409', 'rate_limited', 'rejected', 'error')`,
    ),
    check(
      'agent_turn_telemetry_death_reason',
      sql`${t.deathReason} IN ('none', 'halted_for_confirmation', 'element_never_appeared_in_retry_budget', 'element_click_intercepted', 'element_not_interactable', 'wait_condition_not_met', 'capture_failed', 'page_load_failed', 'invalid_parameter', 'result_too_large', 'readback_gate_blocked', 'answer_path_failed_after_being_reached', 'turn_errored', 'harness_error_unclassified', 'session_error', 'policy_refused', 'model_refused', 'model_unavailable', 'customer_closed_session', 'control_taken_mid_turn', 'budget_exhausted', 'transcript_limit', 'session_not_active', 'control_unavailable', 'turn_in_progress', 'idempotency_in_progress', 'idempotency_mismatch', 'account_turn_limit', 'rate_limited', 'request_rejected')`,
    ),
    check(
      'agent_turn_telemetry_died_step_kind',
      sql`${t.diedStepKind} IS NULL OR ${t.diedStepKind} IN ('navigate', 'interact', 'wait', 'capture', 'scroll', 'behavioral_pause')`,
    ),
    check('agent_turn_telemetry_transport', sql`${t.transport} IN ('stream', 'json')`),
    check('agent_turn_telemetry_model', sql`${t.model} ~ '^[a-z0-9.-]{1,40}$'`),
    check('agent_turn_telemetry_http_status', sql`${t.httpStatus} BETWEEN 100 AND 599`),
    check(
      'agent_turn_telemetry_counts_nonnegative',
      sql`${t.stepsPlanned} >= 0 AND ${t.stepsRun} >= 0 AND ${t.stepsSucceeded} >= 0 AND ${t.replans} >= 0 AND ${t.modelCalls} >= 0 AND ${t.durationMs} >= 0 AND ${t.inputTokens} >= 0 AND ${t.outputTokens} >= 0 AND ${t.cacheReadTokens} >= 0 AND ${t.cacheWriteTokens} >= 0 AND ${t.estimatedCostMillicents} >= 0`,
    ),
  ],
);

// ───────────────────────────────────────────────────────────────────────────
// credit_rate_cards / credit_rate_card_models — the AI credits rate card (0127)
// ───────────────────────────────────────────────────────────────────────────
//
// What a customer pays per token, per model, in microcredits
// (1 credit = 1,000,000 µcr = US$0.01), by numbered card version. A task pins
// the card in force when it starts. Read through `credit-rate-card-repo.ts`;
// nothing in the product reads it until AI credits are switched on.
//
// ⛔ TRIGGERS DRIZZLE CANNOT EXPRESS — migration 0127 installs them, and
// `a-published-credit-rate-card-can-only-be-withdrawn-before-it-takes-effect`
// (integration) proves each one against a real database:
//
//   credit_rate_cards_guard_trigger        BEFORE INSERT OR UPDATE OR DELETE
//     · INSERT forces `announced_at = now()` and `withdrawn_at = NULL`, so a
//       card can be neither backdated nor born withdrawn.
//     · UPDATE is refused unless it is the one permitted change: withdrawing a
//       card before its `effective_at` (on the clock at that statement),
//       touching no other column. `withdrawn_at` is then set to now() whatever
//       the caller wrote.
//     · DELETE is refused.
//   credit_rate_cards_notice_at_commit     CONSTRAINT TRIGGER AFTER INSERT,
//                                          DEFERRABLE INITIALLY DEFERRED,
//                                          WHEN (NEW.version <> 1)
//     · At COMMIT, refuses a card after version 1 that takes effect less than
//       720 hours after the clock at commit. announced_at is the transaction's
//       START; customers see the card only once it commits, so a transaction
//       held open would otherwise eat into the notice. Publish with a margin.
//     · Not queued at all for version 1, so the migration's launch card leaves
//       no deferred event pending. While one is pending Postgres refuses ALTER
//       TABLE and CREATE INDEX on this table, and the migrator runs a whole
//       batch (every migration, on a database built from zero) in one
//       transaction — `a-later-migration-can-still-alter-the-rate-card-table`
//       (integration) proves a later migration can.
//   credit_rate_cards_withdrawal_at_commit CONSTRAINT TRIGGER AFTER UPDATE,
//                                          DEFERRABLE INITIALLY DEFERRED
//     · At COMMIT, refuses a withdrawal committed at or after `effective_at`:
//       until it commits, readers still see the card in force and a task can
//       be priced on it.
//   credit_rate_card_models_guard_trigger  BEFORE INSERT OR UPDATE OR DELETE
//     · INSERT only when the card's `announced_at` equals now() — i.e. in the
//       transaction that created the card. Prices are never added later.
//     · UPDATE and DELETE are refused.
//
// The guards raise SQLSTATE 55000; the notice refusal at commit raises 23514,
// as the notice CHECK does. The CHECKs below are restated from 0127 so the
// schema expresses what it relies on; the notice CHECK is in hours on purpose
// (a '30 days' interval is added in the session time zone).
export const creditRateCards = pgTable(
  'credit_rate_cards',
  {
    version: integer('version').primaryKey(),
    /** Markup over list price in basis points (20,000 = 2.0 ×). */
    markupBp: integer('markup_bp').notNull(),
    /** Forced to now() by trigger on insert. */
    announcedAt: timestamp('announced_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    effectiveAt: timestamp('effective_at', { withTimezone: true }).notNull(),
    /** Set only by a withdrawal before `effective_at`; a withdrawn card is never in force. */
    withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
    createdByKeyId: uuid('created_by_key_id'),
    /** 0138 — the web session that published it, when the owner was signed in.
     *  At most one of the two is set, and neither changes on a withdrawal. */
    createdByWebSessionId: uuid('created_by_web_session_id'),
    note: text('note').notNull().default(''),
  },
  (t) => [
    check(
      'credit_rate_cards_at_most_one_actor',
      sql`num_nonnulls(${t.createdByKeyId}, ${t.createdByWebSessionId}) <= 1`,
    ),
    // One live card per instant, so "the card in force" is always one row.
    uniqueIndex('credit_rate_cards_live_effective_unique')
      .on(t.effectiveAt)
      .where(sql`${t.withdrawnAt} IS NULL`),
    check('credit_rate_cards_version_positive', sql`${t.version} >= 1`),
    check('credit_rate_cards_markup_range', sql`${t.markupBp} BETWEEN 10000 AND 100000`),
    check(
      'credit_rate_cards_thirty_days_notice',
      sql`${t.version} = 1 OR ${t.effectiveAt} >= ${t.announcedAt} + interval '720 hours'`,
    ),
    check(
      'credit_rate_cards_withdraw_before_effective',
      sql`${t.withdrawnAt} IS NULL OR ${t.withdrawnAt} < ${t.effectiveAt}`,
    ),
  ],
);

export type CreditRateCardRow = typeof creditRateCards.$inferSelect;

export const creditRateCardModels = pgTable(
  'credit_rate_card_models',
  {
    version: integer('version')
      .notNull()
      .references(() => creditRateCards.version, { onDelete: 'restrict' }),
    model: text('model').notNull(),
    inputMicroPerToken: bigint('input_micro_per_token', { mode: 'number' }).notNull(),
    outputMicroPerToken: bigint('output_micro_per_token', { mode: 'number' }).notNull(),
    cacheReadMicroPerToken: bigint('cache_read_micro_per_token', { mode: 'number' }).notNull(),
    cacheWrite5mMicroPerToken: bigint('cache_write_5m_micro_per_token', {
      mode: 'number',
    }).notNull(),
    cacheWrite1hMicroPerToken: bigint('cache_write_1h_micro_per_token', {
      mode: 'number',
    }).notNull(),
    minStartMicro: bigint('min_start_micro', { mode: 'number' }).notNull(),
    maxReserveMicro: bigint('max_reserve_micro', { mode: 'number' }).notNull(),
    listInputMicrocentsPerToken: bigint('list_input_microcents_per_token', {
      mode: 'number',
    }).notNull(),
    listOutputMicrocentsPerToken: bigint('list_output_microcents_per_token', {
      mode: 'number',
    }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.version, t.model] }),
    check(
      'credit_rate_card_models_positive',
      sql`${t.inputMicroPerToken} > 0 AND ${t.outputMicroPerToken} > 0 AND ${t.cacheReadMicroPerToken} >= 0`,
    ),
    check(
      'credit_rate_card_models_cache_order',
      sql`${t.cacheReadMicroPerToken} <= ${t.inputMicroPerToken} AND ${t.inputMicroPerToken} <= ${t.cacheWrite5mMicroPerToken} AND ${t.cacheWrite5mMicroPerToken} <= ${t.cacheWrite1hMicroPerToken}`,
    ),
    check(
      'credit_rate_card_models_reserve',
      sql`${t.minStartMicro} > 0 AND ${t.maxReserveMicro} >= ${t.minStartMicro}`,
    ),
    // Opus runs only on the customer's own key; any id containing "opus" is refused.
    check('credit_rate_card_models_never_opus', sql`${t.model} !~* 'opus'`),
  ],
);

export type CreditRateCardModelDbRow = typeof creditRateCardModels.$inferSelect;

// ───────────────────────────────────────────────────────────────────────────
// credit_accounts / credit_plan_overrides / credit_lots / credit_ledger — the
// AI credits ledger core (0128)
// ───────────────────────────────────────────────────────────────────────────
//
// Amounts are microcredits (1 credit = 1,000,000 µcr = US$0.01). A LOT is one
// grant of credits with a term; the LEDGER is one row per movement, and it is
// the only way a lot's `remaining_micro` or an account's `debt_micro` changes.
// Read and written through `credit-ledger-repo.ts`; nothing in the product
// reads these tables until AI credits are switched on.
//
// ⛔ TRIGGERS DRIZZLE CANNOT EXPRESS — migration 0128 installs them, and the
// integration tests named beside each prove them against a real database with
// raw SQL:
//
//   (Every function below pins `search_path = public, pg_temp`, so a
//   session's temporary table named like a credit table cannot stand in for
//   it inside a guard: pg_temp is otherwise searched first.)
//
//   credit_ledger_apply_trigger        AFTER INSERT ON credit_ledger
//     · First locks the account's credit_accounts row — FOR NO KEY UPDATE for
//       a debt movement, FOR SHARE otherwise — and refuses (23503) a row whose
//       account has none. That lock, held to the end of the transaction, is
//       what makes the COMMIT-time debt check below hold when two connections
//       write at once.
//     · Applies the row: `lot_delta_micro` to its lot's remaining, and
//       `debt_delta_micro` to the account's debt. Refuses (23503) a row naming
//       another account's lot, and (23505) a second funding row — grant,
//       proration grant or top-up — for a lot already funded: a lot is funded
//       once, even when spending has left room under its ceiling. AFTER, so an
//       ON CONFLICT DO NOTHING that inserts nothing applies nothing.
//   credit_ledger_append_only_trigger  BEFORE UPDATE OR DELETE ON credit_ledger
//     · Refuses both (55000), except a DELETE whose account row is already gone
//       — the cascade of a deleted account.
//   credit_lots_guard_trigger          BEFORE INSERT OR UPDATE OR DELETE
//     · INSERT forces `remaining_micro = 0` and `held_micro = 0`: a lot is
//       funded only by its grant row.
//     · UPDATE refuses any change to the terms (id, account, kind, rank, window,
//       grant key, granted, starts, expires, created), a change to
//       `remaining_micro` that is not made by the ledger's apply trigger, a
//       change to `held_micro` that is not made by the holds' apply trigger (a
//       later migration), and un-revoking or re-revoking a revoked lot. "Made by
//       the apply trigger" is two facts: the transaction-local flag it raises
//       AND pg_trigger_depth() >= 2, so a session cannot raise the flag itself
//       and write a balance.
//     · DELETE only when the account row is gone.
//   credit_accounts_guard_trigger      BEFORE INSERT OR UPDATE OR DELETE
//     · INSERT forces `debt_micro = 0`. UPDATE refuses a new `account_id` and
//       a debt change not made by the ledger's apply trigger. DELETE only when
//       the account row is gone (removing the row would forgive its debt).
//   credit_ledger_debt_vs_free         CONSTRAINT TRIGGER AFTER INSERT ON
//                                      credit_ledger, DEFERRABLE INITIALLY
//                                      DEFERRED
//     · At COMMIT, refuses (23514) an account holding debt beside spendable
//       credit (started, unexpired, unrevoked, remaining − held > 0). The
//       reservation holds add a second trigger on the same function. It reads
//       the debt holding the credit row FOR SHARE, so a caller that frees
//       credit without a ledger row (a released hold) waits for a concurrent
//       debt writer instead of reading around it.
//
// Proved by (integration): `a-lot-balance-and-debt-move-only-through-ledger-rows`,
// `the-credit-ledger-is-append-only-and-dies-only-with-its-account`,
// `the-database-refuses-a-malformed-credit-lot-or-ledger-row`,
// `a-ledger-row-applied-twice-changes-the-balance-once-even-when-two-connections-race`,
// `a-charge-beyond-what-a-lot-holds-is-refused-and-the-whole-transaction-rolls-back`,
// `debt-cannot-commit-beside-spendable-credit`.
//
// The CHECKs below are restated from 0128 so the schema expresses what it
// relies on. Two are stated on a neighbouring column rather than the kind, and
// mean the same thing because another CHECK ties the two: a lot's window
// follows `spend_rank = 0` (the monthly and proration kinds), and a debt reason
// follows `debt_delta_micro > 0` (only `debt_incurred`). The top-up term is
// counted in UTC: `timestamptz + interval` counts months and days in the
// session time zone.
export const creditAccounts = pgTable(
  'credit_accounts',
  {
    accountId: uuid('account_id')
      .primaryKey()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    /** 'legacy' | 'credits' — how this account's AI is funded. */
    billingMode: text('billing_mode').notNull().default('legacy'),
    /** 'credits' | 'own_key'; null = automatic (own key when usable, else credits). */
    aiSource: text('ai_source'),
    /** 'cutover' | 'customer' | 'admin'; set together with `aiSourceSetAt`. */
    aiSourceSetBy: text('ai_source_set_by'),
    aiSourceSetAt: timestamp('ai_source_set_at', { withTimezone: true }),
    /** Moves only through credit_ledger; forced to 0 on insert. */
    debtMicro: bigint('debt_micro', { mode: 'number' }).notNull().default(0),
    autoTopUpEnabled: boolean('auto_top_up_enabled').notNull().default(false),
    legacyConsentAtMove: boolean('legacy_consent_at_move'),
    legacyCapCentsAtMove: integer('legacy_cap_cents_at_move'),
    hadStoredKeyAtMove: boolean('had_stored_key_at_move'),
    movedToCreditsAt: timestamp('moved_to_credits_at', { withTimezone: true }),
    movedBackAt: timestamp('moved_back_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index('credit_accounts_credits_mode_idx')
      .on(t.accountId)
      .where(sql`${t.billingMode} = 'credits'`),
    check('credit_accounts_billing_mode', sql`${t.billingMode} IN ('legacy', 'credits')`),
    check(
      'credit_accounts_ai_source',
      sql`${t.aiSource} IS NULL OR ${t.aiSource} IN ('credits', 'own_key')`,
    ),
    check(
      'credit_accounts_ai_source_set_by',
      sql`(${t.aiSourceSetBy} IS NULL) = (${t.aiSourceSetAt} IS NULL) AND (${t.aiSourceSetBy} IS NULL OR ${t.aiSourceSetBy} IN ('cutover', 'customer', 'admin'))`,
    ),
    check('credit_accounts_debt_nonnegative', sql`${t.debtMicro} >= 0`),
    check(
      'credit_accounts_move_snapshot',
      sql`${t.movedToCreditsAt} IS NULL OR (${t.legacyConsentAtMove} IS NOT NULL AND ${t.legacyCapCentsAtMove} IS NOT NULL AND ${t.hadStoredKeyAtMove} IS NOT NULL)`,
    ),
  ],
);

export type CreditAccountRow = typeof creditAccounts.$inferSelect;

// Contract and admin-assigned plans. Never created automatically: an admin sets
// each one. No writer exists yet.
export const creditPlanOverrides = pgTable(
  'credit_plan_overrides',
  {
    accountId: uuid('account_id')
      .primaryKey()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    monthlyCredits: integer('monthly_credits').notNull(),
    ownKeyAllowed: boolean('own_key_allowed').notNull().default(true),
    anchorAt: timestamp('anchor_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    effectiveSince: timestamp('effective_since', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    /** 'contract' | 'admin_tier'. */
    reason: text('reason').notNull(),
    setByKeyId: uuid('set_by_key_id'),
    /** 0138 — the web session that set it, when the admin was signed in. At most
     *  one of the two is set. */
    setByWebSessionId: uuid('set_by_web_session_id'),
    note: text('note').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    check('credit_plan_overrides_credits_range', sql`${t.monthlyCredits} BETWEEN 0 AND 10000000`),
    check('credit_plan_overrides_reason', sql`${t.reason} IN ('contract', 'admin_tier')`),
    check(
      'credit_plan_overrides_ends_after_anchor',
      sql`${t.endsAt} IS NULL OR ${t.endsAt} > ${t.anchorAt}`,
    ),
    check(
      'credit_plan_overrides_at_most_one_actor',
      sql`num_nonnulls(${t.setByKeyId}, ${t.setByWebSessionId}) <= 1`,
    ),
  ],
);

export type CreditPlanOverrideRow = typeof creditPlanOverrides.$inferSelect;

export const creditLots = pgTable(
  'credit_lots',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    /** 'monthly' | 'proration' | 'adjustment' | 'top_up' (CREDIT_LOT_KINDS). */
    kind: text('kind').notNull(),
    /** 0 included, 1 goodwill, 2 bought — lower is spent first. */
    spendRank: smallint('spend_rank').notNull(),
    /**
     * The month window of an included lot (`credit_windows`, declared below).
     * 0130's `credit_lots_window_fk` keys on the window AND this row's account
     * (see the table-level `foreignKey` below), so a lot can only name a window
     * of its own account.
     */
    windowId: uuid('window_id'),
    grantKey: text('grant_key').notNull(),
    grantedMicro: bigint('granted_micro', { mode: 'number' }).notNull(),
    /** Moves only through credit_ledger; forced to 0 on insert. */
    remainingMicro: bigint('remaining_micro', { mode: 'number' }).notNull().default(0),
    /** Moves only through the reservation holds; forced to 0 on insert. */
    heldMicro: bigint('held_micro', { mode: 'number' }).notNull().default(0),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    /**
     * 0137 — what the payment that bought this lot still paid (its amount paid
     * less what had been refunded or disputed), in that invoice's minor units,
     * when the lot was granted. A reversal measures what the lot keeps against
     * it. Written once, with the lot, for a month's lot and a plan-change
     * step's lot a Stripe invoice paid for; NULL for every other lot and for
     * lots written before 0137, which readers take as "the whole payment".
     * Immutable, like every other term of a lot (0137's guard).
     */
    stillPaidMinor: bigint('still_paid_minor', { mode: 'number' }),
  },
  (t) => [
    uniqueIndex('credit_lots_grant_key_unique').on(t.grantKey),
    index('credit_lots_spendable_idx')
      .on(t.accountId, t.spendRank, t.expiresAt, t.startsAt)
      .where(sql`${t.remainingMicro} > ${t.heldMicro}`),
    index('credit_lots_expiry_idx')
      .on(t.expiresAt)
      .where(sql`${t.remainingMicro} > ${t.heldMicro}`),
    // A window has at most one monthly lot (0130).
    uniqueIndex('credit_lots_one_monthly_per_window')
      .on(t.windowId)
      .where(sql`${t.kind} = 'monthly'`),
    // 0130: an included lot names a window of ITS OWN account. The account is
    // part of the key, which is why this is a table-level foreign key and not a
    // `.references()` on the column. MATCH SIMPLE, so a lot with no window
    // (a top-up, an adjustment) satisfies it.
    //
    // Its target, `credit_windows_id_account_unique`, is a table-level UNIQUE
    // CONSTRAINT: 0130 created it as a unique index and 0131 promoted that index
    // in place. As a constraint it is the form PostgreSQL's documentation
    // promises a foreign key may target, and drizzle emits it INSIDE the table
    // rather than after the foreign keys, so `drizzle-kit export` replays.
    foreignKey({
      name: 'credit_lots_window_fk',
      columns: [t.windowId, t.accountId],
      foreignColumns: [creditWindows.id, creditWindows.accountId],
    }).onDelete('cascade'),
    check('credit_lots_kind', sql`${t.kind} IN ('monthly', 'proration', 'adjustment', 'top_up')`),
    check(
      'credit_lots_rank_matches_kind',
      sql`(${t.kind} IN ('monthly', 'proration') AND ${t.spendRank} = 0) OR (${t.kind} = 'adjustment' AND ${t.spendRank} = 1) OR (${t.kind} = 'top_up' AND ${t.spendRank} = 2)`,
    ),
    check(
      'credit_lots_window_iff_included',
      sql`(${t.spendRank} = 0) = (${t.windowId} IS NOT NULL)`,
    ),
    check(
      'credit_lots_granted_whole_credits',
      sql`${t.grantedMicro} > 0 AND ${t.grantedMicro} % 1000000 = 0`,
    ),
    check(
      'credit_lots_remaining_bounds',
      sql`${t.remainingMicro} >= 0 AND ${t.remainingMicro} <= ${t.grantedMicro}`,
    ),
    check(
      'credit_lots_held_bounds',
      sql`${t.heldMicro} >= 0 AND ${t.heldMicro} <= ${t.remainingMicro}`,
    ),
    check('credit_lots_term', sql`${t.startsAt} < ${t.expiresAt}`),
    check(
      'credit_lots_top_up_twelve_months',
      sql`${t.kind} <> 'top_up' OR ${t.expiresAt} <= ((${t.startsAt} AT TIME ZONE 'UTC') + interval '12 months 1 day') AT TIME ZONE 'UTC'`,
    ),
    check(
      'credit_lots_still_paid_nonnegative',
      sql`${t.stillPaidMinor} IS NULL OR ${t.stillPaidMinor} >= 0`,
    ),
  ],
);

export type CreditLotRow = typeof creditLots.$inferSelect;

export const creditLedger = pgTable(
  'credit_ledger',
  {
    /** Append-only, so the identity orders the ledger; the API's entry id. */
    id: bigint('id', { mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    lotId: uuid('lot_id').references(() => creditLots.id, { onDelete: 'cascade' }),
    lotDeltaMicro: bigint('lot_delta_micro', { mode: 'number' }).notNull().default(0),
    debtDeltaMicro: bigint('debt_delta_micro', { mode: 'number' }).notNull().default(0),
    idempotencyKey: text('idempotency_key').notNull(),
    /** The task a charge belongs to (0131's `credit_ledger_reservation_fk`). */
    reservationId: uuid('reservation_id').references(() => creditReservations.id, {
      onDelete: 'cascade',
    }),
    agentSessionId: text('agent_session_id'),
    model: text('model'),
    rateCardVersion: integer('rate_card_version').references(() => creditRateCards.version),
    reason: text('reason'),
    actor: text('actor').notNull().default('system'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    // Idempotency: one row per (account, key). Writers ON CONFLICT DO NOTHING.
    uniqueIndex('credit_ledger_idempotency_unique').on(t.accountId, t.idempotencyKey),
    // Newest first. The migration says `"id" DESC`, which Postgres reads as DESC
    // NULLS FIRST; drizzle's `.desc()` alone renders DESC NULLS LAST, a different
    // index, so the nulls order is stated to match the migration.
    index('credit_ledger_account_idx').on(t.accountId, t.id.desc().nullsFirst()),
    index('credit_ledger_reservation_idx')
      .on(t.reservationId)
      .where(sql`${t.reservationId} IS NOT NULL`),
    index('credit_ledger_lot_idx')
      .on(t.lotId, t.kind)
      .where(sql`${t.lotId} IS NOT NULL`),
    // 0140 — the reversal reads (S17 audit 4, #10): a clawback's collected
    // claims by the clawback id inside `claim:<clawback>:…`, a credit unit's
    // given-back rows by the window id inside `reinstate:window:<window>:…`,
    // and the account's debt movements in order.
    // Each key is read by its prefix as a byte range, hence `text_pattern_ops`.
    index('credit_ledger_claim_clawback_idx')
      .on(t.accountId, t.idempotencyKey.op('text_pattern_ops'))
      .where(sql`starts_with(${t.idempotencyKey}, 'claim:')`),
    index('credit_ledger_giveback_window_idx')
      .on(t.accountId, t.idempotencyKey.op('text_pattern_ops'))
      .where(sql`${t.kind} = 'adjustment' AND starts_with(${t.idempotencyKey}, 'reinstate:')`),
    index('credit_ledger_debt_idx')
      .on(t.accountId, t.id)
      .where(sql`${t.debtDeltaMicro} <> 0`),
    check(
      'credit_ledger_kind',
      sql`${t.kind} IN ('grant', 'proration_grant', 'proration_clawback', 'task_charge', 'expiry', 'refund_clawback', 'debt_incurred', 'debt_repayment', 'adjustment', 'top_up')`,
    ),
    check(
      'credit_ledger_actor',
      sql`${t.actor} IN ('system', 'customer', 'admin', 'stripe', 'crypto')`,
    ),
    check('credit_ledger_lot_presence', sql`(${t.lotId} IS NULL) = (${t.lotDeltaMicro} = 0)`),
    check(
      'credit_ledger_shape',
      sql`(${t.kind} IN ('grant', 'proration_grant', 'top_up') AND ${t.lotDeltaMicro} > 0 AND ${t.debtDeltaMicro} = 0) OR (${t.kind} IN ('task_charge', 'expiry', 'proration_clawback', 'refund_clawback') AND ${t.lotDeltaMicro} < 0 AND ${t.debtDeltaMicro} = 0) OR (${t.kind} = 'debt_incurred' AND ${t.lotDeltaMicro} = 0 AND ${t.debtDeltaMicro} > 0) OR (${t.kind} = 'debt_repayment' AND ${t.lotDeltaMicro} < 0 AND ${t.debtDeltaMicro} = ${t.lotDeltaMicro}) OR (${t.kind} = 'adjustment' AND ${t.debtDeltaMicro} <= 0 AND ((${t.lotDeltaMicro} = 0) <> (${t.debtDeltaMicro} = 0)))`,
    ),
    check(
      'credit_ledger_debt_reason',
      sql`${t.debtDeltaMicro} <= 0 OR (${t.reason} IS NOT NULL AND ${t.reason} IN ('payment_reversed', 'plan_change'))`,
    ),
    check(
      'credit_ledger_task_charge_context',
      sql`${t.kind} <> 'task_charge' OR (${t.reservationId} IS NOT NULL AND ${t.rateCardVersion} IS NOT NULL AND ${t.model} IS NOT NULL)`,
    ),
    check(
      'credit_ledger_idempotency_key_length',
      sql`length(${t.idempotencyKey}) BETWEEN 1 AND 200`,
    ),
  ],
);

export type CreditLedgerRow = typeof creditLedger.$inferSelect;

// ───────────────────────────────────────────────────────────────────────────
// ai_credits_admin_audit_log — a SEPARATE, DARK audit trail for the AI-credits
// admin tools (0134). See the migration's own header for why this is not six
// new `admin_audit_action` values: that enum is published (mirrored exactly in
// `packages/api-types/src/admin.ts`, which ships to npm), and this vocabulary
// is not, for the same reason `AI_CREDITS_PROBLEM_TYPES` is a separate roster
// from `PROBLEM_TYPES`. `action` is a plain `text` column with a CHECK, not a
// pgEnum — nothing outside this database needs to mirror its allowed values.
// ───────────────────────────────────────────────────────────────────────────

export const AI_CREDITS_ADMIN_AUDIT_ACTIONS = [
  'credits.goodwill_granted',
  'credits.debt_forgiven',
  'credits.plan_override_set',
  'credits.plan_override_cleared',
  'rate_card.published',
  'rate_card.withdrawn',
  // S16 (migration 0135) — one account cut over onto credits, or rolled back
  // to legacy. Same table, same reason: the published admin audit vocabulary
  // may not carry these words before launch.
  'credits.cutover_moved',
  'credits.cutover_rolled_back',
] as const;

export const aiCreditsAdminAuditLog = pgTable(
  'ai_credits_admin_audit_log',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    adminAccountId: uuid('admin_account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),
    // 0138 — the API key that acted, or null when a web session did, which
    // `adminWebSessionId` then names (no FK). Exactly one is set.
    adminKeyId: uuid('admin_key_id').references(() => apiKeys.id, { onDelete: 'restrict' }),
    adminWebSessionId: uuid('admin_web_session_id'),
    action: text('action').notNull(),
    targetAccountId: uuid('target_account_id').references(() => accounts.id, {
      onDelete: 'set null',
    }),
    targetResourceId: text('target_resource_id'),
    inputPayload: jsonb('input_payload').$type<Record<string, unknown>>(),
    result: text('result').notNull(),
    ipAddress: text('ip_address'),
    timestamp: timestamp('timestamp', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index('ai_credits_admin_audit_log_admin_idx').on(t.adminAccountId, t.timestamp),
    index('ai_credits_admin_audit_log_target_idx').on(t.targetAccountId, t.timestamp),
    index('ai_credits_admin_audit_log_action_idx').on(t.action, t.timestamp),
    // Widened by migration 0135 (S16) to add the cutover/rollback actions.
    check(
      'ai_credits_admin_audit_log_action_check',
      sql`${t.action} IN ('credits.goodwill_granted', 'credits.debt_forgiven', 'credits.plan_override_set', 'credits.plan_override_cleared', 'rate_card.published', 'rate_card.withdrawn', 'credits.cutover_moved', 'credits.cutover_rolled_back')`,
    ),
    check(
      'ai_credits_admin_audit_log_one_actor',
      sql`num_nonnulls(${t.adminKeyId}, ${t.adminWebSessionId}) = 1`,
    ),
  ],
);

export type AiCreditsAdminAuditLogRow = typeof aiCreditsAdminAuditLog.$inferSelect;

// ───────────────────────────────────────────────────────────────────────────
// credit_windows / credit_window_level_changes / credit_clawbacks — the month
// windows included AI credits are granted into (0130)
// ───────────────────────────────────────────────────────────────────────────
//
// A WINDOW is one stretch of time an account's monthly credits belong to: a
// subscription's paid month, one month of a paid year, a crypto payment's term,
// or a month of a plan an admin set by hand. `natural_*` is the month it is part
// of; `window_*` is the part of that month it covers, shorter when an earlier
// window already covered the start or when what was paid for ends first. Its
// included credits are the `credit_lots` rows that name it. Written through
// `credit-windows-repo.ts`, only while AI credits are switched on.
//
// ⛔ WHAT DRIZZLE CANNOT EXPRESS — migration 0130 installs it, and the
// integration tests named below prove it against a real database with raw SQL:
//
//   credit_windows_no_overlap          EXCLUDE USING gist (account_id WITH =,
//                                      tstzrange(window_start, window_end, '[)')
//                                      WITH &&), on the btree_gist extension
//     · An account's windows never overlap, so one stretch of time is granted at
//       most once however many payment sources cover it. Two windows may touch.
//     · ⛔ Writers insert with ON CONFLICT DO NOTHING and NO conflict target.
//       Only that form arbitrates an exclusion constraint: with a target naming
//       the unique index below, an overlapping insert raises 23P01 and aborts
//       the writer's whole transaction instead of inserting nothing. Drizzle's
//       `.onConflictDoNothing()` with no argument renders the target-less form.
//     · Its backing gist index is not declared here: it is not an index the
//       schema could create, and `db-schema-matches-the-migrations-drizzle` names
//       it as the one index that belongs to an exclusion constraint.
//   credit_windows_guard_trigger       BEFORE INSERT OR UPDATE OR DELETE
//     · INSERT forces `created_at = now()` and `level_seq = 0`, whatever the
//       statement said. With the `credit_windows_started` CHECK that makes
//       "never created ahead of its start" a fact about the database clock.
//     · UPDATE refuses (55000) a change to anything but the level, and a level
//       change that does not raise `level_seq` by exactly one (or a `level_seq`
//       change with no level change). Since 0139 "the level" is the pair of
//       `level_micro` and `undisputed_level_micro` (NULL read as the first).
//     · DELETE only when the account row is gone.
//   credit_window_level_changes_guard_trigger   BEFORE UPDATE OR DELETE
//     · Append-only (55000); a row goes only with its window.
//   credit_clawbacks_guard_trigger     BEFORE UPDATE OR DELETE
//     · UPDATE refuses (55000) any change to the facts, a pending claim that
//       rises, and any state move other than applied → reversed. DELETE only
//       when the account row is gone.
//     · 0132 permits ONE movement it used to refuse, and no other: `debt_micro`
//       may RISE by exactly the amount `pending_micro` FALLS in the same
//       statement — credit the account still owed becoming debt it owes, the sum
//       of the two unchanged. Without it `claimsLeftBecomeDebt` could write the
//       ledger's `debt_incurred` row and NOT the clawback's own record of it, so
//       M6's "forgive the unrepaid debt it created", read off that row, would
//       forgive too little. `debt_micro` still cannot move on its own.
//     · 0133, DOCUMENTATION ONLY: the debt movement and the state move are two
//       independent permissions, so ONE update doing both — pending → debt in
//       the same statement as applied → reversed — passes both and is accepted
//       (measured: applied/pending 6,000,000/debt 0 → reversed/pending 0/debt
//       6,000,000, in one statement). Permitted and harmless today: nothing in
//       the server writes `state = 'reversed'` at all, and the pair still sums
//       to the same amount owed, which is the number M6 reads.
//
//   (Every function pins `search_path = public, pg_temp`.)
//
// Proved by (integration): `an-accounts-credit-windows-never-overlap`,
// `a-credit-window-is-never-created-ahead-of-its-start`,
// `a-credit-window-changes-only-its-level-and-dies-only-with-its-account`,
// `the-database-refuses-a-malformed-credit-window-level-change-or-clawback`.
export const creditWindows = pgTable(
  'credit_windows',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    /** 'stripe_invoice' | 'crypto_entitlement' | 'plan_override'. */
    source: text('source').notNull(),
    /** The Stripe invoice id, the crypto order id, or 'override'. */
    sourceRef: text('source_ref').notNull(),
    naturalStart: timestamp('natural_start', { withTimezone: true }).notNull(),
    naturalEnd: timestamp('natural_end', { withTimezone: true }).notNull(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    windowEnd: timestamp('window_end', { withTimezone: true }).notNull(),
    tier: accountTier('tier').notNull(),
    /**
     * The monthly level this window SHOWS, in microcredits: what its paid
     * coverage earns now, refunds and standing disputes taken off.
     */
    levelMicro: bigint('level_micro', { mode: 'number' }).notNull(),
    /**
     * 0139 — the level the coverage earns with standing disputes LEFT OUT
     * (refunds still taken off): what every grant or take of a plan change or
     * a new month is measured on, so that a won dispute leaves the window
     * exactly where it would have been without it. NULL means the same as
     * `level_micro` (every window written before 0139). It moves only with a
     * level change.
     */
    undisputedLevelMicro: bigint('undisputed_level_micro', { mode: 'number' }),
    /** Rises by one with every level change; forced to 0 on insert. */
    levelSeq: integer('level_seq').notNull().default(0),
    /** Forced to now() on insert. */
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    uniqueIndex('credit_windows_source_month_unique').on(
      t.accountId,
      t.source,
      t.sourceRef,
      t.naturalStart,
    ),
    // The migration says `"window_end" DESC`, which Postgres reads as DESC NULLS
    // FIRST; drizzle's `.desc()` alone renders DESC NULLS LAST, a different index.
    index('credit_windows_account_end_idx').on(t.accountId, t.windowEnd.desc().nullsFirst()),
    // What `credit_lots_window_fk` points at: a window is identified by its id
    // AND its account, so an included lot can only name a window of its own
    // account. Redundant as a key — the id alone is the primary key — and there
    // only so the foreign key can carry the account. 0130 created it as a unique
    // INDEX and 0131 promoted that same index to a unique CONSTRAINT in place,
    // which is the form a foreign key is documented to be allowed to target.
    unique('credit_windows_id_account_unique').on(t.id, t.accountId),
    check(
      'credit_windows_source',
      sql`${t.source} IN ('stripe_invoice', 'crypto_entitlement', 'plan_override')`,
    ),
    check('credit_windows_source_ref_length', sql`length(${t.sourceRef}) BETWEEN 1 AND 200`),
    check(
      'credit_windows_order',
      sql`${t.naturalStart} <= ${t.windowStart} AND ${t.windowStart} < ${t.windowEnd} AND ${t.windowEnd} <= ${t.naturalEnd}`,
    ),
    check('credit_windows_started', sql`${t.windowStart} <= ${t.createdAt}`),
    check('credit_windows_level', sql`${t.levelMicro} >= 0 AND ${t.levelMicro} % 1000000 = 0`),
    check('credit_windows_level_seq', sql`${t.levelSeq} >= 0`),
    check(
      'credit_windows_undisputed_level',
      sql`${t.undisputedLevelMicro} IS NULL OR (${t.undisputedLevelMicro} >= 0 AND ${t.undisputedLevelMicro} % 1000000 = 0)`,
    ),
  ],
);

export type CreditWindowRow = typeof creditWindows.$inferSelect;

// One row per change of a window's level: a plan change (S6) or a refund,
// dispute or won dispute (S17). Append-only.
export const creditWindowLevelChanges = pgTable(
  'credit_window_level_changes',
  {
    windowId: uuid('window_id')
      .notNull()
      .references(() => creditWindows.id, { onDelete: 'cascade' }),
    /** The window's `level_seq` after this change; the first change is 1. */
    seq: integer('seq').notNull(),
    /** 'plan_change' | 'refund' | 'dispute' | 'dispute_reinstated'. */
    reason: text('reason').notNull(),
    fromLevelMicro: bigint('from_level_micro', { mode: 'number' }).notNull(),
    toLevelMicro: bigint('to_level_micro', { mode: 'number' }).notNull(),
    effectiveAt: timestamp('effective_at', { withTimezone: true }).notNull(),
    /**
     * Credits granted (positive) or taken back (negative) for the rest of the
     * window by a plan change. A refund, a dispute or a won dispute records 0:
     * the credits it moved are its clawback's rows (S17).
     */
    deltaMicro: bigint('delta_micro', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    /**
     * 0136 — the coverage the change is attributed to: for a plan change, the
     * coverage that supplied the new level (a Stripe invoice id, a crypto order
     * id, or the override marker); for a refund, a dispute or a won dispute, the
     * invoice or order whose payment moved. A proration lot belongs to the
     * invoice its step names. NULL on rows written before 0136.
     */
    sourceRef: text('source_ref'),
    /**
     * 0139 — the window's UNDISPUTED level before and after the change (see
     * `credit_windows.undisputed_level_micro`): both NULL on a row written
     * before 0139, where it equals the level shown. A change may move only
     * this one — a plan change made while a dispute takes all of the month.
     */
    undisputedFromMicro: bigint('undisputed_from_micro', { mode: 'number' }),
    undisputedToMicro: bigint('undisputed_to_micro', { mode: 'number' }),
    /**
     * 0139 — what the payment the change is attributed to still paid when it
     * was made, refunds taken off, in its minor units: what a later refund
     * measures the change's own grant or take against. NULL for a change that
     * names no Stripe invoice, and on rows written before 0139.
     */
    stillPaidMinor: bigint('still_paid_minor', { mode: 'number' }),
  },
  (t) => [
    primaryKey({ columns: [t.windowId, t.seq] }),
    check('credit_window_level_changes_seq', sql`${t.seq} >= 1`),
    check(
      'credit_window_level_changes_reason',
      sql`${t.reason} IN ('plan_change', 'refund', 'dispute', 'dispute_reinstated')`,
    ),
    check(
      'credit_window_level_changes_levels',
      sql`${t.fromLevelMicro} >= 0 AND ${t.fromLevelMicro} % 1000000 = 0 AND ${t.toLevelMicro} >= 0 AND ${t.toLevelMicro} % 1000000 = 0`,
    ),
    check(
      'credit_window_level_changes_real',
      sql`${t.fromLevelMicro} <> ${t.toLevelMicro} OR ${t.undisputedFromMicro} IS DISTINCT FROM ${t.undisputedToMicro}`,
    ),
    check('credit_window_level_changes_whole', sql`${t.deltaMicro} % 1000000 = 0`),
    check(
      'credit_window_level_changes_undisputed',
      sql`(${t.undisputedFromMicro} IS NULL AND ${t.undisputedToMicro} IS NULL) OR (${t.undisputedFromMicro} >= 0 AND ${t.undisputedFromMicro} % 1000000 = 0 AND ${t.undisputedToMicro} >= 0 AND ${t.undisputedToMicro} % 1000000 = 0)`,
    ),
    check(
      'credit_window_level_changes_still_paid',
      sql`${t.stillPaidMinor} IS NULL OR ${t.stillPaidMinor} >= 0`,
    ),
  ],
);

export type CreditWindowLevelChangeRow = typeof creditWindowLevelChanges.$inferSelect;

// One row per refund, dispute or plan change whose credits were taken back, so
// the same one is applied once. Nothing writes it yet.
export const creditClawbacks = pgTable(
  'credit_clawbacks',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    /** 'plan_change' | 'stripe_refund' | 'stripe_dispute' | 'crypto_refund' | 'admin'. */
    source: text('source').notNull(),
    sourceRef: text('source_ref').notNull(),
    targetKey: text('target_key').notNull(),
    /** A share of what was granted, in parts per million; or `amountMicro`, never both. */
    fractionPpm: integer('fraction_ppm'),
    amountMicro: bigint('amount_micro', { mode: 'number' }),
    /** 'applied' | 'unmatched' | 'reversed'. */
    state: text('state').notNull(),
    clawedMicro: bigint('clawed_micro', { mode: 'number' }),
    /** The shortfall that credits held by running tasks cover; only ever falls. */
    pendingMicro: bigint('pending_micro', { mode: 'number' }).notNull().default(0),
    debtMicro: bigint('debt_micro', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    /**
     * 0139 — the amount a dispute took from its payment, in the payment's minor
     * units, on every row the dispute writes under its own id: what a payment
     * has disputed is the SUM of its standing disputes, each by its id, and the
     * sum can pass what the payment row may hold. NULL on every other row.
     */
    disputedMinor: bigint('disputed_minor', { mode: 'number' }),
    /**
     * 0140 — what the payment's credit had been spent, plus what running tasks
     * held of it, across all of its windows when the reversal that wrote this
     * row was measured: the interim annual cap's consumption, FROZEN (S17 R8).
     * The cap reads the newest standing reversal's figure. NULL on every row no
     * reversal of a payment wrote.
     */
    capSpentMicro: bigint('cap_spent_micro', { mode: 'number' }),
    /** 0140 — the account's newest ledger row id when this clawback was measured. */
    ledgerMark: bigint('ledger_mark', { mode: 'number' }),
    /**
     * 0140 — how much more of the unit's credit may be spent after this take
     * before a claim on held credit left unpaid at settlement stops being owed
     * (S17 R8, audit 4 #3). NULL: the whole of an unpaid claim is owed.
     */
    claimForgiveAfterMicro: bigint('claim_forgive_after_micro', { mode: 'number' }),
  },
  (t) => [
    uniqueIndex('credit_clawbacks_idempotency_unique').on(t.source, t.sourceRef, t.targetKey),
    // 0140 — a give-back's record for a task still running, by the task
    // (`hold:<reservation>:…`): what that task's settlement finishes.
    index('credit_clawbacks_hold_idx')
      .on(t.accountId, t.sourceRef.op('text_pattern_ops'))
      .where(sql`starts_with(${t.sourceRef}, 'hold:')`),
    index('credit_clawbacks_pending_idx')
      .on(t.accountId, t.createdAt)
      .where(sql`${t.pendingMicro} > 0`),
    check(
      'credit_clawbacks_source',
      sql`${t.source} IN ('plan_change', 'stripe_refund', 'stripe_dispute', 'crypto_refund', 'admin')`,
    ),
    check('credit_clawbacks_state', sql`${t.state} IN ('applied', 'unmatched', 'reversed')`),
    check(
      'credit_clawbacks_one_measure',
      sql`(${t.fractionPpm} IS NULL) <> (${t.amountMicro} IS NULL)`,
    ),
    check(
      'credit_clawbacks_fraction',
      sql`${t.fractionPpm} IS NULL OR ${t.fractionPpm} BETWEEN 1 AND 1000000`,
    ),
    check('credit_clawbacks_amount', sql`${t.amountMicro} IS NULL OR ${t.amountMicro} > 0`),
    check('credit_clawbacks_pending', sql`${t.pendingMicro} >= 0`),
    check(
      'credit_clawbacks_applied_shape',
      sql`(${t.state} IN ('applied', 'reversed')) = (${t.clawedMicro} IS NOT NULL AND ${t.debtMicro} IS NOT NULL AND ${t.targetKey} <> 'unmatched')`,
    ),
    // An unmatched record took nothing, so it carries no amounts (the shape above
    // alone would accept one that does, provided its target says 'unmatched').
    check(
      'credit_clawbacks_unmatched_shape',
      sql`${t.state} <> 'unmatched' OR (${t.clawedMicro} IS NULL AND ${t.debtMicro} IS NULL AND ${t.pendingMicro} = 0)`,
    ),
    check('credit_clawbacks_disputed', sql`${t.disputedMinor} IS NULL OR ${t.disputedMinor} >= 0`),
    check('credit_clawbacks_cap_spent', sql`${t.capSpentMicro} IS NULL OR ${t.capSpentMicro} >= 0`),
    check('credit_clawbacks_ledger_mark', sql`${t.ledgerMark} IS NULL OR ${t.ledgerMark} >= 0`),
    check(
      'credit_clawbacks_claim_forgive_after',
      sql`${t.claimForgiveAfterMicro} IS NULL OR ${t.claimForgiveAfterMicro} >= 0`,
    ),
  ],
);

export type CreditClawbackRow = typeof creditClawbacks.$inferSelect;

// ───────────────────────────────────────────────────────────────────────────
// credit_reservations / credit_reservation_holds / credit_model_calls — the
// tasks AI credits are spent through (0131)
// ───────────────────────────────────────────────────────────────────────────
//
// A RESERVATION is one task. Before it runs it sets credits aside: how much, at
// which rate card, in which of the account's three enforced slots, and one HOLD
// per lot the amount was taken from. Held credit is not spendable by anything
// else — not another task, not a clawback, not the expiry sweep — and a hold is
// the only thing that moves `credit_lots.held_micro`. Each MODEL CALL the task
// makes is written before it is sent, with the upper bound it was admitted
// under. Read and written through `credit-reservations-repo.ts`; no route
// reserves yet.
//
// ⛔ TRIGGERS AND PARTIAL INDEXES DRIZZLE CANNOT FULLY EXPRESS — migration 0131
// installs them, and the integration tests named beside each prove them against
// a real database with raw SQL:
//
//   (Every function below pins `search_path = public, pg_temp`.)
//
//   credit_holds_apply_trigger         AFTER INSERT OR UPDATE ON
//                                      credit_reservation_holds
//     · INSERT adds the hold to its lot's `held_micro`, and refuses (23514) a
//       lot that has not STARTED, has expired, is revoked, or belongs to another
//       account. The start is H4: every spendable predicate in the system says
//       `starts_at <= now()`, so a task cannot hold credits of a month that has
//       not begun.
//     · INSERT also refuses (23514) a hold that is BORN RELEASED: the release
//       branch needs `released_at` to have been NULL, so such a row would raise
//       `held_micro` with no path back and the credit would be frozen — not
//       spendable, not expirable, never charged.
//     · 0132: INSERT refuses (23514) a hold whose TASK is not an OPEN ENFORCED
//       one. The lot test above says whose credit it is; this says whether there
//       is still a task to spend it. A hold on a SETTLED task is credit frozen
//       after the fact (the settlement that would have walked it has run, and a
//       settled task is final); a hold on a SHADOW task is credit frozen behind
//       a measurement that holds nothing and releases nothing. Neither was
//       caught before: `credit_check_reservation` returns early for shadow, and
//       UNTIL 0133 no COMMIT-time check fired at all on a statement touching
//       only holds.
//       The task is asked about by ID alone — whether it is this ACCOUNT's task
//       is the composite foreign key's job, and that key answers first (23503).
//       ⛔ The lookup takes `FOR SHARE` on the task row. Unlocked it answered
//       from the inserting transaction's snapshot and nothing re-asked, because
//       a statement touching only holds queued no COMMIT-time check — measured,
//       two sessions: a hold inserted while the task was open committed AFTER a
//       concurrent settle, landing on a settled task with `held_micro` raised
//       and no path back. The row lock makes the hold and the settlement order
//       themselves, in either order, against the same row.
//       ⛔ 0133 DOES NOT MAKE THAT LOCK REDUNDANT, and the difference is the
//       mode. The fourth leg below now re-checks the task from a holds-only
//       statement, so an extra hold on a settled ENFORCED task is refused at
//       COMMIT as well as here — no hold can be added and still leave the holds
//       summing to `reserved_micro`. A hold on a SHADOW task is caught by THIS
//       lookup and by nothing else: `credit_check_reservation` returns before
//       the holds leg for a measurement.
//     · UPDATE takes the hold back off the lot, and ONLY for a release —
//       `released_at` NULL → an instant, with the amount, the lot, the ACCOUNT
//       and the TASK unchanged. Every other update is refused (55000). The
//       account matters because `credit_check_debt_vs_free` below asks about the
//       hold's own `account_id`: a release that re-pointed it at an account
//       owing nothing would free credit beside debt and still pass.
//     · It raises the transaction-local flag 0128's `credit_lots_guard` demands
//       for a `held_micro` change, and that guard also requires
//       pg_trigger_depth() >= 2, so a session cannot raise the flag itself.
//   credit_reservations_guard_trigger  BEFORE UPDATE ON credit_reservations
//     · Refuses (55000) a change to the terms — account, session, request key,
//       model, rate card, mode, slot, reserved amount, lease owner, `max_until`,
//       created — and any update at all to a settled reservation.
//   credit_model_calls_guard_trigger   BEFORE UPDATE ON credit_model_calls
//     · Refuses (55000) a change to the call's identity or its bound, a `sent`
//       that goes back to false, and any update to a settled call.
//   credit_reservations_delete_guard,  BEFORE DELETE, all three tables
//   credit_holds_delete_guard,
//   credit_model_calls_delete_guard
//     · 0128's `credit_rows_die_only_with_their_account`: a row goes only with
//       its account.
//   credit_reservations_balance,       CONSTRAINT TRIGGERS, DEFERRABLE
//   credit_model_calls_balance         INITIALLY DEFERRED
//     · At COMMIT, `credit_check_reservation(rid)` refuses (23514) a reservation
//       whose `committed_micro` is not its calls' bounds and charges, an
//       enforced one whose holds do not sum to exactly what it reserved, and a
//       settled one whose charge is not equal across its calls, its holds and
//       its `task_charge` ledger rows. Deferred because a reservation and its
//       holds — and a settlement's charge, releases and ledger rows — are
//       separate statements in one transaction.
//   credit_holds_debt_vs_free          CONSTRAINT TRIGGER AFTER UPDATE ON
//                                      credit_reservation_holds, DEFERRABLE
//                                      INITIALLY DEFERRED
//     · 0128's `credit_check_debt_vs_free` again: releasing a hold frees credit
//       WITHOUT a ledger row, so it is the second way an account could end a
//       transaction holding debt beside spendable credit.
//   credit_ledger_reservation_balance  CONSTRAINT TRIGGER AFTER INSERT ON
//                                      credit_ledger, DEFERRABLE INITIALLY
//                                      DEFERRED, WHEN reservation_id IS NOT NULL
//     · 0132, the THIRD leg of the same balance. A settled task's charge is one
//       number written into three records — its calls, its holds and its
//       `task_charge` ledger rows — and until 0132 only two of them re-checked
//       it, so a lone ledger row written after a task settled moved credit off a
//       lot with nothing asking whether the three still agreed.
//   credit_holds_reservation_balance   CONSTRAINT TRIGGER AFTER INSERT OR
//                                      UPDATE ON credit_reservation_holds,
//                                      DEFERRABLE INITIALLY DEFERRED
//     · 0133, the FOURTH leg, and the one that had been missing over the very
//       table its rule is about: the check was queued from the calls, the
//       reservation and the ledger, and from nothing that touched only the
//       holds. MEASURED on a database at 0132 — a second hold inserted BY
//       ITSELF onto an open enforced task committed, leaving `reserved_micro`
//       50,000,000 against holds of 60,000,000, while an UPDATE of that same
//       task's `lease_expires_at` then failed at COMMIT with 0131's own message.
//       The rule was there; no holds statement could reach it. The extra hold
//       makes the task UNSETTLEABLE (every settlement fails that same check),
//       so the slot is never freed and the credit is held for ever.
//     · INSERT **OR UPDATE**, the shape 0131 gives the first two legs. A release
//       is the only update a hold may take and it moves neither `held_micro` nor
//       `reserved_micro`, so the UPDATE half can refuse nothing the INSERT half
//       would not; it is wired because the leg is about the STATEMENT SHAPE.
//     · It sorts AFTER `credit_holds_debt_vs_free`, deliberately: row triggers
//       fire in name order and deferred events fire at COMMIT in the order they
//       were queued, so a release that frees credit beside debt still reports
//       the debt refusal, which is the one pinned by constraint name.
//   (inside credit_check_reservation)  0133 also closes the early return for a
//                                      SHADOW task
//     · A shadow task holds nothing, so the function returned as soon as it saw
//       `mode = 'shadow'` — before anything asked whether the ledger had charged
//       it anyway. MEASURED at 0132: one `task_charge` row naming a shadow
//       reservation committed and took 7,000,000 µcr off a real lot
//       (`remaining_micro` 100,000,000 → 93,000,000), because
//       `credit_ledger_apply` moves credit whichever task the row names. From
//       0133 a shadow task with a `task_charge` naming it is refused (23514) at
//       COMMIT, through the ledger trigger above. Scoped to `task_charge`
//       because `creditLedgerRowFor` sets `reservation_id` on that branch alone.
//
// The two partial unique indexes carry rules the columns do not say:
// `credit_reservations_open_slot_unique` is what makes "at most three enforced
// tasks at once" a fact about the database rather than a count the service
// takes before it inserts, and `credit_reservations_request_unique` applies only
// where a request key is present, because only the idempotent lane sets one
// (M2 — the inbound request id is client-controlled).
//
// ⛔ A HOLD AND A MODEL CALL NAME A TASK OF THEIR OWN ACCOUNT. Both are keyed on
// (task, account) against `credit_reservations_id_account_unique`, the shape
// 0130 gave a lot and its window. Keyed on the task alone, a hold could put
// ANOTHER account's credit behind this task — measured against Postgres, it
// committed — and the damage is the frozen-credit one twice over: the
// stranger's lot holds credit it can neither spend nor expire, and the task can
// never settle, because `credit_ledger_apply` refuses a charge naming a lot of
// another account, so the hold is never released and the slot never freed.
//
// Proved by (integration):
// `a-task-reserves-credits-in-one-locked-transaction`,
// `at-most-three-enforced-tasks-hold-credit-at-once`,
// `a-hold-moves-held-credit-and-nothing-else-does`,
// `a-settled-task-is-charged-only-what-it-held`,
// `a-late-charge-is-refused-an-unsent-call-is-not-billed-and-a-clawback-records-its-debt`,
// `a-holds-only-statement-re-checks-its-task-and-a-measurement-is-never-charged`.
export const creditReservations = pgTable(
  'credit_reservations',
  {
    /** Minted by the caller before `reserve`, so a crash mid-reserve is findable. */
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    agentSessionId: text('agent_session_id').notNull(),
    /** `'idem:<Idempotency-Key>'`, and NULL on every other lane (M2). */
    requestKey: text('request_key'),
    model: text('model').notNull(),
    rateCardVersion: integer('rate_card_version')
      .notNull()
      .references(() => creditRateCards.version),
    /** 'enforce' | 'shadow' (CREDIT_RESERVATION_MODES). */
    mode: text('mode').notNull(),
    /** 1..3 for an enforced task, NULL for a shadow one. */
    slot: smallint('slot'),
    /** 'open' | 'settled' (CREDIT_RESERVATION_STATES). */
    state: text('state').notNull().default('open'),
    reservedMicro: bigint('reserved_micro', { mode: 'number' }).notNull(),
    /** Open call bounds plus settled call charges. */
    committedMicro: bigint('committed_micro', { mode: 'number' }).notNull().default(0),
    chargedMicro: bigint('charged_micro', { mode: 'number' }),
    /** Shadow only: the first check enforcement would have refused on. */
    wouldRefuseReason: text('would_refuse_reason'),
    /** The boot id of the process holding the lease. */
    leaseOwner: text('lease_owner').notNull(),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }).notNull(),
    /** The hard ceiling: `created_at` + at most 30 minutes (M1). */
    maxUntil: timestamp('max_until', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    settledAt: timestamp('settled_at', { withTimezone: true }),
    /** 'completed' | 'lease_expired' | 'max_age' | 'admin' (CREDIT_SETTLE_REASONS). */
    settleReason: text('settle_reason'),
  },
  (t) => [
    uniqueIndex('credit_reservations_open_slot_unique')
      .on(t.accountId, t.slot)
      .where(sql`${t.state} = 'open' AND ${t.mode} = 'enforce'`),
    uniqueIndex('credit_reservations_request_unique')
      .on(t.accountId, t.requestKey)
      .where(sql`${t.requestKey} IS NOT NULL`),
    index('credit_reservations_lease_idx')
      .on(t.leaseExpiresAt)
      .where(sql`${t.state} = 'open'`),
    index('credit_reservations_max_until_idx')
      .on(t.maxUntil)
      .where(sql`${t.state} = 'open'`),
    index('credit_reservations_session_idx').on(t.agentSessionId, t.createdAt),
    // 0140 — an account's enforced tasks in the order they started: what a
    // won dispute walks to put back what a task's hold sent elsewhere.
    index('credit_reservations_account_created_idx')
      .on(t.accountId, t.createdAt)
      .where(sql`${t.mode} = 'enforce'`),
    check('credit_reservations_mode', sql`${t.mode} IN ('enforce', 'shadow')`),
    check(
      'credit_reservations_slot',
      sql`((${t.mode} = 'enforce') = (${t.slot} IS NOT NULL)) AND (${t.slot} IS NULL OR ${t.slot} BETWEEN 1 AND 3)`,
    ),
    check('credit_reservations_state', sql`${t.state} IN ('open', 'settled')`),
    // 0132 widened this by exactly one shape: a SHADOW measurement of a model
    // the card cannot price reserves NOTHING. It is the only row that may carry
    // `reserved_micro = 0`, because it is the only one with no `max_reserve` to
    // measure against — and without it `would_refuse_reason = 'model'` could
    // never be written at all, which left model refusals invisible to the shadow
    // census and M3's "a lost rate of 0" unreachable.
    //
    // ⛔ `IS NOT DISTINCT FROM`, NOT `=`. A CHECK passes when its expression is
    // NULL and `would_refuse_reason` is nullable, so `= 'model'` would let a
    // SECOND shape through: a shadow row reserving zero with NO reason at all
    // evaluates the disjunct to NULL, and `FALSE OR NULL` is NULL, which a CHECK
    // accepts. Measured: such a row inserted cleanly against `=` and is refused
    // against this. S11's census tells a refusal from a reading by that column,
    // so a zero with no reason would count as a reading of zero.
    check(
      'credit_reservations_amounts',
      sql`(${t.reservedMicro} > 0 OR (${t.reservedMicro} = 0 AND ${t.mode} = 'shadow' AND ${t.wouldRefuseReason} IS NOT DISTINCT FROM 'model')) AND ${t.committedMicro} >= 0 AND (${t.mode} = 'shadow' OR ${t.committedMicro} <= ${t.reservedMicro})`,
    ),
    check(
      'credit_reservations_max_until',
      sql`${t.maxUntil} > ${t.createdAt} AND ${t.maxUntil} <= ${t.createdAt} + interval '30 minutes'`,
    ),
    check(
      'credit_reservations_shadow_reason',
      sql`${t.mode} = 'shadow' OR ${t.wouldRefuseReason} IS NULL`,
    ),
    check(
      'credit_reservations_would_refuse_reason',
      sql`${t.wouldRefuseReason} IS NULL OR ${t.wouldRefuseReason} IN ('model', 'tasks_in_flight', 'debt', 'balance', 'call_did_not_fit')`,
    ),
    check(
      'credit_reservations_settle_reason',
      sql`${t.settleReason} IS NULL OR ${t.settleReason} IN ('completed', 'lease_expired', 'max_age', 'admin')`,
    ),
    check(
      'credit_reservations_terminal_shape',
      sql`(${t.state} = 'open' AND ${t.chargedMicro} IS NULL AND ${t.settledAt} IS NULL AND ${t.settleReason} IS NULL) OR (${t.state} = 'settled' AND ${t.chargedMicro} >= 0 AND (${t.mode} = 'shadow' OR ${t.chargedMicro} <= ${t.reservedMicro}) AND ${t.settledAt} IS NOT NULL AND ${t.settleReason} IS NOT NULL)`,
    ),
    check(
      'credit_reservations_request_key_length',
      sql`${t.requestKey} IS NULL OR length(${t.requestKey}) BETWEEN 1 AND 300`,
    ),
    // What a hold and a model call point at: a task is identified by its id AND
    // its account, so a row of either child table can only name a task of its
    // own account. Redundant as a key — the id alone is the primary key — and
    // there only so those two foreign keys can carry the account, exactly as
    // `credit_windows_id_account_unique` does for a lot and its window.
    unique('credit_reservations_id_account_unique').on(t.id, t.accountId),
  ],
);

export type CreditReservationRow = typeof creditReservations.$inferSelect;

// What one task holds in one lot. `held_micro` never changes; the row is
// released exactly once, for the part the task actually used.
export const creditReservationHolds = pgTable(
  'credit_reservation_holds',
  {
    /**
     * ⛔ NO COLUMN-LEVEL `.references()`: the key to the task is the pair
     * (task, account), declared as a table-level foreign key below.
     */
    reservationId: uuid('reservation_id').notNull(),
    lotId: uuid('lot_id')
      .notNull()
      .references(() => creditLots.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    heldMicro: bigint('held_micro', { mode: 'number' }).notNull(),
    /** What the task took out of this lot; NULL until the hold is released. */
    chargedMicro: bigint('charged_micro', { mode: 'number' }),
    releasedAt: timestamp('released_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.reservationId, t.lotId] }),
    // 0131: a hold names a task of ITS OWN account. The account is part of the
    // key, which is why this is a table-level foreign key and not a
    // `.references()` on the column — and the hold's lot already has to belong
    // to the hold's account (the apply trigger), so between them a task can
    // only ever be backed by its own account's credit.
    foreignKey({
      name: 'credit_reservation_holds_reservation_fk',
      columns: [t.reservationId, t.accountId],
      foreignColumns: [creditReservations.id, creditReservations.accountId],
    }).onDelete('cascade'),
    // 0132: the daily audit's three holds rules all start from "unreleased",
    // and the primary key `(reservation_id, lot_id)` cannot serve any of them —
    // measured as a Seq Scan removing 39,800 of 40,000 rows. The open set stays
    // small while the table grows with every enforced task for ever, so this is
    // partial; `account_id` leads because `claim_pending_with_no_open_hold`
    // correlates on it, and `reservation_id` follows for the other two's
    // anti-join.
    index('credit_reservation_holds_open_idx')
      .on(t.accountId, t.reservationId)
      .where(sql`${t.releasedAt} IS NULL`),
    check('credit_reservation_holds_positive', sql`${t.heldMicro} > 0`),
    check(
      'credit_reservation_holds_release_shape',
      sql`(${t.releasedAt} IS NULL) = (${t.chargedMicro} IS NULL) AND (${t.chargedMicro} IS NULL OR ${t.chargedMicro} BETWEEN 0 AND ${t.heldMicro})`,
    ),
  ],
);

export type CreditReservationHoldRow = typeof creditReservationHolds.$inferSelect;

// One row per billable HTTP attempt, written BEFORE it is sent. Its bound is the
// ceiling the attempt was admitted under and never changes; what it actually
// cost arrives when it settles. Written by S8's per-call admission.
export const creditModelCalls = pgTable(
  'credit_model_calls',
  {
    id: uuid('id').primaryKey(),
    /** ⛔ Keyed to the task by (task, account); see the foreign key below. */
    reservationId: uuid('reservation_id').notNull(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    /** 1, 2, 3 … within the reservation. */
    seq: integer('seq').notNull(),
    /** 'plan' | 'answer' (CREDIT_MODEL_CALL_PURPOSES). */
    purpose: text('purpose').notNull(),
    model: text('model').notNull(),
    inputBoundTokens: integer('input_bound_tokens').notNull(),
    /** 'region_bytes' | 'token_count' (CREDIT_CALL_BOUND_BASES). */
    inputBoundBasis: text('input_bound_basis').notNull(),
    inputBoundMicro: bigint('input_bound_micro', { mode: 'number' }).notNull(),
    maxOutputTokens: integer('max_output_tokens').notNull(),
    boundMicro: bigint('bound_micro', { mode: 'number' }).notNull(),
    /** Shadow only: the bound did not fit what the task had left. */
    shadowOverReservation: boolean('shadow_over_reservation').notNull().default(false),
    /** 'started' | 'settled' (CREDIT_MODEL_CALL_STATES). */
    state: text('state').notNull().default('started'),
    /** One-way: set true in its own statement immediately before the request goes out. */
    sent: boolean('sent').notNull().default(false),
    /** CREDIT_CALL_SETTLE_BASES; NULL until the call settles. */
    settleBasis: text('settle_basis'),
    uncachedInputTokens: integer('uncached_input_tokens'),
    outputTokens: integer('output_tokens'),
    cacheReadTokens: integer('cache_read_tokens'),
    cacheWrite5mTokens: integer('cache_write_5m_tokens'),
    cacheWrite1hTokens: integer('cache_write_1h_tokens'),
    actualMicro: bigint('actual_micro', { mode: 'number' }),
    chargedMicro: bigint('charged_micro', { mode: 'number' }),
    usageRecordId: uuid('usage_record_id'),
    startedAt: timestamp('started_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    settledAt: timestamp('settled_at', { withTimezone: true }),
  },
  (t) => [
    index('credit_model_calls_open_idx')
      .on(t.reservationId)
      .where(sql`${t.state} = 'started'`),
    // 0131, as on the holds: a call belongs to a task of its own account, so a
    // stranger's call cannot enter what this task committed and was charged.
    foreignKey({
      name: 'credit_model_calls_reservation_fk',
      columns: [t.reservationId, t.accountId],
      foreignColumns: [creditReservations.id, creditReservations.accountId],
    }).onDelete('cascade'),
    unique('credit_model_calls_seq_unique').on(t.reservationId, t.seq),
    check('credit_model_calls_purpose', sql`${t.purpose} IN ('plan', 'answer')`),
    check('credit_model_calls_basis', sql`${t.inputBoundBasis} IN ('region_bytes', 'token_count')`),
    check(
      'credit_model_calls_bound',
      sql`${t.seq} >= 1 AND ${t.inputBoundTokens} > 0 AND ${t.maxOutputTokens} > 0 AND ${t.inputBoundMicro} > 0 AND ${t.boundMicro} > ${t.inputBoundMicro}`,
    ),
    check('credit_model_calls_state', sql`${t.state} IN ('started', 'settled')`),
    check(
      'credit_model_calls_settle_basis',
      sql`${t.settleBasis} IS NULL OR ${t.settleBasis} IN ('provider_usage', 'provider_rejected', 'never_sent', 'partial_usage', 'no_record')`,
    ),
    check(
      'credit_model_calls_charge_le_bound',
      sql`${t.chargedMicro} IS NULL OR (${t.chargedMicro} >= 0 AND ${t.chargedMicro} <= ${t.boundMicro})`,
    ),
    check(
      'credit_model_calls_unbilled',
      sql`${t.settleBasis} NOT IN ('provider_rejected', 'never_sent') OR ${t.chargedMicro} = 0`,
    ),
    check(
      'credit_model_calls_never_sent_really',
      sql`${t.settleBasis} <> 'never_sent' OR NOT ${t.sent}`,
    ),
    // 0132, the mirror of the one above: `no_record` charges the FULL BOUND, so
    // it may only be named on a row that says the request really went out.
    check('credit_model_calls_no_record_really', sql`${t.settleBasis} <> 'no_record' OR ${t.sent}`),
    check(
      'credit_model_calls_no_record_pays_bound',
      sql`${t.settleBasis} <> 'no_record' OR ${t.chargedMicro} = ${t.boundMicro}`,
    ),
    check(
      'credit_model_calls_terminal_shape',
      sql`(${t.state} = 'started' AND ${t.chargedMicro} IS NULL AND ${t.settledAt} IS NULL AND ${t.settleBasis} IS NULL) OR (${t.state} = 'settled' AND ${t.chargedMicro} IS NOT NULL AND ${t.settledAt} IS NOT NULL AND ${t.settleBasis} IS NOT NULL)`,
    ),
  ],
);

export type CreditModelCallRow = typeof creditModelCalls.$inferSelect;

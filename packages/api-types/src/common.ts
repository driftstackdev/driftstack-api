import { z } from 'zod';

// ───────────────────────────────────────────────────────────────────────────
// Shared primitives
// ───────────────────────────────────────────────────────────────────────────

export const UuidSchema = z.string().uuid();

/**
 * `.datetime()` already refuses the extended ±YYYYYY form, so anything reaching
 * the refinement has a four-digit year — but it accepts `0000-…`, and there is
 * no year zero. A request filter carrying one is parsed into a Date, handed
 * straight to a timestamptz comparison, and Postgres raises "date/time field
 * value out of range": a 500 from a query string. Verified on
 * GET /v1/admin/audit-log, whose `from` reaches `gte(timestamp, …)`.
 *
 * The floor is the epoch rather than year 1 because every timestamp this API
 * accepts or emits describes something this system recorded. Postgres would
 * store years 1..1969 without complaint; they are refused here because they
 * cannot be legitimate, and refusing them turns a 500 into a 400 that names the
 * field.
 */
export const Iso8601Schema = z
  .string()
  .datetime({ offset: true })
  .refine((value) => Number(value.slice(0, 4)) >= 1970, {
    message: 'timestamp must be at or after 1970-01-01',
  })
  .describe('ISO 8601 timestamp with timezone offset, e.g. 2026-05-02T09:15:00Z');

// Cursor pagination — opaque cursor strings; servers may swap encoding later
// without breaking clients.
//
// Slice 148 — cap cursor at 512 chars matching slice 117/146/147
// convention across all admin + customer list routes. The base shape
// flows into 3 customer-facing routes today (profiles / profile-
// snapshots / sessions) so capping at the source pulls them all into
// the defensive-cap pattern without 3 separate route-level edits. 512
// chars covers any base64url-encoded {ts, uuid} pagination token plus
// headroom; multi-KB cursors are abuse or a bug.
export const PaginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(512).optional(),
});

export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;
/** Caller-side shape — `limit` is optional (server defaults to 50). */
export type PaginationQueryInput = z.input<typeof PaginationQuerySchema>;

export const PaginatedListSchema = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    data: z.array(item),
    has_more: z.boolean(),
    next_cursor: z.string().nullable(),
  });

// ───────────────────────────────────────────────────────────────────────────
// Public-facing IDs are prefixed strings ("acc_…", "key_…", "ses_…") even
// though stored as UUIDs in Postgres. The mapping happens at the route
// boundary; service layers and DB use raw UUIDs.
// ───────────────────────────────────────────────────────────────────────────

export const PrefixedId = (prefix: string): z.ZodString =>
  z
    .string()
    .regex(new RegExp(`^${prefix}_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`), {
      message: `must start with "${prefix}_" followed by a UUID`,
    });

export const AccountIdSchema = PrefixedId('acc');
export const ApiKeyIdSchema = PrefixedId('key');
export const SessionIdSchema = PrefixedId('ses');
export const SessionEventIdSchema = PrefixedId('evt');
export const UsageRecordIdSchema = PrefixedId('use');

export type AccountId = z.infer<typeof AccountIdSchema>;
export type ApiKeyId = z.infer<typeof ApiKeyIdSchema>;
export type SessionId = z.infer<typeof SessionIdSchema>;

// ───────────────────────────────────────────────────────────────────────────
// Account tier is part of the public contract because rate limits + quotas
// are tier-keyed.
// ───────────────────────────────────────────────────────────────────────────

// Locked pricing model — two-ladder concurrent-only per ADR-004
// (supersedes file-127 single-ladder hours-with-overage design;
// pre-launch, no production customers, V-073 migration drops +
// recreates the Postgres enum and re-maps any existing test data
// from old tier names to new equivalents).
//
// Free (perpetual default — no billing, resolves findings #6/#10 by
// removing the one-time trial_pack entirely per founder verdict 2026-05-27):
//   - free          $0  — 1 profile, manual-only (no API), 1 concurrent, no AI agent, no expiry
//
// Manual ladder (humans clicking GUI client; profile count tier-defining):
//   - solo_manual    $79/mo   ($758/yr = $63/mo)    — 10 profiles  / 1 concurrent / unlimited hours
//   - team_manual    $249/mo  ($2,390/yr = $199/mo) — 50 profiles  / 3 concurrent / unlimited hours
//   - agency_manual  $699/mo  ($6,710/yr = $559/mo) — 200 profiles / 8 concurrent / unlimited hours
//
// API ladder (programmatic SDK access; concurrent caps tier-defining):
//   - api_starter    $149/mo   ($1,430/yr = $119/mo)    — 25 profiles  / 2 concurrent  / unlimited hours
//   - api_builder    $499/mo   ($4,790/yr = $399/mo)    — 100 profiles / 8 concurrent  / unlimited hours
//   - api_scale      $1,499/mo ($14,390/yr = $1,199/mo) — 500 profiles / 24 concurrent / unlimited hours
//   - enterprise     from $4,000/mo annual only — custom profiles + concurrent, negotiated
//
// Annual is 20% off across all tiers. Concurrent caps are the
// only metering primitive on paid tiers; the free tier has no
// usage metering at all (no credit, no hours cap, no expiry).
// Profile count is enforced at the /v1/profiles creation gate.
export const AccountTierSchema = z.enum([
  'free',
  'solo_manual',
  'team_manual',
  'agency_manual',
  'api_starter',
  'api_builder',
  'api_scale',
  'enterprise',
]);
export type AccountTier = z.infer<typeof AccountTierSchema>;

/**
 * The tiers a customer can buy through a self-serve checkout: every
 * AccountTier except `free` (perpetual, nothing to purchase) and `enterprise`
 * (negotiated, paid by bank wire).
 *
 * V-924 — spelled as an explicit tuple rather than derived with `.refine()`.
 * Both checkout request schemas used `AccountTierSchema.refine(t => t !== 'free'
 * && t !== 'enterprise')`, which is a runtime predicate that JSON Schema cannot
 * express: the generated OpenAPI document emitted the FULL eight-tier enum, so
 * the published contract for `POST /v1/billing/checkout-session` advertised
 * `free` and `enterprise` as valid tiers while the route returned 400 for both.
 * An enum of exactly the accepted values is what reaches the spec intact.
 *
 * `the-purchasable-product-set-is-one-set` asserts this tuple stays equal to
 * AccountTierSchema minus those two, and equal to the server's priced-tier map,
 * so the explicit spelling cannot drift from either.
 */
export const PURCHASABLE_TIERS = [
  'solo_manual',
  'team_manual',
  'agency_manual',
  'api_starter',
  'api_builder',
  'api_scale',
] as const;

export const PurchasableTierSchema = z.enum(PURCHASABLE_TIERS);
export type PurchasableTier = z.infer<typeof PurchasableTierSchema>;

/**
 * Profile-count limits per tier — single source of truth for
 * marketing-site, customer-dashboard, and server-side enforcement.
 * Numeric tiers expose the concrete cap; `'custom'` means
 * negotiated-per-contract (Enterprise only).
 *
 * Locked per ADR-004. Values mirrored in
 * `apps/marketing-site/src/data/pricing.ts:API_TIERS` (see field
 * `profiles`) — the marketing copy uses friendlier display strings
 * but the numbers are the same. The server-side enforcement at
 * `/v1/profiles` creation gate reads from this constant.
 */
export const PROFILES_PER_TIER: Record<AccountTier, number | 'custom'> = {
  free: 1,
  solo_manual: 10,
  team_manual: 50,
  agency_manual: 200,
  api_starter: 25,
  api_builder: 100,
  api_scale: 500,
  enterprise: 'custom',
};

/**
 * doc-150 item 6 — per-account profile-storage quota (bytes). The
 * enforced quota is the PER-ACCOUNT TOTAL: the SUM of the account's
 * live (non-trashed) profiles' `size_bytes`. The per-profile rails
 * from doc-150 (1 GiB / 5 GiB) are NOT customer-facing-enforced — the
 * 256 MiB-per-blob harness backstop already bounds a single profile;
 * those rails stay internal. Single source of truth for marketing-
 * site, customer-dashboard, and server-side enforcement (mirrors the
 * PROFILES_PER_TIER shape).
 *
 * Caps are declared in GiB and converted to bytes via `* 2 ** 30`.
 * Enterprise is SOFT-ONLY — its value is the alert floor, never a hard
 * block (the launch gate skips enterprise entirely; see
 * `computeAccountStorageState` in
 * `apps/server/src/services/profile-storage-quota.ts`).
 *
 * Server-side enforcement reads this at session-launch (a profile-
 * backed POST /v1/sessions or POST /v1/profiles/:id/launch): when the
 * account's aggregate `size_bytes` has reached its hard cap (100%) the
 * create is refused with a `storage_quota_exceeded` problem (409).
 * Sessions WITHOUT a profile are never blocked; reads/restores always
 * work. The dashboard surfaces the soft (80%) warn state compute-on-read.
 */
export const TIER_STORAGE_BYTES_CAP: Record<AccountTier, number> = {
  free: 1 * 2 ** 30,
  solo_manual: 5 * 2 ** 30,
  team_manual: 25 * 2 ** 30,
  agency_manual: 100 * 2 ** 30,
  api_starter: 15 * 2 ** 30,
  api_builder: 50 * 2 ** 30,
  api_scale: 250 * 2 ** 30,
  // Enterprise is SOFT-ONLY — this is the alert floor, not a hard block.
  enterprise: 500 * 2 ** 30,
};

/**
 * doc-150 item 6 — fraction of the per-account storage cap at which the
 * dashboard surfaces a soft "approaching your limit" warning. Soft never
 * blocks; the hard block is at 100% (`fraction >= 1`). Single source of
 * truth shared by the server quota helper + the dashboard meter.
 */
export const STORAGE_SOFT_WARN_FRACTION = 0.8;

/**
 * Concurrent session limit per tier — the primary metering primitive
 * on paid tiers. A customer can have up to N sessions in `creating` /
 * `ready` / `busy` state simultaneously; creating an (N+1)th triggers
 * `concurrency_limit_exceeded` (HTTP 429).
 *
 * Locked per ADR-004. Values mirrored in
 * `apps/marketing-site/src/data/pricing.ts:API_TIERS` field
 * `concurrent`. `enterprise: 32` is a sentinel floor for the smallest
 * custom contract; per-account overrides via the rate-limit-overrides
 * path bump real Enterprise customers higher.
 *
 * The server-side enforcement at session-create time reads from this
 * constant via `concurrentSessionLimitFor()`. Cross-workspace consumers
 * (customer-dashboard /sessions tier-info, admin-panel account-detail)
 * can import directly.
 */
export const TIER_CONCURRENT_SESSION_LIMITS: Record<AccountTier, number> = {
  free: 1,
  solo_manual: 1,
  team_manual: 3,
  agency_manual: 8,
  api_starter: 2,
  api_builder: 8,
  api_scale: 24,
  enterprise: 32,
};

/**
 * 6.g — saved-proxy (egress endpoint) count cap per tier. Every session
 * must launch through a proxy (a session on the bare datacenter IP is not
 * permitted), so free gets exactly 1 (BYO SOCKS5; no OpenVPN/WireGuard —
 * see TierFeatures.vpnEgress). Paid tiers scale up + unlock VPN egress.
 * `'custom'` = negotiated (Enterprise). Mirrors the PROFILES_PER_TIER
 * shape. The owner-scoped saved-proxy create gate enforces every numeric
 * tier atomically; Enterprise uses its negotiated custom allowance rather
 * than inheriting an invented generic limit.
 */
export const PROXIES_PER_TIER: Record<AccountTier, number | 'custom'> = {
  free: 1,
  solo_manual: 10,
  team_manual: 25,
  agency_manual: 50,
  api_starter: 25,
  api_builder: 100,
  api_scale: 500,
  enterprise: 'custom',
};

/**
 * 6.g — maximum wall-clock duration (minutes) for a single session before
 * auto-destroy. `null` = unlimited (paid tiers). Free is capped so it
 * reads as an evaluation tier (bounds the fleet-slot cost-to-serve and
 * deters sustained free use) without needing a daily-usage meter. The
 * session service enforces this at create + via the idle/duration sweep.
 */
export const MAX_SESSION_MINUTES_PER_TIER: Record<AccountTier, number | null> = {
  free: 20,
  solo_manual: null,
  team_manual: null,
  agency_manual: null,
  api_starter: null,
  api_builder: null,
  api_scale: null,
  enterprise: null,
};

/**
 * V-219 — per-tier rate-limit defaults (token-bucket capacity + refill).
 *
 * One config per `(tier, bucketKey)`. Four bucket keys are defined today:
 *
 *   - `global` — every authenticated `/v1/*` call consumes this bucket.
 *     Protects against accidental DDoS / runaway scripts.
 *   - `sessions:create` — `POST /v1/sessions` only. Lower cap because
 *     session creation is the most expensive op in the system (driver
 *     allocation, archetype hydration, fingerprint pinning).
 *   - `agent_sessions:message` — `POST /v1/agent-sessions/:id/message`. A
 *     turn costs model tokens, so this is capped well under `global`.
 *   - `agent_sessions:input_event` — the raw screen-coordinate stream from
 *     the manual-control overlay. Capacities are the largest of the four
 *     because a single drag emits events continuously.
 *
 * The count above is not decorative: it was stale at two for the whole life
 * of the two agent buckets, and the per-tier table in the customer docs was
 * missing `agent_sessions:input_event` for the same span (V-1091).
 *
 * Capacity = max burst size. Refill = sustained rate (tokens/sec). The
 * effective sustained RPS for a default-cost call is `refillPerSecond`.
 *
 * These are anti-abuse limits, not pricing — per ADR-004, customers
 * pay for concurrent sessions, not per-call. The numbers scale roughly
 * with concurrent cap (more concurrent = more API calls likely). Exposed
 * to SDK consumers + the customer dashboard so they can render the
 * effective limit on the /settings / /usage surface.
 *
 * Source-of-truth lives here; the server reads from this constant via
 * `bucketConfigFor()` in `apps/server/src/services/rate-limit.ts`.
 * Cross-workspace consumers can import directly. Per-account overrides
 * via the rate-limit-overrides path (V-052) supersede these defaults.
 */
export interface BucketLimitConfig {
  capacity: number;
  refill_per_second: number;
}

export const TIER_RATE_LIMIT_DEFAULTS: Record<
  AccountTier,
  Record<
    'global' | 'sessions:create' | 'agent_sessions:message' | 'agent_sessions:input_event',
    BucketLimitConfig
  >
> = {
  free: {
    global: { capacity: 60, refill_per_second: 1 },
    'sessions:create': { capacity: 5, refill_per_second: 1 / 60 },
    // v2-#13 — per-turn AI chat throttle. Chat is naturally bursty
    // (customer types fast); throttle is set to "comfortable for
    // human typing speed but rejects machine-loops". 20 turn burst
    // + 1 / 5s refill is comfortable conversational.
    'agent_sessions:message': { capacity: 20, refill_per_second: 1 / 5 },
    // Slice 4 (Wave 29-NNN ARC 3) — ManualControlOverlay raw screen-
    // coord stream from the customer dashboard. Client-side 120Hz
    // cap; server-side burst of ~2 seconds of un-throttled mousemove
    // + sustained 60Hz refill. Free tier gets a deliberately tight
    // budget — free accounts shouldn't be running pair-mode
    // sessions at scale.
    'agent_sessions:input_event': { capacity: 240, refill_per_second: 60 },
  },
  solo_manual: {
    global: { capacity: 120, refill_per_second: 2 },
    'sessions:create': { capacity: 10, refill_per_second: 1 / 30 },
    'agent_sessions:message': { capacity: 40, refill_per_second: 1 / 3 },
    'agent_sessions:input_event': { capacity: 360, refill_per_second: 90 },
  },
  team_manual: {
    global: { capacity: 360, refill_per_second: 6 },
    'sessions:create': { capacity: 20, refill_per_second: 1 / 10 },
    'agent_sessions:message': { capacity: 100, refill_per_second: 1 },
    'agent_sessions:input_event': { capacity: 480, refill_per_second: 120 },
  },
  agency_manual: {
    global: { capacity: 1_800, refill_per_second: 30 },
    'sessions:create': { capacity: 60, refill_per_second: 1 },
    'agent_sessions:message': { capacity: 300, refill_per_second: 3 },
    'agent_sessions:input_event': { capacity: 600, refill_per_second: 150 },
  },
  api_starter: {
    global: { capacity: 240, refill_per_second: 4 },
    'sessions:create': { capacity: 15, refill_per_second: 1 / 20 },
    'agent_sessions:message': { capacity: 60, refill_per_second: 1 / 2 },
    'agent_sessions:input_event': { capacity: 360, refill_per_second: 90 },
  },
  api_builder: {
    global: { capacity: 1_800, refill_per_second: 30 },
    'sessions:create': { capacity: 60, refill_per_second: 1 },
    'agent_sessions:message': { capacity: 300, refill_per_second: 3 },
    'agent_sessions:input_event': { capacity: 600, refill_per_second: 150 },
  },
  api_scale: {
    global: { capacity: 6_000, refill_per_second: 100 },
    'sessions:create': { capacity: 120, refill_per_second: 2 },
    'agent_sessions:message': { capacity: 1_000, refill_per_second: 10 },
    'agent_sessions:input_event': { capacity: 1_200, refill_per_second: 300 },
  },
  enterprise: {
    global: { capacity: 60_000, refill_per_second: 1_000 },
    'sessions:create': { capacity: 600, refill_per_second: 10 },
    'agent_sessions:message': { capacity: 10_000, refill_per_second: 100 },
    'agent_sessions:input_event': { capacity: 12_000, refill_per_second: 3_000 },
  },
};

/**
 * V-485 — per-tier feature gating registry.
 *
 * Single source of truth for "which capabilities does this tier
 * unlock?" Today the server checks `tier === 'free'` /
 * `PROFILES_PER_TIER[tier]` / `TIER_CONCURRENT_SESSION_LIMITS[tier]`
 * in scattered call sites; this registry is the central place for
 * those plus the AI-agent + LLM-billing gates that ship with V-487+.
 *
 * Mirrors the customer-facing matrix in
 * `apps/marketing-site/src/data/pricing.ts:API_TIERS` — the marketing
 * site renders display strings; this registry exposes the values
 * route handlers and services act on. Both layers MUST agree.
 *
 * Consumers:
 *   - Server: `requireTierFeature(tier, key)` in
 *     `apps/server/src/lib/errors-helpers.ts` throws 403 with
 *     `feature_not_available` problem-type when the gate fails.
 *   - Customer dashboard: read TIER_FEATURES directly to drive
 *     conditional UI (e.g. hide AI-agent CTA on Personal).
 *
 * Adding a new feature: extend `TierFeatures`, populate every row
 * in `TIER_FEATURES`, then have the route handler call
 * `requireTierFeature(tier, 'newFeature')` on the gated path.
 */
export type LlmBilling = 'byok_only' | 'byok_or_bundled' | 'byok_or_bundled_custom' | null;

export interface TierFeatures {
  /** Concurrent session cap. Mirrors TIER_CONCURRENT_SESSION_LIMITS. */
  concurrentSessions: number;
  /** Profile-count cap. `'custom'` for Enterprise (negotiated). */
  profiles: number | 'custom';
  /** Stripe environment for API-key minting (test on free, live elsewhere). */
  apiKeyEnvironment: 'test' | 'live';
  /**
   * Programmatic API / SDK access. `false` on the free tier — it is
   * manual-only (GUI client): cannot mint usable API keys or call the
   * REST API. All paid tiers are `true`.
   */
  apiAccess: boolean;
  /** AI-agent (LLM-driven sessions) feature available on this tier. */
  aiAgent: boolean;
  /** LLM billing model when aiAgent is true; `null` when off. */
  llmBilling: LlmBilling;
  /**
   * 6.g — OpenVPN / WireGuard egress profiles allowed on this tier.
   * `false` on free (SOCKS5 proxy only — see PROXIES_PER_TIER); all
   * paid tiers `true`. (Every tier needs at least one proxy: a session
   * on the bare datacenter IP is not permitted.)
   */
  vpnEgress: boolean;
}

export const TIER_FEATURES: Record<AccountTier, TierFeatures> = {
  free: {
    concurrentSessions: 1,
    profiles: 1,
    apiKeyEnvironment: 'test',
    apiAccess: false,
    aiAgent: false,
    llmBilling: null,
    vpnEgress: false,
  },
  solo_manual: {
    concurrentSessions: 1,
    profiles: 10,
    apiKeyEnvironment: 'live',
    apiAccess: true,
    aiAgent: false,
    llmBilling: null,
    vpnEgress: true,
  },
  team_manual: {
    concurrentSessions: 3,
    profiles: 50,
    apiKeyEnvironment: 'live',
    apiAccess: true,
    aiAgent: true,
    llmBilling: 'byok_only',
    vpnEgress: true,
  },
  agency_manual: {
    concurrentSessions: 8,
    profiles: 200,
    apiKeyEnvironment: 'live',
    apiAccess: true,
    aiAgent: true,
    llmBilling: 'byok_only',
    vpnEgress: true,
  },
  api_starter: {
    concurrentSessions: 2,
    profiles: 25,
    apiKeyEnvironment: 'live',
    apiAccess: true,
    aiAgent: true,
    llmBilling: 'byok_only',
    vpnEgress: true,
  },
  api_builder: {
    concurrentSessions: 8,
    profiles: 100,
    apiKeyEnvironment: 'live',
    apiAccess: true,
    aiAgent: true,
    llmBilling: 'byok_or_bundled',
    vpnEgress: true,
  },
  api_scale: {
    concurrentSessions: 24,
    profiles: 500,
    apiKeyEnvironment: 'live',
    apiAccess: true,
    aiAgent: true,
    llmBilling: 'byok_or_bundled',
    vpnEgress: true,
  },
  enterprise: {
    concurrentSessions: 32,
    profiles: 'custom',
    apiKeyEnvironment: 'live',
    apiAccess: true,
    aiAgent: true,
    llmBilling: 'byok_or_bundled_custom',
    vpnEgress: true,
  },
};

/** Feature keys whose gate is a boolean. Convenience type for `requireTierFeature`. */
export type TierBooleanFeature = {
  [K in keyof TierFeatures]: TierFeatures[K] extends boolean ? K : never;
}[keyof TierFeatures];

/**
 * Lookup a tier's feature config. Pure function; no side effects.
 * Prefer this over indexing TIER_FEATURES directly so tests can mock.
 */
export function tierFeatures(tier: AccountTier): TierFeatures {
  return TIER_FEATURES[tier];
}

/**
 * Boolean predicate — does this tier have the given boolean feature
 * enabled? For non-boolean features (concurrentSessions, profiles,
 * llmBilling), use `tierFeatures(tier)` and inspect directly.
 */
export function tierHasFeature(tier: AccountTier, feature: TierBooleanFeature): boolean {
  return TIER_FEATURES[tier][feature];
}

/**
 * Currently-locked archetype identifier + human-readable label.
 *
 * The identifier (`iphone16pro_ios18_7_safari26_4`) is what the API
 * accepts on `/v1/sessions { archetype }` and what the server stores
 * on session + profile rows. The display label is the customer-facing
 * string surfaced on dashboards + the marketing site.
 *
 * Versioning: every iOS major bump (iOS 19, iOS 20, ...) cycles BOTH
 * values. Apple ships Safari independently of iOS major; the
 * Safari version is part of the identifier so we can ship Safari-only
 * archetype updates without touching iOS framing. Pattern documented
 * in `docs/architecture/archetype-naming-convention.md`.
 *
 * V-136: renamed from the prior `iphone16pro_ios26_4_1` identifier
 * (which conflated Safari 26.4 with a fictional "iOS 26.4.1") to the
 * correct `iphone16pro_ios18_7_safari26_4`. Customer-facing copy
 * also redlined in the same commit.
 */
// 2026-06-11 launch-archetype cutover: the v1.0 launch DEFAULT moved from
// iphone16pro_ios18_7_safari26_4 to iphone17_ios18_7_safari26_4 — the single
// real-device-verified ("PASS") archetype per Agent-1's atlas validator
// (operations/archetype-catalog.json: status=ready). iphone16pro is now a
// scaffolded `reference` baseline (coming_soon), retained below for back-compat
// label resolution on already-created profiles.
export const LOCKED_ARCHETYPE_ID = 'iphone17_ios18_7_safari26_4';
export const LOCKED_ARCHETYPE_DISPLAY_LABEL = 'iPhone 17 / iOS 18.7 / Safari 26.4';

/**
 * Multi-archetype registry — the catalogue of device archetypes the
 * platform models. Driftstack is NOT a single-device product: it spans
 * many iPhone/iPad models across iOS + Safari versions. LOCKED_ARCHETYPE_ID
 * above is just the current launch DEFAULT (the entry whose fingerprint
 * atlas is populated + launch-ready) — NOT the universe of archetypes.
 *
 * `status` reflects fingerprint-atlas readiness, so a new device can be
 * registered as a recognized slug BEFORE its atlas is captured:
 *   - 'launch'    — populated + the current default at v1.0
 *   - 'available' — populated + customer-selectable, but NOT the default (e.g. a legacy device)
 *   - 'reference' — captured INTERNAL baseline, not customer-selectable (e.g. the Family A baseline)
 *   - 'planned'   — recognized slug, atlas not yet populated (placeholder)
 * The customer-selectable set the GUI/dashboard offers = status 'launch' | 'available'.
 *
 * Slugs MUST match Agent-1's atlas naming `<device>_ios<X_Y>_safari<X_Y>`
 * (docs/architecture/archetype-naming-convention.md). The catalogue below is
 * synced from Agent-1's authoritative, real-device-verified catalog
 * (`driftstack/operations/archetype-catalog.json`): all 81 catalog slugs
 * (status `ready`, bit-identical-verified across canvas/fonts/screen/
 * inner_height/config) appear here. The one entry whose id ==
 * `LOCKED_ARCHETYPE_ID` keeps `status:'launch'` (the v1.0 default); every
 * other catalog entry is `status:'available'` (customer-selectable, not the
 * default). One legacy `reference` baseline NOT in the catalog
 * (`iphone15pro_ios17_5_safari17_5`) is retained at the tail so already-
 * created profiles on that slug still resolve a label.
 *
 * `canvasFamily` is the CANVAS pipeline family (Wave 29-408 A/B split),
 * derived from the Safari version exactly as the fork's `s_isFamilyAArchetype`
 * gate does (HTMLCanvasElement.cpp): Safari 17/18/19 + 26.0–26.3 ⇒ 'A' (old
 * pipeline); 26.4+ ⇒ 'B' (new pipeline). NB the WebGPU-exposure axis is
 * SEPARATE — 26.3 is canvas-Family-A but WebGPU-exposed; do not conflate.
 *
 * The display labels (below), the future SDK archetype union, and the
 * dashboard/GUI archetype selectors all derive from this single source
 * instead of re-hardcoding a list. Flipping the launch default = changing
 * which entry is `status:'launch'`, NOT a system-wide slug swap.
 */
export type ArchetypeCanvasFamily = 'A' | 'B';
export type ArchetypeStatus = 'launch' | 'available' | 'reference' | 'planned';

export interface ArchetypeConfig {
  /** Canonical slug, e.g. `iphone17_ios18_7_safari26_4`. */
  readonly id: string;
  /** Human-renderable label, e.g. `iPhone 17 / iOS 18.7 / Safari 26.4`. */
  readonly displayLabel: string;
  /** Marketing device name, e.g. `iPhone 16 Pro`, `iPad Pro`. */
  readonly device: string;
  /** iOS version segment of the slug, e.g. `18.7`. */
  readonly iosVersion: string;
  /** Safari version segment of the slug, e.g. `26.4`. */
  readonly safariVersion: string;
  /** Canvas pipeline family (Wave 29-408 A/B split). */
  readonly canvasFamily: ArchetypeCanvasFamily;
  /** Fingerprint-atlas readiness — see the enum above. */
  readonly status: ArchetypeStatus;
}

/**
 * Devices a tier may select when creating a profile. `null` means unrestricted.
 *
 * ⛔ Keyed on DEVICE, not on iOS version, and that is the whole decision. The
 * plan called for "older iOS only", and the registry cannot express it: iOS has
 * three distinct values across 79 archetypes and two of the three are the same
 * product generation, so an iOS cut separates almost nothing. **Device has 19
 * distinct values and is what a customer already understands** — "you get an
 * iPhone 13 on the free plan" is a sentence someone can act on; "you get
 * iOS 18.4" is not.
 *
 * Free gets the two oldest BASE models. Not the Pro variants, so the cut is a
 * generation boundary rather than an arbitrary pair, and both carry
 * `status: 'available'` so neither is a promise the atlas cannot keep.
 *
 * ⚠️ This is an ENTITLEMENT, not a catalog filter. `GET /v1/archetypes` stays
 * public, unauthenticated and cacheable — it answers "what does this product
 * support", which is the same answer for everyone. What a given account may
 * SELECT is enforced where the selection happens. Hiding the catalog per tier
 * would need auth on a public route and would break its 300s cache for no
 * security gain, since the ids are published in the OpenAPI document anyway.
 */
export const ARCHETYPE_DEVICES_PER_TIER: Record<AccountTier, readonly string[] | null> = {
  free: ['iPhone 13', 'iPhone 13 mini'],
  solo_manual: null,
  team_manual: null,
  agency_manual: null,
  api_starter: null,
  api_builder: null,
  api_scale: null,
  enterprise: null,
};

/**
 * ⛔ CHROME-ON-iOS ARCHETYPES ARE HELD OUT of this registry on A1's direct
 * instruction (2026-08-30). The held-out set, as of 2026-09-02, is SIX:
 *
 *     iphone17_ios18_7_chrome148/149/150   (original)
 *     iphone17_ios18_7_chrome151/152/153   (added 2026-09-02, A3 4799420bc)
 *
 * 151/152/153 are version-invariant CLONES of the corrected chrome150 — UA
 * token and version pin only, 14 differing leaves on a path-keyed diff — and
 * they inherit every reason below unchanged, because a clone is not a render:
 * nothing about them has been measured on a device. A3 holds them out on their
 * side too (registry guard + catalog `held_out` with `verified:false`).
 * ⛔ UN-HOLD AS A SET. Clearing one milestone does not clear a sibling that
 * differs from it only by a version string; the defects below are in the fork's
 * slug PREDICATES, which cannot distinguish 151 from 153.
 *
 * THREE independent reasons — do not add them when only one clears:
 *
 *  1. A1's browser-family gate: the chrome family is OPEN (distribution-policy
 *     weights + founder ATP reference not finalized). A family must be CLOSED
 *     before its archetypes are sellable.
 *  2. A measured fingerprint defect, ADJUDICATED 2026-08-30 on two real device
 *     models (iPhone 15 + iPhone 17 Pro, CriOS, both md5 57186fab = Family B):
 *     the CONFIG is right and the fork's predicate is the defect. The real
 *     mechanism (A1, corrected): driftstackArchetypeIsFamilyB() takes a
 *     "no _safari token → Family A" FALLBACK whose comment justifies it as
 *     "legacy pre-26.4 slug" — true for the ONLY slug class that existed when it
 *     was written. Chrome archetypes are 26.4-era yet carry no _safari token, so
 *     they silently joined a branch whose stated reasoning does not cover them:
 *     a correct assumption that quietly expired. Result: all three render canvas
 *     Family A while their config says Family B — a detectable tell, live in the
 *     fork TODAY. The fork already parses the true version
 *     (DriftstackArchetypeConfig::safariVersion() → "26.4") and a three-valued
 *     resolver already exists unused; the fix wires the predicate to consult it
 *     and stops Unknown collapsing to A. Boundary registry stays sole authority,
 *     no slug renames, and it needs the on-box bit-identical run before chrome
 *     is sellable. A1 confirmed this fix behaviourally on the box (2026-08-30,
 *     commit f204f294e): 18 surfaces flip chrome149 to byte-identical with
 *     safari26_4, and the regression bar held — glyphHash unchanged, no critical
 *     cumrig diffs. Canvas is closed on BOTH halves, which is exactly why
 *     reason 3 exists: closing canvas is not closing chrome.
 *  3. A SECOND, CHEAPER-TO-DETECT DEFECT on a different axis, found while
 *     confirming reason 2 (A1, 2026-08-30). `performance.observerEntryTypes`:
 *     chrome149 serves the OLD Safari API surface (mark, measure, navigation,
 *     paint, resource) while DECLARING 26.4 — missing event, first-input and
 *     largest-contentful-paint, which safari26_4 exposes. Same shape as the
 *     canvas bug, different predicate: driftstackArchetypeSafariAtLeast() also
 *     does sv.find("safari") and returns false when the token is absent, so a
 *     chrome slug reads as older than EVERY version target. Measured blast
 *     radius: FOUR copy-pasted definitions (WebPage.cpp:5735,
 *     RenderThemeMac.mm:467, StyleExtractorCustom.h:91, RenderThemeCocoa.mm:116)
 *     across 16 call sites, gating origin-API, web-animations progress, 26.5
 *     prototype members, the :open pseudo-class, event timing, LCP, two
 *     style-extraction behaviours and a RenderThemeMac colour — all sixteen
 *     answer "older" for chrome.
 *     ⚠️ WORSE than the canvas tell for our purposes: reading
 *     PerformanceObserver.supportedEntryTypes is ONE property access — no
 *     canvas, no timing, no sampling, no statistics. A detector gets it free.
 *     A1 is applying the same resolution and collapsing the four copies into
 *     one (four definitions of a predicate are four places for the next fix to
 *     miss — which is what just happened). Needs its own build and the same
 *     two-sided verification.
 *
 * ⛔ SO: "canvas is fixed" IS NOT "chrome is sellable". All three must clear.
 * The flip event is A1 saying so — a direct message to A2 or a `[for A2]` line
 * in operations/agent-bus/live/A1.md. `operations/archetype-catalog.json` is
 * STALE (June 2026 numbers, per A1) and must not be treated as a readiness feed.
 */
export const ARCHETYPE_REGISTRY: readonly ArchetypeConfig[] = [
  {
    id: LOCKED_ARCHETYPE_ID,
    displayLabel: LOCKED_ARCHETYPE_DISPLAY_LABEL,
    device: 'iPhone 17',
    iosVersion: '18.7',
    safariVersion: '26.4',
    canvasFamily: 'B',
    status: 'launch',
  },
  {
    id: 'iphone13_ios18_6_safari18_6',
    displayLabel: 'iPhone 13 / iOS 18.6 / Safari 18.6',
    device: 'iPhone 13',
    iosVersion: '18.6',
    safariVersion: '18.6',
    canvasFamily: 'A',
    status: 'available',
  },
  {
    id: 'iphone13_ios18_6_safari26_0',
    displayLabel: 'iPhone 13 / iOS 18.6 / Safari 26.0',
    device: 'iPhone 13',
    iosVersion: '18.6',
    safariVersion: '26.0',
    canvasFamily: 'A',
    status: 'available',
  },
  {
    id: 'iphone13_ios18_7_safari26_3',
    displayLabel: 'iPhone 13 / iOS 18.7 / Safari 26.3',
    device: 'iPhone 13',
    iosVersion: '18.7',
    safariVersion: '26.3',
    canvasFamily: 'A',
    status: 'available',
  },
  {
    id: 'iphone13_ios18_7_safari26_4',
    displayLabel: 'iPhone 13 / iOS 18.7 / Safari 26.4',
    device: 'iPhone 13',
    iosVersion: '18.7',
    safariVersion: '26.4',
    canvasFamily: 'B',
    status: 'available',
  },
  {
    id: 'iphone13_ios18_7_safari26_5',
    displayLabel: 'iPhone 13 / iOS 18.7 / Safari 26.5',
    device: 'iPhone 13',
    iosVersion: '18.7',
    safariVersion: '26.5',
    canvasFamily: 'B',
    status: 'available',
  },
  {
    id: 'iphone13mini_ios18_6_safari18_6',
    displayLabel: 'iPhone 13 mini / iOS 18.6 / Safari 18.6',
    device: 'iPhone 13 mini',
    iosVersion: '18.6',
    safariVersion: '18.6',
    canvasFamily: 'A',
    status: 'available',
  },
  {
    id: 'iphone13mini_ios18_7_safari26_4',
    displayLabel: 'iPhone 13 mini / iOS 18.7 / Safari 26.4',
    device: 'iPhone 13 mini',
    iosVersion: '18.7',
    safariVersion: '26.4',
    canvasFamily: 'B',
    status: 'available',
  },
  {
    id: 'iphone13mini_ios18_7_safari26_5',
    displayLabel: 'iPhone 13 mini / iOS 18.7 / Safari 26.5',
    device: 'iPhone 13 mini',
    iosVersion: '18.7',
    safariVersion: '26.5',
    canvasFamily: 'B',
    status: 'available',
  },
  {
    id: 'iphone13pro_ios18_6_safari18_6',
    displayLabel: 'iPhone 13 Pro / iOS 18.6 / Safari 18.6',
    device: 'iPhone 13 Pro',
    iosVersion: '18.6',
    safariVersion: '18.6',
    canvasFamily: 'A',
    status: 'available',
  },
  {
    id: 'iphone13pro_ios18_6_safari26_0',
    displayLabel: 'iPhone 13 Pro / iOS 18.6 / Safari 26.0',
    device: 'iPhone 13 Pro',
    iosVersion: '18.6',
    safariVersion: '26.0',
    canvasFamily: 'A',
    status: 'available',
  },
  {
    id: 'iphone13pro_ios18_7_safari26_3',
    displayLabel: 'iPhone 13 Pro / iOS 18.7 / Safari 26.3',
    device: 'iPhone 13 Pro',
    iosVersion: '18.7',
    safariVersion: '26.3',
    canvasFamily: 'A',
    status: 'available',
  },
  {
    id: 'iphone13pro_ios18_7_safari26_4',
    displayLabel: 'iPhone 13 Pro / iOS 18.7 / Safari 26.4',
    device: 'iPhone 13 Pro',
    iosVersion: '18.7',
    safariVersion: '26.4',
    canvasFamily: 'B',
    status: 'available',
  },
  {
    id: 'iphone13pro_ios18_7_safari26_5',
    displayLabel: 'iPhone 13 Pro / iOS 18.7 / Safari 26.5',
    device: 'iPhone 13 Pro',
    iosVersion: '18.7',
    safariVersion: '26.5',
    canvasFamily: 'B',
    status: 'available',
  },
  {
    id: 'iphone13promax_ios18_6_safari18_6',
    displayLabel: 'iPhone 13 Pro Max / iOS 18.6 / Safari 18.6',
    device: 'iPhone 13 Pro Max',
    iosVersion: '18.6',
    safariVersion: '18.6',
    canvasFamily: 'A',
    status: 'available',
  },
  {
    id: 'iphone13promax_ios18_6_safari26_0',
    displayLabel: 'iPhone 13 Pro Max / iOS 18.6 / Safari 26.0',
    device: 'iPhone 13 Pro Max',
    iosVersion: '18.6',
    safariVersion: '26.0',
    canvasFamily: 'A',
    status: 'available',
  },
  {
    id: 'iphone13promax_ios18_7_safari26_3',
    displayLabel: 'iPhone 13 Pro Max / iOS 18.7 / Safari 26.3',
    device: 'iPhone 13 Pro Max',
    iosVersion: '18.7',
    safariVersion: '26.3',
    canvasFamily: 'A',
    status: 'available',
  },
  {
    id: 'iphone13promax_ios18_7_safari26_4',
    displayLabel: 'iPhone 13 Pro Max / iOS 18.7 / Safari 26.4',
    device: 'iPhone 13 Pro Max',
    iosVersion: '18.7',
    safariVersion: '26.4',
    canvasFamily: 'B',
    status: 'available',
  },
  {
    id: 'iphone13promax_ios18_7_safari26_5',
    displayLabel: 'iPhone 13 Pro Max / iOS 18.7 / Safari 26.5',
    device: 'iPhone 13 Pro Max',
    iosVersion: '18.7',
    safariVersion: '26.5',
    canvasFamily: 'B',
    status: 'available',
  },
  {
    id: 'iphone14_ios18_6_safari18_6',
    displayLabel: 'iPhone 14 / iOS 18.6 / Safari 18.6',
    device: 'iPhone 14',
    iosVersion: '18.6',
    safariVersion: '18.6',
    canvasFamily: 'A',
    status: 'available',
  },
  {
    id: 'iphone14_ios18_6_safari26_0',
    displayLabel: 'iPhone 14 / iOS 18.6 / Safari 26.0',
    device: 'iPhone 14',
    iosVersion: '18.6',
    safariVersion: '26.0',
    canvasFamily: 'A',
    status: 'available',
  },
  {
    id: 'iphone14_ios18_7_safari26_3',
    displayLabel: 'iPhone 14 / iOS 18.7 / Safari 26.3',
    device: 'iPhone 14',
    iosVersion: '18.7',
    safariVersion: '26.3',
    canvasFamily: 'A',
    status: 'available',
  },
  {
    id: 'iphone14_ios18_7_safari26_4',
    displayLabel: 'iPhone 14 / iOS 18.7 / Safari 26.4',
    device: 'iPhone 14',
    iosVersion: '18.7',
    safariVersion: '26.4',
    canvasFamily: 'B',
    status: 'available',
  },
  {
    id: 'iphone14_ios18_7_safari26_5',
    displayLabel: 'iPhone 14 / iOS 18.7 / Safari 26.5',
    device: 'iPhone 14',
    iosVersion: '18.7',
    safariVersion: '26.5',
    canvasFamily: 'B',
    status: 'available',
  },
  {
    id: 'iphone14plus_ios18_6_safari18_6',
    displayLabel: 'iPhone 14 Plus / iOS 18.6 / Safari 18.6',
    device: 'iPhone 14 Plus',
    iosVersion: '18.6',
    safariVersion: '18.6',
    canvasFamily: 'A',
    status: 'available',
  },
  {
    id: 'iphone14plus_ios18_7_safari26_4',
    displayLabel: 'iPhone 14 Plus / iOS 18.7 / Safari 26.4',
    device: 'iPhone 14 Plus',
    iosVersion: '18.7',
    safariVersion: '26.4',
    canvasFamily: 'B',
    status: 'available',
  },
  {
    id: 'iphone14plus_ios18_7_safari26_5',
    displayLabel: 'iPhone 14 Plus / iOS 18.7 / Safari 26.5',
    device: 'iPhone 14 Plus',
    iosVersion: '18.7',
    safariVersion: '26.5',
    canvasFamily: 'B',
    status: 'available',
  },
  {
    id: 'iphone14pro_ios18_6_safari18_6',
    displayLabel: 'iPhone 14 Pro / iOS 18.6 / Safari 18.6',
    device: 'iPhone 14 Pro',
    iosVersion: '18.6',
    safariVersion: '18.6',
    canvasFamily: 'A',
    status: 'available',
  },
  {
    id: 'iphone14pro_ios18_6_safari26_0',
    displayLabel: 'iPhone 14 Pro / iOS 18.6 / Safari 26.0',
    device: 'iPhone 14 Pro',
    iosVersion: '18.6',
    safariVersion: '26.0',
    canvasFamily: 'A',
    status: 'available',
  },
  {
    id: 'iphone14pro_ios18_7_safari26_3',
    displayLabel: 'iPhone 14 Pro / iOS 18.7 / Safari 26.3',
    device: 'iPhone 14 Pro',
    iosVersion: '18.7',
    safariVersion: '26.3',
    canvasFamily: 'A',
    status: 'available',
  },
  {
    id: 'iphone14pro_ios18_7_safari26_4',
    displayLabel: 'iPhone 14 Pro / iOS 18.7 / Safari 26.4',
    device: 'iPhone 14 Pro',
    iosVersion: '18.7',
    safariVersion: '26.4',
    canvasFamily: 'B',
    status: 'available',
  },
  {
    id: 'iphone14pro_ios18_7_safari26_5',
    displayLabel: 'iPhone 14 Pro / iOS 18.7 / Safari 26.5',
    device: 'iPhone 14 Pro',
    iosVersion: '18.7',
    safariVersion: '26.5',
    canvasFamily: 'B',
    status: 'available',
  },
  {
    id: 'iphone14promax_ios18_6_safari18_6',
    displayLabel: 'iPhone 14 Pro Max / iOS 18.6 / Safari 18.6',
    device: 'iPhone 14 Pro Max',
    iosVersion: '18.6',
    safariVersion: '18.6',
    canvasFamily: 'A',
    status: 'available',
  },
  {
    id: 'iphone14promax_ios18_6_safari26_0',
    displayLabel: 'iPhone 14 Pro Max / iOS 18.6 / Safari 26.0',
    device: 'iPhone 14 Pro Max',
    iosVersion: '18.6',
    safariVersion: '26.0',
    canvasFamily: 'A',
    status: 'available',
  },
  {
    id: 'iphone14promax_ios18_7_safari26_3',
    displayLabel: 'iPhone 14 Pro Max / iOS 18.7 / Safari 26.3',
    device: 'iPhone 14 Pro Max',
    iosVersion: '18.7',
    safariVersion: '26.3',
    canvasFamily: 'A',
    status: 'available',
  },
  {
    id: 'iphone14promax_ios18_7_safari26_4',
    displayLabel: 'iPhone 14 Pro Max / iOS 18.7 / Safari 26.4',
    device: 'iPhone 14 Pro Max',
    iosVersion: '18.7',
    safariVersion: '26.4',
    canvasFamily: 'B',
    status: 'available',
  },
  {
    id: 'iphone14promax_ios18_7_safari26_5',
    displayLabel: 'iPhone 14 Pro Max / iOS 18.7 / Safari 26.5',
    device: 'iPhone 14 Pro Max',
    iosVersion: '18.7',
    safariVersion: '26.5',
    canvasFamily: 'B',
    status: 'available',
  },
  {
    id: 'iphone15_ios18_6_safari18_6',
    displayLabel: 'iPhone 15 / iOS 18.6 / Safari 18.6',
    device: 'iPhone 15',
    iosVersion: '18.6',
    safariVersion: '18.6',
    canvasFamily: 'A',
    status: 'available',
  },
  {
    id: 'iphone15_ios18_6_safari26_0',
    displayLabel: 'iPhone 15 / iOS 18.6 / Safari 26.0',
    device: 'iPhone 15',
    iosVersion: '18.6',
    safariVersion: '26.0',
    canvasFamily: 'A',
    status: 'available',
  },
  {
    id: 'iphone15_ios18_7_safari26_3',
    displayLabel: 'iPhone 15 / iOS 18.7 / Safari 26.3',
    device: 'iPhone 15',
    iosVersion: '18.7',
    safariVersion: '26.3',
    canvasFamily: 'A',
    status: 'available',
  },
  {
    id: 'iphone15_ios18_7_safari26_4',
    displayLabel: 'iPhone 15 / iOS 18.7 / Safari 26.4',
    device: 'iPhone 15',
    iosVersion: '18.7',
    safariVersion: '26.4',
    canvasFamily: 'B',
    status: 'available',
  },
  {
    id: 'iphone15_ios18_7_safari26_5',
    displayLabel: 'iPhone 15 / iOS 18.7 / Safari 26.5',
    device: 'iPhone 15',
    iosVersion: '18.7',
    safariVersion: '26.5',
    canvasFamily: 'B',
    status: 'available',
  },
  {
    id: 'iphone15plus_ios18_6_safari18_6',
    displayLabel: 'iPhone 15 Plus / iOS 18.6 / Safari 18.6',
    device: 'iPhone 15 Plus',
    iosVersion: '18.6',
    safariVersion: '18.6',
    canvasFamily: 'A',
    status: 'available',
  },
  {
    id: 'iphone15plus_ios18_7_safari26_4',
    displayLabel: 'iPhone 15 Plus / iOS 18.7 / Safari 26.4',
    device: 'iPhone 15 Plus',
    iosVersion: '18.7',
    safariVersion: '26.4',
    canvasFamily: 'B',
    status: 'available',
  },
  {
    id: 'iphone15plus_ios18_7_safari26_5',
    displayLabel: 'iPhone 15 Plus / iOS 18.7 / Safari 26.5',
    device: 'iPhone 15 Plus',
    iosVersion: '18.7',
    safariVersion: '26.5',
    canvasFamily: 'B',
    status: 'available',
  },
  {
    id: 'iphone15pro_ios18_6_safari18_6',
    displayLabel: 'iPhone 15 Pro / iOS 18.6 / Safari 18.6',
    device: 'iPhone 15 Pro',
    iosVersion: '18.6',
    safariVersion: '18.6',
    canvasFamily: 'A',
    status: 'available',
  },
  {
    id: 'iphone15pro_ios18_6_safari26_0',
    displayLabel: 'iPhone 15 Pro / iOS 18.6 / Safari 26.0',
    device: 'iPhone 15 Pro',
    iosVersion: '18.6',
    safariVersion: '26.0',
    canvasFamily: 'A',
    status: 'available',
  },
  {
    id: 'iphone15pro_ios18_7_safari26_3',
    displayLabel: 'iPhone 15 Pro / iOS 18.7 / Safari 26.3',
    device: 'iPhone 15 Pro',
    iosVersion: '18.7',
    safariVersion: '26.3',
    canvasFamily: 'A',
    status: 'available',
  },
  {
    id: 'iphone15pro_ios18_7_safari26_4',
    displayLabel: 'iPhone 15 Pro / iOS 18.7 / Safari 26.4',
    device: 'iPhone 15 Pro',
    iosVersion: '18.7',
    safariVersion: '26.4',
    canvasFamily: 'B',
    status: 'available',
  },
  {
    id: 'iphone15pro_ios18_7_safari26_5',
    displayLabel: 'iPhone 15 Pro / iOS 18.7 / Safari 26.5',
    device: 'iPhone 15 Pro',
    iosVersion: '18.7',
    safariVersion: '26.5',
    canvasFamily: 'B',
    status: 'available',
  },
  {
    id: 'iphone15promax_ios18_6_safari18_6',
    displayLabel: 'iPhone 15 Pro Max / iOS 18.6 / Safari 18.6',
    device: 'iPhone 15 Pro Max',
    iosVersion: '18.6',
    safariVersion: '18.6',
    canvasFamily: 'A',
    status: 'available',
  },
  {
    id: 'iphone15promax_ios18_6_safari26_0',
    displayLabel: 'iPhone 15 Pro Max / iOS 18.6 / Safari 26.0',
    device: 'iPhone 15 Pro Max',
    iosVersion: '18.6',
    safariVersion: '26.0',
    canvasFamily: 'A',
    status: 'available',
  },
  {
    id: 'iphone15promax_ios18_7_safari26_3',
    displayLabel: 'iPhone 15 Pro Max / iOS 18.7 / Safari 26.3',
    device: 'iPhone 15 Pro Max',
    iosVersion: '18.7',
    safariVersion: '26.3',
    canvasFamily: 'A',
    status: 'available',
  },
  {
    id: 'iphone15promax_ios18_7_safari26_4',
    displayLabel: 'iPhone 15 Pro Max / iOS 18.7 / Safari 26.4',
    device: 'iPhone 15 Pro Max',
    iosVersion: '18.7',
    safariVersion: '26.4',
    canvasFamily: 'B',
    status: 'available',
  },
  {
    id: 'iphone15promax_ios18_7_safari26_5',
    displayLabel: 'iPhone 15 Pro Max / iOS 18.7 / Safari 26.5',
    device: 'iPhone 15 Pro Max',
    iosVersion: '18.7',
    safariVersion: '26.5',
    canvasFamily: 'B',
    status: 'available',
  },
  {
    id: 'iphone16_ios18_6_safari18_6',
    displayLabel: 'iPhone 16 / iOS 18.6 / Safari 18.6',
    device: 'iPhone 16',
    iosVersion: '18.6',
    safariVersion: '18.6',
    canvasFamily: 'A',
    status: 'available',
  },
  {
    id: 'iphone16_ios18_6_safari26_0',
    displayLabel: 'iPhone 16 / iOS 18.6 / Safari 26.0',
    device: 'iPhone 16',
    iosVersion: '18.6',
    safariVersion: '26.0',
    canvasFamily: 'A',
    status: 'available',
  },
  {
    id: 'iphone16_ios18_7_safari26_3',
    displayLabel: 'iPhone 16 / iOS 18.7 / Safari 26.3',
    device: 'iPhone 16',
    iosVersion: '18.7',
    safariVersion: '26.3',
    canvasFamily: 'A',
    status: 'available',
  },
  {
    id: 'iphone16_ios18_7_safari26_4',
    displayLabel: 'iPhone 16 / iOS 18.7 / Safari 26.4',
    device: 'iPhone 16',
    iosVersion: '18.7',
    safariVersion: '26.4',
    canvasFamily: 'B',
    status: 'available',
  },
  {
    id: 'iphone16_ios18_7_safari26_5',
    displayLabel: 'iPhone 16 / iOS 18.7 / Safari 26.5',
    device: 'iPhone 16',
    iosVersion: '18.7',
    safariVersion: '26.5',
    canvasFamily: 'B',
    status: 'available',
  },
  {
    id: 'iphone16plus_ios18_6_safari18_6',
    displayLabel: 'iPhone 16 Plus / iOS 18.6 / Safari 18.6',
    device: 'iPhone 16 Plus',
    iosVersion: '18.6',
    safariVersion: '18.6',
    canvasFamily: 'A',
    status: 'available',
  },
  {
    id: 'iphone16plus_ios18_7_safari26_4',
    displayLabel: 'iPhone 16 Plus / iOS 18.7 / Safari 26.4',
    device: 'iPhone 16 Plus',
    iosVersion: '18.7',
    safariVersion: '26.4',
    canvasFamily: 'B',
    status: 'available',
  },
  {
    id: 'iphone16plus_ios18_7_safari26_5',
    displayLabel: 'iPhone 16 Plus / iOS 18.7 / Safari 26.5',
    device: 'iPhone 16 Plus',
    iosVersion: '18.7',
    safariVersion: '26.5',
    canvasFamily: 'B',
    status: 'available',
  },
  {
    id: 'iphone16pro_ios18_6_safari18_6',
    displayLabel: 'iPhone 16 Pro / iOS 18.6 / Safari 18.6',
    device: 'iPhone 16 Pro',
    iosVersion: '18.6',
    safariVersion: '18.6',
    canvasFamily: 'A',
    status: 'available',
  },
  {
    id: 'iphone16pro_ios18_6_safari26_0',
    displayLabel: 'iPhone 16 Pro / iOS 18.6 / Safari 26.0',
    device: 'iPhone 16 Pro',
    iosVersion: '18.6',
    safariVersion: '26.0',
    canvasFamily: 'A',
    status: 'available',
  },
  {
    id: 'iphone16pro_ios18_6_safari26_3',
    displayLabel: 'iPhone 16 Pro / iOS 18.6 / Safari 26.3',
    device: 'iPhone 16 Pro',
    iosVersion: '18.6',
    safariVersion: '26.3',
    canvasFamily: 'A',
    status: 'available',
  },
  {
    id: 'iphone16pro_ios18_7_safari26_3',
    displayLabel: 'iPhone 16 Pro / iOS 18.7 / Safari 26.3',
    device: 'iPhone 16 Pro',
    iosVersion: '18.7',
    safariVersion: '26.3',
    canvasFamily: 'A',
    status: 'available',
  },
  {
    id: 'iphone16pro_ios18_7_safari26_4',
    displayLabel: 'iPhone 16 Pro / iOS 18.7 / Safari 26.4',
    device: 'iPhone 16 Pro',
    iosVersion: '18.7',
    safariVersion: '26.4',
    canvasFamily: 'B',
    status: 'available',
  },
  {
    id: 'iphone16pro_ios18_7_safari26_5',
    displayLabel: 'iPhone 16 Pro / iOS 18.7 / Safari 26.5',
    device: 'iPhone 16 Pro',
    iosVersion: '18.7',
    safariVersion: '26.5',
    canvasFamily: 'B',
    status: 'available',
  },
  {
    id: 'iphone16promax_ios18_6_safari18_6',
    displayLabel: 'iPhone 16 Pro Max / iOS 18.6 / Safari 18.6',
    device: 'iPhone 16 Pro Max',
    iosVersion: '18.6',
    safariVersion: '18.6',
    canvasFamily: 'A',
    status: 'available',
  },
  {
    id: 'iphone16promax_ios18_6_safari26_0',
    displayLabel: 'iPhone 16 Pro Max / iOS 18.6 / Safari 26.0',
    device: 'iPhone 16 Pro Max',
    iosVersion: '18.6',
    safariVersion: '26.0',
    canvasFamily: 'A',
    status: 'available',
  },
  {
    id: 'iphone16promax_ios18_7_safari26_3',
    displayLabel: 'iPhone 16 Pro Max / iOS 18.7 / Safari 26.3',
    device: 'iPhone 16 Pro Max',
    iosVersion: '18.7',
    safariVersion: '26.3',
    canvasFamily: 'A',
    status: 'available',
  },
  {
    id: 'iphone16promax_ios18_7_safari26_4',
    displayLabel: 'iPhone 16 Pro Max / iOS 18.7 / Safari 26.4',
    device: 'iPhone 16 Pro Max',
    iosVersion: '18.7',
    safariVersion: '26.4',
    canvasFamily: 'B',
    status: 'available',
  },
  {
    id: 'iphone16promax_ios18_7_safari26_5',
    displayLabel: 'iPhone 16 Pro Max / iOS 18.7 / Safari 26.5',
    device: 'iPhone 16 Pro Max',
    iosVersion: '18.7',
    safariVersion: '26.5',
    canvasFamily: 'B',
    status: 'available',
  },
  {
    id: 'iphone17_ios18_7_safari26_5',
    displayLabel: 'iPhone 17 / iOS 18.7 / Safari 26.5',
    device: 'iPhone 17',
    iosVersion: '18.7',
    safariVersion: '26.5',
    canvasFamily: 'B',
    status: 'available',
  },
  {
    id: 'iphone17pro_ios18_6_safari26_0',
    displayLabel: 'iPhone 17 Pro / iOS 18.6 / Safari 26.0',
    device: 'iPhone 17 Pro',
    iosVersion: '18.6',
    safariVersion: '26.0',
    canvasFamily: 'A',
    status: 'available',
  },
  {
    id: 'iphone17pro_ios18_7_safari26_3',
    displayLabel: 'iPhone 17 Pro / iOS 18.7 / Safari 26.3',
    device: 'iPhone 17 Pro',
    iosVersion: '18.7',
    safariVersion: '26.3',
    canvasFamily: 'A',
    status: 'available',
  },
  {
    id: 'iphone17pro_ios18_7_safari26_4',
    displayLabel: 'iPhone 17 Pro / iOS 18.7 / Safari 26.4',
    device: 'iPhone 17 Pro',
    iosVersion: '18.7',
    safariVersion: '26.4',
    canvasFamily: 'B',
    status: 'available',
  },
  {
    id: 'iphone17pro_ios18_7_safari26_5',
    displayLabel: 'iPhone 17 Pro / iOS 18.7 / Safari 26.5',
    device: 'iPhone 17 Pro',
    iosVersion: '18.7',
    safariVersion: '26.5',
    canvasFamily: 'B',
    status: 'available',
  },
  {
    id: 'iphone17promax_ios18_7_safari26_4',
    displayLabel: 'iPhone 17 Pro Max / iOS 18.7 / Safari 26.4',
    device: 'iPhone 17 Pro Max',
    iosVersion: '18.7',
    safariVersion: '26.4',
    canvasFamily: 'B',
    status: 'available',
  },
  {
    id: 'iphone17promax_ios18_7_safari26_5',
    displayLabel: 'iPhone 17 Pro Max / iOS 18.7 / Safari 26.5',
    device: 'iPhone 17 Pro Max',
    iosVersion: '18.7',
    safariVersion: '26.5',
    canvasFamily: 'B',
    status: 'available',
  },
  // ── Legacy reference baseline (NOT in Agent-1's catalog) ──────────────────
  // iPhone 15 Pro / iOS 17.5 (Family A baseline). Not a catalog archetype;
  // retained as a non-selectable `reference` entry so already-created profiles
  // referencing this slug still resolve a display label. The other former
  // reference/planned slugs (iphone16pro_ios18_6/18_7, iphone16, iphone17pro/
  // promax, …) ARE in the catalog now and fold into the entries above as
  // `available`.
  {
    id: 'iphone15pro_ios17_5_safari17_5',
    displayLabel: 'iPhone 15 Pro / iOS 17.5 / Safari 17.5',
    device: 'iPhone 15 Pro',
    iosVersion: '17.5',
    safariVersion: '17.5',
    canvasFamily: 'A',
    status: 'reference',
  },
];

/**
 * Is `archetypeId` selectable on `tier`?
 *
 * PURE and registry-derived: an unknown id is NOT allowed, so a typo cannot slip
 * through a tier gate by failing to match anything — the fail-closed direction.
 * A tier with no restriction allows any id the registry knows.
 */
export function archetypeAllowedForTier(tier: AccountTier, archetypeId: string): boolean {
  const entry = ARCHETYPE_REGISTRY.find((a) => a.id === archetypeId);
  if (entry === undefined) return false;
  const allowed = ARCHETYPE_DEVICES_PER_TIER[tier];
  if (allowed === null) return true;
  return allowed.includes(entry.device);
}

/** Every archetype id `tier` may select. Empty only if the registry is empty. */
export function archetypeIdsForTier(tier: AccountTier): readonly string[] {
  return ARCHETYPE_REGISTRY.filter((a) => archetypeAllowedForTier(tier, a.id)).map((a) => a.id);
}

/**
 * Map an internal archetype identifier to its human-readable label,
 * derived from ARCHETYPE_REGISTRY (single source of truth). Falls back to
 * the identifier itself when unknown — UIs surface the raw id rather than
 * crash.
 */
export const ARCHETYPE_DISPLAY_LABEL: Record<string, string> = Object.fromEntries(
  ARCHETYPE_REGISTRY.map((a) => [a.id, a.displayLabel]),
);

export function archetypeDisplayLabel(id: string): string {
  return ARCHETYPE_DISPLAY_LABEL[id] ?? id;
}

const SELECTABLE_ARCHETYPE_IDS = new Set(
  ARCHETYPE_REGISTRY.filter(
    (archetype) => archetype.status === 'launch' || archetype.status === 'available',
  ).map((archetype) => archetype.id),
);

/** True only for customer-selectable registry entries returned by GET /v1/archetypes. */
export function isSelectableArchetypeId(id: string): boolean {
  return SELECTABLE_ARCHETYPE_IDS.has(id);
}

/**
 * Direct create/import input contract. Stored resource schemas intentionally
 * remain looser so legacy reference rows can still be read, cloned, moved and
 * launched without rewriting their identity.
 */
export const SelectableArchetypeIdSchema = z
  .string()
  .regex(/^[a-z0-9_]+$/, { message: 'archetype slug is lowercase alphanumeric + underscores' })
  .min(3)
  .max(60)
  .refine(isSelectableArchetypeId, {
    message: 'archetype must be a selectable id returned by GET /v1/archetypes',
  });

// `gui_control` is the scope that gates the manual-control plane
// (tap_at, type_focused, etc.) — bypasses the behavioral simulation
// layer, only granted to keys for the self-hosted GUI workflow per
// L-001 in docs/locked-decisions.md. Default key creation does not
// include this scope; enterprise-tier accounts get it explicitly.
/**
 * V-174 — scope architecture split. Two new scopes carve up what
 * 'admin' did pre-V-174:
 *
 * - `account_owner` — gates customer-account control (mint API keys,
 *   revoke API keys, manage subscription, /v1/account/*). A customer
 *   logged into their own dashboard has this scope; their personal
 *   keys can have it. The scope always resolves to exactly ONE account,
 *   but not always the caller's own.
 *
 *   V-795 — this bullet used to deny cross-account reach outright, on
 *   the grounds that handlers only ever read the caller's own account
 *   id. Both halves were false. Per V-326 every route participating in
 *   team RBAC
 *   resolves its target through `resolveEffectiveAccount`
 *   (`apps/server/src/services/auth.ts`), which returns
 *   `membership.ownerAccountId` — an account that is NOT
 *   `ctx.account.id` — when the caller sends `X-Driftstack-Account` for
 *   a team they hold a confirmed membership on. Cross-account access is
 *   therefore possible BY DESIGN and membership-gated: `ctx.teams` is
 *   server-derived and never client-supplied, an unknown id is a 403,
 *   and API-key writes additionally require the `admin` team role
 *   (`effectiveAccountIdForKeyWrite` in `routes/admin.ts`). The
 *   `GET /v1/account/me` handler itself is one that stays self-only —
 *   it reads `ctx.account.id` directly — though other routes in that
 *   same file do resolve an effective account.
 *
 * - `driftstack_internal_admin` — gates Driftstack-staff-only
 *   operations (`/v1/admin/*`: list all accounts, suspend account,
 *   change tier, force-actions, audit-log read, webhook DLQ
 *   management). Only the founder + Driftstack-internal accounts
 *   carry this scope. The exact scope check is the application authority
 *   boundary; Cloudflare Access SSO on admin.driftstack.io (V-135) is a
 *   separate defense-in-depth identity perimeter.
 *
 * - `admin` — pre-V-174 customer compatibility alias. It satisfies
 *   `account_owner` and customer `admin:X` scopes, but never
 *   `driftstack_internal_admin`; cross-account staff authority requires that
 *   exact scope. The enum value remains so stored legacy customer keys parse
 *   and retain their own-account access until they are rotated or revoked.
 */
export const ApiKeyScopeSchema = z.enum([
  'read',
  'write',
  'admin',
  'account_owner',
  'driftstack_internal_admin',
  'gui_control',
  // V-481 — granular per-resource scopes. Verb:resource order.
  // Backwards-compat: customer broad scopes (`read` / `write` / `admin` /
  // `account_owner`) satisfy granular checks via requireScope's
  // verb-prefix logic in `apps/server/src/lib/errors-helpers.ts`
  // and `apps/server/src/services/auth.ts`. Granular scopes do
  // NOT satisfy broad checks — narrow keys stay narrow.
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
export type ApiKeyScope = z.infer<typeof ApiKeyScopeSchema>;

/**
 * Request-only API-key scope list. The response schema intentionally remains
 * tolerant of historic stored arrays, while new writes must use each member of
 * the closed canonical roster at most once.
 */
export const ApiKeyScopeListRequestSchema = z
  .array(ApiKeyScopeSchema)
  .min(1)
  .max(ApiKeyScopeSchema.options.length)
  .refine((scopes) => new Set(scopes).size === scopes.length, {
    message: 'scopes must not contain duplicates',
  });

/**
 * V-481 — split a granular scope into `[verb, resource]`. Returns
 * null for non-granular scopes (the broad ones don't have a colon).
 */
export function parseGranularScope(
  scope: ApiKeyScope,
): { verb: 'read' | 'write' | 'admin'; resource: string } | null {
  const idx = scope.indexOf(':');
  if (idx === -1) return null;
  const verb = scope.slice(0, idx);
  if (verb !== 'read' && verb !== 'write' && verb !== 'admin') return null;
  return { verb, resource: scope.slice(idx + 1) };
}

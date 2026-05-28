import { z } from 'zod';

// ───────────────────────────────────────────────────────────────────────────
// Shared primitives
// ───────────────────────────────────────────────────────────────────────────

export const UuidSchema = z.string().uuid();

export const Iso8601Schema = z
  .string()
  .datetime({ offset: true })
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
 * shape; server-side enforcement reads this at the saved-proxy create
 * gate (egress backend partly stubbed today → enforced when it lands).
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
 * One config per `(tier, bucketKey)`. Two bucket keys are defined today:
 *
 *   - `global` — every authenticated `/v1/*` call consumes this bucket.
 *     Protects against accidental DDoS / runaway scripts.
 *   - `sessions:create` — `POST /v1/sessions` only. Lower cap because
 *     session creation is the most expensive op in the system (driver
 *     allocation, archetype hydration, fingerprint pinning).
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
 *     conditional UI (e.g. hide AI-agent CTA on Solo Manual).
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
  /** Vestigial; always false (the perpetual free tier replaced the one-time trial_pack). TODO(6.b): remove with the trial billing logic. */
  trialPack: boolean;
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
    trialPack: false,
  },
  solo_manual: {
    concurrentSessions: 1,
    profiles: 10,
    apiKeyEnvironment: 'live',
    apiAccess: true,
    aiAgent: false,
    llmBilling: null,
    vpnEgress: true,
    trialPack: false,
  },
  team_manual: {
    concurrentSessions: 3,
    profiles: 50,
    apiKeyEnvironment: 'live',
    apiAccess: true,
    aiAgent: true,
    llmBilling: 'byok_only',
    vpnEgress: true,
    trialPack: false,
  },
  agency_manual: {
    concurrentSessions: 8,
    profiles: 200,
    apiKeyEnvironment: 'live',
    apiAccess: true,
    aiAgent: true,
    llmBilling: 'byok_only',
    vpnEgress: true,
    trialPack: false,
  },
  api_starter: {
    concurrentSessions: 2,
    profiles: 25,
    apiKeyEnvironment: 'live',
    apiAccess: true,
    aiAgent: true,
    llmBilling: 'byok_only',
    vpnEgress: true,
    trialPack: false,
  },
  api_builder: {
    concurrentSessions: 8,
    profiles: 100,
    apiKeyEnvironment: 'live',
    apiAccess: true,
    aiAgent: true,
    llmBilling: 'byok_or_bundled',
    vpnEgress: true,
    trialPack: false,
  },
  api_scale: {
    concurrentSessions: 24,
    profiles: 500,
    apiKeyEnvironment: 'live',
    apiAccess: true,
    aiAgent: true,
    llmBilling: 'byok_or_bundled',
    vpnEgress: true,
    trialPack: false,
  },
  enterprise: {
    concurrentSessions: 32,
    profiles: 'custom',
    apiKeyEnvironment: 'live',
    apiAccess: true,
    aiAgent: true,
    llmBilling: 'byok_or_bundled_custom',
    vpnEgress: true,
    trialPack: false,
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
export const LOCKED_ARCHETYPE_ID = 'iphone16pro_ios18_7_safari26_4';
export const LOCKED_ARCHETYPE_DISPLAY_LABEL = 'iPhone 16 Pro / iOS 18.7 / Safari 26.4';

/**
 * Map an internal archetype identifier to its human-readable label.
 * Falls back to the identifier itself when unknown — UIs surface the
 * raw id rather than crash. Tests can ship known-archetype labels by
 * extending this record before/after V-136.
 */
export const ARCHETYPE_DISPLAY_LABEL: Record<string, string> = {
  [LOCKED_ARCHETYPE_ID]: LOCKED_ARCHETYPE_DISPLAY_LABEL,
};

export function archetypeDisplayLabel(id: string): string {
  return ARCHETYPE_DISPLAY_LABEL[id] ?? id;
}

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
 *   keys can have it; cross-account access is impossible because the
 *   route handlers always operate against `ctx.account.id`.
 *
 * - `driftstack_internal_admin` — gates Driftstack-staff-only
 *   operations (`/v1/admin/*`: list all accounts, suspend account,
 *   change tier, force-actions, audit-log read, webhook DLQ
 *   management). Only the founder + Driftstack-internal accounts
 *   carry this scope. admin.driftstack.dev origin (V-135) gates
 *   reachability via Cloudflare Access SSO; the scope check is the
 *   defense-in-depth layer.
 *
 * - `admin` — pre-V-174 compat alias. Treated as satisfying BOTH new
 *   scopes during the migration window (via
 *   `lib/errors-helpers.ts::requireScope`). Existing API keys with
 *   `'admin'` scope continue to work unchanged. Founder-driven
 *   migration script (separate V-NNN) promotes Driftstack-internal
 *   admin keys to explicit `'driftstack_internal_admin'`; remaining
 *   customer-side `'admin'` keys get re-scoped to `'account_owner'`.
 *   After migration, `'admin'` is deprecated + removed.
 */
export const ApiKeyScopeSchema = z.enum([
  'read',
  'write',
  'admin',
  'account_owner',
  'driftstack_internal_admin',
  'gui_control',
  // V-481 — granular per-resource scopes. Verb:resource order.
  // Backwards-compat: broad scopes (`read` / `write` / `admin` /
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

// W436.A — drift guard for packages/api-types/src/common.ts.
// Shared primitives + locked pricing model + V-485 tier-feature
// registry + V-174 scope split + V-481 granular scopes. Drift here is
// catastrophic: bumping a tier value silently re-prices the entire
// customer base (PROFILES_PER_TIER / TIER_CONCURRENT_SESSION_LIMITS /
// TIER_RATE_LIMIT_DEFAULTS / TIER_FEATURES); collapsing the V-174
// scope split re-grants every customer admin scope across accounts;
// drift on LOCKED_ARCHETYPE_ID re-references the post-V-136 fix and
// the prior iphone16pro_ios26_4_1 conflation regresses.
//
//   • Iso8601Schema: datetime(offset:true) + describe.
//   • PaginationQuery: limit coerce 1..100 default 50 + cursor.
//   • PaginatedListSchema: data + has_more + next_cursor generic factory.
//   • PrefixedId factory regex + 5 IDs (acc/key/ses/evt/use).
//   • ADR-004 locked pricing rationale pinned (file-127 superseded;
//     pre-launch, no production customers, V-073 migration drops +
//     recreates Postgres enum + re-maps test data).
//   • Trial + Manual + API + Enterprise ladder framing pinned with
//     concrete $/profiles/concurrent numbers.
//   • Annual = 20% off; concurrent caps the ONLY metering primitive
//     on paid tiers; hours metering ONLY for trial_pack (ADR-003
//     trial_pack_credit_cents decrement); profile-count enforced at
//     /v1/profiles creation gate (V-073).
//   • AccountTier 8-value enum + PROFILES_PER_TIER + TIER_CONCURRENT_
//     SESSION_LIMITS constants.
//   • V-219 TIER_RATE_LIMIT_DEFAULTS framing + key numbers.
//   • V-485 TierFeatures + TIER_FEATURES registry + helpers.
//   • V-136 LOCKED_ARCHETYPE_ID rename rationale (was
//     iphone16pro_ios26_4_1 conflating Safari 26.4 with fictional
//     iOS 26.4.1).
//   • V-174 scope architecture split (account_owner / driftstack_
//     internal_admin / admin compat alias).
//   • V-481 granular scope enum + parseGranularScope verb-prefix.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/api-types/src/common.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W436.A packages/api-types/src/common.ts content parity', () => {
  const body = read(LIB);

  it("imports z from 'zod' only (no other dependency)", () => {
    expect(body).toMatch(/^import \{ z \} from 'zod';/m);
  });

  it('Iso8601Schema: datetime({offset:true}) + a 1970 floor + describe "ISO 8601 timestamp with timezone offset"; UuidSchema', () => {
    expect(body).toMatch(/export const UuidSchema = z\.string\(\)\.uuid\(\);/);
    // Pinned as fragments rather than one closed multi-line regex. The chain
    // grew a `.refine` and the old regex matched the whole declaration in one
    // piece, so it broke on a change it was not written to police. Fragments
    // survive reflow and say which part moved.
    expect(body).toContain('export const Iso8601Schema = z');
    expect(body).toContain('.datetime({ offset: true })');
    expect(body).toContain(
      ".describe('ISO 8601 timestamp with timezone offset, e.g. 2026-05-02T09:15:00Z')",
    );
    // The floor itself. Timestamp filters are handed straight to a timestamptz
    // comparison, so a year Postgres cannot store becomes a 500 from a query
    // string; `packages/api-types/tests/iso8601-timestamp-floor.test.ts` pins
    // the behaviour, this pins that the shared schema still carries it.
    expect(body).toContain('Number(value.slice(0, 4)) >= 1970');
  });

  it('PaginationQuery framing pinned: opaque cursor strings; servers may swap encoding later without breaking clients; limit coerce 1..100 default 50 + cursor min-1 max-512 optional (slice 148 cap)', () => {
    expect(body).toMatch(
      /\/\/ Cursor pagination — opaque cursor strings; servers may swap encoding later\s*\n?\s*\/\/ without breaking clients\./,
    );
    // Slice 148 added `.min(1).max(512)` to cursor — caps base64url-
    // encoded {ts, uuid} pagination tokens at 512 chars so a single
    // schema-level cap flows into all 3 customer-facing list routes
    // (profiles / profile-snapshots / sessions) instead of requiring
    // 3 separate route-level edits.
    expect(body).toMatch(
      /export const PaginationQuerySchema = z\.object\(\{\s*\n?\s*limit: z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.max\(100\)\.default\(50\),\s*\n?\s*cursor: z\.string\(\)\.min\(1\)\.max\(512\)\.optional\(\),\s*\n?\s*\}\);/,
    );
  });

  it('PaginatedListSchema: generic factory (item: T) → data + has_more + next_cursor nullable', () => {
    expect(body).toMatch(
      /export const PaginatedListSchema = <T extends z\.ZodTypeAny>\(item: T\) =>\s*\n?\s*z\.object\(\{\s*\n?\s*data: z\.array\(item\),\s*\n?\s*has_more: z\.boolean\(\),\s*\n?\s*next_cursor: z\.string\(\)\.nullable\(\),\s*\n?\s*\}\);/,
    );
  });

  it('PrefixedId framing pinned: public-facing prefixed strings ("acc_…", "key_…", "ses_…") stored as UUIDs in Postgres; mapping at route boundary; service+DB use raw UUIDs', () => {
    expect(body).toMatch(
      /\/\/ Public-facing IDs are prefixed strings \("acc_…", "key_…", "ses_…"\) even\s*\n?\s*\/\/ though stored as UUIDs in Postgres\. The mapping happens at the route\s*\n?\s*\/\/ boundary; service layers and DB use raw UUIDs\./,
    );
    expect(body).toMatch(
      /export const PrefixedId = \(prefix: string\): z\.ZodString =>\s*\n?\s*z\s*\n?\s*\.string\(\)\s*\n?\s*\.regex\(new RegExp\(`\^\$\{prefix\}_\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{12\}\$`\), \{\s*\n?\s*message: `must start with "\$\{prefix\}_" followed by a UUID`,\s*\n?\s*\}\);/,
    );
    expect(body).toMatch(/export const AccountIdSchema = PrefixedId\('acc'\);/);
    expect(body).toMatch(/export const ApiKeyIdSchema = PrefixedId\('key'\);/);
    expect(body).toMatch(/export const SessionIdSchema = PrefixedId\('ses'\);/);
    expect(body).toMatch(/export const SessionEventIdSchema = PrefixedId\('evt'\);/);
    expect(body).toMatch(/export const UsageRecordIdSchema = PrefixedId\('use'\);/);
  });

  it('ADR-004 locked pricing rationale pinned: two-ladder concurrent-only (supersedes file-127 single-ladder hours-with-overage); pre-launch / no production customers / V-073 migration drops + recreates Postgres enum + re-maps test data', () => {
    expect(body).toMatch(
      /\/\/ Locked pricing model — two-ladder concurrent-only per ADR-004\s*\n?\s*\/\/ \(supersedes file-127 single-ladder hours-with-overage design;\s*\n?\s*\/\/ pre-launch, no production customers, V-073 migration drops \+\s*\n?\s*\/\/ recreates the Postgres enum and re-maps any existing test data\s*\n?\s*\/\/ from old tier names to new equivalents\)\./,
    );
  });

  it('Free-tier rationale pinned: perpetual default, $0, 1 profile, manual-only (no API), 1 concurrent, no AI, no expiry', () => {
    expect(body).toMatch(
      /\/\/ Free \(perpetual default — no billing, resolves findings #6\/#10 by/,
    );
    expect(body).toMatch(
      /\/\/\s*- free\s+\$0\s+— 1 profile, manual-only \(no API\), 1 concurrent, no AI agent, no expiry/,
    );
  });

  it('Manual ladder rationale pinned: GUI client humans; profile count tier-defining; solo $79/$758 / team $249/$2390 / agency $699/$6710 with 10/50/200 profiles + 1/3/8 concurrent + unlimited hours', () => {
    expect(body).toMatch(
      /\/\/ Manual ladder \(humans clicking GUI client; profile count tier-defining\):\s*\n?\s*\/\/\s*- solo_manual\s+\$79\/mo\s+\(\$758\/yr = \$63\/mo\)\s+— 10 profiles\s+\/ 1 concurrent \/ unlimited hours\s*\n?\s*\/\/\s*- team_manual\s+\$249\/mo\s+\(\$2,390\/yr = \$199\/mo\)\s+— 50 profiles\s+\/ 3 concurrent \/ unlimited hours\s*\n?\s*\/\/\s*- agency_manual\s+\$699\/mo\s+\(\$6,710\/yr = \$559\/mo\)\s+— 200 profiles \/ 8 concurrent \/ unlimited hours/,
    );
  });

  it('API ladder rationale pinned: programmatic SDK access; concurrent caps tier-defining; starter $149/builder $499/scale $1499 with 25/100/500 profiles + 2/8/24 concurrent; enterprise from $4000/mo annual-only + negotiated', () => {
    expect(body).toMatch(
      /\/\/ API ladder \(programmatic SDK access; concurrent caps tier-defining\):\s*\n?\s*\/\/\s*- api_starter\s+\$149\/mo\s+\(\$1,430\/yr = \$119\/mo\)\s+— 25 profiles\s+\/ 2 concurrent\s+\/ unlimited hours\s*\n?\s*\/\/\s*- api_builder\s+\$499\/mo\s+\(\$4,790\/yr = \$399\/mo\)\s+— 100 profiles \/ 8 concurrent\s+\/ unlimited hours\s*\n?\s*\/\/\s*- api_scale\s+\$1,499\/mo \(\$14,390\/yr = \$1,199\/mo\) — 500 profiles \/ 24 concurrent \/ unlimited hours\s*\n?\s*\/\/\s*- enterprise\s+from \$4,000\/mo annual only — custom profiles \+ concurrent, negotiated/,
    );
  });

  it('Annual 20% off + concurrent caps the ONLY metering primitive on paid tiers + free tier has no usage metering + profile-count enforced at /v1/profiles creation gate', () => {
    expect(body).toMatch(
      /\/\/ Annual is 20% off across all tiers\. Concurrent caps are the\s*\n?\s*\/\/ only metering primitive on paid tiers; the free tier has no\s*\n?\s*\/\/ usage metering at all \(no credit, no hours cap, no expiry\)\./,
    );
    expect(body).toMatch(/\/\/ Profile count is enforced at the \/v1\/profiles creation gate\./);
  });

  it('AccountTier enum: 8 values pinned (free/solo_manual/team_manual/agency_manual/api_starter/api_builder/api_scale/enterprise)', () => {
    expect(body).toMatch(
      /export const AccountTierSchema = z\.enum\(\[\s*\n?\s*'free',\s*\n?\s*'solo_manual',\s*\n?\s*'team_manual',\s*\n?\s*'agency_manual',\s*\n?\s*'api_starter',\s*\n?\s*'api_builder',\s*\n?\s*'api_scale',\s*\n?\s*'enterprise',\s*\n?\s*\]\);/,
    );
  });

  it('PROFILES_PER_TIER: single source of truth for marketing/dashboard/server enforcement; mirrored in marketing-site pricing.ts API_TIERS field profiles; enterprise = "custom"', () => {
    expect(body).toMatch(
      /\*\s*Profile-count limits per tier — single source of truth for\s*\n?\s*\*\s*marketing-site, customer-dashboard, and server-side enforcement\./,
    );
    expect(body).toMatch(
      /export const PROFILES_PER_TIER: Record<AccountTier, number \| 'custom'> = \{\s*\n?\s*free: 1,\s*\n?\s*solo_manual: 10,\s*\n?\s*team_manual: 50,\s*\n?\s*agency_manual: 200,\s*\n?\s*api_starter: 25,\s*\n?\s*api_builder: 100,\s*\n?\s*api_scale: 500,\s*\n?\s*enterprise: 'custom',\s*\n?\s*\};/,
    );
  });

  it('6.g PROXIES_PER_TIER: free 1 (BYO SOCKS5; every session needs a proxy) / solo 10 / scaling to enterprise custom', () => {
    expect(body).toMatch(
      /export const PROXIES_PER_TIER: Record<AccountTier, number \| 'custom'> = \{\s*\n?\s*free: 1,\s*\n?\s*solo_manual: 10,\s*\n?\s*team_manual: 25,\s*\n?\s*agency_manual: 50,\s*\n?\s*api_starter: 25,\s*\n?\s*api_builder: 100,\s*\n?\s*api_scale: 500,\s*\n?\s*enterprise: 'custom',\s*\n?\s*\};/,
    );
    expect(body).toMatch(
      /owner-scoped saved-proxy create gate enforces every numeric\s*\n?\s*\* tier atomically/,
    );
    expect(body).toMatch(/Enterprise uses its negotiated custom allowance/);
    expect(body).not.toMatch(/egress backend partly stubbed|enforced when it lands/i);
  });

  it('6.g MAX_SESSION_MINUTES_PER_TIER: free 20-min auto-destroy cap; paid tiers null (unlimited)', () => {
    expect(body).toMatch(
      /export const MAX_SESSION_MINUTES_PER_TIER: Record<AccountTier, number \| null> = \{\s*\n?\s*free: 20,\s*\n?\s*solo_manual: null,\s*\n?\s*team_manual: null,\s*\n?\s*agency_manual: null,\s*\n?\s*api_starter: null,\s*\n?\s*api_builder: null,\s*\n?\s*api_scale: null,\s*\n?\s*enterprise: null,\s*\n?\s*\};/,
    );
  });

  it('TIER_CONCURRENT_SESSION_LIMITS: primary metering primitive on paid tiers; (N+1)th triggers concurrency_limit_exceeded HTTP 429; enterprise: 32 sentinel floor for smallest custom contract (per-account overrides bump higher)', () => {
    expect(body).toMatch(
      /\*\s*Concurrent session limit per tier — the primary metering primitive\s*\n?\s*\*\s*on paid tiers\. A customer can have up to N sessions in `creating` \/\s*\n?\s*\*\s*`ready` \/ `busy` state simultaneously; creating an \(N\+1\)th triggers\s*\n?\s*\*\s*`concurrency_limit_exceeded` \(HTTP 429\)\./,
    );
    expect(body).toMatch(
      /\*\s*Locked per ADR-004\. Values mirrored in\s*\n?\s*\*\s*`apps\/marketing-site\/src\/data\/pricing\.ts:API_TIERS` field\s*\n?\s*\*\s*`concurrent`\. `enterprise: 32` is a sentinel floor for the smallest\s*\n?\s*\*\s*custom contract; per-account overrides via the rate-limit-overrides\s*\n?\s*\*\s*path bump real Enterprise customers higher\./,
    );
    expect(body).toMatch(
      /export const TIER_CONCURRENT_SESSION_LIMITS: Record<AccountTier, number> = \{\s*\n?\s*free: 1,\s*\n?\s*solo_manual: 1,\s*\n?\s*team_manual: 3,\s*\n?\s*agency_manual: 8,\s*\n?\s*api_starter: 2,\s*\n?\s*api_builder: 8,\s*\n?\s*api_scale: 24,\s*\n?\s*enterprise: 32,\s*\n?\s*\};/,
    );
  });

  it('V-219 TIER_RATE_LIMIT_DEFAULTS framing pinned: anti-abuse not pricing; ADR-004 concurrent-not-per-call; two bucket keys (global + sessions:create); per-account overrides via rate-limit-overrides (V-052) supersede defaults', () => {
    expect(body).toMatch(
      /\*\s*V-219 — per-tier rate-limit defaults \(token-bucket capacity \+ refill\)\./,
    );
    expect(body).toMatch(
      /\*\s*- `global` — every authenticated `\/v1\/\*` call consumes this bucket\.\s*\n?\s*\*\s*Protects against accidental DDoS \/ runaway scripts\.\s*\n?\s*\*\s*- `sessions:create` — `POST \/v1\/sessions` only\. Lower cap because\s*\n?\s*\*\s*session creation is the most expensive op in the system \(driver\s*\n?\s*\*\s*allocation, archetype hydration, fingerprint pinning\)\./,
    );
    expect(body).toMatch(
      /\*\s*These are anti-abuse limits, not pricing — per ADR-004, customers\s*\n?\s*\*\s*pay for concurrent sessions, not per-call\./,
    );
    expect(body).toMatch(
      /Per-account overrides\s*\n?\s*\*\s*via the rate-limit-overrides path \(V-052\) supersede these defaults\./,
    );
  });

  it('BucketLimitConfig interface + TIER_RATE_LIMIT_DEFAULTS Record values pinned (trial 60/1 + 5/(1/60) + msg 20/(1/5) + input 240/60; api_scale 6000/100 + 120/2 + msg 1000/10 + input 1200/300; enterprise 60000/1000 + 600/10 + msg 10000/100 + input 12000/3000)', () => {
    expect(body).toMatch(
      /export interface BucketLimitConfig \{\s*\n?\s*capacity: number;\s*\n?\s*refill_per_second: number;\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /export const TIER_RATE_LIMIT_DEFAULTS: Record<\s*\n?\s*AccountTier,\s*\n?\s*Record<\s*\n?\s*'global' \| 'sessions:create' \| 'agent_sessions:message' \| 'agent_sessions:input_event',\s*\n?\s*BucketLimitConfig\s*\n?\s*>\s*\n?\s*> = \{/,
    );
    expect(body).toMatch(
      /free: \{\s*\n?\s*global: \{ capacity: 60, refill_per_second: 1 \},\s*\n?\s*'sessions:create': \{ capacity: 5, refill_per_second: 1 \/ 60 \},[\s\S]*?'agent_sessions:message': \{ capacity: 20, refill_per_second: 1 \/ 5 \},[\s\S]*?'agent_sessions:input_event': \{ capacity: 240, refill_per_second: 60 \},\s*\n?\s*\},/,
    );
    expect(body).toMatch(
      /api_scale: \{\s*\n?\s*global: \{ capacity: 6_000, refill_per_second: 100 \},\s*\n?\s*'sessions:create': \{ capacity: 120, refill_per_second: 2 \},\s*\n?\s*'agent_sessions:message': \{ capacity: 1_000, refill_per_second: 10 \},\s*\n?\s*'agent_sessions:input_event': \{ capacity: 1_200, refill_per_second: 300 \},\s*\n?\s*\},/,
    );
    expect(body).toMatch(
      /enterprise: \{\s*\n?\s*global: \{ capacity: 60_000, refill_per_second: 1_000 \},\s*\n?\s*'sessions:create': \{ capacity: 600, refill_per_second: 10 \},\s*\n?\s*'agent_sessions:message': \{ capacity: 10_000, refill_per_second: 100 \},\s*\n?\s*'agent_sessions:input_event': \{ capacity: 12_000, refill_per_second: 3_000 \},\s*\n?\s*\},/,
    );
  });

  it('V-485 TierFeatures framing pinned: single source of truth for tier-gated capabilities; mirrors marketing-site pricing.ts; consumers (requireTierFeature 403 feature_not_available + customer dashboard conditional UI); add-new-feature instructions', () => {
    expect(body).toMatch(/\*\s*V-485 — per-tier feature gating registry\./);
    expect(body).toMatch(
      /\*\s*Single source of truth for "which capabilities does this tier\s*\n?\s*\*\s*unlock\?" Today the server checks `tier === 'free'` \/\s*\n?\s*\*\s*`PROFILES_PER_TIER\[tier\]` \/ `TIER_CONCURRENT_SESSION_LIMITS\[tier\]`\s*\n?\s*\*\s*in scattered call sites; this registry is the central place for\s*\n?\s*\*\s*those plus the AI-agent \+ LLM-billing gates that ship with V-487\+\./,
    );
    expect(body).toMatch(
      /\*\s*Consumers:\s*\n?\s*\*\s*- Server: `requireTierFeature\(tier, key\)` in\s*\n?\s*\*\s*`apps\/server\/src\/lib\/errors-helpers\.ts` throws 403 with\s*\n?\s*\*\s*`feature_not_available` problem-type when the gate fails\.\s*\n?\s*\*\s*- Customer dashboard: read TIER_FEATURES directly to drive\s*\n?\s*\*\s*conditional UI \(e\.g\. hide AI-agent CTA on Personal\)\./,
    );
    expect(body).toMatch(
      /export type LlmBilling = 'byok_only' \| 'byok_or_bundled' \| 'byok_or_bundled_custom' \| null;/,
    );
    expect(body).toMatch(/export interface TierFeatures \{/);
    expect(body).toMatch(/concurrentSessions: number;/);
    expect(body).toMatch(/profiles: number \| 'custom';/);
    expect(body).toMatch(
      /\/\*\* Stripe environment for API-key minting \(test on free, live elsewhere\)\. \*\//,
    );
    expect(body).toMatch(/apiKeyEnvironment: 'test' \| 'live';/);
    expect(body).toMatch(/apiAccess: boolean;/);
    expect(body).toMatch(/aiAgent: boolean;/);
    expect(body).toMatch(/llmBilling: LlmBilling;/);
    expect(body).toMatch(/vpnEgress: boolean;/);
    // trialPack: boolean removed 2026-05-27 with the trial_pack retirement.
    expect(body).not.toMatch(/trialPack/);
  });

  it('TIER_FEATURES Record: free (test env + apiAccess false + aiAgent false) + team_manual (apiAccess true + aiAgent true + byok_only) + api_builder (byok_or_bundled) + enterprise (custom profiles + byok_or_bundled_custom)', () => {
    expect(body).toMatch(
      /free: \{\s*\n?\s*concurrentSessions: 1,\s*\n?\s*profiles: 1,\s*\n?\s*apiKeyEnvironment: 'test',\s*\n?\s*apiAccess: false,\s*\n?\s*aiAgent: false,\s*\n?\s*llmBilling: null,\s*\n?\s*vpnEgress: false,\s*\n?\s*\},/,
    );
    expect(body).toMatch(
      /team_manual: \{\s*\n?\s*concurrentSessions: 3,\s*\n?\s*profiles: 50,\s*\n?\s*apiKeyEnvironment: 'live',\s*\n?\s*apiAccess: true,\s*\n?\s*aiAgent: true,\s*\n?\s*llmBilling: 'byok_only',\s*\n?\s*vpnEgress: true,\s*\n?\s*\},/,
    );
    expect(body).toMatch(
      /api_builder: \{\s*\n?\s*concurrentSessions: 8,\s*\n?\s*profiles: 100,\s*\n?\s*apiKeyEnvironment: 'live',\s*\n?\s*apiAccess: true,\s*\n?\s*aiAgent: true,\s*\n?\s*llmBilling: 'byok_or_bundled',\s*\n?\s*vpnEgress: true,\s*\n?\s*\},/,
    );
    expect(body).toMatch(
      /enterprise: \{\s*\n?\s*concurrentSessions: 32,\s*\n?\s*profiles: 'custom',\s*\n?\s*apiKeyEnvironment: 'live',\s*\n?\s*apiAccess: true,\s*\n?\s*aiAgent: true,\s*\n?\s*llmBilling: 'byok_or_bundled_custom',\s*\n?\s*vpnEgress: true,\s*\n?\s*\},/,
    );
  });

  it('TierBooleanFeature type + tierFeatures() pure lookup + tierHasFeature(tier, feature) boolean predicate', () => {
    expect(body).toMatch(
      /export type TierBooleanFeature = \{\s*\n?\s*\[K in keyof TierFeatures\]: TierFeatures\[K\] extends boolean \? K : never;\s*\n?\s*\}\[keyof TierFeatures\];/,
    );
    expect(body).toMatch(
      /export function tierFeatures\(tier: AccountTier\): TierFeatures \{\s*\n?\s*return TIER_FEATURES\[tier\];\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /export function tierHasFeature\(tier: AccountTier, feature: TierBooleanFeature\): boolean \{\s*\n?\s*return TIER_FEATURES\[tier\]\[feature\];\s*\n?\s*\}/,
    );
  });

  it('LOCKED_ARCHETYPE_ID + V-136 rename rationale pinned: was iphone16pro_ios26_4_1 (conflated Safari 26.4 with fictional iOS 26.4.1); corrected to iphone16pro_ios18_7_safari26_4; iOS major bump cycles BOTH values; Safari version part of identifier so Safari-only updates ship without touching iOS framing', () => {
    expect(body).toMatch(
      /\*\s*The identifier \(`iphone16pro_ios18_7_safari26_4`\) is what the API\s*\n?\s*\*\s*accepts on `\/v1\/sessions \{ archetype \}` and what the server stores\s*\n?\s*\*\s*on session \+ profile rows\./,
    );
    expect(body).toMatch(
      /\*\s*Versioning: every iOS major bump \(iOS 19, iOS 20, \.\.\.\) cycles BOTH\s*\n?\s*\*\s*values\. Apple ships Safari independently of iOS major; the\s*\n?\s*\*\s*Safari version is part of the identifier so we can ship Safari-only\s*\n?\s*\*\s*archetype updates without touching iOS framing\./,
    );
    expect(body).toMatch(
      /\*\s*V-136: renamed from the prior `iphone16pro_ios26_4_1` identifier\s*\n?\s*\*\s*\(which conflated Safari 26\.4 with a fictional "iOS 26\.4\.1"\) to the\s*\n?\s*\*\s*correct `iphone16pro_ios18_7_safari26_4`\./,
    );
    expect(body).toMatch(/export const LOCKED_ARCHETYPE_ID = 'iphone17_ios18_7_safari26_4';/);
    expect(body).toMatch(
      /export const LOCKED_ARCHETYPE_DISPLAY_LABEL = 'iPhone 17 \/ iOS 18\.7 \/ Safari 26\.4';/,
    );
    // ARCHETYPE_DISPLAY_LABEL is now DERIVED from ARCHETYPE_REGISTRY (the
    // multi-archetype source of truth) rather than a hand-built single
    // entry — labels for every registered archetype, not just the locked one.
    expect(body).toMatch(
      /export const ARCHETYPE_DISPLAY_LABEL: Record<string, string> = Object\.fromEntries\(\s*\n?\s*ARCHETYPE_REGISTRY\.map\(\(a\) => \[a\.id, a\.displayLabel\]\),\s*\n?\s*\);/,
    );
    expect(body).toMatch(
      /export function archetypeDisplayLabel\(id: string\): string \{\s*\n?\s*return ARCHETYPE_DISPLAY_LABEL\[id\] \?\? id;\s*\n?\s*\}/,
    );
  });

  it('direct create/import archetypes derive from the launch+available registry subset', () => {
    expect(body).toMatch(/const SELECTABLE_ARCHETYPE_IDS = new Set\(/);
    expect(body).toMatch(/archetype\.status === 'launch' \|\| archetype\.status === 'available'/);
    expect(body).toMatch(/export function isSelectableArchetypeId\(id: string\): boolean/);
    expect(body).toMatch(/export const SelectableArchetypeIdSchema = z/);
    expect(body).toContain(
      "message: 'archetype must be a selectable id returned by GET /v1/archetypes'",
    );
  });

  it('ARCHETYPE_REGISTRY is the multi-archetype catalogue (NOT a single hardcoded device): ArchetypeConfig shape + status enum + the locked id (iphone17, post-2026-06-11 cutover) is the sole status:launch entry + the full 81-slug Agent-1 catalog folds in as `available` + a legacy reference baseline retained', () => {
    // The platform models a device MATRIX; the registry is the source of
    // truth. A drift back to a single hardcoded archetype would re-break
    // the multi-archetype architecture. The catalogue is synced from
    // Agent-1's verified catalog (driftstack/operations/archetype-catalog.json):
    // all 81 catalog slugs appear; only the locked id is status:'launch', the
    // rest are status:'available', plus a single legacy `reference` baseline.
    expect(body).toMatch(/export interface ArchetypeConfig \{/);
    expect(body).toMatch(
      /export type ArchetypeStatus = 'launch' \| 'available' \| 'reference' \| 'planned';/,
    );
    expect(body).toMatch(/export const ARCHETYPE_REGISTRY: readonly ArchetypeConfig\[\] = \[/);
    // A representative spread of catalog slugs across the device matrix +
    // Safari bands is registered (would catch a drift back to one device).
    expect(body).toMatch(/id: 'iphone13_ios18_6_safari18_6',/);
    expect(body).toMatch(/id: 'iphone14pro_ios18_7_safari26_5',/);
    expect(body).toMatch(/id: 'iphone16pro_ios18_7_safari26_4',/);
    expect(body).toMatch(/id: 'iphone17_ios18_7_safari26_5',/);
    expect(body).toMatch(/id: 'iphone16pro_ios18_6_safari18_6',/);
    expect(body).toMatch(/id: 'iphone17pro_ios18_7_safari26_4',/);
    expect(body).toMatch(/id: 'iphone17promax_ios18_7_safari26_4',/);
    expect(body).toMatch(/id: 'iphone16_ios18_7_safari26_4',/);
    expect(body).toMatch(/id: 'iphone16promax_ios18_7_safari26_4',/);
    // The locked id is the one launch-default entry, reusing the constants
    // (no drift between LOCKED_* and the registry).
    expect(body).toMatch(
      /id: LOCKED_ARCHETYPE_ID,\s*\n?\s*displayLabel: LOCKED_ARCHETYPE_DISPLAY_LABEL,/,
    );
    expect(body).toMatch(/status: 'launch',/);
    // The 80 non-launch catalog entries are customer-selectable 'available';
    // the legacy iphone15pro baseline (NOT in the catalog) stays 'reference'.
    expect(body).toMatch(/status: 'available',/);
    expect(body).toMatch(/status: 'reference',/);
    expect(body).toMatch(/id: 'iphone15pro_ios17_5_safari17_5',/);
    // canvasFamily is derived from the Safari band (s_isFamilyAArchetype gate):
    // 18.x + 26.0-26.3 ⇒ 'A', 26.4+ ⇒ 'B'. Both families are represented.
    expect(body).toMatch(/canvasFamily: 'A',/);
    expect(body).toMatch(/canvasFamily: 'B',/);
  });

  it('V-174 scope split framing pins legacy admin as customer-only and exact staff authority for /v1/admin/*', () => {
    expect(body).toMatch(
      /\*\s*V-174 — scope architecture split\. Two new scopes carve up what\s*\n?\s*\*\s*'admin' did pre-V-174:/,
    );
    expect(body).toMatch(
      /\*\s*- `account_owner` — gates customer-account control \(mint API keys,\s*\n?\s*\*\s*revoke API keys, manage subscription, \/v1\/account\/\*\)\. A customer\s*\n?\s*\*\s*logged into their own dashboard has this scope; their personal\s*\n?\s*\*\s*keys can have it\./,
    );
    // V-795 — the retracted half. This bullet used to end "cross-account access
    // is impossible because the route handlers always operate against
    // ctx.account.id", and both halves were false: resolveEffectiveAccount
    // returns membership.ownerAccountId, an account that is NOT ctx.account.id,
    // whenever the caller sends X-Driftstack-Account for a team they belong to.
    // The type ships to customers in dist/common.d.ts, so the false sentence was
    // an SDK-level statement about tenancy.
    expect(body).toMatch(
      /Cross-account access is\s*\n?\s*\*\s*therefore possible BY DESIGN and membership-gated/,
    );
    expect(body).toMatch(/`ctx\.teams` is\s*\n?\s*\*\s*server-derived and never client-supplied/);
    expect(body).toMatch(/API-key writes additionally require the `admin` team role/);
    expect(body, 'the retracted claim must not return').not.toMatch(
      /cross-account access is impossible/i,
    );
    expect(body).not.toMatch(/route handlers always operate against `ctx\.account\.id`/);
    expect(body).toMatch(
      /\*\s*- `driftstack_internal_admin` — gates Driftstack-staff-only\s*\n?\s*\*\s*operations \(`\/v1\/admin\/\*`: list all accounts, suspend account,\s*\n?\s*\*\s*change tier, force-actions, audit-log read, webhook DLQ\s*\n?\s*\*\s*management\)\. Only the founder \+ Driftstack-internal accounts\s*\n?\s*\*\s*carry this scope\. The exact scope check is the application authority\s*\n?\s*\*\s*boundary; Cloudflare Access SSO on admin\.driftstack\.dev \(V-135\) is a\s*\n?\s*\*\s*separate defense-in-depth identity perimeter\./,
    );
    expect(body).toMatch(
      /\*\s*- `admin` — pre-V-174 customer compatibility alias\. It satisfies\s*\n?\s*\*\s*`account_owner` and customer `admin:X` scopes, but never\s*\n?\s*\*\s*`driftstack_internal_admin`/,
    );
    expect(body).toMatch(/cross-account staff authority requires that\s*\n?\s*\*\s*exact scope\./);
  });

  it('gui_control scope L-001 framing pinned: gates manual-control plane (tap_at, type_focused, etc.) bypassing behavioral simulation layer; only granted to self-hosted GUI workflow keys; default creation does not include; enterprise gets it explicitly', () => {
    expect(body).toMatch(
      /\/\/ `gui_control` is the scope that gates the manual-control plane\s*\n?\s*\/\/ \(tap_at, type_focused, etc\.\) — bypasses the behavioral simulation\s*\n?\s*\/\/ layer, only granted to keys for the self-hosted GUI workflow per\s*\n?\s*\/\/ L-001 in docs\/locked-decisions\.md\. Default key creation does not\s*\n?\s*\/\/ include this scope; enterprise-tier accounts get it explicitly\./,
    );
  });

  it('V-481 ApiKeyScope enum: broad (read|write|admin|account_owner|driftstack_internal_admin|gui_control) + granular verb:resource set with backward-compat framing pinned (broad satisfies granular via verb-prefix in requireScope/auth; granular does NOT satisfy broad — narrow keys stay narrow)', () => {
    expect(body).toMatch(
      /\/\/ V-481 — granular per-resource scopes\. Verb:resource order\.\s*\n?\s*\/\/ Backwards-compat: customer broad scopes \(`read` \/ `write` \/ `admin` \/\s*\n?\s*\/\/ `account_owner`\) satisfy granular checks via requireScope's\s*\n?\s*\/\/ verb-prefix logic in `apps\/server\/src\/lib\/errors-helpers\.ts`\s*\n?\s*\/\/ and `apps\/server\/src\/services\/auth\.ts`\. Granular scopes do\s*\n?\s*\/\/ NOT satisfy broad checks — narrow keys stay narrow\./,
    );
    expect(body).toMatch(
      /export const ApiKeyScopeSchema = z\.enum\(\[\s*\n?\s*'read',\s*\n?\s*'write',\s*\n?\s*'admin',\s*\n?\s*'account_owner',\s*\n?\s*'driftstack_internal_admin',\s*\n?\s*'gui_control',/,
    );
    expect(body).toMatch(/'read:sessions',\s*\n?\s*'write:sessions',/);
    expect(body).toMatch(/'read:profiles',\s*\n?\s*'write:profiles',\s*\n?\s*'admin:profiles',/);
    expect(body).toMatch(/'read:webhooks',\s*\n?\s*'write:webhooks',\s*\n?\s*'admin:webhooks',/);
    expect(body).toMatch(/'read:api-keys',\s*\n?\s*'admin:api-keys',/);
    expect(body).toMatch(/'read:billing',\s*\n?\s*'admin:billing',/);
    expect(body).toMatch(/'read:audit',\s*\n?\s*\]\);/);
  });

  it('parseGranularScope: returns null for non-granular (no colon); returns {verb, resource} for read|write|admin granular', () => {
    expect(body).toMatch(
      /export function parseGranularScope\(\s*\n?\s*scope: ApiKeyScope,\s*\n?\s*\): \{ verb: 'read' \| 'write' \| 'admin'; resource: string \} \| null \{\s*\n?\s*const idx = scope\.indexOf\(':'\);\s*\n?\s*if \(idx === -1\) return null;\s*\n?\s*const verb = scope\.slice\(0, idx\);\s*\n?\s*if \(verb !== 'read' && verb !== 'write' && verb !== 'admin'\) return null;\s*\n?\s*return \{ verb, resource: scope\.slice\(idx \+ 1\) \};\s*\n?\s*\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});

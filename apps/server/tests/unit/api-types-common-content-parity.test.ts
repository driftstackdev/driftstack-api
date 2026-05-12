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

  it('Iso8601Schema: datetime({offset:true}) + describe "ISO 8601 timestamp with timezone offset"; UuidSchema', () => {
    expect(body).toMatch(/export const UuidSchema = z\.string\(\)\.uuid\(\);/);
    expect(body).toMatch(
      /export const Iso8601Schema = z\s*\n?\s*\.string\(\)\s*\n?\s*\.datetime\(\{ offset: true \}\)\s*\n?\s*\.describe\('ISO 8601 timestamp with timezone offset, e\.g\. 2026-05-02T09:15:00Z'\);/,
    );
  });

  it('PaginationQuery framing pinned: opaque cursor strings; servers may swap encoding later without breaking clients; limit coerce 1..100 default 50 + cursor optional', () => {
    expect(body).toMatch(
      /\/\/ Cursor pagination — opaque cursor strings; servers may swap encoding later\s*\n?\s*\/\/ without breaking clients\./,
    );
    expect(body).toMatch(
      /export const PaginationQuerySchema = z\.object\(\{\s*\n?\s*limit: z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.max\(100\)\.default\(50\),\s*\n?\s*cursor: z\.string\(\)\.optional\(\),\s*\n?\s*\}\);/,
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

  it('Trial-pack rationale pinned: $2.99 one-time / 14-day / 1 concurrent / 299¢ at $0.18/hr ≈ 16 hrs (ADR-003)', () => {
    expect(body).toMatch(
      /\/\/ Trial \(one-time\):\s*\n?\s*\/\/\s*- trial_pack\s+\$2\.99\s+— 14-day window, 1 concurrent, 299¢ at \$0\.18\/hr ≈ 16 hrs \(ADR-003\)/,
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

  it('Annual 20% off + concurrent caps the ONLY metering primitive on paid tiers + hours metering ONLY for trial_pack (ADR-003 trial_pack_credit_cents decrement) + profile-count enforced at /v1/profiles creation gate (V-073)', () => {
    expect(body).toMatch(
      /\/\/ Annual is 20% off across all tiers\. Concurrent caps are the\s*\n?\s*\/\/ only metering primitive on paid tiers; hours metering exists\s*\n?\s*\/\/ ONLY for the trial pack \(per ADR-003 trial_pack_credit_cents\s*\n?\s*\/\/ decrement\)\. Profile count is enforced at the \/v1\/profiles\s*\n?\s*\/\/ creation gate \(V-073 lands the constant \+ scaffolding\)\./,
    );
  });

  it('AccountTier enum: 8 values pinned (trial_pack/solo_manual/team_manual/agency_manual/api_starter/api_builder/api_scale/enterprise)', () => {
    expect(body).toMatch(
      /export const AccountTierSchema = z\.enum\(\[\s*\n?\s*'trial_pack',\s*\n?\s*'solo_manual',\s*\n?\s*'team_manual',\s*\n?\s*'agency_manual',\s*\n?\s*'api_starter',\s*\n?\s*'api_builder',\s*\n?\s*'api_scale',\s*\n?\s*'enterprise',\s*\n?\s*\]\);/,
    );
  });

  it('PROFILES_PER_TIER: single source of truth for marketing/dashboard/server enforcement; mirrored in marketing-site pricing.ts API_TIERS field profiles; enterprise = "custom"', () => {
    expect(body).toMatch(
      /\*\s*Profile-count limits per tier — single source of truth for\s*\n?\s*\*\s*marketing-site, customer-dashboard, and server-side enforcement\./,
    );
    expect(body).toMatch(
      /export const PROFILES_PER_TIER: Record<AccountTier, number \| 'custom'> = \{\s*\n?\s*trial_pack: 1,\s*\n?\s*solo_manual: 10,\s*\n?\s*team_manual: 50,\s*\n?\s*agency_manual: 200,\s*\n?\s*api_starter: 25,\s*\n?\s*api_builder: 100,\s*\n?\s*api_scale: 500,\s*\n?\s*enterprise: 'custom',\s*\n?\s*\};/,
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
      /export const TIER_CONCURRENT_SESSION_LIMITS: Record<AccountTier, number> = \{\s*\n?\s*trial_pack: 1,\s*\n?\s*solo_manual: 1,\s*\n?\s*team_manual: 3,\s*\n?\s*agency_manual: 8,\s*\n?\s*api_starter: 2,\s*\n?\s*api_builder: 8,\s*\n?\s*api_scale: 24,\s*\n?\s*enterprise: 32,\s*\n?\s*\};/,
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

  it('BucketLimitConfig interface + TIER_RATE_LIMIT_DEFAULTS Record values pinned (trial 60/1 + 5/(1/60); api_scale 6000/100 + 120/2; enterprise 60000/1000 + 600/10)', () => {
    expect(body).toMatch(
      /export interface BucketLimitConfig \{\s*\n?\s*capacity: number;\s*\n?\s*refill_per_second: number;\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /export const TIER_RATE_LIMIT_DEFAULTS: Record<\s*\n?\s*AccountTier,\s*\n?\s*Record<'global' \| 'sessions:create', BucketLimitConfig>\s*\n?\s*> = \{/,
    );
    expect(body).toMatch(
      /trial_pack: \{\s*\n?\s*global: \{ capacity: 60, refill_per_second: 1 \},\s*\n?\s*'sessions:create': \{ capacity: 5, refill_per_second: 1 \/ 60 \},\s*\n?\s*\},/,
    );
    expect(body).toMatch(
      /api_scale: \{\s*\n?\s*global: \{ capacity: 6_000, refill_per_second: 100 \},\s*\n?\s*'sessions:create': \{ capacity: 120, refill_per_second: 2 \},\s*\n?\s*\},/,
    );
    expect(body).toMatch(
      /enterprise: \{\s*\n?\s*global: \{ capacity: 60_000, refill_per_second: 1_000 \},\s*\n?\s*'sessions:create': \{ capacity: 600, refill_per_second: 10 \},\s*\n?\s*\},/,
    );
  });

  it('V-485 TierFeatures framing pinned: single source of truth for tier-gated capabilities; mirrors marketing-site pricing.ts; consumers (requireTierFeature 403 feature_not_available + customer dashboard conditional UI); add-new-feature instructions', () => {
    expect(body).toMatch(/\*\s*V-485 — per-tier feature gating registry\./);
    expect(body).toMatch(
      /\*\s*Single source of truth for "which capabilities does this tier\s*\n?\s*\*\s*unlock\?" Today the server checks `tier === 'trial_pack'` \/\s*\n?\s*\*\s*`PROFILES_PER_TIER\[tier\]` \/ `TIER_CONCURRENT_SESSION_LIMITS\[tier\]`\s*\n?\s*\*\s*in scattered call sites; this registry is the central place for\s*\n?\s*\*\s*those plus the AI-agent \+ LLM-billing gates that ship with V-487\+\./,
    );
    expect(body).toMatch(
      /\*\s*Consumers:\s*\n?\s*\*\s*- Server: `requireTierFeature\(tier, key\)` in\s*\n?\s*\*\s*`apps\/server\/src\/lib\/errors-helpers\.ts` throws 403 with\s*\n?\s*\*\s*`feature_not_available` problem-type when the gate fails\.\s*\n?\s*\*\s*- Customer dashboard: read TIER_FEATURES directly to drive\s*\n?\s*\*\s*conditional UI \(e\.g\. hide AI-agent CTA on Solo Manual\)\./,
    );
    expect(body).toMatch(
      /export type LlmBilling = 'byok_only' \| 'byok_or_bundled' \| 'byok_or_bundled_custom' \| null;/,
    );
    expect(body).toMatch(
      /export interface TierFeatures \{\s*\n?\s*\/\*\* Concurrent session cap\. Mirrors TIER_CONCURRENT_SESSION_LIMITS\. \*\/\s*\n?\s*concurrentSessions: number;\s*\n?\s*\/\*\* Profile-count cap\. `'custom'` for Enterprise \(negotiated\)\. \*\/\s*\n?\s*profiles: number \| 'custom';\s*\n?\s*\/\*\* Stripe environment for API-key minting \(test on trial_pack, live elsewhere\)\. \*\/\s*\n?\s*apiKeyEnvironment: 'test' \| 'live';\s*\n?\s*\/\*\* AI-agent \(LLM-driven sessions\) feature available on this tier\. \*\/\s*\n?\s*aiAgent: boolean;\s*\n?\s*\/\*\* LLM billing model when aiAgent is true; `null` when off\. \*\/\s*\n?\s*llmBilling: LlmBilling;\s*\n?\s*\/\*\* True for the trial_pack tier — distinguishes one-time from subscription\. \*\/\s*\n?\s*trialPack: boolean;\s*\n?\s*\}/,
    );
  });

  it('TIER_FEATURES Record: trial_pack (test env + aiAgent false + trialPack true) + team_manual (aiAgent true + byok_only) + api_builder (byok_or_bundled) + enterprise (custom profiles + byok_or_bundled_custom)', () => {
    expect(body).toMatch(
      /trial_pack: \{\s*\n?\s*concurrentSessions: 1,\s*\n?\s*profiles: 1,\s*\n?\s*apiKeyEnvironment: 'test',\s*\n?\s*aiAgent: false,\s*\n?\s*llmBilling: null,\s*\n?\s*trialPack: true,\s*\n?\s*\},/,
    );
    expect(body).toMatch(
      /team_manual: \{\s*\n?\s*concurrentSessions: 3,\s*\n?\s*profiles: 50,\s*\n?\s*apiKeyEnvironment: 'live',\s*\n?\s*aiAgent: true,\s*\n?\s*llmBilling: 'byok_only',\s*\n?\s*trialPack: false,\s*\n?\s*\},/,
    );
    expect(body).toMatch(
      /api_builder: \{\s*\n?\s*concurrentSessions: 8,\s*\n?\s*profiles: 100,\s*\n?\s*apiKeyEnvironment: 'live',\s*\n?\s*aiAgent: true,\s*\n?\s*llmBilling: 'byok_or_bundled',\s*\n?\s*trialPack: false,\s*\n?\s*\},/,
    );
    expect(body).toMatch(
      /enterprise: \{\s*\n?\s*concurrentSessions: 32,\s*\n?\s*profiles: 'custom',\s*\n?\s*apiKeyEnvironment: 'live',\s*\n?\s*aiAgent: true,\s*\n?\s*llmBilling: 'byok_or_bundled_custom',\s*\n?\s*trialPack: false,\s*\n?\s*\},/,
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
    expect(body).toMatch(/export const LOCKED_ARCHETYPE_ID = 'iphone16pro_ios18_7_safari26_4';/);
    expect(body).toMatch(
      /export const LOCKED_ARCHETYPE_DISPLAY_LABEL = 'iPhone 16 Pro \/ iOS 18\.7 \/ Safari 26\.4';/,
    );
    expect(body).toMatch(
      /export const ARCHETYPE_DISPLAY_LABEL: Record<string, string> = \{\s*\n?\s*\[LOCKED_ARCHETYPE_ID\]: LOCKED_ARCHETYPE_DISPLAY_LABEL,\s*\n?\s*\};/,
    );
    expect(body).toMatch(
      /export function archetypeDisplayLabel\(id: string\): string \{\s*\n?\s*return ARCHETYPE_DISPLAY_LABEL\[id\] \?\? id;\s*\n?\s*\}/,
    );
  });

  it('V-174 scope split framing pinned: account_owner (customer-account control via ctx.account.id) + driftstack_internal_admin (staff-only gates /v1/admin/* with admin.driftstack.dev Cloudflare Access SSO V-135 + defense-in-depth) + admin compat alias (satisfies BOTH during migration; founder-driven migration script promotes internal admin keys + re-scopes customer admin → account_owner; admin deprecated + removed after)', () => {
    expect(body).toMatch(
      /\*\s*V-174 — scope architecture split\. Two new scopes carve up what\s*\n?\s*\*\s*'admin' did pre-V-174:/,
    );
    expect(body).toMatch(
      /\*\s*- `account_owner` — gates customer-account control \(mint API keys,\s*\n?\s*\*\s*revoke API keys, manage subscription, \/v1\/account\/\*\)\. A customer\s*\n?\s*\*\s*logged into their own dashboard has this scope; their personal\s*\n?\s*\*\s*keys can have it; cross-account access is impossible because the\s*\n?\s*\*\s*route handlers always operate against `ctx\.account\.id`\./,
    );
    expect(body).toMatch(
      /\*\s*- `driftstack_internal_admin` — gates Driftstack-staff-only\s*\n?\s*\*\s*operations \(`\/v1\/admin\/\*`: list all accounts, suspend account,\s*\n?\s*\*\s*change tier, force-actions, audit-log read, webhook DLQ\s*\n?\s*\*\s*management\)\. Only the founder \+ Driftstack-internal accounts\s*\n?\s*\*\s*carry this scope\. admin\.driftstack\.dev origin \(V-135\) gates\s*\n?\s*\*\s*reachability via Cloudflare Access SSO; the scope check is the\s*\n?\s*\*\s*defense-in-depth layer\./,
    );
    expect(body).toMatch(
      /\*\s*- `admin` — pre-V-174 compat alias\. Treated as satisfying BOTH new\s*\n?\s*\*\s*scopes during the migration window \(via\s*\n?\s*\*\s*`lib\/errors-helpers\.ts::requireScope`\)\./,
    );
  });

  it('gui_control scope L-001 framing pinned: gates manual-control plane (tap_at, type_focused, etc.) bypassing behavioral simulation layer; only granted to self-hosted GUI workflow keys; default creation does not include; enterprise gets it explicitly', () => {
    expect(body).toMatch(
      /\/\/ `gui_control` is the scope that gates the manual-control plane\s*\n?\s*\/\/ \(tap_at, type_focused, etc\.\) — bypasses the behavioral simulation\s*\n?\s*\/\/ layer, only granted to keys for the self-hosted GUI workflow per\s*\n?\s*\/\/ L-001 in docs\/locked-decisions\.md\. Default key creation does not\s*\n?\s*\/\/ include this scope; enterprise-tier accounts get it explicitly\./,
    );
  });

  it('V-481 ApiKeyScope enum: broad (read|write|admin|account_owner|driftstack_internal_admin|gui_control) + granular verb:resource set with backward-compat framing pinned (broad satisfies granular via verb-prefix in requireScope/auth; granular does NOT satisfy broad — narrow keys stay narrow)', () => {
    expect(body).toMatch(
      /\/\/ V-481 — granular per-resource scopes\. Verb:resource order\.\s*\n?\s*\/\/ Backwards-compat: broad scopes \(`read` \/ `write` \/ `admin` \/\s*\n?\s*\/\/ `account_owner`\) satisfy granular checks via requireScope's\s*\n?\s*\/\/ verb-prefix logic in `apps\/server\/src\/lib\/errors-helpers\.ts`\s*\n?\s*\/\/ and `apps\/server\/src\/services\/auth\.ts`\. Granular scopes do\s*\n?\s*\/\/ NOT satisfy broad checks — narrow keys stay narrow\./,
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

// W425.C (W668-deepened) — drift guard for packages/sdk-typescript/
// src/resources/account.ts. AccountResource TS parity.
//
// W668 splits the original 17 it() blocks into 23 focused per-concept
// blocks + pins previously-implicit invariants:
//
//   • V-237 me() framing — powers the GUI client's "X / Y concurrent
//     sessions" + "P / Q profiles" header gates. Drift to dropping
//     fields would break dashboard rendering.
//   • Per-V-anchor field pinning on AccountSelfProfile —
//     V-352 timezone (IANA, null=UTC), V-298a slug, V-298b region
//     (3-region closed union), V-352b avatar_url (R2 ~1h presigned),
//     V-353h mfa_enrolled, V-326c teams membership array.
//   • V-352b avatar allowlist on response — content_type literal
//     union (image/png|image/jpeg|image/webp). Drift to widening
//     would let GIF/SVG slip through (XSS via SVG-script).
//   • V-355 3-verb web-session lifecycle: list with current:true
//     marker + revoke-single (idempotent + encodeURIComponent) +
//     revoke-all-other (CRITICAL: EXCLUDES calling session — drift
//     to including would log customer OUT mid-revoke).
//   • V-258 RateLimitBucket bucket_key 4-value union (global|
//     sessions:create|agent_sessions:message|agent_sessions:input_event)
//     + source 2-value union (tier_default|override). Drift to narrowing
//     the bucket set would make a real runtime response unrepresentable.
//   • profile_cap NULL for enterprise (negotiated) — drift to a
//     sentinel number would silently force enterprise customers
//     into a cap they don\'t have.
//   • concurrent_session_active + profile_count "live count, not
//     cached" framing pinned.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/account.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W425.C packages/sdk-typescript/src/resources/account.ts content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path + module header anchor on the resource line', () => {
    expect(existsSync(LIB)).toBe(true);
    expect(body).toMatch(/\/\/ AccountResource — typed methods for \/v1\/account\/\*\./);
  });

  it('V-237/V-298a/V-298b/V-352b/V-353h/V-326c framing pinned — 6-V-anchor module header. CRITICAL: every V-anchor MUST stay attached because each represents a separate field addition to the /me response. Drift to dropping any anchor would lose changelog provenance for that field.', () => {
    expect(body).toMatch(
      /\/\/ V-237 introduced GET \/v1\/account\/me as the customer self-profile\s*\n?\s*\/\/ endpoint\. V-298a\/V-298b\/V-352b\/V-353h\/V-326c added slug, region,\s*\n?\s*\/\/ avatar_url, mfa_enrolled, and teams fields\. The shape below mirrors\s*\n?\s*\/\/ the server's full \/me response\./,
    );
  });

  it('V-450 self-service extension framing pinned — "also wraps /web-sessions list + revoke, /me/avatar upload + clear, and /rate-limits read." Drift to dropping any one of the 3 V-450 extension areas would silently shrink the SDK\'s self-service surface.', () => {
    expect(body).toMatch(
      /\/\/ V-450 — also wraps \/web-sessions list \+ revoke, \/me\/avatar\s*\n?\s*\/\/ upload \+ clear, and \/rate-limits read\./,
    );
  });

  it('Imports — AccountTier + UpdateAccountMeRequest + UploadAvatarRequest from @driftstack/api-types + HttpClient. CRITICAL: AccountTier comes from api-types so the tier closed-set stays in lockstep with server-side enum. Drift to hand-rolling AccountTier would let SDK accept tier values the server rejects.', () => {
    expect(body).toMatch(
      /import type \{\s*\n?\s*AccountTier,\s*\n?\s*UpdateAccountMeRequest,\s*\n?\s*UploadAvatarRequest,\s*\n?\s*\} from '@driftstack\/api-types';/,
    );
    expect(body).toMatch(/import type \{ HttpClient \} from '\.\.\/http\.js';/);
  });

  it('AccountSelfProfile — core 5 fields (id + email + name + tier + status). status 3-value union (active|suspended|deleted) pinned as TS LITERAL types. Drift to widening status would let dashboards render undefined-state badges; drift to a 4th value (e.g. "pending") without coordinated server+client update would break the closed-set switch.', () => {
    expect(body).toMatch(
      /export interface AccountSelfProfile \{\s*\n?\s*id: string;\s*\n?\s*email: string;\s*\n?\s*name: string \| null;\s*\n?\s*tier: AccountTier;\s*\n?\s*status: 'active' \| 'suspended' \| 'deleted';/,
    );
  });

  it('V-352 timezone field — IANA zone (e.g. "Europe/Amsterdam") nullable with "null = UTC fallback" framing. Drift to dropping the UTC-fallback semantic would force every customer to set a timezone (breaking the "I don\'t care" default).', () => {
    expect(body).toMatch(
      /\/\*\* V-352 — IANA timezone \(e\.g\. "Europe\/Amsterdam"\); null = UTC fallback\. \*\/\s*\n?\s*timezone: string \| null;/,
    );
  });

  it('V-298a slug — readable account handle (e.g. /@acme); nullable when unset. The "readable" framing tells customers this is the human-facing handle (vs the opaque account_id). Drift to a non-nullable slug would force every account to pick one.', () => {
    expect(body).toMatch(
      /\/\*\* V-298a — readable account handle; null when unset\. \*\/\s*\n?\s*slug: string \| null;/,
    );
  });

  it('CRITICAL V-298b region — 3-value closed union (us|eu|apac) + null when unset. The 3-region closed-set is what defines where the customer\'s data lives. Drift to widening (e.g. adding "africa") without coordinated server+client update would break the regional-routing infrastructure. Drift to making non-nullable would force every customer to pick a region at signup (vs deferring).', () => {
    expect(body).toMatch(
      /\/\*\* V-298b — stated infrastructure-region preference; null when unset\. \*\/\s*\n?\s*region: 'us' \| 'eu' \| 'apac' \| null;/,
    );
  });

  it('CRITICAL V-352b avatar_url — short-lived (~1h) PRESIGNED R2 GET URL; nullable when no avatar. The "short-lived" framing tells customers the URL EXPIRES — drift to dropping the freshness window claim would let dashboards cache stale URLs that 404 after expiry. Drift to making non-presigned would expose the R2 bucket directly.', () => {
    expect(body).toMatch(
      /\/\*\* V-352b — short-lived \(~1h\) presigned R2 GET URL; null when no avatar\. \*\/\s*\n?\s*avatar_url: string \| null;/,
    );
    expect(body).toMatch(/avatar_source: 'user' \| 'idp' \| 'none';/);
  });

  it('V-353h mfa_enrolled — boolean (true once TOTP enrollment verified). Drift to making nullable would let dashboards render an "MFA: unknown" state (vs the clear yes/no).', () => {
    expect(body).toMatch(
      /\/\*\* V-353h — true once TOTP enrollment is verified\. \*\/\s*\n?\s*mfa_enrolled: boolean;/,
    );
  });

  it('Concurrent-session gauges — concurrent_session_cap (tier-derived) + concurrent_session_active ("live count, not cached" framing pinned). CRITICAL: the "live count" framing is what tells dashboards they can poll /me to get fresh session-count without invalidating a cache. Drift to dropping the live-count framing would let dashboards stale-render the gauge.', () => {
    expect(body).toMatch(
      /\/\*\* Concurrent session cap for this account's tier\. \*\/\s*\n?\s*concurrent_session_cap: number;\s*\n?\s*\/\*\* Active sessions right now \(live count, not cached\)\. \*\/\s*\n?\s*concurrent_session_active: number;/,
    );
  });

  it('CRITICAL profile gauges — profile_cap NULLABLE for enterprise (negotiated) + profile_count "live count, not cached" framing pinned. Drift to making profile_cap a sentinel number (e.g. Infinity, -1) for enterprise would silently force enterprise customers into a cap they don\'t have. Null is the correct "no cap" signal.', () => {
    expect(body).toMatch(
      /\/\*\* Profile cap for this tier; null for enterprise \(negotiated\)\. \*\/\s*\n?\s*profile_cap: number \| null;\s*\n?\s*\/\*\* Existing profiles right now \(live count, not cached\)\. \*\/\s*\n?\s*profile_count: number;/,
    );
  });

  it('CRITICAL V-326c teams membership array — Array<{owner_account_id + owner_email + owner_name + role (admin|member) + membership_id}>. "Empty when none" framing tells dashboards an empty array is the canonical "I\'m not on any team" signal (not absence of the field). 2-value role union pinned (admin|member). owner_email/owner_name (sweep-3) let dashboards label a team by who owns it. Drift to dropping owner_account_id would prevent dashboards from rendering "you\'re a member of X\'s team" cross-account links.', () => {
    expect(body).toMatch(
      /\/\*\* V-326c — team memberships the calling account holds\. Empty when none\.(?:[\s\S]*?)\*\/\s*\n?\s*teams: Array<\{\s*\n?\s*owner_account_id: string;\s*\n?\s*owner_email: string;\s*\n?\s*owner_name: string \| null;\s*\n?\s*role: 'admin' \| 'member';\s*\n?\s*membership_id: string;\s*\n?\s*\}>;/,
    );
  });

  it('CRITICAL V-355 WebSessionEntry — id + os + browser + last_used_at + expires_at + current bool. "True when this entry is the calling session itself" framing pinned on `current` field. Drift to dropping `current` would force dashboards to compare every entry against the cookie\'s session id to identify "this device" (fragile + leaks session info into client logic).', () => {
    expect(body).toMatch(/\/\/ V-355 — active dashboard sign-in for the calling account\./);
    expect(body).toMatch(
      /export interface WebSessionEntry \{\s*\n?\s*id: string;\s*\n?\s*os: string;\s*\n?\s*browser: string;\s*\n?\s*last_used_at: string;\s*\n?\s*expires_at: string;\s*\n?\s*\/\*\* True when this entry is the calling session itself\. \*\/\s*\n?\s*current: boolean;\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /export interface ListWebSessionsResponse \{\s*\n?\s*data: WebSessionEntry\[\];\s*\n?\s*\}/,
    );
  });

  it('CRITICAL V-352b UploadAvatarResponse — content_type 3-value closed union (image/png|image/jpeg|image/webp). Drift to widening (e.g. adding image/gif or image/svg+xml) would open XSS via SVG-embedded <script>. The closed allowlist is the load-bearing security claim. Pre-signed R2 ~1h URL framing pinned.', () => {
    expect(body).toMatch(
      /\/\/ V-352b — avatar upload response\. Presigned R2 URL is short-lived \(~1h\)\./,
    );
    expect(body).toMatch(
      /export interface UploadAvatarResponse \{\s*\n?\s*avatar_url: string \| null;\s*\n?\s*content_type: 'image\/png' \| 'image\/jpeg' \| 'image\/webp';\s*\n?\s*bytes: number;\s*\n?\s*\}/,
    );
  });

  it('CRITICAL V-258 RateLimitBucket — bucket_key 4-value union (global|sessions:create|agent_sessions:message|agent_sessions:input_event, mirroring the server BUCKET_KEYS — sweep-3) + source 2-value union (tier_default|override) + override_expires_at nullable. Drift to NARROWING bucket_key would make an exhaustive switch silently mishandle a real bucket the server returns; drift to widening source would lose the tier-vs-override distinction the dashboard uses to render "tier default" badges. GetAccountRateLimitsResponse wraps tier (string, not AccountTier — admins can override) + buckets[].', () => {
    expect(body).toMatch(
      /\/\/ V-258 — effective rate-limit config \(per-bucket capacity \+ refill\)\./,
    );
    const bucket = body.match(/export interface RateLimitBucket \{[\s\S]*?\n\}/)?.[0] ?? '';
    for (const key of [
      'global',
      'sessions:create',
      'agent_sessions:message',
      'agent_sessions:input_event',
    ]) {
      expect(bucket).toContain(`'${key}'`);
    }
    expect(bucket).toMatch(/capacity: number;/);
    expect(bucket).toMatch(/refill_per_second: number;/);
    expect(bucket).toMatch(/source: 'tier_default' \| 'override';/);
    expect(bucket).toMatch(/override_expires_at: string \| null;/);
    expect(body).toMatch(
      /export interface GetAccountRateLimitsResponse \{\s*\n?\s*tier: string;\s*\n?\s*buckets: RateLimitBucket\[\];\s*\n?\s*\}/,
    );
  });

  it('AccountResource class declaration + private-readonly http constructor field.', () => {
    expect(body).toMatch(
      /export class AccountResource \{\s*\n?\s*constructor\(private readonly http: HttpClient\) \{\}/,
    );
  });

  it('me() verb — V-237 GET /v1/account/me → Promise<AccountSelfProfile>. CRITICAL: "Powers the GUI client\'s `X / Y concurrent sessions` + `P / Q profiles` header gates" — drift to dropping any gauge field would break the dashboard header rendering.', () => {
    expect(body).toMatch(
      /\*\s*V-237 — customer self-profile\. Powers the GUI client's\s*\n?\s*\*\s*"X \/ Y concurrent sessions" \+ "P \/ Q profiles" header gates\./,
    );
    expect(body).toMatch(
      /me\(\): Promise<AccountSelfProfile> \{\s*\n?\s*return this\.http\.request<AccountSelfProfile>\(\{\s*\n?\s*method: 'GET',\s*\n?\s*path: '\/v1\/account\/me',\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('updateMe verb — V-352 PATCH /v1/account/me with UpdateAccountMeRequest body → Promise<AccountSelfProfile>. CRITICAL: "(name / timezone / slug / region)" 4-field partial-update list pinned. Drift to dropping any field from the parenthetical would lose the customer-facing list of updatable fields. PATCH (not PUT) so missing fields stay unchanged.', () => {
    expect(body).toMatch(
      /\/\*\* V-352 — partial update of the calling account \(name \/ timezone \/ slug \/ region\)\. \*\//,
    );
    expect(body).toMatch(
      /updateMe\(body: UpdateAccountMeRequest\): Promise<AccountSelfProfile> \{\s*\n?\s*return this\.http\.request<AccountSelfProfile>\(\{\s*\n?\s*method: 'PATCH',\s*\n?\s*path: '\/v1\/account\/me',\s*\n?\s*body,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('uploadAvatar verb — V-352b POST /v1/account/me/avatar with UploadAvatarRequest body → Promise<UploadAvatarResponse>. The "or replace" framing on the JSDoc tells customers upload IS idempotent at the avatar-pointer level (re-uploading replaces, not duplicates).', () => {
    expect(body).toMatch(/\/\*\* V-352b — upload \(or replace\) the calling account avatar\. \*\//);
    expect(body).toMatch(
      /uploadAvatar\(body: UploadAvatarRequest\): Promise<UploadAvatarResponse> \{\s*\n?\s*return this\.http\.request<UploadAvatarResponse>\(\{\s*\n?\s*method: 'POST',\s*\n?\s*path: '\/v1\/account\/me\/avatar',\s*\n?\s*body,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('clearAvatar verb — V-352b DELETE /v1/account/me/avatar → Promise<void>. "clear the calling account avatar pointer" framing — drift to "delete the avatar file" would mismatch the actual server-side semantics (the file may stick around in R2 with TTL).', () => {
    expect(body).toMatch(/\/\*\* V-352b — clear the calling account avatar pointer\. \*\//);
    expect(body).toMatch(
      /clearAvatar\(\): Promise<void> \{\s*\n?\s*return this\.http\.request<void>\(\{\s*\n?\s*method: 'DELETE',\s*\n?\s*path: '\/v1\/account\/me\/avatar',\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('listWebSessions verb — V-355 GET /v1/account/web-sessions → Promise<ListWebSessionsResponse>. The list-with-current-marker is the load-bearing claim that lets dashboards distinguish "this device" from "other devices".', () => {
    expect(body).toMatch(
      /\/\*\* V-355 — list active dashboard sign-ins for the calling account\. \*\//,
    );
    expect(body).toMatch(
      /listWebSessions\(\): Promise<ListWebSessionsResponse> \{\s*\n?\s*return this\.http\.request<ListWebSessionsResponse>\(\{\s*\n?\s*method: 'GET',\s*\n?\s*path: '\/v1\/account\/web-sessions',\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('revokeWebSession verb — V-355 DELETE /v1/account/web-sessions/${encodeURIComponent(id)} → Promise<void>. CRITICAL: "Idempotent" framing — drift to non-idempotent would break the standard cleanup pattern. encodeURIComponent wrapping prevents path traversal.', () => {
    expect(body).toMatch(/\/\*\* V-355 — revoke a single web session by id\. Idempotent\. \*\//);
    expect(body).toMatch(
      /revokeWebSession\(id: string\): Promise<void> \{\s*\n?\s*return this\.http\.request<void>\(\{\s*\n?\s*method: 'DELETE',\s*\n?\s*path: `\/v1\/account\/web-sessions\/\$\{encodeURIComponent\(id\)\}`,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('CRITICAL revokeAllOtherWebSessions verb — V-355 DELETE /v1/account/web-sessions (NO id, collection root). "revoke every web session EXCEPT the calling one" framing pinned. Drift to including the calling session would log customer OUT mid-revocation, silently breaking the "log out other devices, keep this one" UX. The exclusion is load-bearing.', () => {
    expect(body).toMatch(/\/\*\* V-355 — revoke every web session except the calling one\. \*\//);
    expect(body).toMatch(
      /revokeAllOtherWebSessions\(\): Promise<void> \{\s*\n?\s*return this\.http\.request<void>\(\{\s*\n?\s*method: 'DELETE',\s*\n?\s*path: '\/v1\/account\/web-sessions',\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('rateLimits verb — V-258 GET /v1/account/rate-limits → Promise<GetAccountRateLimitsResponse>. Read-only diagnostic; drift to a POST (e.g. for adjusting limits) would shift this from read-only to write surface needing CSRF protection.', () => {
    expect(body).toMatch(
      /\/\*\* V-258 — read effective rate-limit config \(per-bucket caps \+ override status\)\. \*\//,
    );
    expect(body).toMatch(
      /rateLimits\(\): Promise<GetAccountRateLimitsResponse> \{\s*\n?\s*return this\.http\.request<GetAccountRateLimitsResponse>\(\{\s*\n?\s*method: 'GET',\s*\n?\s*path: '\/v1\/account\/rate-limits',\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('CRITICAL bundled-LLM settings/status verbs (Arc 1 sub-slice 6.6/6.7) — GET+PATCH /v1/account/me/bundled-llm-settings and GET /v1/account/me/bundled-llm-status. Lets the GUI give the customer an in-app fix for BundledLlmConsentRequiredError / BundledLlmBudgetExhaustedError instead of pointing at a raw curl command — drift to dropping any of these 3 verbs would strand the customer on the unreadable API-error path.', () => {
    expect(body).toMatch(
      /\/\/ Arc 1 sub-slice 6\.6\/6\.7 — bundled-LLM settings \+ spend status\./,
    );
    expect(body).toMatch(
      /export interface BundledLlmSettings \{\s*\n?\s*consent: boolean;\s*\n?\s*monthly_cap_usd_cents: number;\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /export interface BundledLlmStatus \{\s*\n?\s*consent: boolean;\s*\n?\s*cap_cents: number;\s*\n?\s*used_this_month_cents: number;\s*\n?\s*remaining_cents: number;\s*\n?\s*refused_count_this_month: number;\s*\n?\s*month_started_at: string;\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /getBundledLlmSettings\(\): Promise<BundledLlmSettings> \{\s*\n?\s*return this\.http\.request<BundledLlmSettings>\(\{\s*\n?\s*method: 'GET',\s*\n?\s*path: '\/v1\/account\/me\/bundled-llm-settings',\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /updateBundledLlmSettings\(body: UpdateBundledLlmSettingsRequest\): Promise<BundledLlmSettings> \{\s*\n?\s*return this\.http\.request<BundledLlmSettings>\(\{\s*\n?\s*method: 'PATCH',\s*\n?\s*path: '\/v1\/account\/me\/bundled-llm-settings',\s*\n?\s*body,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /getBundledLlmStatus\(\): Promise<BundledLlmStatus> \{\s*\n?\s*return this\.http\.request<BundledLlmStatus>\(\{\s*\n?\s*method: 'GET',\s*\n?\s*path: '\/v1\/account\/me\/bundled-llm-status',\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('CRITICAL BYOK Anthropic key verbs (AI-CHAT) — GET/PUT/DELETE /v1/account/me/byok-anthropic-key + POST .../test. "BYOK always wins" (locked verdict) — the key is a customer-controlled billing override; drift to dropping the PUT/DELETE pair would strand a customer unable to rotate or remove their own key.', () => {
    expect(body).toMatch(
      /\/\/ AI-CHAT BYOK Anthropic — customer key metadata \(never plaintext\) \+ set\/test\./,
    );
    expect(body).toMatch(
      /export interface ByokAnthropicKeyMetadata \{\s*\n?\s*has_key: boolean;\s*\n?\s*set_at: string \| null;\s*\n?\s*last_used_at: string \| null;\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /export type TestByokAnthropicKeyResult = \{ ok: true \} \| \{ ok: false; reason: string \};/,
    );
    expect(body).toMatch(
      /getByokAnthropicKey\(\): Promise<ByokAnthropicKeyMetadata> \{\s*\n?\s*return this\.http\.request<ByokAnthropicKeyMetadata>\(\{\s*\n?\s*method: 'GET',\s*\n?\s*path: '\/v1\/account\/me\/byok-anthropic-key',\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /setByokAnthropicKey\(apiKey: string\): Promise<SetByokAnthropicKeyResponse> \{\s*\n?\s*return this\.http\.request<SetByokAnthropicKeyResponse>\(\{\s*\n?\s*method: 'PUT',\s*\n?\s*path: '\/v1\/account\/me\/byok-anthropic-key',\s*\n?\s*body: \{ api_key: apiKey \},\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /clearByokAnthropicKey\(\): Promise<void> \{\s*\n?\s*return this\.http\.request<void>\(\{\s*\n?\s*method: 'DELETE',\s*\n?\s*path: '\/v1\/account\/me\/byok-anthropic-key',\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /testByokAnthropicKey\(\): Promise<TestByokAnthropicKeyResult> \{\s*\n?\s*return this\.http\.request<TestByokAnthropicKeyResult>\(\{\s*\n?\s*method: 'POST',\s*\n?\s*path: '\/v1\/account\/me\/byok-anthropic-key\/test',\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('15-verb inventory + verb-mix invariants — exactly 15 method declarations (the original 8 + bundled-LLM getBundledLlmSettings/updateBundledLlmSettings/getBundledLlmStatus + BYOK getByokAnthropicKey/setByokAnthropicKey/clearByokAnthropicKey/testByokAnthropicKey). Verb mix: 6 GETs (me + listWebSessions + rateLimits + getBundledLlmSettings + getBundledLlmStatus + getByokAnthropicKey) + 2 PATCH (updateMe + updateBundledLlmSettings) + 2 POST (uploadAvatar + testByokAnthropicKey) + 4 DELETEs (clearAvatar + revokeWebSession + revokeAllOtherWebSessions + clearByokAnthropicKey) + 1 PUT (setByokAnthropicKey — the only PUT in the resource; CRITICAL because PUT is the customer-controlled-key-replace semantic, distinct from every other verb here). Drift to a 16th verb without test coverage would let an untested code path ship.', () => {
    const methods = body.match(/^ {2}(?!constructor)[a-zA-Z]+\(/gm) ?? [];
    expect(methods.length, 'expected 15 verb declarations').toBe(15);
    const gets = (body.match(/method: 'GET'/g) ?? []).length;
    expect(gets, 'expected 6 GETs').toBe(6);
    const patches = (body.match(/method: 'PATCH'/g) ?? []).length;
    expect(patches, 'expected 2 PATCHes (updateMe + updateBundledLlmSettings)').toBe(2);
    const posts = (body.match(/method: 'POST'/g) ?? []).length;
    expect(posts, 'expected 2 POSTs (uploadAvatar + testByokAnthropicKey)').toBe(2);
    const deletes = (body.match(/method: 'DELETE'/g) ?? []).length;
    expect(deletes, 'expected 4 DELETEs').toBe(4);
    const puts = (body.match(/method: 'PUT'/g) ?? []).length;
    expect(puts, 'expected 1 PUT (setByokAnthropicKey)').toBe(1);
  });
});

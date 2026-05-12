// W425.C — drift guard for packages/sdk-typescript/src/resources/account.ts.
// AccountResource — the customer self-profile surface (V-237/V-352/
// V-352b/V-353h/V-355/V-258/V-326c). Drift here either breaks the
// dashboard header gates ("X / Y sessions" + "P / Q profiles") or
// strips a tier/region/slug/avatar/MFA-enrolled/teams field the GUI
// renders from /me.
//
//   • V-237 GET /v1/account/me framing + all the field additions
//     (V-298a slug, V-298b region, V-352b avatar_url, V-353h
//     mfa_enrolled, V-326c teams) pinned.
//   • AccountSelfProfile field roster pinned.
//   • V-352 updateMe (PATCH) + V-352b avatar upload/clear pair.
//   • V-355 web-sessions list + revoke (single + all-other).
//   • V-258 rateLimits read.
//   • V-352b UploadAvatarResponse: avatar_url + content_type union
//     (PNG/JPEG/WebP) + bytes.
//   • V-258 RateLimitBucket bucket_key union (global +
//     sessions:create) + source (tier_default | override) +
//     override_expires_at.

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

  it('Framing pinned: V-237 GET /me as customer self-profile + V-298a/V-298b/V-352b/V-353h/V-326c field additions (slug/region/avatar_url/mfa_enrolled/teams)', () => {
    expect(body).toMatch(/\/\/ AccountResource — typed methods for \/v1\/account\/\*\./);
    expect(body).toMatch(
      /\/\/ V-237 introduced GET \/v1\/account\/me as the customer self-profile\s*\n?\s*\/\/ endpoint\. V-298a\/V-298b\/V-352b\/V-353h\/V-326c added slug, region,\s*\n?\s*\/\/ avatar_url, mfa_enrolled, and teams fields\. The shape below mirrors\s*\n?\s*\/\/ the server's full \/me response\./,
    );
  });

  it('V-450 framing pinned: also wraps web-sessions + me/avatar + rate-limits', () => {
    expect(body).toMatch(
      /\/\/ V-450 — also wraps \/web-sessions list \+ revoke, \/me\/avatar\s*\n?\s*\/\/ upload \+ clear, and \/rate-limits read\./,
    );
  });

  it('AccountSelfProfile core fields: id + email + name + tier (AccountTier) + status union (active|suspended|deleted)', () => {
    expect(body).toMatch(
      /export interface AccountSelfProfile \{\s*\n?\s*id: string;\s*\n?\s*email: string;\s*\n?\s*name: string \| null;\s*\n?\s*tier: AccountTier;\s*\n?\s*status: 'active' \| 'suspended' \| 'deleted';/,
    );
  });

  it('V-352 timezone field: IANA zone like Europe/Amsterdam; null = UTC fallback', () => {
    expect(body).toMatch(
      /\/\*\* V-352 — IANA timezone \(e\.g\. "Europe\/Amsterdam"\); null = UTC fallback\. \*\/\s*\n?\s*timezone: string \| null;/,
    );
  });

  it('V-298a slug + V-298b region (us|eu|apac) + V-352b avatar_url (~1h R2 presigned) + V-353h mfa_enrolled', () => {
    expect(body).toMatch(
      /\/\*\* V-298a — readable account handle; null when unset\. \*\/\s*\n?\s*slug: string \| null;/,
    );
    expect(body).toMatch(
      /\/\*\* V-298b — stated infrastructure-region preference; null when unset\. \*\/\s*\n?\s*region: 'us' \| 'eu' \| 'apac' \| null;/,
    );
    expect(body).toMatch(
      /\/\*\* V-352b — short-lived \(~1h\) presigned R2 GET URL; null when no avatar\. \*\/\s*\n?\s*avatar_url: string \| null;/,
    );
    expect(body).toMatch(
      /\/\*\* V-353h — true once TOTP enrollment is verified\. \*\/\s*\n?\s*mfa_enrolled: boolean;/,
    );
  });

  it('Concurrent-session + profile gauges: concurrent_session_cap + concurrent_session_active live; profile_cap (null enterprise) + profile_count live', () => {
    expect(body).toMatch(
      /\/\*\* Concurrent session cap for this account's tier\. \*\/\s*\n?\s*concurrent_session_cap: number;\s*\n?\s*\/\*\* Active sessions right now \(live count, not cached\)\. \*\/\s*\n?\s*concurrent_session_active: number;/,
    );
    expect(body).toMatch(
      /\/\*\* Profile cap for this tier; null for enterprise \(negotiated\)\. \*\/\s*\n?\s*profile_cap: number \| null;\s*\n?\s*\/\*\* Existing profiles right now \(live count, not cached\)\. \*\/\s*\n?\s*profile_count: number;/,
    );
  });

  it('V-326c teams membership array: owner_account_id + role (admin|member) + membership_id', () => {
    expect(body).toMatch(
      /\/\*\* V-326c — team memberships the calling account holds\. Empty when none\. \*\/\s*\n?\s*teams: Array<\{\s*\n?\s*owner_account_id: string;\s*\n?\s*role: 'admin' \| 'member';\s*\n?\s*membership_id: string;\s*\n?\s*\}>;/,
    );
  });

  it('V-355 WebSessionEntry: id + os + browser + last_used_at + expires_at + current boolean', () => {
    expect(body).toMatch(/\/\/ V-355 — active dashboard sign-in for the calling account\./);
    expect(body).toMatch(
      /export interface WebSessionEntry \{\s*\n?\s*id: string;\s*\n?\s*os: string;\s*\n?\s*browser: string;\s*\n?\s*last_used_at: string;\s*\n?\s*expires_at: string;\s*\n?\s*\/\*\* True when this entry is the calling session itself\. \*\/\s*\n?\s*current: boolean;\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /export interface ListWebSessionsResponse \{\s*\n?\s*data: WebSessionEntry\[\];\s*\n?\s*\}/,
    );
  });

  it('V-352b UploadAvatarResponse: avatar_url string|null + content_type union (image/png|image/jpeg|image/webp) + bytes number; presigned R2 URL ~1h', () => {
    expect(body).toMatch(
      /\/\/ V-352b — avatar upload response\. Presigned R2 URL is short-lived \(~1h\)\./,
    );
    expect(body).toMatch(
      /export interface UploadAvatarResponse \{\s*\n?\s*avatar_url: string \| null;\s*\n?\s*content_type: 'image\/png' \| 'image\/jpeg' \| 'image\/webp';\s*\n?\s*bytes: number;\s*\n?\s*\}/,
    );
  });

  it('V-258 RateLimitBucket: bucket_key (global|sessions:create) + capacity + refill_per_second + source (tier_default|override) + override_expires_at; GetAccountRateLimitsResponse wraps tier + buckets[]', () => {
    expect(body).toMatch(
      /\/\/ V-258 — effective rate-limit config \(per-bucket capacity \+ refill\)\./,
    );
    expect(body).toMatch(
      /export interface RateLimitBucket \{\s*\n?\s*bucket_key: 'global' \| 'sessions:create';\s*\n?\s*capacity: number;\s*\n?\s*refill_per_second: number;\s*\n?\s*source: 'tier_default' \| 'override';\s*\n?\s*override_expires_at: string \| null;\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /export interface GetAccountRateLimitsResponse \{\s*\n?\s*tier: string;\s*\n?\s*buckets: RateLimitBucket\[\];\s*\n?\s*\}/,
    );
  });

  it('me(): GET /v1/account/me; powers GUI X/Y sessions + P/Q profiles header gates (V-237 framing)', () => {
    expect(body).toMatch(
      /\*\s*V-237 — customer self-profile\. Powers the GUI client's\s*\n?\s*\*\s*"X \/ Y concurrent sessions" \+ "P \/ Q profiles" header gates\./,
    );
    expect(body).toMatch(
      /me\(\): Promise<AccountSelfProfile> \{\s*\n?\s*return this\.http\.request<AccountSelfProfile>\(\{\s*\n?\s*method: 'GET',\s*\n?\s*path: '\/v1\/account\/me',\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('V-352 updateMe: PATCH /v1/account/me with UpdateAccountMeRequest (name/timezone/slug/region partial-update)', () => {
    expect(body).toMatch(
      /\/\*\* V-352 — partial update of the calling account \(name \/ timezone \/ slug \/ region\)\. \*\//,
    );
    expect(body).toMatch(
      /updateMe\(body: UpdateAccountMeRequest\): Promise<AccountSelfProfile> \{\s*\n?\s*return this\.http\.request<AccountSelfProfile>\(\{\s*\n?\s*method: 'PATCH',\s*\n?\s*path: '\/v1\/account\/me',\s*\n?\s*body,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('V-352b uploadAvatar (POST /me/avatar) + clearAvatar (DELETE /me/avatar)', () => {
    expect(body).toMatch(/\/\*\* V-352b — upload \(or replace\) the calling account avatar\. \*\//);
    expect(body).toMatch(
      /uploadAvatar\(body: UploadAvatarRequest\): Promise<UploadAvatarResponse> \{\s*\n?\s*return this\.http\.request<UploadAvatarResponse>\(\{\s*\n?\s*method: 'POST',\s*\n?\s*path: '\/v1\/account\/me\/avatar',\s*\n?\s*body,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
    expect(body).toMatch(/\/\*\* V-352b — clear the calling account avatar pointer\. \*\//);
    expect(body).toMatch(
      /clearAvatar\(\): Promise<void> \{\s*\n?\s*return this\.http\.request<void>\(\{\s*\n?\s*method: 'DELETE',\s*\n?\s*path: '\/v1\/account\/me\/avatar',\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('V-355 web-sessions: list (GET /web-sessions) + revoke single (DELETE /:id encoded, idempotent) + revoke all-other (DELETE /web-sessions)', () => {
    expect(body).toMatch(
      /\/\*\* V-355 — list active dashboard sign-ins for the calling account\. \*\//,
    );
    expect(body).toMatch(
      /listWebSessions\(\): Promise<ListWebSessionsResponse> \{\s*\n?\s*return this\.http\.request<ListWebSessionsResponse>\(\{\s*\n?\s*method: 'GET',\s*\n?\s*path: '\/v1\/account\/web-sessions',\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
    expect(body).toMatch(/\/\*\* V-355 — revoke a single web session by id\. Idempotent\. \*\//);
    expect(body).toMatch(
      /revokeWebSession\(id: string\): Promise<void> \{\s*\n?\s*return this\.http\.request<void>\(\{\s*\n?\s*method: 'DELETE',\s*\n?\s*path: `\/v1\/account\/web-sessions\/\$\{encodeURIComponent\(id\)\}`,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
    expect(body).toMatch(/\/\*\* V-355 — revoke every web session except the calling one\. \*\//);
    expect(body).toMatch(
      /revokeAllOtherWebSessions\(\): Promise<void> \{\s*\n?\s*return this\.http\.request<void>\(\{\s*\n?\s*method: 'DELETE',\s*\n?\s*path: '\/v1\/account\/web-sessions',\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('V-258 rateLimits: GET /v1/account/rate-limits; returns GetAccountRateLimitsResponse', () => {
    expect(body).toMatch(
      /\/\*\* V-258 — read effective rate-limit config \(per-bucket caps \+ override status\)\. \*\//,
    );
    expect(body).toMatch(
      /rateLimits\(\): Promise<GetAccountRateLimitsResponse> \{\s*\n?\s*return this\.http\.request<GetAccountRateLimitsResponse>\(\{\s*\n?\s*method: 'GET',\s*\n?\s*path: '\/v1\/account\/rate-limits',\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('imports: AccountTier + UpdateAccountMeRequest + UploadAvatarRequest from api-types + HttpClient', () => {
    expect(body).toMatch(
      /import type \{\s*\n?\s*AccountTier,\s*\n?\s*UpdateAccountMeRequest,\s*\n?\s*UploadAvatarRequest,\s*\n?\s*\} from '@driftstack\/api-types';/,
    );
    expect(body).toMatch(/import type \{ HttpClient \} from '\.\.\/http\.js';/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});

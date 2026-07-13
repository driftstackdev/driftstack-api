// W590.B (W638-deepened) — drift guard for packages/sdk-go/account.go.
// AccountResource Go parity — 8 V-450 self-service verbs.
//
// W638 splits the original 4 it() blocks (framing-bundle + Me bundle +
// 7-verbs-bundle + file-exists) into 11 focused per-concept blocks +
// pins previously-implicit invariants:
//
//   • V-211 no-IP/UA-fingerprint contract on /v1/account/me response
//     (the inline Note in the struct + the X-Driftstack-Account team-
//     RBAC-IMMUNE invariant on Me() = the load-bearing privacy +
//     auth-scoping pair).
//   • Keyed-construction sentinel (the trailing _ struct{} field)
//     that forces callers to use field names — drift to dropping
//     this would break the forward-compat invariant that adding new
//     fields can't break existing AccountSelfProfile{...} positional
//     constructions in customer code.
//   • UploadAvatarRequest content-type allowlist (PNG / JPEG / WebP)
//     + 2 MiB raw cap. Drift to accepting GIF or animated formats
//     would change the server-side storage contract.
//   • UpdateMeRequest pointer-field semantics: empty string clears
//     (server-side accepts JSON null to clear) vs nil-pointer omits.
//   • V-355 web-sessions 3-verb surface: List + Revoke-by-id +
//     Revoke-all-other (the latter explicitly excludes the calling
//     session so customers can't lock themselves out).
//   • V-258 RateLimitBucket per-bucket override source pinned (the
//     "tier_default" | "override" enum tells dashboards which rows
//     are admin-set vs derived from the tier baseline).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-go/account.go');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W590.B packages/sdk-go/account.go content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path + V-428/V-385 AccountResource binds /v1/account/* + mirrors TS + Python SDKs (cross-language wire-shape parity)', () => {
    expect(existsSync(LIB)).toBe(true);
    expect(body).toMatch(/^package driftstack$/m);
    expect(body).toMatch(/\/\/ V-428 — adds the Go AccountResource with Me\(\) returning the rich/);
    expect(body).toMatch(
      /\/\/ \/v1\/account\/me response \(V-385\)\. Mirrors the TS \+ Python SDKs\./,
    );
    expect(body).toMatch(/^type AccountResource struct \{\s*\n\s*client \*Client\s*\n\}/m);
  });

  it('AccountTeamMembership — V-326c per-team membership row. Role inline-comment enum ("admin" | "member") pinned so a drift adding e.g. "owner" or "viewer" does not silently widen the SDK shape.', () => {
    expect(body).toMatch(/\/\/ AccountTeamMembership — V-326c\. One entry per team the calling/);
    expect(body).toMatch(/\/\/ account is a member of\./);
    expect(body).toMatch(
      /^type AccountTeamMembership struct \{\s*\n\s*OwnerAccountID\s+string\s+`json:"owner_account_id"`\s*\n\s*OwnerEmail\s+string\s+`json:"owner_email"`[^\n]*\n\s*OwnerName\s+\*string\s+`json:"owner_name"`[^\n]*\n\s*Role\s+string\s+`json:"role"`\s*\/\/ "admin" \| "member"\s*\n\s*MembershipID\s+string\s+`json:"membership_id"`\s*\n\}/m,
    );
  });

  it("AccountSelfProfile — rich /me response with V-298a/V-298b/V-352b/V-353h surface. All V-NNN inline-comments pinned per-field so a regen can't silently drop the V-anchor that links each field back to its proposal: Timezone V-352, Slug V-298a, Region V-298b (us|eu|apac|null), AvatarURL V-352b short-lived presigned URL, MfaEnrolled V-353h, Teams V-326c. Region enum closed-list pinned in the inline comment.", () => {
    expect(body).toMatch(/\/\/ AccountSelfProfile — full \/v1\/account\/me response\./);
    expect(body).toMatch(/\/\/ V-298a\/V-298b\/V-352b\/V-353h fields the server adds beyond the/);
    expect(body).toMatch(/\/\/ base AccountSchema\. Pointer fields are nullable; absent in the/);
    expect(body).toMatch(/\/\/ JSON means nil\./);
    expect(body).toMatch(/Timezone\s+\*string\s+`json:"timezone"`\s+\/\/ V-352/);
    expect(body).toMatch(/Slug\s+\*string\s+`json:"slug"`\s+\/\/ V-298a/);
    expect(body).toMatch(
      /Region\s+\*string\s+`json:"region"`\s+\/\/ V-298b — "us"\|"eu"\|"apac"\|null/,
    );
    expect(body).toMatch(
      /AvatarURL\s+\*string\s+`json:"avatar_url"`\s+\/\/ V-352b — short-lived presigned URL/,
    );
    expect(body).toMatch(
      /AvatarSource\s+string\s+`json:"avatar_source"`\s+\/\/ "user"\|"idp"\|"none"/,
    );
    expect(body).toMatch(/MfaEnrolled\s+bool\s+`json:"mfa_enrolled"`\s+\/\/ V-353h/);
    expect(body).toMatch(/Teams\s+\[\]AccountTeamMembership `json:"teams"` \/\/ V-326c/);
  });

  it('AccountSelfProfile V-211 no-IP/UA-fingerprint invariant + keyed-construction sentinel. The trailing `_ struct{} // force keyed-struct construction for forward-compat` field is load-bearing: it forces callers to write AccountSelfProfile{ID: "x", Email: "y", ...} with field names, not positional construction. Drift to dropping the sentinel would break the forward-compat guarantee that adding new server-side fields can\'t silently shift positional construction in customer code.', () => {
    expect(body).toMatch(/\/\/ Note: V-211 — the rich \/me response intentionally doesn't include/);
    expect(body).toMatch(
      /\/\/ any IP \/ user-agent fingerprint of the caller\. The server-side\s*\n\s*\/\/ audit log captures them in a separate internal store; the/,
    );
    expect(body).toMatch(/\/\/ \/v1\/account\/audit-log customer-facing surface elides them\./);
    expect(body).toMatch(/_ struct\{\} \/\/ force keyed-struct construction for forward-compat/);
  });

  it('Me — V-385 GET /v1/account/me with X-Driftstack-Account team-RBAC-IMMUNE invariant: "Bearer-authenticated; never honors the X-Driftstack-Account header (always returns the caller\'s own account, even when the caller is on a team)." Drift to honoring the team header would let team-context-switched dashboards see the OWNER\'s profile as their own — a serious auth-scope confusion.', () => {
    expect(body).toMatch(/\/\/ Me — V-385\. Read the calling account's full self-visible state\./);
    expect(body).toMatch(/\/\/ Bearer-authenticated; never honors the X-Driftstack-Account header/);
    expect(body).toMatch(/\/\/ \(always returns the caller's own account, even when the caller is/);
    expect(body).toMatch(/\/\/ on a team\)\./);
    expect(body).toMatch(
      /func \(r \*AccountResource\) Me\(ctx context\.Context\) \(\*AccountSelfProfile, error\)/,
    );
    expect(body).toMatch(/method: "GET",\s*\n\s*path:\s+"\/v1\/account\/me",/);
  });

  it('UpdateMeRequest + UpdateMe — V-352 PATCH /v1/account/me partial-update. 4-field pointer struct (Name + Timezone + Slug + Region) with omitempty on every field. Pointer semantics pinned in the doc-comment: "Use a *string with empty string to clear (the server\'s PATCH schema accepts JSON null to clear; nil-pointer omits the field entirely)." Drift here would break the customer-side "clear vs omit" distinction.', () => {
    expect(body).toMatch(
      /\/\/ V-450 — extend AccountResource with update \/ avatar \/ web-sessions \//,
    );
    expect(body).toMatch(/\/\/ rate-limits methods\./);
    expect(body).toMatch(/\/\/ UpdateMeRequest — partial update body\. At least one field must be/);
    expect(body).toMatch(/\/\/ non-nil\. Use a \*string with empty string to clear \(the server's/);
    expect(body).toMatch(/\/\/ PATCH schema accepts JSON null to clear; nil-pointer omits the/);
    expect(body).toMatch(/\/\/ field entirely\)\./);
    expect(body).toMatch(
      /^type UpdateMeRequest struct \{\s*\n\s*Name\s+\*string `json:"name,omitempty"`\s*\n\s*Timezone \*string `json:"timezone,omitempty"`\s*\n\s*Slug\s+\*string `json:"slug,omitempty"`\s*\n\s*Region\s+\*string `json:"region,omitempty"` \/\/ "us" \| "eu" \| "apac"\s*\n\}/m,
    );
    expect(body).toMatch(/\/\/ UpdateMe — V-352 partial update of the calling account\./);
    expect(body).toMatch(/method: "PATCH",\s*\n\s*path:\s+"\/v1\/account\/me",/);
  });

  it('UploadAvatarRequest + UploadAvatar — V-352b POST /v1/account/me/avatar inline-base64 body. ContentType allowlist invariant: image/png | image/jpeg | image/webp (inline comment pinned). 2 MiB raw cap pinned in the doc-comment. Drift to accepting GIF or animated formats would change the server-side storage contract. UploadAvatarResponse returns nullable AvatarURL (short-lived presigned URL — same shape as the field on AccountSelfProfile).', () => {
    expect(body).toMatch(/\/\/ UploadAvatarRequest — V-352b\. Inline base64 body; max 2 MiB raw\./);
    expect(body).toMatch(
      /^type UploadAvatarRequest struct \{\s*\n\s*DataBase64\s+string `json:"data_base64"`\s*\n\s*ContentType string `json:"content_type"` \/\/ "image\/png" \| "image\/jpeg" \| "image\/webp"\s*\n\}/m,
    );
    expect(body).toMatch(
      /^type UploadAvatarResponse struct \{\s*\n\s*AvatarURL\s+\*string `json:"avatar_url"`\s*\n\s*ContentType string\s+`json:"content_type"`\s*\n\s*Bytes\s+int\s+`json:"bytes"`\s*\n\}/m,
    );
    expect(body).toMatch(
      /\/\/ UploadAvatar — V-352b upload \(or replace\) the calling account avatar\./,
    );
    expect(body).toMatch(/method: "POST",\s*\n\s*path:\s+"\/v1\/account\/me\/avatar",/);
  });

  it('ClearAvatar — V-352b DELETE /v1/account/me/avatar clears the avatar pointer (sets server-side avatar_url null). Plain error return; no out struct. Drift to a softer "clear-soft-delete" semantic would break the customer-facing "remove my avatar entirely" expectation.', () => {
    expect(body).toMatch(/\/\/ ClearAvatar — V-352b clear the avatar pointer\./);
    expect(body).toMatch(
      /func \(r \*AccountResource\) ClearAvatar\(ctx context\.Context\) error \{\s*\n\s*return r\.client\.do\(ctx, requestOptions\{\s*\n\s*method: "DELETE",\s*\n\s*path:\s+"\/v1\/account\/me\/avatar",\s*\n\s*\}\)\s*\n\}/,
    );
  });

  it('WebSessionEntry + ListWebSessions — V-355 6-field active-sign-in row (ID + OS + Browser + LastUsedAt + ExpiresAt + Current bool). The Current flag is load-bearing: it tells the dashboard which row IS the calling session (must not be revokable from itself). GET /v1/account/web-sessions returns ListWebSessionsResponse with the Data slice.', () => {
    expect(body).toMatch(/\/\/ WebSessionEntry — V-355 active dashboard sign-in\./);
    expect(body).toMatch(
      /^type WebSessionEntry struct \{\s*\n\s*ID\s+string\s+`json:"id"`\s*\n\s*OS\s+string\s+`json:"os"`\s*\n\s*Browser\s+string\s+`json:"browser"`\s*\n\s*LastUsedAt time\.Time `json:"last_used_at"`\s*\n\s*ExpiresAt\s+time\.Time `json:"expires_at"`\s*\n\s*Current\s+bool\s+`json:"current"`\s*\n\}/m,
    );
    expect(body).toMatch(/\/\/ ListWebSessions — V-355 active dashboard sign-ins\./);
    expect(body).toMatch(
      /func \(r \*AccountResource\) ListWebSessions\(ctx context\.Context\) \(\*ListWebSessionsResponse, error\)/,
    );
    expect(body).toMatch(/method: "GET",\s*\n\s*path:\s+"\/v1\/account\/web-sessions",/);
  });

  it('RevokeWebSession + RevokeAllOtherWebSessions — V-355 dual-verb revoke surface. RevokeWebSession DELETE /v1/account/web-sessions/{id} is idempotent (re-revoking is a no-op) + URL-escapes sessionID. RevokeAllOtherWebSessions DELETE /v1/account/web-sessions explicitly EXCLUDES the calling session so customers can\'t lock themselves out by revoking everything. The "every session except the calling one" framing pinned because dropping the qualifier would silently allow self-revocation.', () => {
    expect(body).toMatch(
      /\/\/ RevokeWebSession — V-355 revoke a single web session by id\. Idempotent\./,
    );
    expect(body).toMatch(
      /func \(r \*AccountResource\) RevokeWebSession\(ctx context\.Context, sessionID string\) error \{\s*\n\s*return r\.client\.do\(ctx, requestOptions\{\s*\n\s*method: "DELETE",\s*\n\s*path:\s+"\/v1\/account\/web-sessions\/" \+ url\.PathEscape\(sessionID\),\s*\n\s*\}\)\s*\n\}/,
    );
    expect(body).toMatch(
      /\/\/ RevokeAllOtherWebSessions — V-355 revoke every session except the calling one\./,
    );
    expect(body).toMatch(
      /func \(r \*AccountResource\) RevokeAllOtherWebSessions\(ctx context\.Context\) error \{\s*\n\s*return r\.client\.do\(ctx, requestOptions\{\s*\n\s*method: "DELETE",\s*\n\s*path:\s+"\/v1\/account\/web-sessions",\s*\n\s*\}\)\s*\n\}/,
    );
  });

  it('RateLimitBucket + RateLimits — V-258 per-bucket effective rate-limit config. BucketKey enum-example comment (all 4 buckets incl. agent_sessions:message + agent_sessions:input_event — sweep-3) + Source enum ("tier_default" | "override") + nullable OverrideExpiresAt. Source enum is load-bearing for dashboards rendering "this row is overridden until X" vs "this row is your tier default" — drift would silently collapse the two rendering paths.', () => {
    expect(body).toMatch(/\/\/ RateLimitBucket — V-258 per-bucket effective rate-limit config\./);
    expect(body).toMatch(
      /^type RateLimitBucket struct \{\s*\n\s*\/\/ "global" \| "sessions:create" \| "agent_sessions:message" \| "agent_sessions:input_event"\s*\n\s*BucketKey\s+string\s+`json:"bucket_key"`\s*\n\s*Capacity\s+int\s+`json:"capacity"`\s*\n\s*RefillPerSecond\s+float64 `json:"refill_per_second"`\s*\n\s*Source\s+string\s+`json:"source"` \/\/ "tier_default" \| "override"\s*\n\s*OverrideExpiresAt \*string `json:"override_expires_at"`\s*\n\}/m,
    );
    expect(body).toMatch(
      /^type GetAccountRateLimitsResponse struct \{\s*\n\s*Tier\s+string\s+`json:"tier"`\s*\n\s*Buckets \[\]RateLimitBucket `json:"buckets"`\s*\n\}/m,
    );
    expect(body).toMatch(/\/\/ RateLimits — V-258 read effective rate-limit config\./);
    expect(body).toMatch(
      /func \(r \*AccountResource\) RateLimits\(ctx context\.Context\) \(\*GetAccountRateLimitsResponse, error\)/,
    );
    expect(body).toMatch(/method: "GET",\s*\n\s*path:\s+"\/v1\/account\/rate-limits",/);
  });
});

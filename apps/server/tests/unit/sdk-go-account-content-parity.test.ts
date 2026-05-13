// W590.B — drift guard for packages/sdk-go/account.go.
// AccountResource Go parity — 8 V-450 self-service verbs.
//
//   • V-385 Me() rich self-profile (V-298a/V-298b/V-352b/V-353h
//     surface) + X-Driftstack-Account team-RBAC-immune.
//   • V-450 update + avatar upload/clear + V-355 web-sessions 3 +
//     V-258 rate-limits.
//   • Embedded types: AccountSelfProfile (with _ struct{} keyed-
//     construction sentinel + V-211 no-IP/UA-fingerprint
//     framing), UpdateMeRequest pointer fields, UploadAvatar*
//     base64+content_type, WebSessionEntry, RateLimitBucket.

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

  it('V-428/V-385 AccountResource framing + AccountTeamMembership V-326c + AccountSelfProfile V-NNN surface + V-211 no-IP/UA-fingerprint + keyed-construction sentinel pinned', () => {
    expect(body).toMatch(/\/\/ V-428 — adds the Go AccountResource with Me\(\) returning the rich/);
    expect(body).toMatch(
      /\/\/ \/v1\/account\/me response \(V-385\)\. Mirrors the TS \+ Python SDKs\./,
    );
    expect(body).toMatch(/^type AccountResource struct \{\s*\n\s*client \*Client\s*\n\}/m);
    expect(body).toMatch(/\/\/ AccountTeamMembership — V-326c\. One entry per team the calling/);
    expect(body).toMatch(/\/\/ account is a member of\./);
    expect(body).toMatch(
      /^type AccountTeamMembership struct \{\s*\n\s*OwnerAccountID string `json:"owner_account_id"`/m,
    );
    expect(body).toMatch(/Role\s+string `json:"role"` \/\/ "admin" \| "member"/);
    expect(body).toMatch(/MembershipID\s+string `json:"membership_id"`/);
    expect(body).toMatch(/\/\/ AccountSelfProfile — full \/v1\/account\/me response\./);
    expect(body).toMatch(/Timezone \*string\s+`json:"timezone"`\s+\/\/ V-352/);
    expect(body).toMatch(/Slug\s+\*string\s+`json:"slug"`\s+\/\/ V-298a/);
    expect(body).toMatch(
      /Region\s+\*string\s+`json:"region"`\s+\/\/ V-298b — "us"\|"eu"\|"apac"\|null/,
    );
    expect(body).toMatch(
      /AvatarURL \*string\s+`json:"avatar_url"`\s+\/\/ V-352b — short-lived presigned URL/,
    );
    expect(body).toMatch(/MfaEnrolled\s+bool\s+`json:"mfa_enrolled"` \/\/ V-353h/);
    expect(body).toMatch(/Teams\s+\[\]AccountTeamMembership `json:"teams"` \/\/ V-326c/);
    expect(body).toMatch(/\/\/ Note: V-211 — the rich \/me response intentionally doesn't include/);
    expect(body).toMatch(/\/\/ any IP \/ user-agent fingerprint of the caller\./);
    expect(body).toMatch(/_ struct\{\} \/\/ force keyed-struct construction for forward-compat/);
  });

  it('Me() V-385 GET /me + X-Driftstack-Account team-RBAC-immune framing pinned', () => {
    expect(body).toMatch(/\/\/ Me — V-385\. Read the calling account's full self-visible state\./);
    expect(body).toMatch(/\/\/ Bearer-authenticated; never honors the X-Driftstack-Account header/);
    expect(body).toMatch(/\/\/ \(always returns the caller's own account, even when the caller is/);
    expect(body).toMatch(/\/\/ on a team\)\./);
    expect(body).toMatch(
      /func \(r \*AccountResource\) Me\(ctx context\.Context\) \(\*AccountSelfProfile, error\) \{/,
    );
    expect(body).toMatch(/path:\s+"\/v1\/account\/me",/);
  });

  it('V-450 UpdateMe pointer-fields + UploadAvatar base64+content_type allowlist + ClearAvatar DELETE; V-355 ListWebSessions 3-verb (List + RevokeWebSession idempotent + RevokeAllOtherWebSessions) + V-258 RateLimits read pinned', () => {
    expect(body).toMatch(
      /\/\/ V-450 — extend AccountResource with update \/ avatar \/ web-sessions \//,
    );
    expect(body).toMatch(/\/\/ rate-limits methods\./);
    expect(body).toMatch(/\/\/ UpdateMeRequest — partial update body\. At least one field must be/);
    expect(body).toMatch(/\/\/ non-nil\. Use a \*string with empty string to clear/);
    expect(body).toMatch(
      /^type UpdateMeRequest struct \{\s*\n\s*Name\s+\*string `json:"name,omitempty"`\s*\n\s*Timezone \*string `json:"timezone,omitempty"`\s*\n\s*Slug\s+\*string `json:"slug,omitempty"`\s*\n\s*Region\s+\*string `json:"region,omitempty"` \/\/ "us" \| "eu" \| "apac"\s*\n\}/m,
    );
    expect(body).toMatch(/\/\/ UpdateMe — V-352 partial update of the calling account\./);
    expect(body).toMatch(/method: "PATCH",\s*\n\s*path:\s+"\/v1\/account\/me",/);
    expect(body).toMatch(/\/\/ UploadAvatarRequest — V-352b\. Inline base64 body; max 2 MiB raw\./);
    expect(body).toMatch(
      /^type UploadAvatarRequest struct \{\s*\n\s*DataBase64\s+string `json:"data_base64"`\s*\n\s*ContentType string `json:"content_type"` \/\/ "image\/png" \| "image\/jpeg" \| "image\/webp"\s*\n\}/m,
    );
    expect(body).toMatch(/path:\s+"\/v1\/account\/me\/avatar",/);
    expect(body).toMatch(
      /func \(r \*AccountResource\) ClearAvatar\(ctx context\.Context\) error \{\s*\n\s*return r\.client\.do\(ctx, requestOptions\{\s*\n\s*method: "DELETE",\s*\n\s*path:\s+"\/v1\/account\/me\/avatar",\s*\n\s*\}\)\s*\n\}/,
    );
    expect(body).toMatch(/\/\/ WebSessionEntry — V-355 active dashboard sign-in\./);
    expect(body).toMatch(/Current\s+bool\s+`json:"current"`/);
    expect(body).toMatch(/\/\/ ListWebSessions — V-355 active dashboard sign-ins\./);
    expect(body).toMatch(/path:\s+"\/v1\/account\/web-sessions",/);
    expect(body).toMatch(
      /\/\/ RevokeWebSession — V-355 revoke a single web session by id\. Idempotent\./,
    );
    expect(body).toMatch(
      /path:\s+"\/v1\/account\/web-sessions\/" \+ url\.PathEscape\(sessionID\),/,
    );
    expect(body).toMatch(
      /\/\/ RevokeAllOtherWebSessions — V-355 revoke every session except the calling one\./,
    );
    expect(body).toMatch(
      /func \(r \*AccountResource\) RevokeAllOtherWebSessions\(ctx context\.Context\) error \{\s*\n\s*return r\.client\.do\(ctx, requestOptions\{\s*\n\s*method: "DELETE",\s*\n\s*path:\s+"\/v1\/account\/web-sessions",\s*\n\s*\}\)\s*\n\}/,
    );
    expect(body).toMatch(/\/\/ RateLimitBucket — V-258 per-bucket effective rate-limit config\./);
    expect(body).toMatch(
      /BucketKey\s+string\s+`json:"bucket_key"` \/\/ "global" \| "sessions:create"/,
    );
    expect(body).toMatch(/Source\s+string\s+`json:"source"` \/\/ "tier_default" \| "override"/);
    expect(body).toMatch(/\/\/ RateLimits — V-258 read effective rate-limit config\./);
    expect(body).toMatch(/path:\s+"\/v1\/account\/rate-limits",/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});

// W770 — apps/docs api/account.md content parity. Ninety-sixth in
// the cross-SDK drift-guard series.
//
// /api/account is the canonical reference for /v1/account/me +
// avatar + web-sessions + rate-limits. Drift to the no-team-RBAC
// framing or the avatar 2 MiB cap would mismatch W759 dashboard
// /settings + W766 /api/team isolation contract.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccountTierSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/api/account.md');

describe('W770 docs /api/account content parity', () => {
  it('api/account.md file exists', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('CRITICAL frontmatter title pinned.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/^---\nlayout: \.\.\/\.\.\/layouts\/DocLayout\.astro\ntitle: Account\n/);
  });

  it('CRITICAL tier-count claim matches AccountTierSchema cardinality — the `tier` field doc says "eight tier slugs" and the enum has exactly eight options. Tied together so adding/removing a tier forces a doc update (this drifted to "seven" once).', () => {
    const p = read(PAGE);

    expect(p).toMatch(/One of the eight tier slugs\./);
    expect(AccountTierSchema.options).toHaveLength(8);
  });

  it('CRITICAL exact identity /me stays self-only while nested profile organization explicitly honors the effective account.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /The exact `\/v1\/account\/me` identity resource is the calling\s*\n?account's self-edit surface\. It is bearer-authenticated and never\s*\n?honours the team-RBAC `X-Driftstack-Account` header/,
    );
    expect(p).toMatch(
      /The nested\s*\n?`\/v1\/account\/me\/organization` profile-taxonomy resource is an\s*\n?explicit exception: it honours the selected effective account so\s*\n?folders and tags stay with the profiles they organize\./,
    );
  });

  it('CRITICAL organization scopes, team roles, authorization order and exact-owner persistence are pinned.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /`GET \/v1\/account\/me\/organization` reads the effective account's\s*\n?saved folder\/icon and tag taxonomy\. It requires `read:profiles`/,
    );
    expect(p).toMatch(/Both team `member` and `admin` roles may read/);
    expect(p).toMatch(
      /`PUT \/v1\/account\/me\/organization` replaces that complete taxonomy\s*\n?and requires `write:profiles`/,
    );
    expect(p).toMatch(/In team context, only `admin` may\s*\n?write\./);
    expect(p).toMatch(
      /The server resolves membership and role before validating\s*\n?or persisting the body, and writes only the account named by\s*\n?`X-Driftstack-Account`\./,
    );
    expect(p).toMatch(
      /Without the header, both methods retain\s*\n?their original calling-account behavior\./,
    );
  });

  it('CRITICAL self-state field table pinned with 16 fields. Drift to dropping any would silently break SDK consumer types.', () => {
    const p = read(PAGE);

    for (const field of [
      'id',
      'email',
      'name',
      'tier',
      'status',
      'timezone',
      'slug',
      'region',
      'avatar_url',
      'avatar_source',
      'mfa_enrolled',
      'concurrent_session_cap',
      'concurrent_session_active',
      'profile_cap',
      'profile_count',
      'teams',
    ]) {
      expect(p, `field ${field}`).toMatch(new RegExp(`\\| \`${field}\``));
    }
  });

  it('CRITICAL acc_-prefix framing pinned. Drift to a different prefix would break SDK type discriminators.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/Public id, prefixed `acc_`\./);
  });

  it('CRITICAL 3-status enum — active/suspended/deleted pinned. Drift would let SDK consumers fail to handle suspended/deleted states.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/`active` \/ `suspended` \/ `deleted`\./);
  });

  it("CRITICAL timezone IANA + UTC-fallback framing pinned. The 'IANA name (Europe/Amsterdam); null means UTC fallback for client renders' wording matches W759 dashboard /settings V-352c profile-form timezone field.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /IANA name \(`Europe\/Amsterdam`\); null means UTC fallback for client renders\./,
    );
  });

  it('CRITICAL slug 3-32-char + lowercase + hyphen + uniqueness 409 framing pinned. Matches W759 dashboard /settings V-298a slug-conditional-inclusion.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/readable handle \(lowercase a-z \+ 0-9 \+ hyphen, 3-32 chars\)/);
    expect(p).toMatch(
      /3-32 chars, lowercase a-z \+ 0-9 \+ hyphen, no leading or trailing hyphen, no consecutive hyphens\. Returns `409 Conflict` when another account already owns the slug\./,
    );
  });

  it("CRITICAL region 3-enum us/eu/apac + DPA Annex 3 cross-reference framing pinned. The 'Informational for v1; routing is governed by [DPA Annex 3]' wording matches W759 dashboard /settings V-298b region-empty-string-as-null encoding.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/stated infrastructure-region preference \(`us` \/ `eu` \/ `apac`\)\./);
    expect(p).toMatch(
      /Informational for v1; routing is governed by \[DPA Annex 3\]\(https:\/\/driftstack\.dev\/legal\/dpa\/#annex-3--sub-processors\)/,
    );
    expect(p).not.toContain('https://driftstack.dev/legal/dpa#annex-3--sub-processors');
  });

  it('CRITICAL avatar URL/source framing distinguishes removable uploads from the linked-sign-in fallback.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/short-lived \(1h\) presigned R2 upload/);
    expect(p).toMatch(/`user` for a removable customer upload/);
    expect(p).toMatch(/`idp` for the read-only linked-sign-in fallback/);
    expect(p).toMatch(/Use this field—not the URL host—to decide whether to offer Remove\./);
  });

  it("CRITICAL profile_cap null-on-enterprise framing pinned. Matches W769 /api/usage profiles_limit may be null + W752 dashboard atLimit 'custom'-sentinel.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/Per-tier profile ceiling; null on enterprise \(custom\)\./);
  });

  it('CRITICAL teams array shape pinned — owner_account_id + owner_email + owner_name + role + membership_id + empty-array-when-no-team framing. Matches W766 /api/team .teams[] embedding.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /owner accounts the caller is a member of\. Each entry: `owner_account_id`, `owner_email` \(falls back to `acc_<id>` when unknown\), `owner_name` \(nullable\), `role`, `membership_id`\. Empty array when not on any team\./,
    );
  });

  it('CRITICAL PATCH partial-update + null-clears + at-least-one-required framing pinned. Drift would let SDK consumers fail to surface partial-update semantics.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Partial update — pass any subset of `name`, `timezone`, `slug`,\s*\n?`region`\. At least one field must be present\. Pass `null` to clear\s*\n?a nullable field\./,
    );
  });

  it('CRITICAL name 1-120-trimmed-chars + UI-falls-back-to-email framing pinned. Drift to a different bound would mismatch server validation.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/`name` — 1-120 trimmed chars; null clears \(UI falls back to email\)\./);
  });

  it('CRITICAL avatar POST inline-base64 + 3-content-type set framing pinned. image/png + image/jpeg + image/webp. Drift to allowing other formats would let SDK consumers send GIFs that the server then rejects.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/Allowed `content_type`: `image\/png`, `image\/jpeg`, `image\/webp`\./);
    expect(p).toMatch(/"data_base64":/);
    expect(p).toMatch(/"content_type":/);
  });

  it("CRITICAL avatar 2 MiB raw + 3.5 MiB body-limit framing pinned. The '(route body limit is 3.5 MiB to allow the base64 envelope)' clause explains why the limits differ — base64 = ~33% overhead.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Max raw size: 2 MiB \(route body limit is 3\.5 MiB to allow the base64 envelope\)\./,
    );
  });

  // S38 2026-07-07 (fable-truth-audit follow-on) — the old pin locked an "EU-jurisdiction R2"
  // claim; the buckets live in Cloudflare's default jurisdiction
  // (EU + US replication; founder soften decision 2026-07-07), so the
  // page now states the honest posture.
  it('CRITICAL avatar R2 storage framing, corrected by V-797. This pinned "stored privately on Cloudflare R2". The upload path uses r2Public — the bucket bootstrap.ts itself calls public-readable and explicitly contrasts with the private recordings bucket — so the presigned URL is a stable time-limited link, not a confidentiality control', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /The image is stored on Cloudflare R2 in the\s*\n?public-readable bucket \(its storage network can replicate outside the\s*\n?EU\)\./,
    );
    expect(p, 'the presign must be described as a link, not access control').toMatch(
      /a stable\s*\n?time-limited link rather than an access control/,
    );
    expect(p, 'the privacy claim must not return').not.toMatch(/stored privately on Cloudflare R2/);
    expect(p).not.toMatch(/EU-jurisdiction/);
  });

  it("CRITICAL DELETE avatar framing, corrected by V-797. The old wording called a sweeper collecting orphaned keys the load-bearing async-GC contract; there is no such sweeper anywhere in src, and the route's own comment says a FUTURE one. The page now says the object persists and a shared URL keeps resolving, so a customer does not read the delete as an erasure.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /clears the avatar pointer on your\s*\n?account, so the image stops being served from `\/v1\/account\/me`\./,
    );
    expect(p).toMatch(/there is no sweeper collecting\s*\n?orphaned keys today/);
    expect(p, 'the phantom garbage collector must not return').not.toMatch(
      /a sweeper job collects orphaned keys/,
    );
  });

  it("CRITICAL web-sessions current: true discriminator framing pinned. The 'The entry with current: true is the calling session itself' wording explains the self-identifier on V-355 session-list.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/The entry with `current: true` is the calling session itself\./);
  });

  it("CRITICAL IP-omitted + UA-reduced framing pinned. The 'IP addresses are deliberately omitted; user-agents are reduced to OS + browser bucket per the anonymity' wording matches W768 audit-log ip/user-agent privacy contract.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /IP addresses are deliberately omitted; user-agents are reduced to\s*\n?OS \+ browser bucket per the anonymity\./,
    );
  });

  it('CRITICAL revoke-all-other web-sessions cross-language SDK framing pinned — revokeAllOtherWebSessions / equivalent. Matches W759 dashboard /settings V-355 bulk DELETE-?keep=current.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Revoke every other session in one\s*\n?call with `revokeAllOtherWebSessions\(\)` \/ equivalent\./,
    );
  });

  it("CRITICAL rate-limit source 2-enum tier_default | override framing pinned. The 'override_expires_at is non-null in the override case' clause is what tells SDK consumers when staff has applied a per-account adjustment.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /`source` is `tier_default` for unbounded tier-derived caps or\s*\n?`override` when staff has applied a per-account adjustment;\s*\n?`override_expires_at` is non-null in the override case\./,
    );
  });

  it('CRITICAL email-preferences critical-emails-not-opt-outable framing pinned. The 3-event critical set (verification, password-reset, billing-failure) is the load-bearing contract that protects customers from misconfiguring themselves out of critical comms. (S44 2026-07-07 founder-approved trim deleted the never-wired subscription-cancellation + support-ack templates from the set.)', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Critical emails \(verification, password-reset, billing-failure\)\s*\n?are not opt-outable —\s*\n?they're absent from the `OptOutableEmailEvent` enum on purpose\./,
    );
    expect(p).not.toMatch(/subscription-cancellation|support-ack/);
  });

  it('CRITICAL why identity-/me-ignores-team-RBAC framing stays narrow and names the nested taxonomy exception.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /editing a team owner's display\s*\n?name, slug, region, or avatar via a member's bearer token would be\s*\n?surprising\./,
    );
    expect(p).toMatch(
      /Those account edits stay bound to the authenticated\s*\n?account\. This does not cover the nested profile taxonomy described\s*\n?above, whose owner must match the selected profile workspace\./,
    );
  });

  it('CRITICAL 3-language SDK examples pinned — listWebSessions / list_web_sessions / ListWebSessions(ctx).', () => {
    const p = read(PAGE);

    expect(p).toMatch(/await client\.account\.listWebSessions\(\)/);
    expect(p).toMatch(/client\.account\.list_web_sessions\(\)/);
    expect(p).toMatch(/client\.Account\.ListWebSessions\(ctx\)/);
  });

  it('CRITICAL 4-endpoint canonical action set pinned — GET /v1/account/me + PATCH /v1/account/me + POST /v1/account/me/avatar + DELETE /v1/account/me/avatar.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/`GET \/v1\/account\/me`/);
    expect(p).toMatch(/`PATCH \/v1\/account\/me`/);
    expect(p).toMatch(/`POST \/v1\/account\/me\/avatar`/);
    expect(p).toMatch(/`DELETE \/v1\/account\/me\/avatar`/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/docs-pages-api-account-content-parity.test.ts'),
      ),
    ).toBe(true);
  });
});

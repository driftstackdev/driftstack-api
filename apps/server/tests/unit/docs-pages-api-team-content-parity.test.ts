// W766 — apps/docs api/team.md content parity. Ninety-second in the
// cross-SDK drift-guard series.
//
// /api/team is the canonical reference for the team-RBAC contract +
// the X-Driftstack-Account header. Drift to the role-gating split or
// the header-honoring endpoint list would let SDK consumers'
// expectations diverge from V-326e server enforcement and the W757
// dashboard /team surface.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/api/team.md');

describe('W766 docs /api/team content parity', () => {
  it('api/team.md file exists', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('CRITICAL frontmatter title + description pinned.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/^---\nlayout: \.\.\/\.\.\/layouts\/DocLayout\.astro\ntitle: Team RBAC\n/);
    expect(p).toMatch(
      /description: Invite team members, accept invites, list members, remove members via \/v1\/team\/\*, and read or rename teams via \/v1\/teams\./,
    );
  });

  it("CRITICAL multi-user-team-asymmetry framing pinned. The 'one owner-account plus zero or more member-accounts joined to it' + 'API keys remain account-scoped (shared across the team) and admin-gated' wording matches W757 dashboard /team page asymmetric-model framing.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/Driftstack supports multi-user teams: one owner-account plus zero or/);
    expect(p).toMatch(/more member-accounts joined to it via the `\/v1\/team\/\*` endpoints\./);
    expect(p).toMatch(
      /Each member uses their own login \+ their own dashboard sessions\. API\s*\n?keys remain account-scoped \(shared across the team\) and admin-gated\./,
    );
  });

  it('CRITICAL 4-concept set pinned — Owner account / Member account / Invite / Role. Drift to dropping any would lose the load-bearing vocabulary set.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/\*\*Owner account\.\*\* The account that pays the subscription\./);
    expect(p).toMatch(/\*\*Member account\.\*\* A separate `accounts` row/);
    expect(p).toMatch(/\*\*Invite\.\*\* A pending double-opt-in record in `team_invites`\./);
    expect(p).toMatch(/\*\*Role\.\*\* `member` \(read-only on owner resources\) or `admin` \(full/);
  });

  it('CRITICAL invite sha256-token-hashed-at-rest + 7-day expiry pinned. Drift to plaintext storage would erode security; drift to a different TTL would mismatch W757 dashboard 7-day-accept-link framing.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/Token-hashed at\s*\n?\s+rest \(sha256\), 7-day expiry\./);
  });

  it('CRITICAL X-Driftstack-Account header acting-on-behalf framing pinned with curl example shape. Drift to dropping the example would lose the canonical demo of the V-326e team-RBAC contract.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /```http\nGET \/v1\/sessions\nAuthorization: Bearer ds_live_<member-key>\nX-Driftstack-Account: acc_<owner-uuid>/,
    );
  });

  it("CRITICAL role-gating split pinned — GET=member+admin, POST/PATCH/DELETE=admin-only. The 'member role gets 403' wording matches W757 + V-326e server enforcement.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/\*\*Read endpoints\*\* \(GET\) accept both `member` and `admin` roles\./);
    expect(p).toMatch(
      /\*\*Write endpoints\*\* \(POST \/ PATCH \/ DELETE \/ api-keys rotate\)\s*\n?\s+require `admin` role on the team\. `member` role gets `403`\./,
    );
  });

  it("CRITICAL X-Driftstack-Account-honoring-endpoint set pinned. The 7-endpoint-group inventory (sessions/profiles/api-keys/webhooks/audit-log/email-preferences/usage) is the load-bearing list of team-scoped surfaces. Drift to adding/removing would let SDK consumers misjudge what's RBAC-honored.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /`\/v1\/sessions` \(GET \/ POST \/ DELETE\) \+ `\/:id\/\{navigate,interact,\s*\n?wait,capture,gui-input,state\}`/,
    );
    expect(p).toMatch(/`\/v1\/profiles` \(GET \/ POST \/ PATCH \/ DELETE\)/);
    expect(p).toMatch(/`\/v1\/api-keys` \(GET \/ POST \/ DELETE \/ `:id\/rotate`\)/);
    expect(p).toMatch(
      /`\/v1\/webhooks` \(GET \/ POST \/ DELETE\) \+ `\/:id\/deliveries` \+\s*\n?\s+`\/v1\/webhook-deliveries\/:id\/replay`/,
    );
    expect(p).toMatch(/`\/v1\/account\/audit-log` \(GET\) \+ `\/audit-log\/export` \(GET\)/);
    expect(p).toMatch(/`\/v1\/account\/email-preferences` \(GET \/ PUT — PUT admin-only\)/);
    expect(p).toMatch(/`\/v1\/usage` \+ `\/v1\/usage\/series` \(GET\)/);
  });

  it('CRITICAL X-Driftstack-Account NON-honoring-endpoint set pinned — /v1/team/* + /v1/account/me + /v1/auth/*. Drift to listing wrong endpoints would let SDK consumers confused which routes are team-scoped vs caller-scoped.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/`\/v1\/team\/\*` — managing your own team \(members \+ invites\)\./);
    expect(p).toMatch(
      /`\/v1\/account\/me` — always your own profile \(with the team list\s*\n?\s+populated so clients know which owners they can act for\)\./,
    );
    expect(p).toMatch(/`\/v1\/auth\/\*` — authentication is per-caller\./);
  });

  it('CRITICAL GET /v1/team/owners inverse-view + GET /v1/account/me .teams[] embedding framing pinned. The \'Useful for populating an "act as" picker\' wording matches W757 dashboard V-331 picker.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /`GET \/v1\/team\/owners` — returns `\{ data: TeamOwner\[\] \}` where each\s*\n?entry has `owner_account_id`, `owner_email` \(falls back to\s*\n?`acc_<id>` when unknown\), `owner_name` \(nullable\), `role`, and\s*\n?`membership_id`\./,
    );
    expect(p).toMatch(/Useful for populating an "act as" picker in custom\s*\n?dashboards\./);
    expect(p).toMatch(
      /The same data is also embedded in `GET \/v1\/account\/me`\s*\n?under `teams\[\]`\./,
    );
  });

  it("CRITICAL POST /v1/team/invites returns 202 framing pinned. The 'response (202)' + invite-sent message matches W757 dashboard 202-Accepted-on-invite handler.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/Response \(202\):/);
    expect(p).toMatch(/"message": "Invite sent\. The invitee can accept via the email link\."/);
  });

  it("CRITICAL invite-accept email-must-match framing pinned. The 'The accepting account\\'s email MUST match the invitee email — server returns 409 Conflict otherwise. This prevents accidentally accepting an invite addressed to someone else even if they share the URL.' wording is the load-bearing CSRF-style defense.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /The accepting account's email MUST match the invitee email — server\s*\n?returns 409 Conflict otherwise\./,
    );
    expect(p).toMatch(
      /This prevents accidentally accepting\s*\n?an invite addressed to someone else even if they share the URL\./,
    );
  });

  it("CRITICAL DELETE /v1/team/members/:id owner-scoped framing pinned — '404 if the membership isn\\'t owned by the calling account'. Drift would let SDK consumers leak existence cross-account.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /`DELETE \/v1\/team\/members\/:id` — owner-scoped\. 404 if the membership\s*\n?isn't owned by the calling account\./,
    );
  });

  it('CRITICAL 3-row audit-log table pinned — team.member_invited / team.invite_accepted / team.member_removed. Matches W755 /audit-log AccountAuditAction enum.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/`team\.member_invited`\s+\|\s+owner calls POST \/v1\/team\/invites/);
    expect(p).toMatch(
      /`team\.invite_accepted`\s+\|\s+invitee calls POST \/v1\/team\/invites\/accept/,
    );
    expect(p).toMatch(/`team\.member_removed`\s+\|\s+owner calls DELETE \/v1\/team\/members\/:id/);
  });

  it('CRITICAL audit-log-export curl example pinned. Drift would lose the canonical CSV export demo + W755 GDPR Article 20 cross-reference.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /curl -H "Authorization: Bearer \$DRIFTSTACK_API_KEY" \\\s*\n?\s+"https:\/\/api\.driftstack\.dev\/v1\/account\/audit-log\/export\?format=csv"/,
    );
  });

  it("CRITICAL member-as-separate-Data-Subject framing pinned. The 'A member is a separate Data Subject from the owner. Their account email is processed under Privacy §3.1 (Account data) on the same legal basis as any other Customer contact.' wording is the load-bearing GDPR/DPA framing — drift would mismatch the privacy.md surface.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/A member is a separate Data Subject from the owner\. Their account/);
    expect(p).toMatch(
      /email is processed under Privacy §3\.1 \(Account data\) on the same\s*\n?legal basis as any other Customer contact\./,
    );
  });

  it('CRITICAL 5-endpoint canonical action set pinned — GET /v1/team/owners + POST /v1/team/invites + GET /v1/team/invites + POST /v1/team/invites/accept + GET /v1/team/members + DELETE /v1/team/members/:id.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/`GET \/v1\/team\/owners`/);
    expect(p).toMatch(/`POST \/v1\/team\/invites`/);
    expect(p).toMatch(/`GET \/v1\/team\/invites`/);
    expect(p).toMatch(/`POST \/v1\/team\/invites\/accept`/);
    expect(p).toMatch(/`GET \/v1\/team\/members`/);
    expect(p).toMatch(/`DELETE \/v1\/team\/members\/:id`/);
  });

  it('CRITICAL 3-language SDK examples pinned. TypeScript + Python + Go each show invite/listMembers/acceptInvite/removeMember.', () => {
    const p = read(PAGE);

    // TS.
    expect(p).toMatch(/await client\.team\.invite\('alice@example\.com', \{ role: 'admin' \}\)/);
    expect(p).toMatch(/await client\.team\.listMembers\(\)/);
    expect(p).toMatch(/await client\.team\.acceptInvite\(tokenFromEmail\)/);
    expect(p).toMatch(/await client\.team\.removeMember\('mem_…'\)/);

    // Python.
    expect(p).toMatch(/client\.team\.invite\("alice@example\.com", role="admin"\)/);
    expect(p).toMatch(/client\.team\.list_members\(\)/);
    expect(p).toMatch(/client\.team\.accept_invite\(token_from_email\)/);
    expect(p).toMatch(/client\.team\.remove_member\("mem_…"\)/);

    // Go.
    expect(p).toMatch(/driftstack\.TeamRoleAdmin/);
    expect(p).toMatch(/client\.Team\.ListMembers\(ctx\)/);
    expect(p).toMatch(/client\.Team\.AcceptInvite\(ctx, tokenFromEmail\)/);
    expect(p).toMatch(/client\.Team\.RemoveMember\(ctx, "mem_…"\)/);
  });

  it('CRITICAL membership shape — member_email + role + accepted_at fields pinned. Matches W757 dashboard member-row render.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/"member_email": "alice@example\.com"/);
    expect(p).toMatch(/"role": "member"/);
    expect(p).toMatch(/"accepted_at":/);
    expect(p).toMatch(/"invited_by_account_id":/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/docs-pages-api-team-content-parity.test.ts'),
      ),
    ).toBe(true);
  });
});

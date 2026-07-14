// Drift guard for apps/docs/src/pages/api/team.md. Pins the
// customer-facing Team RBAC docs — 2-role split (member RO / admin
// RW) + X-Driftstack-Account scoping pattern + honored endpoints
// + 3-NOT-honored + email-match-on-accept 409 anti-misroute + 7-day
// invite expiry + sha256 token-hashed at rest.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/docs/src/pages/api/team.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('docs/api/team content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it("Team RBAC overview framing pinned: 'Driftstack supports multi-user teams: one owner-account plus zero or more member-accounts joined to it via the /v1/team/* endpoints. Each member uses their own login + their own dashboard sessions. API keys remain account-scoped (shared across the team) and admin-gated.' — pinned so the 1-owner + N-members + per-member-login + account-scoped-API-keys contract all stay documented", () => {
    expect(body).toMatch(
      /Driftstack supports multi-user teams: one owner-account plus zero or\s*\n?\s*more member-accounts joined to it via the `\/v1\/team\/\*` endpoints\./,
    );
    expect(body).toMatch(
      /Each member uses their own login \+ their own dashboard sessions\. API\s*\n?\s*keys remain account-scoped \(shared across the team\) and admin-gated\./,
    );
  });

  it('4-concept framing pinned: Owner-account (pays subscription, shows up as owner_account_id) + Member-account (separate accounts row, own login + email, joined via team_members, cascade-delete) + Invite (double-opt-in record in team_invites, token-hashed at rest sha256, 7-day expiry) + Role (member RO / admin full RW). Drift to dropping the sha256-hash-at-rest or 7-day expiry would weaken the invite-security model', () => {
    expect(body).toMatch(/Owner account\.\*\* The account that pays the subscription\./);
    expect(body).toMatch(/Token-hashed at\s*\n?\s*rest \(sha256\), 7-day expiry\./);
    expect(body).toMatch(/Cascade-delete on\s*\n?\s*either side removes the membership\./);
    expect(body).toMatch(
      /\*\*Role\.\*\* `member` \(read-only on owner resources\) or `admin` \(full\s*\n?\s*read \+ write\)\./,
    );
  });

  it("Role-gating split framing pinned: 'Read endpoints (GET) accept both member and admin roles.' + 'Write endpoints (POST / PATCH / DELETE / api-keys rotate) require admin role on the team. member role gets 403.' — pinned so the GET-both + write-admin-only + 403-on-member-write contract all stay documented", () => {
    expect(body).toMatch(
      /- \*\*Read endpoints\*\* \(GET\) accept both `member` and `admin` roles\./,
    );
    expect(body).toMatch(
      /- \*\*Write endpoints\*\* \(POST \/ PATCH \/ DELETE \/ api-keys rotate\)\s*\n?\s*require `admin` role on the team\. `member` role gets `403`\./,
    );
    expect(body).toMatch(
      /- \*\*Agent-session exception\.\*\* `\/v1\/agent-sessions` contains AI\s*\n?\s*transcripts and live-control state, so its collection and `:id`\s*\n?\s*surface require `admin` for both reads and writes\./,
    );
  });

  it('X-Driftstack-Account-honored endpoint roster pinned: /v1/sessions (full surface) + /v1/profiles (full surface) + /v1/api-keys (full + rotate) + /v1/webhooks (full + deliveries + replay) + /v1/account/audit-log + /export + /v1/account/email-preferences (GET/PUT admin-only) + /v1/usage + /usage/series. Drift to dropping any honored endpoint would break team-owner-scoping consistency across the customer surface', () => {
    expect(body).toMatch(/- `\/v1\/sessions` \(GET \/ POST \/ DELETE\)/);
    expect(body).toMatch(/- `\/v1\/profiles` \(GET \/ POST \/ PATCH \/ DELETE\)/);
    expect(body).toMatch(/- `\/v1\/api-keys` \(GET \/ POST \/ DELETE \/ `:id\/rotate`\)/);
    expect(body).toMatch(/- `\/v1\/webhooks` \(GET \/ POST \/ DELETE\)/);
    expect(body).toMatch(/- `\/v1\/account\/audit-log` \(GET\) \+ `\/audit-log\/export` \(GET\)/);
    expect(body).toMatch(/- `\/v1\/account\/email-preferences` \(GET \/ PUT — PUT admin-only\)/);
    expect(body).toMatch(/- `\/v1\/usage` \+ `\/v1\/usage\/series` \(GET\)/);
    // Agent-session collection/create/:id all honor the header for admins while
    // preserving the narrower transcript/live-control role boundary.
    expect(body).toMatch(
      /- `\/v1\/agent-sessions` \(GET collection \/ POST create \/ `:id`\s*\n?\s*reads and controls\) — an \*\*admin\*\* member can list and operate/,
    );
    expect(body).toMatch(/`member` role gets `403` on this whole surface/);
    expect(body).toMatch(/ships\s+the owner's per-profile\s+DEK/);
  });

  it("3-NOT-honored endpoint roster pinned: /v1/team/* (managing own team) + /v1/account/me (always own profile) + /v1/auth/* (per-caller authentication). + 'Endpoints that do not honor the header (operate on the caller's own account regardless)' framing — pinned so the 3-NOT-honored exception list + caller's-own-account semantics contract all stay documented", () => {
    expect(body).toMatch(
      /Endpoints that \*\*do not\*\* honor the header \(operate on the caller's\s*\n?\s*own account regardless\):/,
    );
    expect(body).toMatch(/- `\/v1\/team\/\*` — managing your own team \(members \+ invites\)\./);
    expect(body).toMatch(/- `\/v1\/account\/me` — always your own profile/);
    expect(body).toMatch(/- `\/v1\/auth\/\*` — authentication is per-caller\./);
  });

  it("Email-match-on-accept 409 anti-misroute framing pinned: 'The accepting account's email MUST match the invitee email — server returns 409 Conflict otherwise. This prevents accidentally accepting an invite addressed to someone else even if they share the URL.' — pinned so the email-equality-required + 409-on-mismatch + share-URL-attack-vector-rationale contract all stay documented (drift to dropping this would let any signed-in user accept invites addressed to other emails)", () => {
    expect(body).toMatch(
      /The accepting account's email MUST match the invitee email — server\s*\n?\s*returns 409 Conflict otherwise\. This prevents accidentally accepting\s*\n?\s*an invite addressed to someone else even if they share the URL\./,
    );
  });

  it('Team audit-log 3-action roster pinned: team.member_invited + team.invite_accepted + team.member_removed. + curl-export-CSV example for team-history.csv download. Drift to dropping any audit action would create a gap in the team-mutation paper trail for compliance / debug', () => {
    expect(body).toMatch(/\|\s*`team\.member_invited`\s*\|\s*owner calls POST \/v1\/team\/invites/);
    expect(body).toMatch(
      /\|\s*`team\.invite_accepted`\s*\|\s*invitee calls POST \/v1\/team\/invites\/accept/,
    );
    expect(body).toMatch(
      /\|\s*`team\.member_removed`\s*\|\s*owner calls DELETE \/v1\/team\/members\/:id/,
    );
    expect(body).toMatch(/> team-history\.csv/);
  });

  it("Privacy/DPA Data Subject framing pinned: 'A member is a separate Data Subject from the owner. Their account email is processed under Privacy §3.1 (Account data) on the same legal basis as any other Customer contact.' — pinned so the GDPR Data Subject separation + Privacy §3.1 cross-reference contract stays documented", () => {
    expect(body).toMatch(
      /A member is a separate Data Subject from the owner\. Their account\s*\n?\s*email is processed under Privacy §3\.1 \(Account data\) on the same\s*\n?\s*legal basis as any other Customer contact\./,
    );
  });

  it('/v1/team/owners + GET /v1/account/me/teams[] embedding framing pinned: \'GET /v1/team/owners — returns { data: TeamOwner[] } where each entry has owner_account_id, role, and membership_id. Useful for populating an "act as" picker in custom dashboards. The same data is also embedded in GET /v1/account/me under teams[].\' — pinned so the inverse-view + account-me-embed + act-as-picker UX contract all stay documented', () => {
    expect(body).toMatch(
      /`GET \/v1\/team\/owners` — returns `\{ data: TeamOwner\[\] \}` where each\s*\n?\s*entry has `owner_account_id`, `owner_email` \(falls back to\s*\n?\s*`acc_<id>` when unknown\), `owner_name` \(nullable\), `role`, and\s*\n?\s*`membership_id`\./,
    );
    expect(body).toMatch(
      /The same data is also embedded in `GET \/v1\/account\/me`\s*\n?\s*under `teams\[\]`\./,
    );
  });
});

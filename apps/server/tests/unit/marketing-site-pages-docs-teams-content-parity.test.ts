// W519.A — drift guard for apps/marketing-site/src/pages/docs/teams.astro.
// V-693 + W219.A teams accuracy pass. Drift here either softens the
// member-vs-admin role boundary (would create marketing↔team-RBAC
// divergence) or breaks the X-Driftstack-Account effective-account
// header commitment (would mislead clients on team scoping).
//
//   • V-693 doc-comment framing + W219.A accuracy-pass anchor
//     (pinned against apps/server/src/routes/team.ts).
//   • V-326c + V-330b/d/e/f effective-account model.
//   • Owner / Member / Admin 3-role vocabulary.
//   • Invite flow 3-step: POST /v1/team/invites + GET /v1/team/invites +
//     POST /v1/team/invites/accept (plaintext token, no :id/accept).
//   • Membership-id mem_ vs account-id acc_ on DELETE route.
//   • GET /v1/team/members (my team) vs GET /v1/team/owners (teams I'm on).
//   • X-Driftstack-Account routes to owner's resources.
//   • Read allowed for member + admin; write requires admin (403 on member).
//   • 3-admin-cannot list: tier-change + team-management + other-members-API-keys.
//   • team.* actions in audit log.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/teams.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W519.A apps/marketing-site/src/pages/docs/teams.astro content parity', () => {
  const body = read(LIB);

  it("V-693 + W219.A 5-V-anchor framing pinned: 'teams developer docs. Walks through the team RBAC surface (invite → accept → member/admin roles) and the V-326c / V-330b/d/e/f effective-account model that lets team members act on the owner account's resources via X-Driftstack-Account.' + W219.A accuracy-pass pinned against apps/server/src/routes/team.ts — pinned so the V-693 + V-326c + V-330b/d/e/f effective-account-model anchors + W219.A team.ts-source-of-truth commitment all survive", () => {
    expect(body).toMatch(
      /\/\/ V-693 — teams developer docs\. Walks through the team RBAC\s*\/\/ surface \(invite → accept → member\/admin roles\) and the V-326c \/\s*\/\/ V-330b\/d\/e\/f effective-account model that lets team members act\s*\/\/ on the owner account's resources via X-Driftstack-Account\./,
    );
    expect(body).toMatch(
      /\/\/ W219\.A — accuracy pass: every endpoint pinned against\s*\/\/ apps\/server\/src\/routes\/team\.ts\./,
    );
  });

  it("3-role vocabulary pinned: Owner account (pays the bill, sessions/profiles/webhooks/billing live here) + Member (read access via X-Driftstack-Account) + Admin (member + write access on owner's resources) — pinned so the 3-role + bill-lives-on-owner + member-read-only + admin-write commitment survives", () => {
    expect(body).toMatch(
      /<strong>Owner account<\/strong> — the account that pays the\s*bill\. Sessions, profiles, webhooks, and billing all live on\s*the owner account\./,
    );
    expect(body).toMatch(
      /<strong>Member<\/strong> — a user invited to the owner\s*account with read access to its resources via\s*<code>X-Driftstack-Account<\/code>\./,
    );
    expect(body).toMatch(
      /<strong>Admin<\/strong> — a member who additionally has\s*write access \(create \+ modify sessions, profiles, webhooks\)\s*on the owner account\./,
    );
  });

  it("Invite-flow 3-step framing pinned: POST /v1/team/invites with {email, role: admin} → 202 Accepted + 'Invite sent. The invitee can accept via the email link.' + GET /v1/team/invites list response with 7-field invite (id inv_ + owner_account_id + invitee_email + role + expires_at + invited_by_account_id + accepted_at null + created_at) + POST /v1/team/invites/accept with plaintext token → 200 OK with 8-field membership envelope (id mem_ + owner_account_id + member_account_id + member_email + role + invited_at + accepted_at + invited_by_account_id) + 'Acceptance posts the plaintext token from the email — there is no /v1/team/invites/<id>/accept endpoint. The invite row itself can't be revoked via the API today; the invite simply expires.' — pinned so the 3-step invite + 7-field invite shape + 8-field membership envelope + no-:id/accept + can't-revoke-via-API + expires-naturally commitments survive", () => {
    expect(body).toMatch(/POST \/v1\/team\/invites/);
    expect(body).toMatch(/\{ "email": "dev@example\.com", "role": "admin" \}/);
    expect(body).toMatch(/→ 202 Accepted/);
    expect(body).toMatch(/"message": "Invite sent\. The invitee can accept via the email link\."/);
    expect(body).toMatch(/"id": "inv_…"/);
    expect(body).toMatch(/"invitee_email": "dev@example\.com"/);
    expect(body).toMatch(/"accepted_at": null/);
    expect(body).toMatch(/POST \/v1\/team\/invites\/accept/);
    expect(body).toMatch(/"token": "<plaintext token from the email link>"/);
    expect(body).toMatch(/"id": "mem_…"/);
    expect(body).toMatch(/"member_account_id": "acc_invitee_…"/);
    expect(body).toMatch(
      /Acceptance posts the <em>plaintext token<\/em> from the email —\s*there is no <code>\/v1\/team\/invites\/&lt;id&gt;\/accept<\/code>\s*endpoint\. The invite row itself can't be revoked via the API\s*today; the invite simply expires\./,
    );
  });

  it("List/remove members + DELETE mem_ (not acc_) framing pinned: GET /v1/team/members with 8-field membership row + DELETE /v1/team/members/mem_… → 204 + 'The DELETE route takes the mem_ membership id, not an acc_ account id. Transferring ownership of an account is a support-ticket operation today.' — pinned so the GET + DELETE-on-mem_-not-acc_ + ownership-transfer-is-support-ticket commitment survives (drift to accepting acc_ on DELETE would create marketing↔route-id divergence)", () => {
    expect(body).toMatch(/GET \/v1\/team\/members/);
    expect(body).toMatch(/DELETE \/v1\/team\/members\/mem_…/);
    expect(body).toMatch(/→ 204 No Content/);
    expect(body).toMatch(
      /The DELETE route takes the <code>mem_<\/code> membership id, not\s*an <code>acc_<\/code> account id\. Transferring ownership of an\s*account is a support-ticket operation today\./,
    );
  });

  it("GET /v1/team/owners (teams I'm on) framing pinned: 3-field response (owner_account_id + role + membership_id) + 'The mirror of /v1/team/members — the latter lists members of my team, this one lists teams I am on. Use the returned owner_account_id with the X-Driftstack-Account header on subsequent requests to act on that team's resources.' — pinned so the GET /v1/team/owners + 3-field-shape + mirror-of-/v1/team/members commitment survives", () => {
    expect(body).toMatch(/GET \/v1\/team\/owners/);
    expect(body).toMatch(/"owner_account_id": "acc_owner_…"/);
    expect(body).toMatch(/"role": "admin"/);
    expect(body).toMatch(/"membership_id": "mem_…"/);
    expect(body).toMatch(
      /The mirror of <code>\/v1\/team\/members<\/code> — the latter\s*lists members of <em>my<\/em> team, this one lists teams\s*<em>I am on<\/em>\./,
    );
  });

  it("X-Driftstack-Account framing + role-enforcement pinned: 'Team members read + write the owner's resources by passing the owner's account id in the X-Driftstack-Account request header. The server validates the caller has a valid membership on that owner before routing the request.' + sample GET /v1/sessions + 'Role enforcement: reads are allowed for both member and admin. Writes (e.g. POST /v1/sessions, POST /v1/webhooks, POST /v1/webhooks/<id>/rotate-secret) require admin; members get 403.' — pinned so the X-Driftstack-Account + valid-membership-pre-route + read-both-roles + write-admin-only + 403-on-member-write commitment survives", () => {
    expect(body).toMatch(
      /Team members read \+ write the owner's resources by passing the\s*owner's account id in the <code>X-Driftstack-Account<\/code>\s*request header\. The server validates the caller has a valid\s*membership on that owner before routing the request\./,
    );
    expect(body).toMatch(/X-Driftstack-Account: acc_owner_…/);
    expect(body).toMatch(
      /Role enforcement: <strong>reads<\/strong> are allowed for both\s*<code>member<\/code> and <code>admin<\/code>\. <strong>Writes<\/strong>\s*\(e\.g\. <code>POST \/v1\/sessions<\/code>,\s*<code>POST \/v1\/webhooks<\/code>,\s*<code>POST \/v1\/webhooks\/&lt;id&gt;\/rotate-secret<\/code>\) require\s*<code>admin<\/code>; members get <code>403<\/code>\./,
    );
  });

  it("3-admins-cannot framing pinned: tier-change-or-checkout-is-owner-only + manage-the-team-itself (invite/remove/accept-on-behalf-of-someone-else) + see-or-modify-other-members-API-keys (each member's keys are private to their account) — pinned so the 3-admin-cannot ceiling commitment + owner-only-billing + admin-cannot-manage-team + per-member-key-privacy commitments survive (drift to letting admin invite/remove would erode the owner-only team-management commitment)", () => {
    expect(body).toMatch(
      /<li>Change the owner's <strong>tier<\/strong> or initiate\s*checkout — those are owner-only operations\.<\/li>/,
    );
    expect(body).toMatch(
      /<li>Manage the team itself — invite, remove members, accept on\s*behalf of someone else\.<\/li>/,
    );
    expect(body).toMatch(
      /<li>See or modify other members' API keys; each member's keys\s*are private to their account\.<\/li>/,
    );
  });

  it("Audit-trail framing pinned: 'Team mutations (invite sent, invite accepted, member removed) write entries on the owner's audit log. The action filter is exact-match (one action per request, no wildcards), e.g. GET /v1/account/audit-log?action=team.member_invited (also team.invite_accepted / team.member_removed) — see /docs/audit-log.' — pinned so the 3-team-mutation + on-owner-audit-log + exact-match-action-filter (no wildcards) + 3 concrete team.* action names + /docs/audit-log cross-ref survives. The filter was corrected: ?action= is exact-match, NOT a team.* wildcard, matching the audit-log action-filter semantics.", () => {
    expect(body).toMatch(
      /Team mutations \(invite sent, invite accepted, member removed\)\s*write entries on the owner's audit log\. The <code>action<\/code>\s*filter is exact-match \(one action per request, no wildcards\),\s*e\.g\. <code>GET \/v1\/account\/audit-log\?action=team\.member_invited<\/code>\s*\(also <code>team\.invite_accepted<\/code> \/\s*<code>team\.member_removed<\/code>\) — see\s*<a href="\/docs\/audit-log\/">\/docs\/audit-log<\/a>\./,
    );
    // Anti-drift: the action filter is exact-match, not a wildcard; the old
    // ?action=team.* glob framing must NOT return (no wildcard support).
    expect(body).not.toMatch(/audit-log\?action=team\.\*/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});

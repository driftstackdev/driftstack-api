// W427.B (W660-deepened) — drift guard for packages/sdk-typescript/
// src/resources/team.ts. V-298c/V-309e Team RBAC TS parity.
//
// W660 splits the original 11 it() blocks into 17 focused per-concept
// blocks + pins previously-implicit invariants:
//
//   • Acting-as contract — team membership IS honored on the auth
//     path via `X-Driftstack-Account: acc_<owner-uuid>`, authorized
//     against the caller's membership role and the route's scope.
//     Drift to dropping
//     this caveat would let callers assume implicit permissions
//     that don't yet exist — silently broken authorization.
//   • TeamRole 2-value union ('member' | 'admin') pinned. Drift
//     to a 3rd value (e.g. 'owner', 'guest') without coordinated
//     server+client update would break the closed-set switch.
//   • Email-match-409 enforcement pinned per-line on acceptInvite:
//     "The accepting account's email MUST match the invitee email
//     — server enforces; mismatched accept returns 409." Drift to
//     dropping the 409 framing would lose the cross-account-leak
//     guard documented to customers.
//   • account_owner scope pinned on both invite AND removeMember.
//     Drift to allowing 'admin' role to invite/remove would
//     widen the role surface.
//   • encodeURIComponent on :membershipId in removeMember —
//     drift to dropping would let "abc/../../admin" traverse.
//   • Conditional role spread on invite — `options.role !== undefined
//     ? { role: options.role } : {}` defers to server-side default
//     when role unset. Drift to ?? 'member' would client-side-
//     default instead of deferring.
//   • SDK-defined-NOT-api-types-imported invariant on team shapes.
//   • TeamMember 8-field vs TeamInvite 8-field shape parity — both
//     carry the role + owner_account_id + invited_by_account_id
//     thread + similar 8-field shape with subtle nullability
//     differences pinned.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/team.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W427.B packages/sdk-typescript/src/resources/team.ts content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path + module header + all six team endpoints scope', () => {
    expect(existsSync(LIB)).toBe(true);
    expect(body).toMatch(/\/\/ V-298c \/ V-309e — Team RBAC resource\./);
    // V-1611 #14 added the two `/v1/teams` team-record endpoints beside the six
    // membership ones, so this sentence now names both families.
    expect(body).toMatch(
      /\/\/ All six \/v1\/team\/\* endpoints, plus the two \/v1\/teams team-record endpoints\./,
    );
  });

  it("CRITICAL acting-as contract pinned per-line. The old text claimed membership granted NO implicit permissions until a future release; `resolveEffectiveAccount` in apps/server/src/services/auth.ts proves otherwise — it resolves `X-Driftstack-Account: acc_<uuid>` against `ctx.teams` and carries the membership role through, so members DO act on the owner's resources today. Pinning the stale caveat would keep a false limitation on a shipped SDK surface.", () => {
    expect(body).toMatch(
      /\/\/ All six \/v1\/team\/\* endpoints, plus the two \/v1\/teams team-record endpoints\. Team membership IS honored on the auth\s*\/\/ path: send `X-Driftstack-Account: acc_<owner-uuid>` to act on the\s*\/\/ resources of an owner you are a member of\./,
    );
    // The superseded claim must never come back to a shipped SDK surface.
    expect(body).not.toMatch(/grants no implicit permissions/);
  });

  it('Imports — HttpClient only (no @driftstack/api-types import). Team shapes are SDK-DEFINED locally, not re-exported from api-types. Drift to importing from api-types would force Zod schema parity for both SDK and dashboard — but the dashboard uses a different subset.', () => {
    expect(body).toMatch(/import type \{ HttpClient \} from '\.\.\/http\.js';/);
    expect(body).not.toMatch(/from '@driftstack\/api-types'/);
  });

  it("CRITICAL TeamRole 2-value union pinned: `'member' | 'admin'`. Drift to a 3rd value (e.g. 'owner', 'guest', 'viewer') WITHOUT coordinated server+client update would break the closed-set switch in dashboards rendering role badges. The owner account itself is NOT a TeamRole — owners aren't TeamMembers, they OWN the team; drift to adding 'owner' would conflate the two concepts.", () => {
    expect(body).toMatch(/export type TeamRole = 'member' \| 'admin';/);
  });

  it('TeamMember — 8-field shape (id + owner_account_id + member_account_id + member_email + role + invited_at + accepted_at + invited_by_account_id). CRITICAL: accepted_at is REQUIRED (NOT nullable) on TeamMember — a TeamMember row only exists AFTER acceptance, so accepted_at is always populated. Drift to making it nullable would confuse callers who use member.accepted_at unconditionally. invited_by_account_id IS nullable (null for legacy invites or system-issued).', () => {
    expect(body).toMatch(
      /export interface TeamMember \{\s*id: string;\s*owner_account_id: string;\s*member_account_id: string;\s*member_email: string;\s*role: TeamRole;\s*invited_at: string;\s*accepted_at: string;\s*invited_by_account_id: string \| null;\s*\}/,
    );
  });

  it('TeamInvite — 8-field shape (id + owner_account_id + invitee_email + role + expires_at + invited_by_account_id + accepted_at + created_at). CRITICAL: accepted_at is NULLABLE on TeamInvite (null while pending; ISO string after acceptance — though the invite typically becomes a TeamMember row at that point). expires_at is REQUIRED — every invite has a finite TTL to prevent stale invite links from being usable months later. invitee_email is RAW (not normalized) — drift to normalizing would silently change the email-match comparison in acceptInvite.', () => {
    expect(body).toMatch(
      /export interface TeamInvite \{\s*id: string;\s*owner_account_id: string;\s*invitee_email: string;\s*role: TeamRole;\s*expires_at: string;\s*invited_by_account_id: string \| null;\s*accepted_at: string \| null;\s*created_at: string;\s*\}/,
    );
  });

  it('TeamOwner — five-field inverse workspace shape with nullable owner_name', () => {
    expect(body).toMatch(
      /export interface TeamOwner \{\s*owner_account_id: string;\s*owner_email: string;\s*owner_name: string \| null;\s*role: TeamRole;\s*membership_id: string;\s*\}/,
    );
  });

  it('TeamMembersList + TeamInvitesList + TeamOwnersList envelopes are unpaginated typed arrays', () => {
    expect(body).toMatch(/export interface TeamMembersList \{\s*data: TeamMember\[\];\s*\}/);
    expect(body).toMatch(/export interface TeamInvitesList \{\s*data: TeamInvite\[\];\s*\}/);
    expect(body).toMatch(/export interface TeamOwnersList \{\s*data: TeamOwner\[\];\s*\}/);
  });

  it('AcceptInviteResponse — single-field {membership: TeamMember}. The envelope wraps the membership so future fields (e.g. team_settings, welcome_message) can be added without breaking the response shape. Drift to flattening to bare TeamMember would prevent forward-compat extension.', () => {
    expect(body).toMatch(/export interface AcceptInviteResponse \{\s*membership: TeamMember;\s*\}/);
  });

  it("InviteOptions — single optional role field (defaults to server-side default when omitted). Drift to making role required would break the \"just invite someone\" call site where caller doesn't care about role (defaults to 'member' server-side).", () => {
    expect(body).toMatch(/export interface InviteOptions \{\s*role\?: TeamRole;\s*\}/);
  });

  it('TeamResource class declaration + private-readonly http constructor field. Stateless wrapper pattern.', () => {
    expect(body).toMatch(/^export class TeamResource \{$/m);
    expect(body).toMatch(/constructor\(private readonly http: HttpClient\) \{\}/);
  });

  it("invite verb — POST /v1/team/invites with email + conditional role spread. CRITICAL: \"account_owner scope required\" — drift to allowing 'admin' role to invite would let admins escalate the team without owner consent. Conditional role spread `options.role !== undefined ? { role: options.role } : {}` defers to server-side default; drift to `?? 'member'` would client-side-default instead of deferring. Returns `{ message: string }` (a confirmation, NOT the invite row — the invite is sent async via email).", () => {
    expect(body).toMatch(
      /\/\*\* Invite an email to the calling owner's team\. account_owner scope required\. \*\//,
    );
    expect(body).toMatch(
      /invite\(email: string, options: InviteOptions = \{\}\): Promise<\{ message: string \}> \{\s*return this\.http\.request<\{ message: string \}>\(\{\s*method: 'POST',\s*path: '\/v1\/team\/invites',\s*body: \{ email, \.\.\.\(options\.role !== undefined \? \{ role: options\.role \} : \{\}\) \},\s*\}\);\s*\}/,
    );
  });

  it('listMembers verb — GET /v1/team/members → Promise<TeamMembersList>. "List confirmed team members" framing — drift to including PENDING invites would conflate the two lists. The split between listMembers (accepted) and listInvites (pending) is the load-bearing claim.', () => {
    expect(body).toMatch(/\/\*\* List confirmed team members for the calling owner\. \*\//);
    expect(body).toMatch(
      /listMembers\(\): Promise<TeamMembersList> \{\s*return this\.http\.request<TeamMembersList>\(\{\s*method: 'GET',\s*path: '\/v1\/team\/members',\s*\}\);\s*\}/,
    );
  });

  it('listInvites verb — GET /v1/team/invites → Promise<TeamInvitesList>. CRITICAL: "List pending (unaccepted, unexpired) invites" — server-side filters BOTH accepted AND expired invites out. Drift to including expired invites would let dashboards render stale links the customer can\'t use.', () => {
    expect(body).toMatch(
      /\/\*\* List pending \(unaccepted, unexpired\) invites for the calling owner\. \*\//,
    );
    expect(body).toMatch(
      /listInvites\(\): Promise<TeamInvitesList> \{\s*return this\.http\.request<TeamInvitesList>\(\{\s*method: 'GET',\s*path: '\/v1\/team\/invites',\s*\}\);\s*\}/,
    );
  });

  it('listOwners verb — GET /v1/team/owners → Promise<TeamOwnersList>', () => {
    expect(body).toMatch(/\/\*\* List owner workspaces the calling account has joined\. \*\//);
    expect(body).toMatch(
      /listOwners\(\): Promise<TeamOwnersList> \{\s*return this\.http\.request<TeamOwnersList>\(\{\s*method: 'GET',\s*path: '\/v1\/team\/owners',\s*\}\);\s*\}/,
    );
  });

  it('acceptInvite verb — POST /v1/team/invites/accept with `body: { token }`. CRITICAL email-match-409 enforcement pinned per-line: "The accepting account\'s email MUST match the invitee email — server enforces; mismatched accept returns 409." Drift to dropping the 409 framing would lose the cross-account-leak guard. Without the email-match enforcement, anyone with a token (e.g. via shoulder-surf) could accept an invite into ANOTHER user\'s account.', () => {
    expect(body).toMatch(
      /\*\s*Accept a pending invite\. The accepting account's email MUST match\s*\*\s*the invitee email — server enforces; mismatched accept returns 409\./,
    );
    expect(body).toMatch(
      /acceptInvite\(token: string\): Promise<AcceptInviteResponse> \{\s*return this\.http\.request<AcceptInviteResponse>\(\{\s*method: 'POST',\s*path: '\/v1\/team\/invites\/accept',\s*body: \{ token \},\s*\}\);\s*\}/,
    );
  });

  it('removeMember verb — DELETE /v1/team/members/${encodeURIComponent(membershipId)}. "account_owner scope required" — drift to allowing \'admin\' role to remove would let admins remove the owner OR other admins (escalation risk). encodeURIComponent wrapping prevents "abc/../../admin" path traversal. Returns Promise<void> (no body needed — the membership row is gone).', () => {
    expect(body).toMatch(
      /\/\*\* Remove a member by membership id\. account_owner scope required\. \*\//,
    );
    expect(body).toMatch(
      /removeMember\(membershipId: string\): Promise<void> \{\s*return this\.http\.request<void>\(\{\s*method: 'DELETE',\s*path: `\/v1\/team\/members\/\$\{encodeURIComponent\(membershipId\)\}`,\s*\}\);\s*\}/,
    );
  });

  it('8-verb inventory + verb-mix invariants — 2 POSTs + 4 GETs + 1 DELETE + 1 PATCH, and still no role-update mutation', () => {
    const methods = body.match(/^ {2}(?!constructor)[a-zA-Z]+\(/gm) ?? [];
    // 8: the six membership verbs + listTeams + renameTeam.
    expect(methods.length, 'expected 8 verb declarations').toBe(8);
    const posts = (body.match(/method: 'POST'/g) ?? []).length;
    expect(posts, 'expected 2 POSTs (invite + acceptInvite)').toBe(2);
    const gets = (body.match(/method: 'GET'/g) ?? []).length;
    expect(gets, 'expected 4 GETs (members + invites + owners + teams)').toBe(4);
    const deletes = (body.match(/method: 'DELETE'/g) ?? []).length;
    expect(deletes, 'expected 1 DELETE (removeMember)').toBe(1);
    // ⛔ This used to be a blanket `not.toMatch(/method: 'PATCH'/)`, and V-1611 #14
    // made that false by adding `renameTeam`. Deleting it would have thrown away
    // the claim it was actually protecting, which is not "there are no PATCHes"
    // but "membership ROLE is not mutable through this resource" — the endpoint
    // the original sketch promised and that was deliberately never built.
    //
    // So the negative is kept and made specific: exactly one PATCH, and no PATCH
    // pointed at a role.
    const patches = (body.match(/method: 'PATCH'/g) ?? []).length;
    expect(patches, 'expected 1 PATCH (renameTeam)').toBe(1);
    expect(body, 'a role-update mutation has appeared on the team resource').not.toMatch(
      /\/role\b/,
    );
    expect(body).not.toMatch(/method: 'PUT'/);
  });

  it('account_owner scope appears in EXACTLY 2 JSDoc blocks (invite + removeMember). Drift to adding to listMembers/listInvites would silently lock down the read endpoints — they should remain readable by team admins for inventory purposes.', () => {
    const ownerScopeMatches = body.match(/account_owner scope required/g) ?? [];
    expect(
      ownerScopeMatches.length,
      'expected 3 account_owner scope mentions (invite + removeMember + renameTeam)',
    ).toBe(3);
  });
});

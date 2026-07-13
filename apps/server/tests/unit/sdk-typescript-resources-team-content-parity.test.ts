// W427.B (W660-deepened) — drift guard for packages/sdk-typescript/
// src/resources/team.ts. V-298c/V-309e Team RBAC TS parity.
//
// W660 splits the original 11 it() blocks into 17 focused per-concept
// blocks + pins previously-implicit invariants:
//
//   • V-298d-pending caveat — "The auth path itself does NOT yet
//     honor team membership (V-298d); accepted members can sign in
//     but the membership grants no implicit permissions on the
//     owner's resources until V-298d ships." Drift to dropping
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
    expect(body).toMatch(/\/\/ All six \/v1\/team\/\* endpoints\./);
  });

  it('CRITICAL V-298d-pending caveat pinned per-line: "The auth path itself does NOT yet honor team membership (V-298d); accepted members can sign in but the membership grants no implicit permissions on the owner\'s resources until V-298d ships." Drift to dropping this caveat would let callers assume implicit permissions that don\'t yet exist — silently broken authorization across the whole product.', () => {
    expect(body).toMatch(
      /\/\/ All six \/v1\/team\/\* endpoints\. The auth path itself does NOT yet\s*\n?\s*\/\/ honor team membership \(V-298d\); accepted members can sign in but\s*\n?\s*\/\/ the membership grants no implicit permissions on the owner's\s*\n?\s*\/\/ resources until V-298d ships\./,
    );
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
      /export interface TeamMember \{\s*\n?\s*id: string;\s*\n?\s*owner_account_id: string;\s*\n?\s*member_account_id: string;\s*\n?\s*member_email: string;\s*\n?\s*role: TeamRole;\s*\n?\s*invited_at: string;\s*\n?\s*accepted_at: string;\s*\n?\s*invited_by_account_id: string \| null;\s*\n?\s*\}/,
    );
  });

  it('TeamInvite — 8-field shape (id + owner_account_id + invitee_email + role + expires_at + invited_by_account_id + accepted_at + created_at). CRITICAL: accepted_at is NULLABLE on TeamInvite (null while pending; ISO string after acceptance — though the invite typically becomes a TeamMember row at that point). expires_at is REQUIRED — every invite has a finite TTL to prevent stale invite links from being usable months later. invitee_email is RAW (not normalized) — drift to normalizing would silently change the email-match comparison in acceptInvite.', () => {
    expect(body).toMatch(
      /export interface TeamInvite \{\s*\n?\s*id: string;\s*\n?\s*owner_account_id: string;\s*\n?\s*invitee_email: string;\s*\n?\s*role: TeamRole;\s*\n?\s*expires_at: string;\s*\n?\s*invited_by_account_id: string \| null;\s*\n?\s*accepted_at: string \| null;\s*\n?\s*created_at: string;\s*\n?\s*\}/,
    );
  });

  it('TeamOwner — five-field inverse workspace shape with nullable owner_name', () => {
    expect(body).toMatch(
      /export interface TeamOwner \{\s*\n?\s*owner_account_id: string;\s*\n?\s*owner_email: string;\s*\n?\s*owner_name: string \| null;\s*\n?\s*role: TeamRole;\s*\n?\s*membership_id: string;\s*\n?\s*\}/,
    );
  });

  it('TeamMembersList + TeamInvitesList + TeamOwnersList envelopes are unpaginated typed arrays', () => {
    expect(body).toMatch(
      /export interface TeamMembersList \{\s*\n?\s*data: TeamMember\[\];\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /export interface TeamInvitesList \{\s*\n?\s*data: TeamInvite\[\];\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /export interface TeamOwnersList \{\s*\n?\s*data: TeamOwner\[\];\s*\n?\s*\}/,
    );
  });

  it('AcceptInviteResponse — single-field {membership: TeamMember}. The envelope wraps the membership so future fields (e.g. team_settings, welcome_message) can be added without breaking the response shape. Drift to flattening to bare TeamMember would prevent forward-compat extension.', () => {
    expect(body).toMatch(
      /export interface AcceptInviteResponse \{\s*\n?\s*membership: TeamMember;\s*\n?\s*\}/,
    );
  });

  it("InviteOptions — single optional role field (defaults to server-side default when omitted). Drift to making role required would break the \"just invite someone\" call site where caller doesn't care about role (defaults to 'member' server-side).", () => {
    expect(body).toMatch(/export interface InviteOptions \{\s*\n?\s*role\?: TeamRole;\s*\n?\s*\}/);
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
      /invite\(email: string, options: InviteOptions = \{\}\): Promise<\{ message: string \}> \{\s*\n?\s*return this\.http\.request<\{ message: string \}>\(\{\s*\n?\s*method: 'POST',\s*\n?\s*path: '\/v1\/team\/invites',\s*\n?\s*body: \{ email, \.\.\.\(options\.role !== undefined \? \{ role: options\.role \} : \{\}\) \},\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('listMembers verb — GET /v1/team/members → Promise<TeamMembersList>. "List confirmed team members" framing — drift to including PENDING invites would conflate the two lists. The split between listMembers (accepted) and listInvites (pending) is the load-bearing claim.', () => {
    expect(body).toMatch(/\/\*\* List confirmed team members for the calling owner\. \*\//);
    expect(body).toMatch(
      /listMembers\(\): Promise<TeamMembersList> \{\s*\n?\s*return this\.http\.request<TeamMembersList>\(\{\s*\n?\s*method: 'GET',\s*\n?\s*path: '\/v1\/team\/members',\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('listInvites verb — GET /v1/team/invites → Promise<TeamInvitesList>. CRITICAL: "List pending (unaccepted, unexpired) invites" — server-side filters BOTH accepted AND expired invites out. Drift to including expired invites would let dashboards render stale links the customer can\'t use.', () => {
    expect(body).toMatch(
      /\/\*\* List pending \(unaccepted, unexpired\) invites for the calling owner\. \*\//,
    );
    expect(body).toMatch(
      /listInvites\(\): Promise<TeamInvitesList> \{\s*\n?\s*return this\.http\.request<TeamInvitesList>\(\{\s*\n?\s*method: 'GET',\s*\n?\s*path: '\/v1\/team\/invites',\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('listOwners verb — GET /v1/team/owners → Promise<TeamOwnersList>', () => {
    expect(body).toMatch(/\/\*\* List owner workspaces the calling account has joined\. \*\//);
    expect(body).toMatch(
      /listOwners\(\): Promise<TeamOwnersList> \{\s*\n?\s*return this\.http\.request<TeamOwnersList>\(\{\s*\n?\s*method: 'GET',\s*\n?\s*path: '\/v1\/team\/owners',\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('acceptInvite verb — POST /v1/team/invites/accept with `body: { token }`. CRITICAL email-match-409 enforcement pinned per-line: "The accepting account\'s email MUST match the invitee email — server enforces; mismatched accept returns 409." Drift to dropping the 409 framing would lose the cross-account-leak guard. Without the email-match enforcement, anyone with a token (e.g. via shoulder-surf) could accept an invite into ANOTHER user\'s account.', () => {
    expect(body).toMatch(
      /\*\s*Accept a pending invite\. The accepting account's email MUST match\s*\n?\s*\*\s*the invitee email — server enforces; mismatched accept returns 409\./,
    );
    expect(body).toMatch(
      /acceptInvite\(token: string\): Promise<AcceptInviteResponse> \{\s*\n?\s*return this\.http\.request<AcceptInviteResponse>\(\{\s*\n?\s*method: 'POST',\s*\n?\s*path: '\/v1\/team\/invites\/accept',\s*\n?\s*body: \{ token \},\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('removeMember verb — DELETE /v1/team/members/${encodeURIComponent(membershipId)}. "account_owner scope required" — drift to allowing \'admin\' role to remove would let admins remove the owner OR other admins (escalation risk). encodeURIComponent wrapping prevents "abc/../../admin" path traversal. Returns Promise<void> (no body needed — the membership row is gone).', () => {
    expect(body).toMatch(
      /\/\*\* Remove a member by membership id\. account_owner scope required\. \*\//,
    );
    expect(body).toMatch(
      /removeMember\(membershipId: string\): Promise<void> \{\s*\n?\s*return this\.http\.request<void>\(\{\s*\n?\s*method: 'DELETE',\s*\n?\s*path: `\/v1\/team\/members\/\$\{encodeURIComponent\(membershipId\)\}`,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('6-verb inventory + verb-mix invariants — 2 POSTs + 3 GETs + 1 DELETE and no role-update mutation', () => {
    const methods = body.match(/^ {2}(?!constructor)[a-zA-Z]+\(/gm) ?? [];
    expect(methods.length, 'expected 6 verb declarations').toBe(6);
    const posts = (body.match(/method: 'POST'/g) ?? []).length;
    expect(posts, 'expected 2 POSTs (invite + acceptInvite)').toBe(2);
    const gets = (body.match(/method: 'GET'/g) ?? []).length;
    expect(gets, 'expected 3 GETs (members + invites + owners)').toBe(3);
    const deletes = (body.match(/method: 'DELETE'/g) ?? []).length;
    expect(deletes, 'expected 1 DELETE (removeMember)').toBe(1);
    expect(body).not.toMatch(/method: 'PATCH'/);
    expect(body).not.toMatch(/method: 'PUT'/);
  });

  it('account_owner scope appears in EXACTLY 2 JSDoc blocks (invite + removeMember). Drift to adding to listMembers/listInvites would silently lock down the read endpoints — they should remain readable by team admins for inventory purposes.', () => {
    const ownerScopeMatches = body.match(/account_owner scope required/g) ?? [];
    expect(
      ownerScopeMatches.length,
      'expected 2 account_owner scope mentions (invite + removeMember)',
    ).toBe(2);
  });
});

// W427.B — drift guard for packages/sdk-typescript/src/resources/team.ts.
// V-298c/V-309e Team RBAC resource. Drift here either drops the
// V-298d "auth does not yet honor membership" caveat (caller assumes
// implicit permissions that don't exist) or strips the accept-mismatch
// 409 enforcement.
//
//   • Framing pinned: V-298c/V-309e; auth does NOT yet honor team
//     membership (V-298d pending); accepted members can sign in but
//     no implicit permissions on owner resources.
//   • TeamRole union: 'member' | 'admin'.
//   • Shapes pinned: TeamMember (9 fields) + TeamInvite (8 fields) +
//     TeamMembersList/TeamInvitesList envelopes + AcceptInviteResponse.
//   • InviteOptions.role optional.
//   • 5 verbs: invite + listMembers + listInvites + acceptInvite +
//     removeMember.
//   • invite: account_owner scope; accept enforces email match (409
//     on mismatch); removeMember: account_owner scope.

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

  it('Framing pinned: V-298c/V-309e Team RBAC; auth does NOT yet honor team membership (V-298d); accepted members sign in but no implicit permissions', () => {
    expect(body).toMatch(/\/\/ V-298c \/ V-309e — Team RBAC resource\./);
    expect(body).toMatch(
      /\/\/ All five \/v1\/team\/\* endpoints\. The auth path itself does NOT yet\s*\n?\s*\/\/ honor team membership \(V-298d\); accepted members can sign in but\s*\n?\s*\/\/ the membership grants no implicit permissions on the owner's\s*\n?\s*\/\/ resources until V-298d ships\./,
    );
  });

  it("TeamRole union: 'member' | 'admin'", () => {
    expect(body).toMatch(/export type TeamRole = 'member' \| 'admin';/);
  });

  it('TeamMember shape pinned: id + owner_account_id + member_account_id + member_email + role + invited_at + accepted_at + invited_by_account_id (nullable)', () => {
    expect(body).toMatch(
      /export interface TeamMember \{\s*\n?\s*id: string;\s*\n?\s*owner_account_id: string;\s*\n?\s*member_account_id: string;\s*\n?\s*member_email: string;\s*\n?\s*role: TeamRole;\s*\n?\s*invited_at: string;\s*\n?\s*accepted_at: string;\s*\n?\s*invited_by_account_id: string \| null;\s*\n?\s*\}/,
    );
  });

  it('TeamInvite shape pinned: id + owner_account_id + invitee_email + role + expires_at + invited_by_account_id (nullable) + accepted_at (nullable) + created_at', () => {
    expect(body).toMatch(
      /export interface TeamInvite \{\s*\n?\s*id: string;\s*\n?\s*owner_account_id: string;\s*\n?\s*invitee_email: string;\s*\n?\s*role: TeamRole;\s*\n?\s*expires_at: string;\s*\n?\s*invited_by_account_id: string \| null;\s*\n?\s*accepted_at: string \| null;\s*\n?\s*created_at: string;\s*\n?\s*\}/,
    );
  });

  it('TeamMembersList / TeamInvitesList envelopes (data[]) + AcceptInviteResponse (membership: TeamMember) + InviteOptions.role optional', () => {
    expect(body).toMatch(
      /export interface TeamMembersList \{\s*\n?\s*data: TeamMember\[\];\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /export interface TeamInvitesList \{\s*\n?\s*data: TeamInvite\[\];\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /export interface AcceptInviteResponse \{\s*\n?\s*membership: TeamMember;\s*\n?\s*\}/,
    );
    expect(body).toMatch(/export interface InviteOptions \{\s*\n?\s*role\?: TeamRole;\s*\n?\s*\}/);
  });

  it('invite verb: POST /v1/team/invites; account_owner scope required; conditional role spread; returns { message: string }', () => {
    expect(body).toMatch(
      /\/\*\* Invite an email to the calling owner's team\. account_owner scope required\. \*\//,
    );
    expect(body).toMatch(
      /invite\(email: string, options: InviteOptions = \{\}\): Promise<\{ message: string \}> \{\s*\n?\s*return this\.http\.request<\{ message: string \}>\(\{\s*\n?\s*method: 'POST',\s*\n?\s*path: '\/v1\/team\/invites',\s*\n?\s*body: \{ email, \.\.\.\(options\.role !== undefined \? \{ role: options\.role \} : \{\}\) \},\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('listMembers + listInvites verbs: GET /v1/team/members + GET /v1/team/invites', () => {
    expect(body).toMatch(/\/\*\* List confirmed team members for the calling owner\. \*\//);
    expect(body).toMatch(
      /listMembers\(\): Promise<TeamMembersList> \{\s*\n?\s*return this\.http\.request<TeamMembersList>\(\{\s*\n?\s*method: 'GET',\s*\n?\s*path: '\/v1\/team\/members',\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /\/\*\* List pending \(unaccepted, unexpired\) invites for the calling owner\. \*\//,
    );
    expect(body).toMatch(
      /listInvites\(\): Promise<TeamInvitesList> \{\s*\n?\s*return this\.http\.request<TeamInvitesList>\(\{\s*\n?\s*method: 'GET',\s*\n?\s*path: '\/v1\/team\/invites',\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('acceptInvite verb: POST /v1/team/invites/accept; email-match enforcement (409 on mismatch); body { token }', () => {
    expect(body).toMatch(
      /\*\s*Accept a pending invite\. The accepting account's email MUST match\s*\n?\s*\*\s*the invitee email — server enforces; mismatched accept returns 409\./,
    );
    expect(body).toMatch(
      /acceptInvite\(token: string\): Promise<AcceptInviteResponse> \{\s*\n?\s*return this\.http\.request<AcceptInviteResponse>\(\{\s*\n?\s*method: 'POST',\s*\n?\s*path: '\/v1\/team\/invites\/accept',\s*\n?\s*body: \{ token \},\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('removeMember verb: DELETE /v1/team/members/:membershipId encoded; account_owner scope required', () => {
    expect(body).toMatch(
      /\/\*\* Remove a member by membership id\. account_owner scope required\. \*\//,
    );
    expect(body).toMatch(
      /removeMember\(membershipId: string\): Promise<void> \{\s*\n?\s*return this\.http\.request<void>\(\{\s*\n?\s*method: 'DELETE',\s*\n?\s*path: `\/v1\/team\/members\/\$\{encodeURIComponent\(membershipId\)\}`,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('imports: HttpClient only (team shapes are SDK-defined, not re-exported from api-types)', () => {
    expect(body).toMatch(/import type \{ HttpClient \} from '\.\.\/http\.js';/);
    expect(body).not.toMatch(/from '@driftstack\/api-types'/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});

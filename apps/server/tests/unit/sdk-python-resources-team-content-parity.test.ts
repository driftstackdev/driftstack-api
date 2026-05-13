// W582.B — drift guard for packages/sdk-python/src/resources/team.py.
// V-298c/V-309f TeamResource Python parity + V-298d auth-path gate.
// Drift here either flips TeamRole literal enum or breaks the
// V-298d posture (members can sign in but get NO implicit
// permissions on owner resources).
//
//   • 5 verbs each: invite / list_members / list_invites /
//     accept_invite / remove_member.
//   • TeamRole = Literal["member", "admin"] — narrow enum.
//   • TeamMember + TeamInvite + envelopes + AcceptInviteResponse
//     pydantic models pinned.
//   • V-298d framing: accepted ≠ permissioned.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/resources/team.py');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W582.B packages/sdk-python/src/driftstack/resources/team.py content parity', () => {
  const body = read(LIB);

  it('Module docstring + V-298c/V-309f framing + V-298d auth-path-integration not-yet-permissioning rationale pinned', () => {
    expect(body).toMatch(/^"""V-298c \/ V-309f — Team RBAC resource\.\n/);
    expect(body).toMatch(/All five \/v1\/team\/\* endpoints\. Auth path integration is V-298d —/);
    expect(body).toMatch(/accepted members can sign in but the membership grants no implicit/);
    expect(body).toMatch(/permissions on the owner's resources until V-298d ships\./);
  });

  it('TeamRole Literal["member","admin"] + TeamMember 8-field + TeamInvite 8-field + TeamMembersList/TeamInvitesList envelopes + AcceptInviteResponse pydantic models pinned', () => {
    expect(body).toMatch(/^TeamRole = Literal\["member", "admin"\]$/m);
    expect(body).toMatch(
      /^class TeamMember\(BaseModel\):\s*\n\s*id: str\s*\n\s*owner_account_id: str\s*\n\s*member_account_id: str\s*\n\s*member_email: str\s*\n\s*role: TeamRole\s*\n\s*invited_at: str\s*\n\s*accepted_at: str\s*\n\s*invited_by_account_id: str \| None$/m,
    );
    expect(body).toMatch(
      /^class TeamInvite\(BaseModel\):\s*\n\s*id: str\s*\n\s*owner_account_id: str\s*\n\s*invitee_email: str\s*\n\s*role: TeamRole\s*\n\s*expires_at: str\s*\n\s*invited_by_account_id: str \| None\s*\n\s*accepted_at: str \| None\s*\n\s*created_at: str$/m,
    );
    expect(body).toMatch(/^class TeamMembersList\(BaseModel\):\s*\n\s*data: list\[TeamMember\]$/m);
    expect(body).toMatch(/^class TeamInvitesList\(BaseModel\):\s*\n\s*data: list\[TeamInvite\]$/m);
    expect(body).toMatch(
      /^class AcceptInviteResponse\(BaseModel\):\s*\n\s*membership: TeamMember$/m,
    );
  });

  it('Sync TeamResource: invite POST optional role kwarg + list_members/list_invites GET model_validate envelopes + accept_invite POST token + remove_member DELETE quote()-escaped membership_id', () => {
    expect(body).toMatch(/^class TeamResource:$/m);
    expect(body).toMatch(
      /def invite\(self, email: str, \*, role: TeamRole \| None = None\) -> dict\[str, Any\]:\s*\n\s*body: dict\[str, Any\] = \{"email": email\}\s*\n\s*if role is not None:\s*\n\s*body\["role"\] = role\s*\n\s*data = self\._http\.request\("POST", "\/v1\/team\/invites", json_body=body\)\s*\n\s*return data {2}# \{"message": \.\.\.\}/,
    );
    expect(body).toMatch(
      /def list_members\(self\) -> TeamMembersList:\s*\n\s*data = self\._http\.request\("GET", "\/v1\/team\/members"\)\s*\n\s*return TeamMembersList\.model_validate\(data\)/,
    );
    expect(body).toMatch(
      /def list_invites\(self\) -> TeamInvitesList:\s*\n\s*data = self\._http\.request\("GET", "\/v1\/team\/invites"\)\s*\n\s*return TeamInvitesList\.model_validate\(data\)/,
    );
    expect(body).toMatch(
      /def accept_invite\(self, token: str\) -> AcceptInviteResponse:\s*\n\s*data = self\._http\.request\("POST", "\/v1\/team\/invites\/accept", json_body=\{"token": token\}\)\s*\n\s*return AcceptInviteResponse\.model_validate\(data\)/,
    );
    expect(body).toMatch(
      /def remove_member\(self, membership_id: str\) -> None:\s*\n\s*self\._http\.request\("DELETE", f"\/v1\/team\/members\/\{quote\(membership_id, safe=''\)\}"\)/,
    );
  });

  it('Async AsyncTeamResource: mirrored awaited surface with model_validate roundtrips + quote()-escaped membership DELETE', () => {
    expect(body).toMatch(/^class AsyncTeamResource:$/m);
    expect(body).toMatch(
      /async def invite\(self, email: str, \*, role: TeamRole \| None = None\) -> dict\[str, Any\]:/,
    );
    expect(body).toMatch(
      /data = await self\._http\.request\("POST", "\/v1\/team\/invites", json_body=body\)/,
    );
    expect(body).toMatch(
      /async def list_members\(self\) -> TeamMembersList:\s*\n\s*data = await self\._http\.request\("GET", "\/v1\/team\/members"\)\s*\n\s*return TeamMembersList\.model_validate\(data\)/,
    );
    expect(body).toMatch(
      /async def accept_invite\(self, token: str\) -> AcceptInviteResponse:\s*\n\s*data = await self\._http\.request\(\s*\n\s*"POST", "\/v1\/team\/invites\/accept", json_body=\{"token": token\}\s*\n\s*\)\s*\n\s*return AcceptInviteResponse\.model_validate\(data\)/,
    );
    expect(body).toMatch(
      /async def remove_member\(self, membership_id: str\) -> None:\s*\n\s*await self\._http\.request\("DELETE", f"\/v1\/team\/members\/\{quote\(membership_id, safe=''\)\}"\)/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});

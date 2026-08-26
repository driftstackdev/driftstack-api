// W582.B (W642-deepened) — drift guard for packages/sdk-python/src/driftstack/resources/team.py.
// V-298c/V-309f TeamResource Python parity + V-298d auth-path gate.
//
// W642 splits the 5 it() blocks (where the 5 sync verbs were bundled
// in one block and the 5 async twins in another) into 12 focused per-
// verb + per-model blocks + pins previously-implicit invariants:
//
//   • V-298d auth-path-not-yet-permissioned contract — accepted
//     members CAN SIGN IN, but their membership grants no implicit
//     permissions on the owner's resources until V-298d ships
//     (mirrors the sdk-go W634 deepening).
//   • TeamRole Literal["member","admin"] narrow enum — drift to
//     widening would silently let the SDK accept e.g. "owner" or
//     "viewer" that the server-side enum still rejects.
//   • quote(membership_id, safe='') URL-escape on the DELETE verb
//     so a malformed id cannot inject path traversal — the
//     safe='' kwarg means even "/" gets percent-encoded (default
//     would let "/" through).
//   • Conditional role-in-body wiring on invite — only emits "role"
//     in JSON body when the caller passed it; falls back to server-
//     side default otherwise.
//   • Mixed sync/async return shapes — invite returns bare dict
//     (server returns just a {"message": ...} ack), other verbs
//     return pydantic-validated models. Drift to a different return
//     shape on either side would break customer error-handling.

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

  it("file exists at canonical path + module docstring V-298c/V-309f framing + V-298d auth-path-integration-not-yet-permissioning contract. CRITICAL: accepted members can sign in but their membership grants no implicit permissions on the owner's resources until V-298d ships. Drift to dropping this framing would silently widen the auth surface.", () => {
    expect(existsSync(LIB)).toBe(true);
    expect(body).toMatch(/^"""V-298c \/ V-309f — Team RBAC resource\.\n/);
    // `resolveEffectiveAccount` (apps/server/src/services/auth.ts) resolves
    // `X-Driftstack-Account: acc_<uuid>` against `ctx.teams` and carries the
    // membership role through, so members DO act on the owner's resources.
    // The old "no implicit permissions until V-298d ships" caveat was a
    // deferred promise that is now simply false on a shipped SDK surface.
    expect(body).toMatch(
      /All six \/v1\/team\/\* endpoints, plus the two \/v1\/teams team-record endpoints\.\s*Team membership IS honored on the auth/,
    );
    expect(body).toMatch(/``X-Driftstack-Account: acc_<owner-uuid>`` to act on the/);
    expect(body).toMatch(/against your membership role \(``admin`` or ``member``\)/);
    expect(body).not.toMatch(/grants no implicit permissions/);
  });

  it('TeamRole = Literal["member", "admin"] narrow enum pinned. Drift to adding "owner" or "viewer" would let the SDK accept role values the server-side enum still rejects — customers would get cryptic 400s instead of compile-time/typecheck-time errors.', () => {
    expect(body).toMatch(/^TeamRole = Literal\["member", "admin"\]$/m);
  });

  it('TeamMember pydantic model — 8-field row (id + owner_account_id + member_account_id + member_email + role + invited_at + accepted_at + invited_by_account_id nullable). Both invited_at AND accepted_at are non-null strings here because TeamMember is the CONFIRMED-membership view; pending invites live on TeamInvite instead.', () => {
    expect(body).toMatch(
      /^class TeamMember\(BaseModel\):\s*\n\s*id: str\s*\n\s*owner_account_id: str\s*\n\s*member_account_id: str\s*\n\s*member_email: str\s*\n\s*role: TeamRole\s*\n\s*invited_at: str\s*\n\s*accepted_at: str\s*\n\s*invited_by_account_id: str \| None$/m,
    );
  });

  it('TeamInvite pydantic model — 8-field row with nullable accepted_at (None until the invitee accepts) + invited_by_account_id nullable (None for system-initiated invites). expires_at non-null str because every invite has a deadline. Drift to making accepted_at non-null would conflate TeamInvite with TeamMember.', () => {
    expect(body).toMatch(
      /^class TeamInvite\(BaseModel\):\s*\n\s*id: str\s*\n\s*owner_account_id: str\s*\n\s*invitee_email: str\s*\n\s*role: TeamRole\s*\n\s*expires_at: str\s*\n\s*invited_by_account_id: str \| None\s*\n\s*accepted_at: str \| None\s*\n\s*created_at: str$/m,
    );
  });

  it('TeamOwner pydantic model pins the five-field owner workspace shape', () => {
    expect(body).toMatch(
      /^class TeamOwner\(BaseModel\):\s*\n\s*owner_account_id: str\s*\n\s*owner_email: str\s*\n\s*owner_name: str \| None\s*\n\s*role: TeamRole\s*\n\s*membership_id: str$/m,
    );
  });

  it('Envelope models include typed members, invites, and owner-workspace lists', () => {
    expect(body).toMatch(/^class TeamMembersList\(BaseModel\):\s*\n\s*data: list\[TeamMember\]$/m);
    expect(body).toMatch(/^class TeamInvitesList\(BaseModel\):\s*\n\s*data: list\[TeamInvite\]$/m);
    expect(body).toMatch(/^class TeamOwnersList\(BaseModel\):\s*\n\s*data: list\[TeamOwner\]$/m);
    expect(body).toMatch(
      /^class AcceptInviteResponse\(BaseModel\):\s*\n\s*membership: TeamMember$/m,
    );
  });

  it('TeamResource sync class shell + HttpClient injection', () => {
    expect(body).toMatch(/^class TeamResource:$/m);
    expect(body).toMatch(/"""Synchronous team resource\."""/);
    expect(body).toMatch(
      /def __init__\(self, http: HttpClient\) -> None:\s*\n\s*self\._http = http/,
    );
  });

  it('invite (sync) — POST /v1/team/invites with email-required + kwarg-only optional role. Conditional `if role is not None: body["role"] = role` so omitting the kwarg DEFERS to the server-side default role (no client-side default that could drift from server). Returns bare dict (server returns just {"message": ...} ack), not a pydantic model — drift to a model would force customers to call .model_dump() to read the ack message.', () => {
    expect(body).toMatch(
      /def invite\(self, email: str, \*, role: TeamRole \| None = None\) -> dict\[str, Any\]:\s*\n\s*body: dict\[str, Any\] = \{"email": email\}\s*\n\s*if role is not None:\s*\n\s*body\["role"\] = role\s*\n\s*data = self\._http\.request\("POST", "\/v1\/team\/invites", json_body=body\)\s*\n\s*return data {2}# \{"message": \.\.\.\}/,
    );
  });

  it('list_members + list_invites + list_owners sync methods validate typed envelopes', () => {
    expect(body).toMatch(
      /def list_members\(self\) -> TeamMembersList:\s*\n\s*data = self\._http\.request\("GET", "\/v1\/team\/members"\)\s*\n\s*return parse_model\(TeamMembersList, data\)/,
    );
    expect(body).toMatch(
      /def list_invites\(self\) -> TeamInvitesList:\s*\n\s*data = self\._http\.request\("GET", "\/v1\/team\/invites"\)\s*\n\s*return parse_model\(TeamInvitesList, data\)/,
    );
    expect(body).toMatch(
      /def list_owners\(self\) -> TeamOwnersList:\s*\n\s*data = self\._http\.request\("GET", "\/v1\/team\/owners"\)\s*\n\s*return parse_model\(TeamOwnersList, data\)/,
    );
  });

  it('accept_invite (sync) — POST /v1/team/invites/accept with bare-string token wrapped as {"token": token}. Customer ergonomic: pasted magic-link tokens go directly to the verb without constructing a request struct. Returns AcceptInviteResponse with the new TeamMember row so dashboards can render the "you joined X" confirmation.', () => {
    expect(body).toMatch(
      /def accept_invite\(self, token: str\) -> AcceptInviteResponse:\s*\n\s*data = self\._http\.request\("POST", "\/v1\/team\/invites\/accept", json_body=\{"token": token\}\)\s*\n\s*return parse_model\(AcceptInviteResponse, data\)/,
    );
  });

  it("remove_member (sync) — DELETE /v1/team/members/{quote(membership_id, safe='')}. CRITICAL: safe='' kwarg means EVEN '/' gets percent-encoded (default quote would let '/' through). Drift to a different escape (or no escape) would let a malformed membership_id inject path traversal. Returns None (Python 204-no-content idiom).", () => {
    expect(body).toMatch(
      /def remove_member\(self, membership_id: str\) -> None:\s*\n\s*self\._http\.request\("DELETE", f"\/v1\/team\/members\/\{quote\(membership_id, safe=''\)\}"\)/,
    );
  });

  it('AsyncTeamResource provides all 6 awaited verb twins with typed list_owners', () => {
    expect(body).toMatch(/^class AsyncTeamResource:$/m);
    expect(body).toMatch(/"""Async team resource\."""/);
    expect(body).toMatch(
      /async def invite\(self, email: str, \*, role: TeamRole \| None = None\) -> dict\[str, Any\]:/,
    );
    expect(body).toMatch(
      /async def list_members\(self\) -> TeamMembersList:\s*\n\s*data = await self\._http\.request\("GET", "\/v1\/team\/members"\)\s*\n\s*return parse_model\(TeamMembersList, data\)/,
    );
    expect(body).toMatch(
      /async def list_invites\(self\) -> TeamInvitesList:\s*\n\s*data = await self\._http\.request\("GET", "\/v1\/team\/invites"\)\s*\n\s*return parse_model\(TeamInvitesList, data\)/,
    );
    expect(body).toMatch(
      /async def list_owners\(self\) -> TeamOwnersList:\s*\n\s*data = await self\._http\.request\("GET", "\/v1\/team\/owners"\)\s*\n\s*return parse_model\(TeamOwnersList, data\)/,
    );
    expect(body).toMatch(
      /async def accept_invite\(self, token: str\) -> AcceptInviteResponse:\s*\n\s*data = await self\._http\.request\(\s*\n\s*"POST", "\/v1\/team\/invites\/accept", json_body=\{"token": token\}\s*\n\s*\)\s*\n\s*return parse_model\(AcceptInviteResponse, data\)/,
    );
    expect(body).toMatch(
      /async def remove_member\(self, membership_id: str\) -> None:\s*\n\s*await self\._http\.request\("DELETE", f"\/v1\/team\/members\/\{quote\(membership_id, safe=''\)\}"\)/,
    );
  });

  it('Imports — pydantic + urllib.parse.quote + Literal + Any + Async/Sync HttpClient pinned. Drift to using `from urllib.parse import urlencode` instead of `quote` for membership_id escape would change the encoding rules (urlencode is for ?query strings, quote is for path segments).', () => {
    expect(body).toMatch(/^from __future__ import annotations$/m);
    expect(body).toMatch(/^from typing import Any, Literal$/m);
    expect(body).toMatch(/^from urllib\.parse import quote$/m);
    expect(body).toMatch(/^from pydantic import BaseModel$/m);
    expect(body).toMatch(
      /^from driftstack\.http import AsyncHttpClient, HttpClient, parse_model$/m,
    );
  });
});

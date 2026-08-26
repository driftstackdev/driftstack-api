"""V-298c / V-309f — Team RBAC resource.

All six /v1/team/* endpoints, plus the two /v1/teams team-record endpoints. Team membership IS honored on the auth
path: send ``X-Driftstack-Account: acc_<owner-uuid>`` to act on the
resources of an owner you are a member of. The request is authorized
against your membership role (``admin`` or ``member``) and the route's
required scope; without the header every call acts on your own account.
"""

from __future__ import annotations

from typing import Any, Literal
from urllib.parse import quote

from pydantic import BaseModel

from driftstack.http import AsyncHttpClient, HttpClient, parse_model

TeamRole = Literal["member", "admin"]


class TeamMember(BaseModel):
    id: str
    owner_account_id: str
    member_account_id: str
    member_email: str
    role: TeamRole
    invited_at: str
    accepted_at: str
    invited_by_account_id: str | None


class TeamInvite(BaseModel):
    id: str
    owner_account_id: str
    invitee_email: str
    role: TeamRole
    expires_at: str
    invited_by_account_id: str | None
    accepted_at: str | None
    created_at: str


class TeamOwner(BaseModel):
    owner_account_id: str
    owner_email: str
    owner_name: str | None
    role: TeamRole
    membership_id: str


class TeamMembersList(BaseModel):
    data: list[TeamMember]


class TeamInvitesList(BaseModel):
    data: list[TeamInvite]


class TeamOwnersList(BaseModel):
    data: list[TeamOwner]


class AcceptInviteResponse(BaseModel):
    membership: TeamMember


class TeamRecord(BaseModel):
    """A team as a record — what ``GET /v1/teams`` returns.

    Distinct from ``TeamOwner``, which describes a team you BELONG to (it
    carries your ``role`` and ``membership_id``). This one is the team itself.

    ``slug`` is always ``None`` today: the field exists on the record but no
    endpoint sets one, because whether team slugs become public URL components
    is an open decision. Safe to read; it stays ``None`` until that is settled.
    """

    id: str
    name: str
    slug: str | None
    owner_account_id: str
    created_at: str
    updated_at: str


class TeamRecordsList(BaseModel):
    data: list[TeamRecord]


class RenameTeamResponse(BaseModel):
    team: TeamRecord


class TeamResource:
    """Synchronous team resource."""

    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def invite(self, email: str, *, role: TeamRole | None = None) -> dict[str, Any]:
        body: dict[str, Any] = {"email": email}
        if role is not None:
            body["role"] = role
        data = self._http.request("POST", "/v1/team/invites", json_body=body)
        return data  # {"message": ...}

    # Requires broad read or account_owner.
    def list_members(self) -> TeamMembersList:
        data = self._http.request("GET", "/v1/team/members")
        return parse_model(TeamMembersList, data)

    # Requires broad read or account_owner.
    def list_invites(self) -> TeamInvitesList:
        data = self._http.request("GET", "/v1/team/invites")
        return parse_model(TeamInvitesList, data)

    # Requires broad read or account_owner.
    def list_owners(self) -> TeamOwnersList:
        data = self._http.request("GET", "/v1/team/owners")
        return parse_model(TeamOwnersList, data)

    # Requires account_owner.
    def accept_invite(self, token: str) -> AcceptInviteResponse:
        data = self._http.request("POST", "/v1/team/invites/accept", json_body={"token": token})
        return parse_model(AcceptInviteResponse, data)

    def remove_member(self, membership_id: str) -> None:
        self._http.request("DELETE", f"/v1/team/members/{quote(membership_id, safe='')}")

    # Requires broad read or account_owner.
    def list_teams(self) -> TeamRecordsList:
        data = self._http.request("GET", "/v1/teams")
        return parse_model(TeamRecordsList, data)

    # Requires account_owner. 404 covers both an unknown id and a team owned by
    # someone else, deliberately — telling them apart would let a caller
    # enumerate which team ids exist.
    def rename_team(self, team_id: str, name: str) -> RenameTeamResponse:
        data = self._http.request(
            "PATCH", f"/v1/teams/{quote(team_id, safe='')}", json_body={"name": name}
        )
        return parse_model(RenameTeamResponse, data)


class AsyncTeamResource:
    """Async team resource."""

    def __init__(self, http: AsyncHttpClient) -> None:
        self._http = http

    async def invite(self, email: str, *, role: TeamRole | None = None) -> dict[str, Any]:
        body: dict[str, Any] = {"email": email}
        if role is not None:
            body["role"] = role
        data = await self._http.request("POST", "/v1/team/invites", json_body=body)
        return data

    # Requires broad read or account_owner.
    async def list_members(self) -> TeamMembersList:
        data = await self._http.request("GET", "/v1/team/members")
        return parse_model(TeamMembersList, data)

    # Requires broad read or account_owner.
    async def list_invites(self) -> TeamInvitesList:
        data = await self._http.request("GET", "/v1/team/invites")
        return parse_model(TeamInvitesList, data)

    # Requires broad read or account_owner.
    async def list_owners(self) -> TeamOwnersList:
        data = await self._http.request("GET", "/v1/team/owners")
        return parse_model(TeamOwnersList, data)

    # Requires account_owner.
    async def accept_invite(self, token: str) -> AcceptInviteResponse:
        data = await self._http.request(
            "POST", "/v1/team/invites/accept", json_body={"token": token}
        )
        return parse_model(AcceptInviteResponse, data)

    async def remove_member(self, membership_id: str) -> None:
        await self._http.request("DELETE", f"/v1/team/members/{quote(membership_id, safe='')}")

    # Requires broad read or account_owner.
    async def list_teams(self) -> TeamRecordsList:
        data = await self._http.request("GET", "/v1/teams")
        return parse_model(TeamRecordsList, data)

    # Requires account_owner. 404 covers both an unknown id and a team owned by
    # someone else, deliberately — telling them apart would let a caller
    # enumerate which team ids exist.
    async def rename_team(self, team_id: str, name: str) -> RenameTeamResponse:
        data = await self._http.request(
            "PATCH", f"/v1/teams/{quote(team_id, safe='')}", json_body={"name": name}
        )
        return parse_model(RenameTeamResponse, data)

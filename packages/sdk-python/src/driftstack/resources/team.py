"""V-298c / V-309f — Team RBAC resource.

All six /v1/team/* endpoints. Team membership IS honored on the auth
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

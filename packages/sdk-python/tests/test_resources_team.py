"""V-309f — Team resource tests."""

from __future__ import annotations

import json

import httpx
import pytest
import respx

from driftstack import AsyncDriftstack, Driftstack, TeamOwner, TeamOwnersList
from driftstack.resources.team import (
    AcceptInviteResponse,
    TeamInvitesList,
    TeamMembersList,
)

API_KEY = "ds_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
BASE = "https://api.test"

MEMBER_ROW: dict = {
    "id": "mem_00000000-0000-4000-8000-000000000001",
    "owner_account_id": "acc_00000000-0000-4000-8000-000000000010",
    "member_account_id": "acc_00000000-0000-4000-8000-000000000020",
    "member_email": "member@example.test",
    "role": "member",
    "invited_at": "2026-05-08T10:00:00Z",
    "accepted_at": "2026-05-08T10:05:00Z",
    "invited_by_account_id": "acc_00000000-0000-4000-8000-000000000010",
}

INVITE_ROW: dict = {
    "id": "inv_00000000-0000-4000-8000-000000000001",
    "owner_account_id": "acc_00000000-0000-4000-8000-000000000010",
    "invitee_email": "pending@example.test",
    "role": "member",
    "expires_at": "2026-05-15T10:00:00Z",
    "invited_by_account_id": "acc_00000000-0000-4000-8000-000000000010",
    "accepted_at": None,
    "created_at": "2026-05-08T10:00:00Z",
}

OWNER_ROW: dict = {
    "owner_account_id": "acc_00000000-0000-4000-8000-000000000010",
    "owner_email": "owner@example.test",
    "owner_name": "Workspace owner",
    "role": "admin",
    "membership_id": "mem_00000000-0000-4000-8000-000000000001",
}


def test_sync_invite() -> None:
    with respx.mock(base_url=BASE) as mock:
        route = mock.post("/v1/team/invites").mock(
            return_value=httpx.Response(202, json={"message": "Invite sent."}),
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            result = client.team.invite("user@example.test", role="admin")
        assert route.called
        assert result["message"] == "Invite sent."


def test_sync_list_members() -> None:
    with respx.mock(base_url=BASE) as mock:
        mock.get("/v1/team/members").mock(
            return_value=httpx.Response(200, json={"data": [MEMBER_ROW]}),
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            result = client.team.list_members()
        assert isinstance(result, TeamMembersList)
        assert len(result.data) == 1
        assert result.data[0].member_email == "member@example.test"


def test_sync_list_invites() -> None:
    with respx.mock(base_url=BASE) as mock:
        mock.get("/v1/team/invites").mock(
            return_value=httpx.Response(200, json={"data": [INVITE_ROW]}),
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            result = client.team.list_invites()
        assert isinstance(result, TeamInvitesList)
        assert result.data[0].invitee_email == "pending@example.test"


def test_sync_list_owners() -> None:
    with respx.mock(base_url=BASE) as mock:
        mock.get("/v1/team/owners").mock(
            return_value=httpx.Response(200, json={"data": [OWNER_ROW]}),
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            result = client.team.list_owners()
        assert isinstance(result, TeamOwnersList)
        assert isinstance(result.data[0], TeamOwner)
        assert result.data[0].owner_name == "Workspace owner"


def test_sync_accept_invite() -> None:
    with respx.mock(base_url=BASE) as mock:
        mock.post("/v1/team/invites/accept").mock(
            return_value=httpx.Response(200, json={"membership": MEMBER_ROW}),
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            result = client.team.accept_invite("plaintexttokenplaintext")
        assert isinstance(result, AcceptInviteResponse)
        assert result.membership.member_email == "member@example.test"


def test_sync_remove_member() -> None:
    with respx.mock(base_url=BASE) as mock:
        mock.delete(f"/v1/team/members/{MEMBER_ROW['id']}").mock(
            return_value=httpx.Response(204),
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            result = client.team.remove_member(MEMBER_ROW["id"])
        assert result is None


@pytest.mark.asyncio
async def test_async_invite() -> None:
    with respx.mock(base_url=BASE) as mock:
        mock.post("/v1/team/invites").mock(
            return_value=httpx.Response(202, json={"message": "ok"}),
        )
        async with AsyncDriftstack(api_key=API_KEY, base_url=BASE) as client:
            result = await client.team.invite("user@example.test")
        assert result["message"] == "ok"


@pytest.mark.asyncio
async def test_async_accept_invite() -> None:
    with respx.mock(base_url=BASE) as mock:
        mock.post("/v1/team/invites/accept").mock(
            return_value=httpx.Response(200, json={"membership": MEMBER_ROW}),
        )
        async with AsyncDriftstack(api_key=API_KEY, base_url=BASE) as client:
            result = await client.team.accept_invite("token")
        assert result.membership.id == MEMBER_ROW["id"]


@pytest.mark.asyncio
async def test_async_list_owners() -> None:
    with respx.mock(base_url=BASE) as mock:
        route = mock.get("/v1/team/owners").mock(
            return_value=httpx.Response(200, json={"data": [OWNER_ROW]}),
        )
        async with AsyncDriftstack(api_key=API_KEY, base_url=BASE) as client:
            result = await client.team.list_owners()
        assert route.called
        assert isinstance(result, TeamOwnersList)
        assert result.data[0].owner_email == "owner@example.test"


# ── list_teams / rename_team shipped with NO test in ANY of the three SDKs
# ── (V-1978). Both target real routes with matching verbs, so nothing was
# ── broken; nothing was checking either.

TEAM_ROW: dict = {
    "id": "team_00000000-0000-4000-8000-000000000001",
    "name": "Acme",
    "slug": None,
    "owner_account_id": "acc_00000000-0000-4000-8000-000000000010",
    "created_at": "2026-05-08T10:00:00Z",
    "updated_at": "2026-05-08T10:00:00Z",
}


def test_sync_list_teams_gets_v1_teams() -> None:
    with respx.mock(base_url=BASE) as mock:
        route = mock.get("/v1/teams").mock(
            return_value=httpx.Response(200, json={"data": [TEAM_ROW]})
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            out = client.team.list_teams()
        assert route.called
        assert route.calls[0].request.method == "GET"
        # `slug` is published but always None; parse_model would reject a row
        # missing it, so this pins the shape as well as the verb.
        assert out.data[0].slug is None
        assert out.data[0].name == "Acme"


def test_sync_rename_team_patches_with_exactly_the_name() -> None:
    with respx.mock(base_url=BASE) as mock:
        route = mock.patch("/v1/teams/team_1").mock(
            return_value=httpx.Response(200, json={"team": dict(TEAM_ROW, name="New")})
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            out = client.team.rename_team("team_1", "New")
        assert route.called
        assert route.calls[0].request.method == "PATCH"
        # Exactly {"name": ...}: the route runs reportUnknownRequestFields against
        # RenameTeamBodySchema, so an extra key is a warning the caller never sees.
        assert json.loads(route.calls[0].request.content) == {"name": "New"}
        assert out.team.name == "New"


def test_sync_rename_team_url_encodes_the_team_id() -> None:
    """A caller-supplied id must not be able to alter the path.

    Asserted on ``request.url.raw_path``, NOT on the respx route pattern: respx
    percent-DECODES the pattern before matching, so a route written as
    ``/v1/teams/team%2Fwith%20space`` also matches a request that sent the slash
    unencoded. An arm built on the pattern alone cannot fail and was vacuous
    until a mutation exposed it.
    """
    with respx.mock(base_url=BASE) as mock:
        route = mock.route().mock(return_value=httpx.Response(200, json={"team": TEAM_ROW}))
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            client.team.rename_team("team/with space", "n")
        assert route.called
        assert route.calls[0].request.url.raw_path == b"/v1/teams/team%2Fwith%20space"


@pytest.mark.asyncio
async def test_async_rename_team_url_encodes_the_team_id() -> None:
    """The async mirror is a separate method and therefore a separate chance to
    skip the encoding."""
    with respx.mock(base_url=BASE) as mock:
        route = mock.route().mock(return_value=httpx.Response(200, json={"team": TEAM_ROW}))
        async with AsyncDriftstack(api_key=API_KEY, base_url=BASE) as client:
            await client.team.rename_team("team/with space", "n")
        assert route.called
        assert route.calls[0].request.url.raw_path == b"/v1/teams/team%2Fwith%20space"

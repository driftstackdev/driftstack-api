"""Resource-level iterate() tests (V-126).

Each resource that adopts the pagination helper gets a small test that
verifies cursor handoff + filter threading via a fake HTTP client.
"""

from __future__ import annotations

from typing import Any

import pytest

from driftstack.resources.profile_snapshots import (
    AsyncProfileSnapshotsResource,
    ProfileSnapshotsResource,
)
from driftstack.resources.profiles import AsyncProfilesResource, ProfilesResource
from driftstack.resources.sessions import AsyncSessionsResource, SessionsResource
from driftstack.resources.webhooks import AsyncWebhooksResource, WebhooksResource


class FakeSyncHttp:
    """Captures every request + replays a queued list of responses."""

    def __init__(self, responses: list[Any]) -> None:
        self._responses = list(responses)
        self.calls: list[dict[str, Any]] = []

    def request(self, method: str, path: str, **kw: Any) -> Any:
        self.calls.append({"method": method, "path": path, **kw})
        return self._responses.pop(0)


class FakeAsyncHttp:
    def __init__(self, responses: list[Any]) -> None:
        self._responses = list(responses)
        self.calls: list[dict[str, Any]] = []

    async def request(self, method: str, path: str, **kw: Any) -> Any:
        self.calls.append({"method": method, "path": path, **kw})
        return self._responses.pop(0)


# Server-validated ID prefixes per `_generated/models.py` patterns.
# Tests use deterministic UUID-shaped suffixes so pydantic regex passes.
_SES_PREFIX = "ses_"
_ACC_ID = "acc_00000000-0000-0000-0000-000000000001"
_KEY_ID = "key_00000000-0000-0000-0000-000000000002"
_WHK_ID = "whk_00000000-0000-0000-0000-000000000003"


def _ses_id(n: int) -> str:
    return f"{_SES_PREFIX}00000000-0000-0000-0000-{n:012d}"


def _wdl_id(n: int) -> str:
    return f"wdl_00000000-0000-0000-0000-{n:012d}"


def _session_dict(n: int) -> dict[str, Any]:
    return {
        "id": _ses_id(n),
        "account_id": _ACC_ID,
        "api_key_id": _KEY_ID,
        "status": "ready",
        "archetype": "iphone16pro_ios18_7_safari26_4",
        "purpose": "production_customer",
        "label": None,
        "metadata": None,
        "egress_capabilities": None,
        "created_at": "2026-05-04T00:00:00Z",
        "updated_at": "2026-05-04T00:00:00Z",
        "last_state_at": None,
        "destroyed_at": None,
    }


def _delivery_dict(n: int) -> dict[str, Any]:
    return {
        "id": _wdl_id(n),
        "webhook_id": _WHK_ID,
        "event_id": "00000000-0000-0000-0000-000000000000",
        "event_type": "session.completed",
        "status": "dlq",
        "attempts": 3,
        "next_attempt_at": "2026-05-04T00:00:00Z",
        "last_response_status": 500,
        "last_response_excerpt": None,
        "last_error": "internal server error",
        "delivered_at": None,
        "created_at": "2026-05-04T00:00:00Z",
    }


# ── sessions ──────────────────────────────────────────────────────────


def test_sessions_iterate_walks_pages() -> None:
    http = FakeSyncHttp(
        [
            {
                "data": [_session_dict(1), _session_dict(2)],
                "has_more": True,
                "next_cursor": "cur_2",
            },
            {
                "data": [_session_dict(3)],
                "has_more": False,
                "next_cursor": None,
            },
        ],
    )
    sessions = SessionsResource(http)  # type: ignore[arg-type]
    ids = [s.id for s in sessions.iterate(limit=2)]
    assert ids == [_ses_id(1), _ses_id(2), _ses_id(3)]
    assert [c.get("params", {}) for c in http.calls] == [
        {"limit": 2},
        {"limit": 2, "cursor": "cur_2"},
    ]


@pytest.mark.asyncio
async def test_async_sessions_iterate_walks_pages() -> None:
    http = FakeAsyncHttp(
        [
            {
                "data": [_session_dict(10)],
                "has_more": True,
                "next_cursor": "cur_b",
            },
            {
                "data": [_session_dict(11)],
                "has_more": False,
                "next_cursor": None,
            },
        ],
    )
    sessions = AsyncSessionsResource(http)  # type: ignore[arg-type]
    ids: list[str] = []
    async for s in sessions.iterate():
        ids.append(s.id)
    assert ids == [_ses_id(10), _ses_id(11)]


# ── profiles (dict-shaped pages) ──────────────────────────────────────


def test_profiles_iterate_walks_pages() -> None:
    http = FakeSyncHttp(
        [
            {"data": [{"id": "prof_1"}, {"id": "prof_2"}], "next_cursor": "cur_2"},
            {"data": [{"id": "prof_3"}], "next_cursor": None},
        ],
    )
    profiles = ProfilesResource(http)  # type: ignore[arg-type]
    ids = [p["id"] for p in profiles.iterate(limit=2)]
    assert ids == ["prof_1", "prof_2", "prof_3"]


@pytest.mark.asyncio
async def test_async_profiles_iterate_walks_pages() -> None:
    http = FakeAsyncHttp(
        [
            {"data": [{"id": "prof_x"}], "next_cursor": None},
        ],
    )
    profiles = AsyncProfilesResource(http)  # type: ignore[arg-type]
    ids: list[str] = []
    async for p in profiles.iterate():
        ids.append(p["id"])
    assert ids == ["prof_x"]


# ── profile clone (V-313) ─────────────────────────────────────────────


def test_profiles_clone_default_body_empty() -> None:
    http = FakeSyncHttp([{"id": "prof_copy"}])
    profiles = ProfilesResource(http)  # type: ignore[arg-type]
    out = profiles.clone("prof_src")
    assert out["id"] == "prof_copy"
    assert http.calls[0]["method"] == "POST"
    assert http.calls[0]["path"] == "/v1/profiles/prof_src/clone"
    assert http.calls[0]["json_body"] == {}


def test_profiles_clone_passes_explicit_name() -> None:
    http = FakeSyncHttp([{"id": "prof_x"}])
    profiles = ProfilesResource(http)  # type: ignore[arg-type]
    profiles.clone("prof_src", {"name": "my-explicit-clone"})
    assert http.calls[0]["json_body"] == {"name": "my-explicit-clone"}


# ── profile snapshots (V-312, dict-shaped pages) ──────────────────────


def test_profile_snapshots_capture_and_paths() -> None:
    """Sync resource — capture / list / restore / delete hit the right paths."""
    http = FakeSyncHttp(
        [
            {"id": "psnap_1", "label": "before-iOS-26"},
            {"data": [{"id": "psnap_a"}], "next_cursor": None},
            {"data": [{"id": "psnap_b"}], "next_cursor": None},
            {"id": "prof_new", "name": "restored"},
            None,
        ],
    )
    snaps = ProfileSnapshotsResource(http)  # type: ignore[arg-type]
    snaps.capture("prof_p", {"label": "before-iOS-26"})
    snaps.list_for_profile("prof_p", limit=10)
    snaps.list(limit=10)
    snaps.restore("psnap_1", {"name": "restored"})
    snaps.delete("psnap_1")
    paths = [(c["method"], c["path"]) for c in http.calls]
    assert paths == [
        ("POST", "/v1/profiles/prof_p/snapshots"),
        ("GET", "/v1/profiles/prof_p/snapshots?limit=10"),
        ("GET", "/v1/profile-snapshots?limit=10"),
        ("POST", "/v1/profile-snapshots/psnap_1/restore"),
        ("DELETE", "/v1/profile-snapshots/psnap_1"),
    ]


def test_profile_snapshots_iterate_walks_pages() -> None:
    http = FakeSyncHttp(
        [
            {"data": [{"id": "psnap_1"}, {"id": "psnap_2"}], "next_cursor": "cur_2"},
            {"data": [{"id": "psnap_3"}], "next_cursor": None},
        ],
    )
    snaps = ProfileSnapshotsResource(http)  # type: ignore[arg-type]
    ids = [s["id"] for s in snaps.iterate(limit=2)]
    assert ids == ["psnap_1", "psnap_2", "psnap_3"]


@pytest.mark.asyncio
async def test_async_profile_snapshots_iterate_walks_pages() -> None:
    http = FakeAsyncHttp(
        [
            {"data": [{"id": "psnap_x"}], "next_cursor": None},
        ],
    )
    snaps = AsyncProfileSnapshotsResource(http)  # type: ignore[arg-type]
    ids: list[str] = []
    async for s in snaps.iterate():
        ids.append(s["id"])
    assert ids == ["psnap_x"]


# ── webhooks deliveries (status filter threaded) ──────────────────────


def test_webhooks_iterate_deliveries_threads_status_filter() -> None:
    http = FakeSyncHttp(
        [
            {
                "data": [_delivery_dict(1), _delivery_dict(2)],
                "has_more": True,
                "next_cursor": "cur_2",
            },
            {
                "data": [_delivery_dict(3)],
                "has_more": False,
                "next_cursor": None,
            },
        ],
    )
    webhooks = WebhooksResource(http)  # type: ignore[arg-type]
    ids = [d.id for d in webhooks.iterate_deliveries(_WHK_ID, limit=2, status="dlq")]
    assert ids == [_wdl_id(1), _wdl_id(2), _wdl_id(3)]
    # status threaded through every page; cursor only present on subsequent.
    params_seen = [c.get("params", {}) for c in http.calls]
    assert params_seen == [
        {"limit": 2, "status": "dlq"},
        {"limit": 2, "status": "dlq", "cursor": "cur_2"},
    ]


@pytest.mark.asyncio
async def test_async_webhooks_iterate_deliveries_walks_pages() -> None:
    http = FakeAsyncHttp(
        [
            {
                "data": [_delivery_dict(99)],
                "has_more": False,
                "next_cursor": None,
            },
        ],
    )
    webhooks = AsyncWebhooksResource(http)  # type: ignore[arg-type]
    ids: list[str] = []
    async for d in webhooks.iterate_deliveries(_WHK_ID):
        ids.append(d.id)
    assert ids == [_wdl_id(99)]

"""Resource-level iterate() tests (V-126).

Each resource that adopts the pagination helper gets a small test that
verifies cursor handoff + filter threading via a fake HTTP client.
"""

from __future__ import annotations

from typing import Any

import pytest

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
        "archetype": "mac_iphone_14_safari",
        "label": None,
        "metadata": None,
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

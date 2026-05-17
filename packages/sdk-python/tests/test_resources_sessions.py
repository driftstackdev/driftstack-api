"""Sessions resource tests — sync + async via respx mocks.

The mock asserts the request shape (URL, method, headers, body) AND
the response decoding into the right Pydantic model. A regression
that breaks either side trips here before reaching real customers.
"""

from __future__ import annotations

import httpx
import pytest
import respx

from driftstack import AsyncDriftstack, Driftstack
from driftstack._generated.models import (
    CaptureResponse,
    CreateSessionResponse,
    InteractResponse,
    NavigateResponse,
    Session,
    SessionState,
    WaitResponse,
)
from driftstack.resources.sessions import SessionsListPage

API_KEY = "ds_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
BASE = "https://api.test"

SESSION_FIXTURE: dict = {
    "id": "ses_00000000-0000-4000-8000-000000000001",
    "account_id": "acc_00000000-0000-4000-8000-000000000001",
    "api_key_id": "key_00000000-0000-4000-8000-000000000001",
    "status": "ready",
    "archetype": "iphone16pro_ios18_7_safari26_4",
    # V-169 — purpose is required; defaults to production_customer.
    "purpose": "production_customer",
    "label": None,
    "metadata": None,
    "egress_capabilities": None,
    "created_at": "2026-05-02T10:00:00Z",
    "updated_at": "2026-05-02T10:00:00Z",
    "last_state_at": None,
    "destroyed_at": None,
}


# ──────────────────────────────────────────────────────────────────────────
# Sync
# ──────────────────────────────────────────────────────────────────────────


def test_sync_create_session_posts_and_decodes() -> None:
    with respx.mock(base_url=BASE) as mock:
        route = mock.post("/v1/sessions").mock(
            return_value=httpx.Response(201, json=SESSION_FIXTURE)
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            result = client.sessions.create()

        assert isinstance(result, CreateSessionResponse)
        assert str(result.id) == SESSION_FIXTURE["id"]
        # One request was made; bearer header + content-type as expected.
        req = route.calls[0].request
        assert req.headers["authorization"] == f"Bearer {API_KEY}"
        assert req.headers["accept"] == "application/json"
        assert req.headers["content-type"] == "application/json"
        assert req.method == "POST"


def test_sync_create_with_explicit_body() -> None:
    with respx.mock(base_url=BASE) as mock:
        mock.post("/v1/sessions").mock(return_value=httpx.Response(201, json=SESSION_FIXTURE))
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            result = client.sessions.create({"label": "ci-run"})
        assert str(result.id) == SESSION_FIXTURE["id"]


def test_sync_list_passes_pagination_query() -> None:
    page = {"data": [SESSION_FIXTURE], "has_more": False, "next_cursor": None}
    with respx.mock(base_url=BASE) as mock:
        route = mock.get("/v1/sessions").mock(return_value=httpx.Response(200, json=page))
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            result = client.sessions.list({"limit": 50})

        assert isinstance(result, SessionsListPage)
        assert len(result.data) == 1
        # The query params are url-encoded.
        req = route.calls[0].request
        assert "limit=50" in req.url.query.decode()


def test_sync_get_session() -> None:
    with respx.mock(base_url=BASE) as mock:
        mock.get("/v1/sessions/ses_xx").mock(return_value=httpx.Response(200, json=SESSION_FIXTURE))
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            result = client.sessions.get("ses_xx")
        assert isinstance(result, Session)


def test_sync_navigate() -> None:
    body = {
        "url": "https://example.com/",
        "status": 200,
        "final_url": "https://example.com/",
        "duration_ms": 100,
    }
    with respx.mock(base_url=BASE) as mock:
        route = mock.post("/v1/sessions/ses_xx/navigate").mock(
            return_value=httpx.Response(200, json=body)
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            result = client.sessions.navigate("ses_xx", {"url": "https://example.com/"})

        assert isinstance(result, NavigateResponse)
        # Body sent matches what we passed.
        sent = route.calls[0].request.read().decode()
        assert "https://example.com/" in sent


def test_sync_interact() -> None:
    body = {"ok": True, "duration_ms": 50}
    with respx.mock(base_url=BASE) as mock:
        mock.post("/v1/sessions/ses_xx/interact").mock(return_value=httpx.Response(200, json=body))
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            result = client.sessions.interact(
                "ses_xx", {"action": {"kind": "tap", "selector": "#submit"}}
            )
        assert isinstance(result, InteractResponse)


def test_sync_wait() -> None:
    body = {"satisfied": True, "duration_ms": 200}
    with respx.mock(base_url=BASE) as mock:
        mock.post("/v1/sessions/ses_xx/wait").mock(return_value=httpx.Response(200, json=body))
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            result = client.sessions.wait(
                "ses_xx",
                {
                    "condition": {"kind": "selector", "selector": "#ready"},
                    "timeout_ms": 5000,
                },
            )
        assert isinstance(result, WaitResponse)
        assert result.satisfied is True


def test_sync_get_state() -> None:
    state = {
        "url": "https://example.com",
        "title": "Example",
        "cookies": [],
        "local_storage": {},
        "captured_at": "2026-05-02T10:00:00Z",
    }
    with respx.mock(base_url=BASE) as mock:
        mock.get("/v1/sessions/ses_xx/state").mock(return_value=httpx.Response(200, json=state))
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            result = client.sessions.get_state("ses_xx")
        assert isinstance(result, SessionState)


def test_sync_capture() -> None:
    capture = {
        "kind": "screenshot",
        "data": "iVBORw0KGgo=",
        "encoding": "base64",
        "byte_size": 100,
        "duration_ms": 50,
    }
    with respx.mock(base_url=BASE) as mock:
        mock.post("/v1/sessions/ses_xx/capture").mock(
            return_value=httpx.Response(200, json=capture)
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            result = client.sessions.capture("ses_xx", {"kind": "screenshot"})
        assert isinstance(result, CaptureResponse)


def test_sync_destroy_returns_none_on_204() -> None:
    with respx.mock(base_url=BASE) as mock:
        mock.delete("/v1/sessions/ses_xx").mock(return_value=httpx.Response(204))
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            result = client.sessions.destroy("ses_xx")
        assert result is None


def test_sync_session_id_url_encoding() -> None:
    """Session ids are URL-encoded so weird characters can't break the path."""
    weird_id = "ses_with/slash"
    with respx.mock(base_url=BASE) as mock:
        route = mock.get("/v1/sessions/ses_with%2Fslash").mock(
            return_value=httpx.Response(200, json=SESSION_FIXTURE)
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            client.sessions.get(weird_id)
        # The route only matches if the URL was correctly percent-encoded.
        assert route.called


# ──────────────────────────────────────────────────────────────────────────
# Async (one-of-each — same plumbing as sync)
# ──────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_async_create_session_posts_and_decodes() -> None:
    with respx.mock(base_url=BASE) as mock:
        mock.post("/v1/sessions").mock(return_value=httpx.Response(201, json=SESSION_FIXTURE))
        async with AsyncDriftstack(api_key=API_KEY, base_url=BASE) as client:
            result = await client.sessions.create()
        assert isinstance(result, CreateSessionResponse)
        assert str(result.id) == SESSION_FIXTURE["id"]


@pytest.mark.asyncio
async def test_async_destroy_returns_none() -> None:
    with respx.mock(base_url=BASE) as mock:
        mock.delete("/v1/sessions/ses_xx").mock(return_value=httpx.Response(204))
        async with AsyncDriftstack(api_key=API_KEY, base_url=BASE) as client:
            result = await client.sessions.destroy("ses_xx")
        assert result is None


@pytest.mark.asyncio
async def test_async_list_returns_paginated_page() -> None:
    page = {"data": [SESSION_FIXTURE, SESSION_FIXTURE], "has_more": True, "next_cursor": "abc"}
    with respx.mock(base_url=BASE) as mock:
        mock.get("/v1/sessions").mock(return_value=httpx.Response(200, json=page))
        async with AsyncDriftstack(api_key=API_KEY, base_url=BASE) as client:
            result = await client.sessions.list({"cursor": "abc"})
        assert isinstance(result, SessionsListPage)
        assert len(result.data) == 2
        assert result.has_more is True
        assert result.next_cursor == "abc"

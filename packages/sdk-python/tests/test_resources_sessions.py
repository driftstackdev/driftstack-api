"""Sessions resource tests — sync + async via respx mocks.

The mock asserts the request shape (URL, method, headers, body) AND
the response decoding into the right Pydantic model. A regression
that breaks either side trips here before reaching real customers.
"""

from __future__ import annotations

import httpx
import pydantic
import pytest
import respx

from driftstack import AsyncDriftstack, Driftstack
from driftstack._generated.models import (
    CaptureResponse,
    CreateSessionResponse,
    InteractResponse,
    NavigateResponse,
    SearchResponse1,
    SearchResponse2,
    Session,
    SessionLoginResponse1,
    SessionLoginResponse2,
    SessionState,
    WaitResponse,
)
from driftstack.errors import DriftstackError, TransportError
from driftstack.resources.sessions import SessionsListPage

API_KEY = "ds_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
BASE = "https://api.test"

SESSION_FIXTURE: dict = {
    "id": "ses_00000000-0000-4000-8000-000000000001",
    "account_id": "acc_00000000-0000-4000-8000-000000000001",
    "api_key_id": "key_00000000-0000-4000-8000-000000000001",
    "status": "ready",
    "archetype": "iphone17_ios18_7_safari26_4",
    # V-169 — purpose is required; defaults to production_customer.
    "purpose": "production_customer",
    "label": None,
    "metadata": None,
    "egress_capabilities": None,
    "egress_capability_report": None,
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


def test_sync_get_session_schema_mismatch_raises_transport_error() -> None:
    """A 2xx body that doesn't match the generated ``Session`` schema (a
    stale codegen / server contract drift) must surface as a typed
    :class:`TransportError` — NOT a raw ``pydantic.ValidationError`` escaping
    past the SDK's documented "catch DriftstackError" contract."""
    malformed = {"id": "ses_xx"}  # missing every other required Session field
    with respx.mock(base_url=BASE) as mock:
        mock.get("/v1/sessions/ses_xx").mock(return_value=httpx.Response(200, json=malformed))
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            with pytest.raises(TransportError) as exc_info:
                client.sessions.get("ses_xx")
    # It's catchable via the SDK's own base class...
    assert isinstance(exc_info.value, DriftstackError)
    # ...and the original pydantic error is preserved for diagnosis.
    assert isinstance(exc_info.value.__cause__, pydantic.ValidationError)


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


def test_sync_search_returns_direct_completed_branch_attributes() -> None:
    response = {
        "submitted": False,
        "query_truncated": False,
        "results_visible": False,
        "duration_ms": 8_420,
    }
    with respx.mock(base_url=BASE) as mock:
        route = mock.post("/v1/sessions/ses_xx/search").mock(
            return_value=httpx.Response(200, json=response)
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            result = client.sessions.search(
                "ses_xx", {"query": "wireless headphones", "submit": False}
            )

    assert isinstance(result, SearchResponse1)
    assert result.submitted is False
    assert result.query_truncated is False
    assert result.results_visible is False
    assert result.duration_ms == 8_420
    assert b"wireless headphones" in route.calls[0].request.read()


@pytest.mark.parametrize(
    "response",
    [
        {
            "submitted": False,
            "query_truncated": True,
            "results_visible": False,
            "duration_ms": 1,
        },
        {
            "submitted": True,
            "query_truncated": False,
            "results_visible": None,
            "duration_ms": 1,
        },
    ],
)
def test_sync_search_rejects_malformed_success_body_as_transport_error(
    response: dict[str, object],
) -> None:
    with respx.mock(base_url=BASE) as mock:
        mock.post("/v1/sessions/ses_xx/search").mock(
            return_value=httpx.Response(200, json=response)
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            with pytest.raises(TransportError):
                client.sessions.search("ses_xx", {"query": "wireless headphones"})


@pytest.mark.parametrize(
    "response",
    [
        # JSON 1/0 are not booleans. `isinstance(True, int)` is true, so
        # pydantic's lax mode would coerce these into a fabricated
        # submitted/refusal verdict the browser never produced.
        {"submitted": 1, "query_truncated": False, "duration_ms": 1},
        {"submitted": False, "query_truncated": 0, "duration_ms": 1},
        {"submitted": False, "query_truncated": False, "results_visible": 1, "duration_ms": 1},
        # duration_ms must be a real integer inside the 600,000 ms producer
        # budget — never a numeric string, float or bool.
        {"submitted": False, "query_truncated": False, "duration_ms": "1"},
        {"submitted": False, "query_truncated": False, "duration_ms": 1.0},
        {"submitted": False, "query_truncated": False, "duration_ms": True},
        {"submitted": False, "query_truncated": False, "duration_ms": 600_001},
        # A safe refusal never carries a results assessment.
        {"submitted": False, "query_truncated": True, "results_visible": False, "duration_ms": 1},
    ],
)
def test_sync_search_rejects_hostile_primitive_body_as_transport_error(
    response: dict[str, object],
) -> None:
    with respx.mock(base_url=BASE) as mock:
        mock.post("/v1/sessions/ses_xx/search").mock(
            return_value=httpx.Response(200, json=response)
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            with pytest.raises(TransportError):
                client.sessions.search("ses_xx", {"query": "wireless headphones"})


def test_sync_login_returns_direct_submitted_branch_attributes() -> None:
    response = {
        "submitted": True,
        "credentials_truncated": False,
        "logged_in": False,
        "post_login_url": "https://example.test/challenge",
        "duration_ms": 12_450,
    }
    with respx.mock(base_url=BASE) as mock:
        route = mock.post("/v1/sessions/ses_xx/login").mock(
            return_value=httpx.Response(200, json=response)
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            result = client.sessions.login(
                "ses_xx", {"username": "user@example.test", "password": "not-logged"}
            )

    assert isinstance(result, SessionLoginResponse1)
    assert result.submitted is True
    assert result.credentials_truncated is False
    assert result.logged_in is False
    assert result.post_login_url == "https://example.test/challenge"
    assert result.duration_ms == 12_450
    sent = route.calls[0].request.read().decode()
    assert "user@example.test" in sent


def test_sync_login_rejects_contradictory_success_body_as_transport_error() -> None:
    response = {
        "submitted": False,
        "credentials_truncated": True,
        "logged_in": False,
        "post_login_url": "https://example.test/should-not-exist",
        "duration_ms": 1,
    }
    with respx.mock(base_url=BASE) as mock:
        mock.post("/v1/sessions/ses_xx/login").mock(return_value=httpx.Response(200, json=response))
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            with pytest.raises(TransportError):
                client.sessions.login(
                    "ses_xx", {"username": "user@example.test", "password": "not-logged"}
                )


def test_sync_login_rejects_explicit_null_url_as_transport_error() -> None:
    response = {
        "submitted": True,
        "credentials_truncated": False,
        "logged_in": False,
        "post_login_url": None,
        "duration_ms": 1,
    }
    with respx.mock(base_url=BASE) as mock:
        mock.post("/v1/sessions/ses_xx/login").mock(return_value=httpx.Response(200, json=response))
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            with pytest.raises(TransportError):
                client.sessions.login(
                    "ses_xx", {"username": "user@example.test", "password": "not-logged"}
                )


@pytest.mark.parametrize(
    "response",
    [
        # A coerced 1/0/"false" would publish a credential-submission or
        # session verdict the harness never asserted.
        {"submitted": 1, "credentials_truncated": False, "logged_in": False, "duration_ms": 1},
        {"submitted": False, "credentials_truncated": 1, "logged_in": False, "duration_ms": 1},
        {
            "submitted": True,
            "credentials_truncated": False,
            "logged_in": "false",
            "duration_ms": 1,
        },
        # duration_ms must be a real integer inside the 600,000 ms producer
        # budget — never a numeric string, float or bool.
        {"submitted": True, "credentials_truncated": False, "logged_in": False, "duration_ms": "1"},
        {"submitted": True, "credentials_truncated": False, "logged_in": False, "duration_ms": 1.0},
        {
            "submitted": True,
            "credentials_truncated": False,
            "logged_in": False,
            "duration_ms": True,
        },
        {
            "submitted": True,
            "credentials_truncated": False,
            "logged_in": False,
            "duration_ms": 600_001,
        },
        # post_login_url is absent or an exact string, never another primitive.
        {
            "submitted": True,
            "credentials_truncated": False,
            "logged_in": False,
            "post_login_url": 5,
            "duration_ms": 1,
        },
    ],
)
def test_sync_login_rejects_hostile_primitive_body_as_transport_error(
    response: dict[str, object],
) -> None:
    with respx.mock(base_url=BASE) as mock:
        mock.post("/v1/sessions/ses_xx/login").mock(return_value=httpx.Response(200, json=response))
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            with pytest.raises(TransportError):
                client.sessions.login(
                    "ses_xx", {"username": "user@example.test", "password": "not-logged"}
                )


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
async def test_async_search_returns_direct_safe_refusal_attributes() -> None:
    response = {
        "submitted": False,
        "query_truncated": True,
        "duration_ms": 600_000,
    }
    with respx.mock(base_url=BASE) as mock:
        mock.post("/v1/sessions/ses_xx/search").mock(
            return_value=httpx.Response(200, json=response)
        )
        async with AsyncDriftstack(api_key=API_KEY, base_url=BASE) as client:
            result = await client.sessions.search("ses_xx", {"query": "wireless headphones"})

    assert isinstance(result, SearchResponse2)
    assert result.submitted is False
    assert result.query_truncated is True
    assert result.duration_ms == 600_000
    assert not hasattr(result, "results_visible")


@pytest.mark.asyncio
async def test_async_login_returns_direct_safe_refusal_attributes() -> None:
    response = {
        "submitted": False,
        "credentials_truncated": True,
        "logged_in": False,
        "duration_ms": 600_000,
    }
    with respx.mock(base_url=BASE) as mock:
        mock.post("/v1/sessions/ses_xx/login").mock(return_value=httpx.Response(200, json=response))
        async with AsyncDriftstack(api_key=API_KEY, base_url=BASE) as client:
            result = await client.sessions.login(
                "ses_xx", {"username": "user@example.test", "password": "not-logged"}
            )

    assert isinstance(result, SessionLoginResponse2)
    assert result.submitted is False
    assert result.credentials_truncated is True
    assert result.logged_in is False
    assert result.duration_ms == 600_000
    assert not hasattr(result, "post_login_url")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "response",
    [
        {"submitted": 1, "query_truncated": False, "duration_ms": 1},
        {"submitted": False, "query_truncated": 0, "duration_ms": 1},
        {"submitted": False, "query_truncated": False, "results_visible": 1, "duration_ms": 1},
        {"submitted": False, "query_truncated": False, "duration_ms": "1"},
    ],
)
async def test_async_search_rejects_hostile_primitive_body_as_transport_error(
    response: dict[str, object],
) -> None:
    """The async path shares one validator; drift here would leave it unguarded."""
    with respx.mock(base_url=BASE) as mock:
        mock.post("/v1/sessions/ses_xx/search").mock(
            return_value=httpx.Response(200, json=response)
        )
        async with AsyncDriftstack(api_key=API_KEY, base_url=BASE) as client:
            with pytest.raises(TransportError):
                await client.sessions.search("ses_xx", {"query": "wireless headphones"})


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "response",
    [
        {"submitted": 1, "credentials_truncated": False, "logged_in": False, "duration_ms": 1},
        {"submitted": False, "credentials_truncated": 1, "logged_in": False, "duration_ms": 1},
        {
            "submitted": True,
            "credentials_truncated": False,
            "logged_in": "false",
            "duration_ms": 1,
        },
        {"submitted": True, "credentials_truncated": False, "logged_in": False, "duration_ms": "1"},
    ],
)
async def test_async_login_rejects_hostile_primitive_body_as_transport_error(
    response: dict[str, object],
) -> None:
    """The async path shares one validator; drift here would leave it unguarded."""
    with respx.mock(base_url=BASE) as mock:
        mock.post("/v1/sessions/ses_xx/login").mock(return_value=httpx.Response(200, json=response))
        async with AsyncDriftstack(api_key=API_KEY, base_url=BASE) as client:
            with pytest.raises(TransportError):
                await client.sessions.login(
                    "ses_xx", {"username": "user@example.test", "password": "not-logged"}
                )


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


@pytest.mark.asyncio
async def test_async_get_session_schema_mismatch_raises_transport_error() -> None:
    """Async mirror of the sync schema-mismatch test above — the async
    client must wrap the escaping ``pydantic.ValidationError`` the same way."""
    malformed = {"id": "ses_xx"}
    with respx.mock(base_url=BASE) as mock:
        mock.get("/v1/sessions/ses_xx").mock(return_value=httpx.Response(200, json=malformed))
        async with AsyncDriftstack(api_key=API_KEY, base_url=BASE) as client:
            with pytest.raises(TransportError) as exc_info:
                await client.sessions.get("ses_xx")
    assert isinstance(exc_info.value, DriftstackError)
    assert isinstance(exc_info.value.__cause__, pydantic.ValidationError)

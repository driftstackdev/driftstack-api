"""AgentSessions resource tests — Python SDK parity with TS SDK AgentSessionsResource."""

from __future__ import annotations

import json

import httpx
import pytest
import respx

from driftstack import AsyncDriftstack, Driftstack
from driftstack.errors import RateLimitError, TransportError

API_KEY = "ds_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
BASE = "https://api.test"


SESSION_ENVELOPE = {
    "id": "agt_inmem_00000001",
    "account_id": "acc_1",
    "driftstack_session_id": None,
    "status": "active",
    "closed_reason": None,
    "token_budget_total": 100_000,
    "token_budget_remaining": 100_000,
    "transcript_length": 0,
    "closed_at": None,
    "created_by_user_id": None,
    "mode": "ai",
    "created_at": "2026-05-16T00:00:00Z",
    "updated_at": "2026-05-16T00:00:00Z",
}


def sse_response(status: int, body: object, *, heartbeat: bool = True) -> httpx.Response:
    prefix = ": stream open\n\n"
    if heartbeat:
        prefix += ": heartbeat 2026-07-13T21:00:00.000Z\n\n"
    terminal = json.dumps({"status": status, "body": body}, separators=(",", ":"))
    return httpx.Response(
        200,
        text=f"{prefix}event: response\ndata: {terminal}\n\n",
        headers={"content-type": "text/event-stream; charset=utf-8"},
    )


def test_sync_create_default_body() -> None:
    with respx.mock(base_url=BASE) as mock:
        route = mock.post("/v1/agent-sessions").mock(
            return_value=httpx.Response(201, json=SESSION_ENVELOPE),
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            out = client.agent_sessions.create()
        assert out["id"] == "agt_inmem_00000001"
        assert route.called


def test_sync_create_with_budget() -> None:
    with respx.mock(base_url=BASE) as mock:
        route = mock.post("/v1/agent-sessions").mock(
            return_value=httpx.Response(201, json=SESSION_ENVELOPE),
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            client.agent_sessions.create({"token_budget": 25_000})
        assert route.called


def test_sync_get_url_encoded() -> None:
    with respx.mock(base_url=BASE) as mock:
        route = mock.get("/v1/agent-sessions/agt%20xyz").mock(
            return_value=httpx.Response(200, json=SESSION_ENVELOPE),
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            client.agent_sessions.get("agt xyz")
        assert route.called


def test_sync_message_plan_response() -> None:
    reply = {
        "kind": "plan-executed",
        "session": SESSION_ENVELOPE,
        "intents": [{"kind": "navigate", "url": "https://example.com"}],
        "results": [
            {
                "kind": "success",
                "intent": {"kind": "navigate", "url": "https://example.com"},
                "summary": "navigated",
            }
        ],
        "ok": True,
    }
    with respx.mock(base_url=BASE) as mock:
        route = mock.post("/v1/agent-sessions/agt_1/message").mock(
            return_value=sse_response(200, reply),
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            out = client.agent_sessions.message("agt_1", "open https://example.com")
        assert out["kind"] == "plan-executed"
        assert out["ok"] is True
        assert route.called
        assert route.calls.last.request.headers["accept"] == "text/event-stream"


def test_sync_message_stream_maps_terminal_problem_and_rejects_missing_terminal() -> None:
    problem = {
        "type": "https://errors.driftstack.dev/rate-limited",
        "title": "Too Many Requests",
        "status": 429,
        "retry_after_seconds": 7,
    }
    with respx.mock(base_url=BASE) as mock:
        mock.post("/v1/agent-sessions/agt_1/message").mock(
            return_value=sse_response(429, problem),
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            with pytest.raises(RateLimitError) as caught:
                client.agent_sessions.message("agt_1", "hi")
        assert caught.value.retry_after_seconds == 7

    with respx.mock(base_url=BASE) as mock:
        mock.post("/v1/agent-sessions/agt_1/message").mock(
            return_value=httpx.Response(
                200,
                text=": heartbeat only\n\n",
                headers={"content-type": "text/event-stream"},
            ),
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            with pytest.raises(TransportError, match="without a terminal response"):
                client.agent_sessions.message("agt_1", "hi")


def test_sync_message_byok_api_key_sets_header() -> None:
    """BYOK convenience: passing ``byok_api_key`` sets the
    ``x-byok-anthropic-api-key`` header so callers don't construct it
    by hand. Matches the server-side header reading at
    apps/server/src/routes/agent-sessions.ts (commit 1b97a5e0)."""
    reply = {
        "kind": "clarify",
        "session": SESSION_ENVELOPE,
        "clarifying_question": "?",
    }
    with respx.mock(base_url=BASE) as mock:
        route = mock.post("/v1/agent-sessions/agt_1/message").mock(
            return_value=httpx.Response(200, json=reply),
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            client.agent_sessions.message("agt_1", "hi", byok_api_key="sk-ant-test-byok")
        assert route.called
        sent_headers = route.calls.last.request.headers
        assert sent_headers["x-byok-anthropic-api-key"] == "sk-ant-test-byok"


def test_sync_message_no_byok_omits_header() -> None:
    """Omitting ``byok_api_key`` sends NO byok header (distinguishes
    "no key" from "empty key" at the server boundary)."""
    reply = {"kind": "clarify", "session": SESSION_ENVELOPE, "clarifying_question": "?"}
    with respx.mock(base_url=BASE) as mock:
        route = mock.post("/v1/agent-sessions/agt_1/message").mock(
            return_value=httpx.Response(200, json=reply),
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            client.agent_sessions.message("agt_1", "hi")
        assert route.called
        sent_headers = route.calls.last.request.headers
        assert "x-byok-anthropic-api-key" not in sent_headers


def test_sync_message_empty_byok_omits_header() -> None:
    """Passing ``byok_api_key=""`` (empty string) sends NO byok header
    — cross-SDK parity with the Go SDK's ``opts.ByokAPIKey != ""`` guard
    and the TS SDK's ``byokApiKey.length > 0`` guard. Closes the slice
    105 / 106 round-trip skip: an empty client-side value used to send
    ``x-byok-anthropic-api-key:`` on the wire, which the server then
    normalised to absent — wasted round-trip header bytes."""
    reply = {"kind": "clarify", "session": SESSION_ENVELOPE, "clarifying_question": "?"}
    with respx.mock(base_url=BASE) as mock:
        route = mock.post("/v1/agent-sessions/agt_1/message").mock(
            return_value=httpx.Response(200, json=reply),
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            client.agent_sessions.message("agt_1", "hi", byok_api_key="")
        assert route.called
        sent_headers = route.calls.last.request.headers
        assert "x-byok-anthropic-api-key" not in sent_headers


def test_sync_create_idempotency_key_sets_header() -> None:
    """v2-#19 — passing ``idempotency_key`` forwards the
    ``Idempotency-Key`` request header so server-side dedupe collapses
    retries onto a single row."""
    with respx.mock(base_url=BASE) as mock:
        route = mock.post("/v1/agent-sessions").mock(
            return_value=httpx.Response(201, json=SESSION_ENVELOPE),
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            client.agent_sessions.create(idempotency_key="idem-py-test")
        assert route.called
        sent_headers = route.calls.last.request.headers
        assert sent_headers["Idempotency-Key"] == "idem-py-test"


def test_sync_create_no_idempotency_key_omits_header() -> None:
    """Omitting ``idempotency_key`` sends NO Idempotency-Key header
    (header is opt-in; parity with the TS + Go SDKs)."""
    with respx.mock(base_url=BASE) as mock:
        route = mock.post("/v1/agent-sessions").mock(
            return_value=httpx.Response(201, json=SESSION_ENVELOPE),
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            client.agent_sessions.create()
        sent_headers = route.calls.last.request.headers
        assert "Idempotency-Key" not in sent_headers


def test_sync_close_delete() -> None:
    with respx.mock(base_url=BASE) as mock:
        route = mock.delete("/v1/agent-sessions/agt_1").mock(
            return_value=httpx.Response(204),
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            client.agent_sessions.close("agt_1")
        assert route.called


# Arc 2 sub-slice 8.9 (v2-#8) — pair-mode takeover/handback Python SDK.
def test_sync_takeover_posts_with_client_id() -> None:
    reply = {"pair_mode_state": {"kind": "takeover-pending"}}
    with respx.mock(base_url=BASE) as mock:
        route = mock.post("/v1/agent-sessions/agt_1/takeover").mock(
            return_value=httpx.Response(200, json=reply),
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            out = client.agent_sessions.takeover("agt_1", "cli_a")
        assert route.called
        assert out["pair_mode_state"]["kind"] == "takeover-pending"


def test_sync_handback_posts_empty_body() -> None:
    reply = {"pair_mode_state": {"kind": "handback-pending"}}
    with respx.mock(base_url=BASE) as mock:
        route = mock.post("/v1/agent-sessions/agt_1/handback").mock(
            return_value=httpx.Response(200, json=reply),
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            out = client.agent_sessions.handback("agt_1")
        assert route.called
        assert out["pair_mode_state"]["kind"] == "handback-pending"


# LK.3 — Python SDK livekit_token() helper for re-minting after the
# 24h TTL. Cross-SDK parity with TS / Go (same shape, same paths).
def test_sync_livekit_token_posts_no_body() -> None:
    reply = {
        "ws_url": "wss://mac-011.driftstack.dev:8443",
        "room": "agt_lk",
        "token": "eyJhbGciOiJIUzI1NiJ9.fake",
        "participant_identity": "subscriber_acc_1",
        "expires_at": "2026-05-19T00:00:00Z",
    }
    with respx.mock(base_url=BASE) as mock:
        route = mock.post("/v1/agent-sessions/agt_lk/livekit-token").mock(
            return_value=httpx.Response(200, json=reply),
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            out = client.agent_sessions.livekit_token("agt_lk")
        assert route.called
        assert out["ws_url"] == "wss://mac-011.driftstack.dev:8443"
        assert out["token"] == "eyJhbGciOiJIUzI1NiJ9.fake"
        assert out["expires_at"] == "2026-05-19T00:00:00Z"


def test_sync_livekit_token_url_encodes_session_id() -> None:
    # The session id segment must round-trip through quote(safe=''),
    # so a space in the id lands as %20 on the wire. Matches the
    # test_sync_get_url_encoded pattern.
    reply = {
        "ws_url": "wss://mac-012.driftstack.dev:8443",
        "room": "agt xyz",
        "token": "eyJhbGciOiJIUzI1NiJ9.fake",
        "participant_identity": "subscriber_acc_2",
        "expires_at": "2026-05-19T00:00:00Z",
    }
    with respx.mock(base_url=BASE) as mock:
        route = mock.post("/v1/agent-sessions/agt%20xyz/livekit-token").mock(
            return_value=httpx.Response(200, json=reply),
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            client.agent_sessions.livekit_token("agt xyz")
        assert route.called


@pytest.mark.asyncio
async def test_async_livekit_token_posts_no_body() -> None:
    reply = {
        "ws_url": "wss://mac-013.driftstack.dev:8443",
        "room": "agt_lk_async",
        "token": "eyJhbGciOiJIUzI1NiJ9.fake",
        "participant_identity": "subscriber_acc_3",
        "expires_at": "2026-05-19T00:00:00Z",
    }
    with respx.mock(base_url=BASE) as mock:
        route = mock.post("/v1/agent-sessions/agt_lk_async/livekit-token").mock(
            return_value=httpx.Response(200, json=reply),
        )
        async with AsyncDriftstack(api_key=API_KEY, base_url=BASE) as client:
            out = await client.agent_sessions.livekit_token("agt_lk_async")
        assert route.called
        assert out["ws_url"] == "wss://mac-013.driftstack.dev:8443"


@pytest.mark.asyncio
async def test_async_create_default_body() -> None:
    with respx.mock(base_url=BASE) as mock:
        route = mock.post("/v1/agent-sessions").mock(
            return_value=httpx.Response(201, json=SESSION_ENVELOPE),
        )
        async with AsyncDriftstack(api_key=API_KEY, base_url=BASE) as client:
            out = await client.agent_sessions.create()
        assert out["id"] == "agt_inmem_00000001"
        assert route.called


@pytest.mark.asyncio
async def test_async_message_clarify_response() -> None:
    reply = {
        "kind": "clarify",
        "session": SESSION_ENVELOPE,
        "clarifying_question": "What action do you want me to take?",
    }
    with respx.mock(base_url=BASE) as mock:
        route = mock.post("/v1/agent-sessions/agt_1/message").mock(
            return_value=sse_response(200, reply),
        )
        async with AsyncDriftstack(api_key=API_KEY, base_url=BASE) as client:
            out = await client.agent_sessions.message("agt_1", "do stuff")
        assert out["kind"] == "clarify"
        assert "clarifying_question" in out
        assert route.calls.last.request.headers["accept"] == "text/event-stream"


@pytest.mark.asyncio
async def test_async_message_byok_api_key_sets_header() -> None:
    """Async parity with test_sync_message_byok_api_key_sets_header.
    Confirms the AsyncAgentSessionsResource.message path also forwards
    the x-byok-anthropic-api-key header — the production code at
    agent_sessions.py:233 uses the same `if byok_api_key` guard as the
    sync variant, so a future refactor that touches one variant but
    not the other would now trip a test."""
    reply = {"kind": "clarify", "session": SESSION_ENVELOPE, "clarifying_question": "?"}
    with respx.mock(base_url=BASE) as mock:
        route = mock.post("/v1/agent-sessions/agt_1/message").mock(
            return_value=httpx.Response(200, json=reply),
        )
        async with AsyncDriftstack(api_key=API_KEY, base_url=BASE) as client:
            await client.agent_sessions.message("agt_1", "hi", byok_api_key="sk-ant-test-byok")
        assert route.called
        sent_headers = route.calls.last.request.headers
        assert sent_headers["x-byok-anthropic-api-key"] == "sk-ant-test-byok"


@pytest.mark.asyncio
async def test_async_message_empty_byok_omits_header() -> None:
    """Async parity with test_sync_message_empty_byok_omits_header
    (slice 127). The async variant carries the same `if byok_api_key`
    guard — empty string is falsy in Python so the header is skipped.
    Test pins the behaviour so the async path doesn't drift from the
    sync path independently."""
    reply = {"kind": "clarify", "session": SESSION_ENVELOPE, "clarifying_question": "?"}
    with respx.mock(base_url=BASE) as mock:
        route = mock.post("/v1/agent-sessions/agt_1/message").mock(
            return_value=httpx.Response(200, json=reply),
        )
        async with AsyncDriftstack(api_key=API_KEY, base_url=BASE) as client:
            await client.agent_sessions.message("agt_1", "hi", byok_api_key="")
        assert route.called
        sent_headers = route.calls.last.request.headers
        assert "x-byok-anthropic-api-key" not in sent_headers

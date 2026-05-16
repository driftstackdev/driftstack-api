"""AgentSessions resource tests — Python SDK parity with TS SDK AgentSessionsResource."""

from __future__ import annotations

import httpx
import pytest
import respx

from driftstack import AsyncDriftstack, Driftstack

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
    "created_at": "2026-05-16T00:00:00Z",
    "updated_at": "2026-05-16T00:00:00Z",
}


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
            return_value=httpx.Response(200, json=reply),
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            out = client.agent_sessions.message("agt_1", "open https://example.com")
        assert out["kind"] == "plan-executed"
        assert out["ok"] is True
        assert route.called


def test_sync_close_delete() -> None:
    with respx.mock(base_url=BASE) as mock:
        route = mock.delete("/v1/agent-sessions/agt_1").mock(
            return_value=httpx.Response(204),
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            client.agent_sessions.close("agt_1")
        assert route.called


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
        mock.post("/v1/agent-sessions/agt_1/message").mock(
            return_value=httpx.Response(200, json=reply),
        )
        async with AsyncDriftstack(api_key=API_KEY, base_url=BASE) as client:
            out = await client.agent_sessions.message("agt_1", "do stuff")
        assert out["kind"] == "clarify"
        assert "clarifying_question" in out

"""B2 — ``agent_sessions.stop()``: the request it puts on the wire, and both answers."""

from __future__ import annotations

import json

import httpx
import pytest
import respx

from driftstack import AsyncDriftstack, Driftstack

API_KEY = "ds_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
BASE = "https://api.test"


def test_sync_stop_posts_an_empty_body_to_the_stop_path() -> None:
    with respx.mock(base_url=BASE) as mock:
        route = mock.post("/v1/agent-sessions/agt%20xyz/stop").mock(
            return_value=httpx.Response(
                202, json={"status": "stop_requested", "session_id": "agt xyz"}
            ),
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            out = client.agent_sessions.stop("agt xyz")
        assert route.called
        # The server's body schema is strict: an empty object and nothing else.
        assert json.loads(route.calls.last.request.content) == {}
        assert out == {"status": "stop_requested", "session_id": "agt xyz"}


def test_sync_stop_with_nothing_running_is_a_success() -> None:
    with respx.mock(base_url=BASE) as mock:
        mock.post("/v1/agent-sessions/agt_1/stop").mock(
            return_value=httpx.Response(
                200, json={"status": "no_turn_running", "session_id": "agt_1"}
            ),
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            out = client.agent_sessions.stop("agt_1")
        assert out["status"] == "no_turn_running"


@pytest.mark.asyncio
async def test_async_stop_mirrors_sync() -> None:
    with respx.mock(base_url=BASE) as mock:
        route = mock.post("/v1/agent-sessions/agt_1/stop").mock(
            return_value=httpx.Response(
                202, json={"status": "stop_requested", "session_id": "agt_1"}
            ),
        )
        async with AsyncDriftstack(api_key=API_KEY, base_url=BASE) as client:
            out = await client.agent_sessions.stop("agt_1")
        assert route.called
        assert json.loads(route.calls.last.request.content) == {}
        assert out["status"] == "stop_requested"

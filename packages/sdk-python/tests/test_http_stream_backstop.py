"""The SSE reader must bound total wall-clock, not just idle time.

httpx's timeout is a per-READ idle deadline. The server sends keep-alive
comments every 15s, so that deadline is reset forever by exactly the traffic
that signals nothing is finishing — a stream that heartbeats but never emits its
terminal ``event: response`` would block a Python caller indefinitely. The 8 MiB
byte ceiling is no help either: heartbeat comments are a few bytes each, so
reaching it would take longer than any caller would wait.

The TypeScript SDK caps one agent turn at ``AGENT_MESSAGE_STREAM_TIMEOUT_MS``
(50 minutes) and the Go SDK at ``AgentMessageStreamTimeout``; Python had no
equivalent. These tests pin the backstop and its parity with the other two.
"""

from __future__ import annotations

import time
from collections.abc import AsyncIterator, Iterator

import httpx
import pytest
import respx

from driftstack.errors import TransportError
from driftstack.http import AGENT_MESSAGE_STREAM_TIMEOUT_S, AsyncHttpClient, HttpClient

BASE = "https://api.test"
API_KEY = "ds_test_key"
SSE_HEADERS = {"content-type": "text/event-stream; charset=utf-8"}


def endless_heartbeats() -> Iterator[bytes]:
    """A stream that stays healthy forever and never terminates.

    This is the shape that defeats an idle-only timeout: every read succeeds, so
    nothing ever looks wrong to httpx.
    """
    yield b": stream open\n\n"
    while True:
        time.sleep(0.002)
        yield b": heartbeat\n\n"


async def endless_heartbeats_async() -> AsyncIterator[bytes]:
    yield b": stream open\n\n"
    while True:
        yield b": heartbeat\n\n"


def test_backstop_matches_the_other_sdks() -> None:
    """50 minutes, the same ceiling the TypeScript and Go SDKs enforce.

    Drift here is silent: a shorter Python ceiling aborts turns the server would
    still have completed, a longer one re-opens the hang this exists to close.
    """
    assert AGENT_MESSAGE_STREAM_TIMEOUT_S == 50 * 60


def test_sync_stream_gives_up_at_the_backstop() -> None:
    with respx.mock(base_url=BASE) as mock:
        mock.post("/v1/agent-sessions/agt_1/message").mock(
            return_value=httpx.Response(200, headers=SSE_HEADERS, content=endless_heartbeats()),
        )
        http = HttpClient(API_KEY, base_url=BASE)
        started = time.monotonic()
        with pytest.raises(TransportError) as excinfo:
            http.request_event_stream(
                "POST",
                "/v1/agent-sessions/agt_1/message",
                json_body={"user_message": "hi"},
                stream_timeout_s=0.05,
            )
        http.close()

    assert "absolute timeout" in str(excinfo.value)
    # It gave up promptly rather than reading until some other limit tripped.
    assert time.monotonic() - started < 5


@pytest.mark.asyncio
async def test_async_stream_gives_up_at_the_backstop() -> None:
    async with respx.mock(base_url=BASE) as mock:
        mock.post("/v1/agent-sessions/agt_1/message").mock(
            return_value=httpx.Response(
                200, headers=SSE_HEADERS, content=endless_heartbeats_async()
            ),
        )
        http = AsyncHttpClient(API_KEY, base_url=BASE)
        with pytest.raises(TransportError) as excinfo:
            await http.request_event_stream(
                "POST",
                "/v1/agent-sessions/agt_1/message",
                json_body={"user_message": "hi"},
                stream_timeout_s=0.05,
            )
        await http.aclose()

    assert "absolute timeout" in str(excinfo.value)


def test_a_terminating_stream_is_unaffected() -> None:
    """The differential arm.

    Without it, every assertion above is satisfied by a reader that refuses all
    streams — which would break every agent turn instead of only the hung ones.
    """
    terminal = b'event: response\ndata: {"status":200,"body":{"ok":true}}\n\n'
    with respx.mock(base_url=BASE) as mock:
        mock.post("/v1/agent-sessions/agt_1/message").mock(
            return_value=httpx.Response(
                200, headers=SSE_HEADERS, content=b": stream open\n\n" + terminal
            ),
        )
        http = HttpClient(API_KEY, base_url=BASE)
        out = http.request_event_stream(
            "POST",
            "/v1/agent-sessions/agt_1/message",
            json_body={"user_message": "hi"},
            stream_timeout_s=30,
        )
        http.close()

    assert out["ok"] is True

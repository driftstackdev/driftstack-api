"""A screenshot and the transcript can be read through the Python SDK.

A ``capture`` step hands back a ``captureId``, and the conversation lives behind
an event stream. Neither was reachable from this SDK: a program had to write its
own binary fetch and its own SSE reader. Every arm drives the real client
through respx, on the sync and the async client, so the request the SDK
assembles, the way it reads a body that is not JSON, and the bounds it holds a
stream to are all exercised.
"""

from __future__ import annotations

import contextlib
import json
from collections.abc import AsyncIterator, Iterator
from typing import Any

import httpx
import pytest
import respx

from driftstack import AsyncDriftstack, Driftstack
from driftstack import http as sdk_http
from driftstack.errors import NotFoundError, RateLimitError, TransportError
from driftstack.retry import RetryConfig

API_KEY = "ds_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
BASE = "https://api.test"
SSE_HEADERS = {"content-type": "text/event-stream; charset=utf-8"}
CAPTURE_PATH = "/v1/agent-sessions/agt_1/captures/cap_9"
TRANSCRIPT_PATH = "/v1/agent-sessions/agt_1/transcript"

# The PNG signature, then bytes that are not valid UTF-8: reading them as text
# and back would corrupt them, which is what a JSON-only client does.
PNG = bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0xFF, 0xFE, 0x00, 0x80])

NO_RETRY = RetryConfig(enabled=False)


def problem(status: int, type_: str, **ext: Any) -> dict[str, Any]:
    return {
        "type": f"https://errors.driftstack.dev/{type_}",
        "title": type_,
        "status": status,
        **ext,
    }


def entry_frame(index: int, role: str, body: str) -> str:
    data = {"index": index, "entry": {"role": role, "body": body, "at": "2026-09-19T00:00:00Z"}}
    return f"id: {index}\nevent: transcript.entry\ndata: {json.dumps(data)}\n\n"


TRANSCRIPT = "".join(
    [
        ": stream open\n\n",
        entry_frame(0, "user", "Open the invoices page."),
        entry_frame(1, "agent", "navigate https://portal.example.test/invoices"),
        ": heartbeat 2026-09-19T00:00:30.000Z\n\n",
        "event: transcript.entry\ndata: {not json\n\n",
        'event: something.new\ndata: {"index":7,"entry":{}}\n\n',
        # An index that is not a number is not an entry this SDK can place.
        'event: transcript.entry\ndata: {"index":"3","entry":{}}\n\n',
        entry_frame(2, "user", "And the total?"),
    ]
)
EXPECTED = [
    (0, "user", "Open the invoices page."),
    (1, "agent", "navigate https://portal.example.test/invoices"),
    (2, "user", "And the total?"),
]


def chunked(text: str, size: int) -> Iterator[bytes]:
    """Split a stream at arbitrary byte offsets, mid-frame included."""
    raw = text.encode()
    for i in range(0, len(raw), size):
        yield raw[i : i + size]


class RecordingStream(httpx.SyncByteStream):
    """A body that never ends by itself, and records being closed."""

    def __init__(self, frames: list[str]) -> None:
        self._frames = frames
        self.closed = False

    def __iter__(self) -> Iterator[bytes]:
        for f in self._frames:
            yield f.encode()
        # The server keeps a transcript stream open: reading past the entries
        # that exist must not look like the end of the stream.
        raise AssertionError("the SDK read past the entry the caller stopped at")

    def close(self) -> None:
        self.closed = True


class AsyncRecordingStream(httpx.AsyncByteStream):
    def __init__(self, frames: list[str]) -> None:
        self._frames = frames
        self.closed = False

    async def __aiter__(self) -> AsyncIterator[bytes]:
        for f in self._frames:
            yield f.encode()
        raise AssertionError("the SDK read past the entry the caller stopped at")

    async def aclose(self) -> None:
        self.closed = True


# ── screenshots ───────────────────────────────────────────────────────────


def test_get_capture_returns_the_bytes_exactly_as_sent_with_their_media_type() -> None:
    with respx.mock(base_url=BASE) as mock:
        route = mock.get(CAPTURE_PATH).mock(
            return_value=httpx.Response(200, headers={"content-type": "image/png"}, content=PNG)
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            shot = client.agent_sessions.get_capture("agt_1", "cap_9")
        request = route.calls.last.request
    assert shot == {"content_type": "image/png", "bytes": PNG}
    assert isinstance(shot["bytes"], bytes)
    assert request.method == "GET"
    assert request.headers["authorization"] == f"Bearer {API_KEY}"
    assert request.content == b""
    # Not "application/json": this request is for an image.
    assert request.headers["accept"] == "*/*"


def test_get_capture_says_jpeg_for_a_jpeg_without_the_header_parameters() -> None:
    with respx.mock(base_url=BASE) as mock:
        mock.get(CAPTURE_PATH).mock(
            return_value=httpx.Response(
                200, headers={"content-type": "Image/JPEG; charset=binary"}, content=PNG
            )
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            assert client.agent_sessions.get_capture("agt_1", "cap_9")["content_type"] == (
                "image/jpeg"
            )


def test_get_capture_escapes_both_ids() -> None:
    with respx.mock(base_url=BASE) as mock:
        route = mock.get(url__regex=r".*/captures/.*").mock(
            return_value=httpx.Response(200, headers={"content-type": "image/png"}, content=PNG)
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            client.agent_sessions.get_capture("agt/../x", "cap 1/2")
        assert route.calls.last.request.url.raw_path == (
            b"/v1/agent-sessions/agt%2F..%2Fx/captures/cap%201%2F2"
        )


def test_a_screenshot_that_is_no_longer_kept_is_not_found_not_an_empty_image() -> None:
    with respx.mock(base_url=BASE) as mock:
        mock.get(CAPTURE_PATH).mock(
            return_value=httpx.Response(404, json=problem(404, "not-found"))
        )
        with Driftstack(api_key=API_KEY, base_url=BASE, retry=NO_RETRY) as client:
            with pytest.raises(NotFoundError):
                client.agent_sessions.get_capture("agt_1", "cap_9")


def test_get_capture_is_retried_like_any_other_get() -> None:
    with respx.mock(base_url=BASE) as mock:
        route = mock.get(CAPTURE_PATH).mock(
            side_effect=[
                httpx.Response(500, json=problem(500, "internal")),
                httpx.Response(200, headers={"content-type": "image/png"}, content=PNG),
            ]
        )
        retry = RetryConfig(max_retries=2, initial_delay_ms=1, max_delay_ms=2)
        with Driftstack(api_key=API_KEY, base_url=BASE, retry=retry) as client:
            shot = client.agent_sessions.get_capture("agt_1", "cap_9")
        assert route.call_count == 2
    assert shot["bytes"] == PNG


def test_get_capture_refuses_a_body_larger_than_the_response_ceiling(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(sdk_http, "MAX_RESPONSE_BODY_BYTES", 8)
    with respx.mock(base_url=BASE) as mock:
        mock.get(CAPTURE_PATH).mock(
            return_value=httpx.Response(200, headers={"content-type": "image/png"}, content=PNG)
        )
        with Driftstack(api_key=API_KEY, base_url=BASE, retry=NO_RETRY) as client:
            with pytest.raises(TransportError, match="exceeds 8-byte limit"):
                client.agent_sessions.get_capture("agt_1", "cap_9")


@pytest.mark.asyncio
async def test_async_get_capture_returns_the_same_thing() -> None:
    async with respx.mock(base_url=BASE) as mock:
        mock.get(CAPTURE_PATH).mock(
            return_value=httpx.Response(200, headers={"content-type": "image/png"}, content=PNG)
        )
        async with AsyncDriftstack(api_key=API_KEY, base_url=BASE) as client:
            shot = await client.agent_sessions.get_capture("agt_1", "cap_9")
    assert shot == {"content_type": "image/png", "bytes": PNG}


@pytest.mark.asyncio
async def test_async_get_capture_raises_not_found() -> None:
    async with respx.mock(base_url=BASE) as mock:
        mock.get(CAPTURE_PATH).mock(
            return_value=httpx.Response(404, json=problem(404, "not-found"))
        )
        async with AsyncDriftstack(api_key=API_KEY, base_url=BASE, retry=NO_RETRY) as client:
            with pytest.raises(NotFoundError):
                await client.agent_sessions.get_capture("agt_1", "cap_9")


# ── the transcript ────────────────────────────────────────────────────────


def test_transcript_yields_each_entry_in_order_and_skips_everything_else() -> None:
    with respx.mock(base_url=BASE) as mock:
        route = mock.get(TRANSCRIPT_PATH).mock(
            # 17-byte chunks: every frame arrives split across several reads.
            return_value=httpx.Response(200, headers=SSE_HEADERS, content=chunked(TRANSCRIPT, 17))
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            events = list(client.agent_sessions.transcript("agt_1"))
        request = route.calls.last.request
    assert [(e["index"], e["entry"]["role"], e["entry"]["body"]) for e in events] == EXPECTED
    assert request.headers["accept"] == "text/event-stream"
    assert request.headers["authorization"] == f"Bearer {API_KEY}"
    assert "last-event-id" not in request.headers, "a first read replays from the beginning"


def test_last_event_id_resumes_after_it_including_zero_which_is_an_index_not_unset() -> None:
    with respx.mock(base_url=BASE) as mock:
        route = mock.get(TRANSCRIPT_PATH).mock(
            return_value=httpx.Response(200, headers=SSE_HEADERS, content=b"")
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            list(client.agent_sessions.transcript("agt_1", last_event_id=0))
            list(client.agent_sessions.transcript("agt_1", last_event_id=41))
        sent = [call.request.headers["last-event-id"] for call in route.calls]
    assert sent == ["0", "41"]


def test_leaving_the_loop_closes_the_connection() -> None:
    body = RecordingStream([entry_frame(0, "user", "one"), entry_frame(1, "agent", "two")])
    with respx.mock(base_url=BASE) as mock:
        mock.get(TRANSCRIPT_PATH).mock(
            return_value=httpx.Response(200, headers=SSE_HEADERS, stream=body)
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            transcript_length = 2
            seen: list[int] = []
            with contextlib.closing(client.agent_sessions.transcript("agt_1")) as events:
                for event in events:
                    seen.append(event["index"])
                    if event["index"] == transcript_length - 1:
                        break
            assert body.closed, "the response was closed when the iterator was"
    assert seen == [0, 1]


def test_the_stream_is_held_to_an_absolute_time_limit(monkeypatch: pytest.MonkeyPatch) -> None:
    # Fifty minutes by default, the same backstop a message has.
    assert sdk_http.AGENT_MESSAGE_STREAM_TIMEOUT_S == 50 * 60.0
    clock = {"now": 1000.0}
    monkeypatch.setattr(sdk_http.time, "monotonic", lambda: clock["now"])

    def frames() -> Iterator[bytes]:
        yield entry_frame(0, "user", "one").encode()
        clock["now"] += 50 * 60.0 + 1  # the keep-alives went on past the limit
        yield b": heartbeat\n\n"
        yield entry_frame(1, "agent", "never read").encode()

    with respx.mock(base_url=BASE) as mock:
        mock.get(TRANSCRIPT_PATH).mock(
            return_value=httpx.Response(200, headers=SSE_HEADERS, content=frames())
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            seen: list[int] = []
            events = client.agent_sessions.transcript("agt_1")
            seen.append(next(events)["index"])
            with pytest.raises(TransportError, match="exceeded its absolute timeout"):
                next(events)
    assert seen == [0]


def test_timeout_s_sets_that_limit_for_one_call(monkeypatch: pytest.MonkeyPatch) -> None:
    clock = {"now": 1000.0}
    monkeypatch.setattr(sdk_http.time, "monotonic", lambda: clock["now"])

    def frames() -> Iterator[bytes]:
        yield entry_frame(0, "user", "one").encode()
        clock["now"] += 6
        yield entry_frame(1, "agent", "two").encode()

    with respx.mock(base_url=BASE) as mock:
        mock.get(TRANSCRIPT_PATH).mock(
            return_value=httpx.Response(200, headers=SSE_HEADERS, content=frames())
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            with pytest.raises(TransportError, match="exceeded its absolute timeout"):
                list(client.agent_sessions.transcript("agt_1", timeout_s=5))


def test_a_quiet_stream_is_not_cut_at_the_default_thirty_second_read_timeout() -> None:
    """The server's keep-alive arrives about every 30 seconds, which is httpx's
    default read timeout. The stream asks for a read-idle limit it can survive."""
    with respx.mock(base_url=BASE) as mock:
        route = mock.get(TRANSCRIPT_PATH).mock(
            return_value=httpx.Response(200, headers=SSE_HEADERS, content=b"")
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            list(client.agent_sessions.transcript("agt_1"))
        timeout = route.calls.last.request.extensions["timeout"]
    assert timeout["read"] == sdk_http.OPEN_EVENT_STREAM_READ_IDLE_S
    assert timeout["read"] >= 60
    assert timeout["connect"] == sdk_http.DEFAULT_TIMEOUT_S


def test_the_whole_stream_is_held_to_the_response_ceiling(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sdk_http, "MAX_RESPONSE_BODY_BYTES", 64)
    with respx.mock(base_url=BASE) as mock:
        mock.get(TRANSCRIPT_PATH).mock(
            return_value=httpx.Response(200, headers=SSE_HEADERS, content=chunked(TRANSCRIPT, 17))
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            with pytest.raises(TransportError, match="exceeds 64-byte limit"):
                list(client.agent_sessions.transcript("agt_1"))


def test_the_eleventh_open_stream_is_a_rate_limit_error_that_says_how_long_to_wait() -> None:
    with respx.mock(base_url=BASE) as mock:
        route = mock.get(TRANSCRIPT_PATH).mock(
            return_value=httpx.Response(
                429,
                headers={"retry-after": "30"},
                json=problem(429, "rate-limited", retry_after_seconds=30),
            )
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            with pytest.raises(RateLimitError) as caught:
                list(client.agent_sessions.transcript("agt_1"))
        # Never retried: the caller knows where to resume from.
        assert route.call_count == 1
    assert caught.value.retry_after_seconds == 30


def test_an_unknown_session_is_not_found_and_a_200_that_is_not_a_stream_is_a_contract_error() -> (
    None
):
    with respx.mock(base_url=BASE) as mock:
        mock.get(TRANSCRIPT_PATH).mock(
            return_value=httpx.Response(404, json=problem(404, "not-found"))
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            with pytest.raises(NotFoundError):
                list(client.agent_sessions.transcript("agt_1"))
    with respx.mock(base_url=BASE) as mock:
        mock.get(TRANSCRIPT_PATH).mock(return_value=httpx.Response(200, json={}))
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            with pytest.raises(TransportError, match="expected an event stream"):
                list(client.agent_sessions.transcript("agt_1"))


def test_nothing_is_requested_until_the_transcript_is_iterated() -> None:
    with respx.mock(base_url=BASE, assert_all_called=False) as mock:
        route = mock.get(TRANSCRIPT_PATH).mock(
            return_value=httpx.Response(200, headers=SSE_HEADERS, content=b"")
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            client.agent_sessions.transcript("agt_1")
        assert route.call_count == 0


@pytest.mark.asyncio
async def test_async_transcript_yields_the_same_entries_with_async_for() -> None:
    async def achunked() -> AsyncIterator[bytes]:
        for chunk in chunked(TRANSCRIPT, 17):
            yield chunk

    async with respx.mock(base_url=BASE) as mock:
        route = mock.get(TRANSCRIPT_PATH).mock(
            return_value=httpx.Response(200, headers=SSE_HEADERS, content=achunked())
        )
        async with AsyncDriftstack(api_key=API_KEY, base_url=BASE) as client:
            events = [e async for e in client.agent_sessions.transcript("agt_1", last_event_id=0)]
        request = route.calls.last.request
    assert [(e["index"], e["entry"]["role"], e["entry"]["body"]) for e in events] == EXPECTED
    assert request.headers["last-event-id"] == "0"
    assert request.headers["accept"] == "text/event-stream"
    assert request.extensions["timeout"]["read"] == sdk_http.OPEN_EVENT_STREAM_READ_IDLE_S


@pytest.mark.asyncio
async def test_async_closing_the_iterator_closes_the_connection() -> None:
    body = AsyncRecordingStream([entry_frame(0, "user", "one"), entry_frame(1, "agent", "two")])
    async with respx.mock(base_url=BASE) as mock:
        mock.get(TRANSCRIPT_PATH).mock(
            return_value=httpx.Response(200, headers=SSE_HEADERS, stream=body)
        )
        async with AsyncDriftstack(api_key=API_KEY, base_url=BASE) as client:
            seen: list[int] = []
            async with contextlib.aclosing(client.agent_sessions.transcript("agt_1")) as events:
                async for event in events:
                    seen.append(event["index"])
                    if event["index"] == 1:
                        break
            assert body.closed
    assert seen == [0, 1]


@pytest.mark.asyncio
async def test_async_transcript_raises_the_typed_error_and_the_time_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async with respx.mock(base_url=BASE) as mock:
        mock.get(TRANSCRIPT_PATH).mock(
            return_value=httpx.Response(
                429, json=problem(429, "rate-limited", retry_after_seconds=30)
            )
        )
        async with AsyncDriftstack(api_key=API_KEY, base_url=BASE) as client:
            with pytest.raises(RateLimitError):
                async for _ in client.agent_sessions.transcript("agt_1"):
                    pass

    clock = {"now": 1000.0}
    monkeypatch.setattr(sdk_http.time, "monotonic", lambda: clock["now"])

    async def frames() -> AsyncIterator[bytes]:
        yield entry_frame(0, "user", "one").encode()
        clock["now"] += 6
        yield entry_frame(1, "agent", "two").encode()

    async with respx.mock(base_url=BASE) as mock:
        mock.get(TRANSCRIPT_PATH).mock(
            return_value=httpx.Response(200, headers=SSE_HEADERS, content=frames())
        )
        async with AsyncDriftstack(api_key=API_KEY, base_url=BASE) as client:
            with pytest.raises(TransportError, match="exceeded its absolute timeout"):
                async for _ in client.agent_sessions.transcript("agt_1", timeout_s=5):
                    pass

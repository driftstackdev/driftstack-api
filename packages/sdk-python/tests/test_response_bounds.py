"""Response streaming and memory-ceiling regression tests."""

from __future__ import annotations

from collections.abc import AsyncIterator, Iterator

import httpx
import pytest

from driftstack.errors import TransportError
from driftstack.http import MAX_RESPONSE_BODY_BYTES, AsyncHttpClient, HttpClient
from driftstack.retry import RetryConfig

API_KEY = "ds_test_response_bounds"
BASE = "https://api.test"
NO_RETRY = RetryConfig(enabled=False)
CHUNK_BYTES = 64 * 1024


class SyncChunks(httpx.SyncByteStream):
    def __init__(self, count: int) -> None:
        self.count = count
        self.yielded = 0
        self.closed = False

    def __iter__(self) -> Iterator[bytes]:
        chunk = b"x" * CHUNK_BYTES
        for _ in range(self.count):
            self.yielded += 1
            yield chunk

    def close(self) -> None:
        self.closed = True


class AsyncChunks(httpx.AsyncByteStream):
    def __init__(self, count: int) -> None:
        self.count = count
        self.yielded = 0
        self.closed = False

    async def __aiter__(self) -> AsyncIterator[bytes]:
        chunk = b"x" * CHUNK_BYTES
        for _ in range(self.count):
            self.yielded += 1
            yield chunk

    async def aclose(self) -> None:
        self.closed = True


@pytest.mark.parametrize("status", [200, 500])
def test_sync_rejects_declared_oversize_before_iteration(status: int) -> None:
    stream = SyncChunks(1)

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            status,
            headers={"content-length": str(MAX_RESPONSE_BODY_BYTES + 1)},
            stream=stream,
        )

    client = httpx.Client(transport=httpx.MockTransport(handler))
    http = HttpClient(API_KEY, base_url=BASE, client=client, retry=NO_RETRY)
    try:
        with pytest.raises(TransportError) as caught:
            http.request("GET", "/v1/x")
    finally:
        client.close()

    assert caught.value.status == status
    assert str(caught.value) == "response body exceeds 8388608-byte limit"
    assert stream.yielded == 0
    assert stream.closed is True


def test_sync_caps_unknown_length_body_and_closes_stream() -> None:
    stream = SyncChunks(MAX_RESPONSE_BODY_BYTES // CHUNK_BYTES + 1)

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, stream=stream)

    client = httpx.Client(transport=httpx.MockTransport(handler))
    http = HttpClient(API_KEY, base_url=BASE, client=client, retry=NO_RETRY)
    try:
        with pytest.raises(TransportError, match="response body exceeds 8388608-byte limit"):
            http.request("GET", "/v1/x")
    finally:
        client.close()

    assert stream.yielded == MAX_RESPONSE_BODY_BYTES // CHUNK_BYTES + 1
    assert stream.closed is True


@pytest.mark.asyncio
async def test_async_caps_unknown_length_body_and_closes_stream() -> None:
    stream = AsyncChunks(MAX_RESPONSE_BODY_BYTES // CHUNK_BYTES + 1)

    async def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, stream=stream)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    http = AsyncHttpClient(API_KEY, base_url=BASE, client=client, retry=NO_RETRY)
    try:
        with pytest.raises(TransportError) as caught:
            await http.request("GET", "/v1/x")
    finally:
        await client.aclose()

    assert caught.value.status == 500
    assert str(caught.value) == "response body exceeds 8388608-byte limit"
    assert stream.yielded == MAX_RESPONSE_BODY_BYTES // CHUNK_BYTES + 1
    assert stream.closed is True


def test_sync_body_timeout_keeps_typed_timeout_contract() -> None:
    class TimedOutBody(httpx.SyncByteStream):
        closed = False

        def __iter__(self) -> Iterator[bytes]:
            raise httpx.ReadTimeout("body stalled")
            yield b""  # pragma: no cover - keeps this a generator for typing

        def close(self) -> None:
            self.closed = True

    stream = TimedOutBody()
    client = httpx.Client(
        transport=httpx.MockTransport(lambda _request: httpx.Response(200, stream=stream))
    )
    http = HttpClient(API_KEY, base_url=BASE, client=client, retry=NO_RETRY)
    try:
        with pytest.raises(TransportError) as caught:
            http.request("GET", "/v1/x")
    finally:
        client.close()

    assert caught.value.status == 0
    assert str(caught.value) == "request timed out"
    assert stream.closed is True


@pytest.mark.asyncio
async def test_async_body_timeout_keeps_typed_timeout_contract() -> None:
    class TimedOutBody(httpx.AsyncByteStream):
        closed = False

        async def __aiter__(self) -> AsyncIterator[bytes]:
            raise httpx.ReadTimeout("body stalled")
            yield b""  # pragma: no cover - keeps this an async generator for typing

        async def aclose(self) -> None:
            self.closed = True

    stream = TimedOutBody()

    async def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, stream=stream)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    http = AsyncHttpClient(API_KEY, base_url=BASE, client=client, retry=NO_RETRY)
    try:
        with pytest.raises(TransportError) as caught:
            await http.request("GET", "/v1/x")
    finally:
        await client.aclose()

    assert caught.value.status == 0
    assert str(caught.value) == "request timed out"
    assert stream.closed is True

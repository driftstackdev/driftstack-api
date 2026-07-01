"""Sessions resource.

Wraps every ``/v1/sessions[/...]`` route. Both sync and async variants
share the URL/parameter shapes; the only difference is which HTTP
client they call.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Iterator
from typing import Any
from urllib.parse import quote

from pydantic import BaseModel

from driftstack._generated.models import (
    CaptureRequest,
    CaptureResponse,
    CreateSessionRequest,
    CreateSessionResponse,
    ExtractRequest,
    ExtractResponse,
    InteractRequest,
    InteractResponse,
    NavigateRequest,
    NavigateResponse,
    PaginationQuery,
    SearchRequest,
    SearchResponse,
    Session,
    SessionLoginRequest,
    SessionLoginResponse,
    SessionState,
    WaitRequest,
    WaitResponse,
)
from driftstack.http import AsyncHttpClient, HttpClient, parse_model
from driftstack.pagination import aiterate_paginated, iterate_paginated
from driftstack.resources._common import coerce_body, coerce_query


class SessionsListPage(BaseModel):
    """Paginated list of sessions returned by ``GET /v1/sessions``."""

    data: list[Session]
    has_more: bool
    next_cursor: str | None


def _session_path(session_id: str, suffix: str = "") -> str:
    return f"/v1/sessions/{quote(session_id, safe='')}{suffix}"


class SessionsResource:
    """Synchronous sessions resource."""

    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def create(
        self, body: CreateSessionRequest | dict[str, Any] | None = None
    ) -> CreateSessionResponse:
        """Create a new session. Returns the new ``Session`` row."""
        data = self._http.request("POST", "/v1/sessions", json_body=coerce_body(body) or {})
        return parse_model(CreateSessionResponse, data)

    def list(self, query: PaginationQuery | dict[str, Any] | None = None) -> SessionsListPage:
        """List sessions for the current account, newest first."""
        data = self._http.request("GET", "/v1/sessions", params=coerce_query(query))
        return parse_model(SessionsListPage, data)

    def iterate(self, *, limit: int | None = None) -> Iterator[Session]:
        """Lazily walk every session for the calling account.

        Wraps :meth:`list` with cursor handoff so callers can write::

            for session in client.sessions.iterate(limit=50):
                ...
        """

        def fetch_page(cursor: str | None) -> SessionsListPage:
            params: dict[str, Any] = {}
            if limit is not None:
                params["limit"] = limit
            if cursor is not None:
                params["cursor"] = cursor
            return self.list(params)

        return iterate_paginated(fetch_page)

    def get(self, session_id: str) -> Session:
        data = self._http.request("GET", _session_path(session_id))
        return parse_model(Session, data)

    def navigate(self, session_id: str, body: NavigateRequest | dict[str, Any]) -> NavigateResponse:
        data = self._http.request(
            "POST", _session_path(session_id, "/navigate"), json_body=coerce_body(body)
        )
        return parse_model(NavigateResponse, data)

    def interact(self, session_id: str, body: InteractRequest | dict[str, Any]) -> InteractResponse:
        data = self._http.request(
            "POST", _session_path(session_id, "/interact"), json_body=coerce_body(body)
        )
        return parse_model(InteractResponse, data)

    def wait(self, session_id: str, body: WaitRequest | dict[str, Any]) -> WaitResponse:
        data = self._http.request(
            "POST", _session_path(session_id, "/wait"), json_body=coerce_body(body)
        )
        return parse_model(WaitResponse, data)

    def get_state(self, session_id: str) -> SessionState:
        data = self._http.request("GET", _session_path(session_id, "/state"))
        return parse_model(SessionState, data)

    def capture(self, session_id: str, body: CaptureRequest | dict[str, Any]) -> CaptureResponse:
        data = self._http.request(
            "POST", _session_path(session_id, "/capture"), json_body=coerce_body(body)
        )
        return parse_model(CaptureResponse, data)

    def extract(self, session_id: str, body: ExtractRequest | dict[str, Any]) -> ExtractResponse:
        data = self._http.request(
            "POST", _session_path(session_id, "/extract"), json_body=coerce_body(body)
        )
        return parse_model(ExtractResponse, data)

    def search(self, session_id: str, body: SearchRequest | dict[str, Any]) -> SearchResponse:
        data = self._http.request(
            "POST", _session_path(session_id, "/search"), json_body=coerce_body(body)
        )
        return parse_model(SearchResponse, data)

    def login(
        self, session_id: str, body: SessionLoginRequest | dict[str, Any]
    ) -> SessionLoginResponse:
        data = self._http.request(
            "POST", _session_path(session_id, "/login"), json_body=coerce_body(body)
        )
        return parse_model(SessionLoginResponse, data)

    def destroy(self, session_id: str) -> None:
        """Destroy the session. Idempotent (safe to call twice)."""
        self._http.request("DELETE", _session_path(session_id))


class AsyncSessionsResource:
    """Async sessions resource. Mirrors :class:`SessionsResource`."""

    def __init__(self, http: AsyncHttpClient) -> None:
        self._http = http

    async def create(
        self, body: CreateSessionRequest | dict[str, Any] | None = None
    ) -> CreateSessionResponse:
        data = await self._http.request("POST", "/v1/sessions", json_body=coerce_body(body) or {})
        return parse_model(CreateSessionResponse, data)

    async def list(self, query: PaginationQuery | dict[str, Any] | None = None) -> SessionsListPage:
        data = await self._http.request("GET", "/v1/sessions", params=coerce_query(query))
        return parse_model(SessionsListPage, data)

    def iterate(self, *, limit: int | None = None) -> AsyncIterator[Session]:
        """Async variant of :meth:`SessionsResource.iterate`.

        Returns an async iterator suitable for ``async for ... in ...``.
        """

        async def fetch_page(cursor: str | None) -> SessionsListPage:
            params: dict[str, Any] = {}
            if limit is not None:
                params["limit"] = limit
            if cursor is not None:
                params["cursor"] = cursor
            return await self.list(params)

        return aiterate_paginated(fetch_page)

    async def get(self, session_id: str) -> Session:
        data = await self._http.request("GET", _session_path(session_id))
        return parse_model(Session, data)

    async def navigate(
        self, session_id: str, body: NavigateRequest | dict[str, Any]
    ) -> NavigateResponse:
        data = await self._http.request(
            "POST", _session_path(session_id, "/navigate"), json_body=coerce_body(body)
        )
        return parse_model(NavigateResponse, data)

    async def interact(
        self, session_id: str, body: InteractRequest | dict[str, Any]
    ) -> InteractResponse:
        data = await self._http.request(
            "POST", _session_path(session_id, "/interact"), json_body=coerce_body(body)
        )
        return parse_model(InteractResponse, data)

    async def wait(self, session_id: str, body: WaitRequest | dict[str, Any]) -> WaitResponse:
        data = await self._http.request(
            "POST", _session_path(session_id, "/wait"), json_body=coerce_body(body)
        )
        return parse_model(WaitResponse, data)

    async def get_state(self, session_id: str) -> SessionState:
        data = await self._http.request("GET", _session_path(session_id, "/state"))
        return parse_model(SessionState, data)

    async def capture(
        self, session_id: str, body: CaptureRequest | dict[str, Any]
    ) -> CaptureResponse:
        data = await self._http.request(
            "POST", _session_path(session_id, "/capture"), json_body=coerce_body(body)
        )
        return parse_model(CaptureResponse, data)

    async def extract(
        self, session_id: str, body: ExtractRequest | dict[str, Any]
    ) -> ExtractResponse:
        data = await self._http.request(
            "POST", _session_path(session_id, "/extract"), json_body=coerce_body(body)
        )
        return parse_model(ExtractResponse, data)

    async def search(self, session_id: str, body: SearchRequest | dict[str, Any]) -> SearchResponse:
        data = await self._http.request(
            "POST", _session_path(session_id, "/search"), json_body=coerce_body(body)
        )
        return parse_model(SearchResponse, data)

    async def login(
        self, session_id: str, body: SessionLoginRequest | dict[str, Any]
    ) -> SessionLoginResponse:
        data = await self._http.request(
            "POST", _session_path(session_id, "/login"), json_body=coerce_body(body)
        )
        return parse_model(SessionLoginResponse, data)

    async def destroy(self, session_id: str) -> None:
        await self._http.request("DELETE", _session_path(session_id))

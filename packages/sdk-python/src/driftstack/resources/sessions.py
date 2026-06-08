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
    Session,
    SessionState,
    WaitRequest,
    WaitResponse,
)
from driftstack.http import AsyncHttpClient, HttpClient
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
        return CreateSessionResponse.model_validate(data)

    def list(self, query: PaginationQuery | dict[str, Any] | None = None) -> SessionsListPage:
        """List sessions for the current account, newest first."""
        data = self._http.request("GET", "/v1/sessions", params=coerce_query(query))
        return SessionsListPage.model_validate(data)

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
        return Session.model_validate(data)

    def navigate(self, session_id: str, body: NavigateRequest | dict[str, Any]) -> NavigateResponse:
        data = self._http.request(
            "POST", _session_path(session_id, "/navigate"), json_body=coerce_body(body)
        )
        return NavigateResponse.model_validate(data)

    def interact(self, session_id: str, body: InteractRequest | dict[str, Any]) -> InteractResponse:
        data = self._http.request(
            "POST", _session_path(session_id, "/interact"), json_body=coerce_body(body)
        )
        return InteractResponse.model_validate(data)

    def wait(self, session_id: str, body: WaitRequest | dict[str, Any]) -> WaitResponse:
        data = self._http.request(
            "POST", _session_path(session_id, "/wait"), json_body=coerce_body(body)
        )
        return WaitResponse.model_validate(data)

    def get_state(self, session_id: str) -> SessionState:
        data = self._http.request("GET", _session_path(session_id, "/state"))
        return SessionState.model_validate(data)

    def capture(self, session_id: str, body: CaptureRequest | dict[str, Any]) -> CaptureResponse:
        data = self._http.request(
            "POST", _session_path(session_id, "/capture"), json_body=coerce_body(body)
        )
        return CaptureResponse.model_validate(data)

    def extract(self, session_id: str, body: ExtractRequest | dict[str, Any]) -> ExtractResponse:
        data = self._http.request(
            "POST", _session_path(session_id, "/extract"), json_body=coerce_body(body)
        )
        return ExtractResponse.model_validate(data)

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
        return CreateSessionResponse.model_validate(data)

    async def list(self, query: PaginationQuery | dict[str, Any] | None = None) -> SessionsListPage:
        data = await self._http.request("GET", "/v1/sessions", params=coerce_query(query))
        return SessionsListPage.model_validate(data)

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
        return Session.model_validate(data)

    async def navigate(
        self, session_id: str, body: NavigateRequest | dict[str, Any]
    ) -> NavigateResponse:
        data = await self._http.request(
            "POST", _session_path(session_id, "/navigate"), json_body=coerce_body(body)
        )
        return NavigateResponse.model_validate(data)

    async def interact(
        self, session_id: str, body: InteractRequest | dict[str, Any]
    ) -> InteractResponse:
        data = await self._http.request(
            "POST", _session_path(session_id, "/interact"), json_body=coerce_body(body)
        )
        return InteractResponse.model_validate(data)

    async def wait(self, session_id: str, body: WaitRequest | dict[str, Any]) -> WaitResponse:
        data = await self._http.request(
            "POST", _session_path(session_id, "/wait"), json_body=coerce_body(body)
        )
        return WaitResponse.model_validate(data)

    async def get_state(self, session_id: str) -> SessionState:
        data = await self._http.request("GET", _session_path(session_id, "/state"))
        return SessionState.model_validate(data)

    async def capture(
        self, session_id: str, body: CaptureRequest | dict[str, Any]
    ) -> CaptureResponse:
        data = await self._http.request(
            "POST", _session_path(session_id, "/capture"), json_body=coerce_body(body)
        )
        return CaptureResponse.model_validate(data)

    async def extract(
        self, session_id: str, body: ExtractRequest | dict[str, Any]
    ) -> ExtractResponse:
        data = await self._http.request(
            "POST", _session_path(session_id, "/extract"), json_body=coerce_body(body)
        )
        return ExtractResponse.model_validate(data)

    async def destroy(self, session_id: str) -> None:
        await self._http.request("DELETE", _session_path(session_id))

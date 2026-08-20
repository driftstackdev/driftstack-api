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
    SearchResponse1,
    SearchResponse2,
    Session,
    SessionLoginRequest,
    SessionLoginResponse1,
    SessionLoginResponse2,
    SessionState,
    WaitRequest,
    WaitResponse,
)
from driftstack._generated.models import (
    SearchResponse as GeneratedSearchResponse,
)
from driftstack._generated.models import (
    SessionLoginResponse as GeneratedSessionLoginResponse,
)
from driftstack.errors import TransportError
from driftstack.http import AsyncHttpClient, HttpClient, parse_model
from driftstack.pagination import aiterate_paginated, iterate_paginated
from driftstack.resources._common import coerce_body, coerce_query

SearchResponse = SearchResponse1 | SearchResponse2
SessionLoginResponse = SessionLoginResponse1 | SessionLoginResponse2


class SessionsListPage(BaseModel):
    """Paginated list of sessions returned by ``GET /v1/sessions``."""

    data: list[Session]
    has_more: bool
    next_cursor: str | None


def _session_path(session_id: str, suffix: str = "") -> str:
    return f"/v1/sessions/{quote(session_id, safe='')}{suffix}"


_DURATION_MS_MAX = 600_000

_SEARCH_REQUIRED_KEYS = frozenset({"submitted", "query_truncated", "duration_ms"})
_LOGIN_REQUIRED_KEYS = frozenset({"submitted", "credentials_truncated", "logged_in", "duration_ms"})


def _schema_error() -> TransportError:
    """One fixed message so a hostile body can never shape the exception."""
    return TransportError("response did not match expected schema", status=None)


def _exact_bool(payload: dict[str, Any], key: str) -> bool:
    """Require a real JSON boolean.

    ``isinstance(True, int)`` is true, so ``bool`` fields must be checked by
    exact type: otherwise a hostile ``1``/``0``/``"false"`` is coerced by
    Pydantic's default lax mode and reaches the customer as a fabricated
    ``submitted``/``logged_in`` verdict.
    """
    value = payload[key]
    if type(value) is not bool:
        raise _schema_error()
    return value


def _exact_duration_ms(payload: dict[str, Any]) -> None:
    """Require a real JSON integer inside the producer budget."""
    value = payload["duration_ms"]
    # ``type(...) is int`` also rejects ``bool``; lax mode would otherwise
    # accept ``"1"``/``1.0``/``True`` as a duration.
    if type(value) is not int or not 0 <= value <= _DURATION_MS_MAX:
        raise _schema_error()


def _validate_raw_search_response(data: Any) -> None:
    """Reject hostile primitives before the generated model coerces them."""
    if not isinstance(data, dict) or not _SEARCH_REQUIRED_KEYS <= set(data):
        raise _schema_error()
    submitted = _exact_bool(data, "submitted")
    truncated = _exact_bool(data, "query_truncated")
    _exact_duration_ms(data)
    if truncated:
        # Safe refusal is exact: nothing was submitted and no results
        # assessment exists to report.
        if submitted or set(data) != _SEARCH_REQUIRED_KEYS:
            raise _schema_error()
        return
    if set(data) - _SEARCH_REQUIRED_KEYS - {"results_visible"}:
        raise _schema_error()
    # The generated optional field cannot distinguish absent from explicit
    # JSON null; the public wire contract permits only absence or a boolean.
    if "results_visible" in data:
        _exact_bool(data, "results_visible")


def _validate_raw_login_response(data: Any) -> None:
    """Reject hostile primitives before the generated model coerces them."""
    if not isinstance(data, dict) or not _LOGIN_REQUIRED_KEYS <= set(data):
        raise _schema_error()
    submitted = _exact_bool(data, "submitted")
    truncated = _exact_bool(data, "credentials_truncated")
    logged_in = _exact_bool(data, "logged_in")
    _exact_duration_ms(data)
    if truncated:
        # Safe refusal is exact: no submission, no session, and no URL.
        if submitted or logged_in or set(data) != _LOGIN_REQUIRED_KEYS:
            raise _schema_error()
        return
    if not submitted or set(data) - _LOGIN_REQUIRED_KEYS - {"post_login_url"}:
        raise _schema_error()
    # OpenAPI models represent an absent optional field as ``None`` and the
    # generator therefore cannot distinguish it from an explicit JSON null.
    # The wire contract is stricter: post_login_url may be absent, never null.
    if "post_login_url" in data and type(data["post_login_url"]) is not str:
        raise _schema_error()


def _parse_session_search_response(data: Any) -> SearchResponse:
    """Validate the strict union and expose its selected branch directly."""
    _validate_raw_search_response(data)
    return parse_model(GeneratedSearchResponse, data).root


def _parse_session_login_response(data: Any) -> SessionLoginResponse:
    """Validate the generated strict union and expose its selected branch.

    ``datamodel-code-generator`` correctly emits an OpenAPI ``oneOf`` as a
    Pydantic ``RootModel``. Returning that wrapper would silently break the
    established customer ergonomics (``result.logged_in``); unwrap only after
    the raw primitive check and the root model have both enforced the exact
    submitted/truncated branch.
    """
    _validate_raw_login_response(data)
    return parse_model(GeneratedSessionLoginResponse, data).root


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
        """Lazily walk every session for the EFFECTIVE account.

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
        return _parse_session_search_response(data)

    def login(
        self, session_id: str, body: SessionLoginRequest | dict[str, Any]
    ) -> SessionLoginResponse:
        data = self._http.request(
            "POST", _session_path(session_id, "/login"), json_body=coerce_body(body)
        )
        return _parse_session_login_response(data)

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
        return _parse_session_search_response(data)

    async def login(
        self, session_id: str, body: SessionLoginRequest | dict[str, Any]
    ) -> SessionLoginResponse:
        data = await self._http.request(
            "POST", _session_path(session_id, "/login"), json_body=coerce_body(body)
        )
        return _parse_session_login_response(data)

    async def destroy(self, session_id: str) -> None:
        await self._http.request("DELETE", _session_path(session_id))

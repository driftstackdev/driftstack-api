"""HTTP client wrapper.

Customers don't construct this directly — they get a :class:`Driftstack`
or :class:`AsyncDriftstack`, which wraps an :class:`HttpClient`
internally. The wrapper handles:

* Bearer auth header injection
* RFC 7807 problem-json → typed error mapping (``error_from_response``)
* Per-request timeout
* Retry policy delegation (see :mod:`driftstack.retry`)

Both sync and async variants share the same problem-mapping logic in
:func:`_error_from_response_data`, so a future shape change to the
server's error envelope updates both paths in one place.
"""

from __future__ import annotations

import json
from typing import Any

import httpx

from driftstack._version import __version__
from driftstack.errors import (
    PROBLEM_TYPE_TO_ERROR,
    ConcurrencyLimitError,
    DriftstackError,
    LegalAcceptanceRequiredError,
    QuotaExceededError,
    RateLimitError,
    SessionTimeoutError,
    TransportError,
)
from driftstack.retry import RetryConfig, with_retry, with_retry_async

DEFAULT_TIMEOUT_S = 30.0
USER_AGENT = f"driftstack-sdk-python/{__version__}"


def _build_headers(api_key: str, has_body: bool) -> dict[str, str]:
    headers = {
        "authorization": f"Bearer {api_key}",
        "user-agent": USER_AGENT,
        "accept": "application/json",
    }
    if has_body:
        headers["content-type"] = "application/json"
    return headers


def _problem_from_text(text: str, status: int) -> dict[str, Any] | None:
    """Parse a response body as RFC 7807 problem+json. Return None on parse fail."""
    if not text:
        return None
    try:
        parsed = json.loads(text)
    except (json.JSONDecodeError, ValueError):
        return None
    if not isinstance(parsed, dict):
        return None
    if "type" not in parsed or "title" not in parsed or "status" not in parsed:
        return None
    return parsed


def _error_from_response_data(
    status: int,
    text: str,
    retry_after_header: str | None,
) -> DriftstackError:
    """Map a non-2xx response to the right :class:`DriftstackError` subclass.

    Falls back to :class:`TransportError` when the body isn't a proper
    problem document — that surfaces as a server contract violation,
    which is the right diagnostic for "we got a 500 with HTML in it."
    """
    problem = _problem_from_text(text, status)
    if problem is None:
        return TransportError(
            f"non-2xx response ({status}) with non-problem body",
            status=status,
        )

    problem_type = str(problem.get("type", ""))
    title = str(problem.get("title", ""))
    detail = str(problem.get("detail") or title)

    # Retry-After can come from either the header or from a problem field.
    retry_after_seconds: int | None = None
    if retry_after_header is not None:
        try:
            retry_after_seconds = int(retry_after_header)
        except ValueError:
            retry_after_seconds = None
    if retry_after_seconds is None and "retry_after_seconds" in problem:
        try:
            retry_after_seconds = int(problem["retry_after_seconds"])
        except (TypeError, ValueError):
            retry_after_seconds = None

    error_cls = PROBLEM_TYPE_TO_ERROR.get(problem_type, DriftstackError)

    if error_cls is RateLimitError:
        return RateLimitError(
            detail,
            retry_after_seconds=retry_after_seconds,
            status=status,
            problem_type=problem_type,
            problem=problem,
        )
    if error_cls is QuotaExceededError:
        return QuotaExceededError(
            detail,
            current=_int_or_none(problem.get("current")),
            limit=_int_or_none(problem.get("limit")),
            record_type=str(problem["record_type"]) if problem.get("record_type") else None,
            status=status,
            problem_type=problem_type,
            problem=problem,
        )
    if error_cls is ConcurrencyLimitError:
        return ConcurrencyLimitError(
            detail,
            current_sessions=_int_or_none(problem.get("current_sessions")),
            limit=_int_or_none(problem.get("limit")),
            status=status,
            problem_type=problem_type,
            problem=problem,
        )
    if error_cls is SessionTimeoutError:
        return SessionTimeoutError(
            detail,
            timeout_ms=_int_or_none(problem.get("timeout_ms")),
            status=status,
            problem_type=problem_type,
            problem=problem,
        )
    if error_cls is LegalAcceptanceRequiredError:
        raw = problem.get("pending_acceptances")
        pending: list[dict[str, str]] = []
        if isinstance(raw, list):
            for entry in raw:
                if (
                    isinstance(entry, dict)
                    and isinstance(entry.get("document_key"), str)
                    and isinstance(entry.get("current_version"), str)
                ):
                    pending.append(
                        {
                            "document_key": entry["document_key"],
                            "current_version": entry["current_version"],
                        }
                    )
        return LegalAcceptanceRequiredError(
            detail,
            pending_acceptances=pending,
            status=status,
            problem_type=problem_type,
            problem=problem,
        )
    return error_cls(detail, status=status, problem_type=problem_type, problem=problem)


def _int_or_none(value: Any) -> int | None:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


# ──────────────────────────────────────────────────────────────────────────
# Sync HTTP client (httpx.Client)
# ──────────────────────────────────────────────────────────────────────────


class HttpClient:
    """Thin wrapper around ``httpx.Client`` for the sync :class:`Driftstack`."""

    def __init__(
        self,
        api_key: str,
        *,
        base_url: str,
        timeout_s: float = DEFAULT_TIMEOUT_S,
        retry: RetryConfig | None = None,
        client: httpx.Client | None = None,
    ) -> None:
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._retry = retry
        self._client = client or httpx.Client(timeout=timeout_s)
        self._owns_client = client is None

    def close(self) -> None:
        if self._owns_client:
            self._client.close()

    def __enter__(self) -> HttpClient:
        return self

    def __exit__(self, *_excinfo: Any) -> None:
        self.close()

    def request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        json_body: Any | None = None,
        retry: RetryConfig | None = None,
    ) -> Any:
        url = self._base_url + path
        headers = _build_headers(self._api_key, has_body=json_body is not None)

        def _do() -> Any:
            try:
                response = self._client.request(
                    method,
                    url,
                    params=params,
                    json=json_body,
                    headers=headers,
                )
            except httpx.TimeoutException as err:
                raise TransportError("request timed out", status=0) from err
            except httpx.HTTPError as err:
                raise TransportError(str(err), status=0) from err

            return _decode_or_raise(response)

        return with_retry(_do, retry or self._retry)


# ──────────────────────────────────────────────────────────────────────────
# Async HTTP client (httpx.AsyncClient)
# ──────────────────────────────────────────────────────────────────────────


class AsyncHttpClient:
    """Async analogue of :class:`HttpClient`."""

    def __init__(
        self,
        api_key: str,
        *,
        base_url: str,
        timeout_s: float = DEFAULT_TIMEOUT_S,
        retry: RetryConfig | None = None,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._retry = retry
        self._client = client or httpx.AsyncClient(timeout=timeout_s)
        self._owns_client = client is None

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def __aenter__(self) -> AsyncHttpClient:
        return self

    async def __aexit__(self, *_excinfo: Any) -> None:
        await self.aclose()

    async def request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        json_body: Any | None = None,
        retry: RetryConfig | None = None,
    ) -> Any:
        url = self._base_url + path
        headers = _build_headers(self._api_key, has_body=json_body is not None)

        async def _do() -> Any:
            try:
                response = await self._client.request(
                    method,
                    url,
                    params=params,
                    json=json_body,
                    headers=headers,
                )
            except httpx.TimeoutException as err:
                raise TransportError("request timed out", status=0) from err
            except httpx.HTTPError as err:
                raise TransportError(str(err), status=0) from err

            return _decode_or_raise(response)

        return await with_retry_async(_do, retry or self._retry)


# ──────────────────────────────────────────────────────────────────────────
# Shared response handling
# ──────────────────────────────────────────────────────────────────────────


def _decode_or_raise(response: httpx.Response) -> Any:
    """2xx → parsed JSON (or None on 204). Anything else → raise typed error."""
    if 200 <= response.status_code < 300:
        if response.status_code == 204 or not response.content:
            return None
        try:
            return response.json()
        except (json.JSONDecodeError, ValueError) as err:
            raise TransportError(
                "failed to parse JSON response body",
                status=response.status_code,
            ) from err

    raise _error_from_response_data(
        status=response.status_code,
        text=response.text,
        retry_after_header=response.headers.get("retry-after"),
    )

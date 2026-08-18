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
import time
from collections.abc import AsyncIterator, Iterator
from typing import Any, TypeVar

import httpx
import pydantic
from pydantic import BaseModel

from driftstack._version import __version__
from driftstack.errors import (
    PROBLEM_TYPE_TO_ERROR,
    ConcurrencyLimitError,
    DriftstackError,
    LegalAcceptanceRequiredError,
    ProxyValidationFailedError,
    QuotaExceededError,
    RateLimitError,
    SessionTimeoutError,
    StorageQuotaExceededError,
    TransportError,
)
from driftstack.retry import RetryConfig, with_retry, with_retry_async

DEFAULT_TIMEOUT_S = 30.0
USER_AGENT = f"driftstack-sdk-python/{__version__}"
# Matches the Go and TypeScript SDK response ceiling. API JSON and RFC 7807
# bodies are normally tiny; this leaves generous list-response headroom while
# preventing a compromised server or intermediary from exhausting the client.
MAX_RESPONSE_BODY_BYTES = 8 * 1024 * 1024
_RESPONSE_CHUNK_BYTES = 64 * 1024

_ModelT = TypeVar("_ModelT", bound=BaseModel)

# Headroom added on top of a body-declared long-running operation timeout when
# deriving the per-request transport timeout — covers network round-trip + the
# server's scheduling slack so the client never aborts a request the server
# would still honour. Mirrors the TS/Go SDKs.
_BODY_TIMEOUT_HEADROOM_S = 15.0

# Absolute wall-clock backstop for one heartbeat-backed SSE turn, mirroring the
# TypeScript SDK's AGENT_MESSAGE_STREAM_TIMEOUT_MS and the Go SDK's
# AgentMessageStreamTimeout. Eight legal five-minute harness intents consume
# ~42 minutes; this leaves headroom for decomposition + optional read-back while
# preventing a permanently-heartbeating but never-terminal stream from hanging
# forever.
#
# httpx's timeout is a per-READ idle deadline, not a wall-clock one, and the
# server sends keep-alive comments every 15s — so the idle deadline is reset
# forever by exactly the traffic that indicates nothing is finishing. The byte
# ceiling does not help either: heartbeat comments are a few bytes, so 8 MiB of
# them is effectively unreachable. Without this backstop a Python caller could
# block indefinitely where the other two SDKs give up at 50 minutes.
AGENT_MESSAGE_STREAM_TIMEOUT_S = 50 * 60.0


def _body_operation_timeout_s(json_body: Any) -> float | None:
    """Extract a long-running-operation deadline from a request body, in seconds.

    Recognises the two server contract fields: ``timeout_ms`` (milliseconds —
    navigate / wait / interact) and ``timeout_seconds`` (login / search).
    Returns ``None`` when the body carries neither (or isn't a dict), so the
    caller falls back to the configured client timeout. A non-positive /
    non-numeric value is ignored (treated as absent).
    """
    if not isinstance(json_body, dict):
        return None
    ms = json_body.get("timeout_ms")
    if isinstance(ms, (int, float)) and not isinstance(ms, bool) and ms > 0:
        return float(ms) / 1000.0
    secs = json_body.get("timeout_seconds")
    if isinstance(secs, (int, float)) and not isinstance(secs, bool) and secs > 0:
        return float(secs)
    return None


def _resolve_request_timeout_s(base_timeout_s: float, json_body: Any) -> float | None:
    """Resolve the per-request transport timeout (seconds).

    Auto-raises the configured base to a body-declared long-running deadline +
    headroom when the body carries ``timeout_ms`` / ``timeout_seconds`` (the
    navigate / wait / login / search contract, up to 120s server-side) — so a
    30s base never aborts a 90s op the server would honour. The body timeout
    only ever RAISES the floor. Returns ``None`` (httpx "no override" → use the
    client's own timeout) when the body declares no longer deadline.
    """
    body_timeout = _body_operation_timeout_s(json_body)
    if body_timeout is None:
        return None
    raised = body_timeout + _BODY_TIMEOUT_HEADROOM_S
    return raised if raised > base_timeout_s else None


# HTTP methods that are idempotent by RFC 7231 semantics — always safe to
# auto-retry. POST and PATCH are excluded; they're only retried when the
# caller supplies an Idempotency-Key (see :func:`_is_retry_safe`).
_IDEMPOTENT_METHODS = frozenset({"GET", "HEAD", "PUT", "DELETE", "OPTIONS", "TRACE"})


def _is_retry_safe(method: str, headers: dict[str, str]) -> bool:
    """Whether a request may be transparently retried by the SDK.

    True for idempotent methods, or for any method carrying a USABLE
    ``Idempotency-Key`` header (case-insensitive name, non-blank value). A
    non-idempotent POST/PATCH without a key is NOT retried: a transient 5xx /
    network blip on a create may already have been applied server-side, so a
    retry would mint a duplicate. With a key the server replays the original
    response, so the retry is safe.

    The value check is load-bearing, not defensive tidying. The server treats an
    empty or whitespace-only ``Idempotency-Key`` as ABSENT — it stores no dedup
    record and replays nothing. A header present with a blank value is therefore
    the worst case: it buys no server-side protection while, before this check,
    it switched retries on. An unset variable reaching the header map as ``""``
    turned a single POST into an auto-retried one that could mint duplicates.
    """
    if method.upper() in _IDEMPOTENT_METHODS:
        return True
    return any(
        k.lower() == "idempotency-key" and isinstance(v, str) and v.strip() != ""
        for k, v in headers.items()
    )



_REDACTED_HEADERS = ("authorization", "x-driftstack-gui-control-key", "x-byok-anthropic-api-key")


def _scrub_chained_request(err: BaseException) -> BaseException:
    """Strip credentials from the request httpx attaches to a transport error.

    httpx puts the full :class:`httpx.Request` — headers included — on its
    transport exceptions, and we chain those with ``raise ... from err`` so a
    caller can see the underlying cause. The API key therefore stays reachable
    at ``err.__cause__.request.headers['authorization']`` even though it never
    appears in ``str()`` or ``repr()`` of anything in the chain, which is all
    the existing leak tests looked at.

    That matters for error reporters rather than for logs: Sentry and similar
    capture exception chains and frame locals, so a transient connection
    failure could ship a live customer key to a third party. The Go SDK does not
    have this exposure — its chain is url.Error -> net.OpError -> syscall.Errno,
    none of which carry headers.

    The request is about to be discarded, so redacting in place costs nothing
    and keeps the cause chain intact for debugging.
    """
    request = getattr(err, "request", None)
    headers = getattr(request, "headers", None)
    if headers is None:
        return err
    for name in _REDACTED_HEADERS:
        try:
            if name in headers:
                headers[name] = "[redacted]"
        except Exception:  # noqa: BLE001 - never let scrubbing mask the real error
            pass
    return err

def _build_headers(
    api_key: str, has_body: bool, effective_account: str | None = None
) -> dict[str, str]:
    headers = {
        "authorization": f"Bearer {api_key}",
        # V-326c/V-330 team workspaces — set on every request when the
        # client was constructed with effective_account (owner account id).
        **({"x-driftstack-account": effective_account} if effective_account else {}),
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
            # V-815 — the server sends `resource` on the tier-limit problem;
            # `record_type` was never on the wire, so this was always None. The
            # old key stays as a fallback; the ARGUMENT keeps its published name.
            record_type=_first_str(problem, "resource", "record_type"),
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
    if error_cls is StorageQuotaExceededError:
        return StorageQuotaExceededError(
            detail,
            used_bytes=_int_or_none(problem.get("used_bytes")),
            cap_bytes=_int_or_none(problem.get("cap_bytes")),
            tier=str(problem["tier"]) if problem.get("tier") else None,
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
    if error_cls is ProxyValidationFailedError:
        # Mirror the TS/Go SDKs: surface the structured `reason` enum
        # (unreachable / auth_failed / timeout / egress_blocked) as a first-class
        # attribute so customers can branch on the failure cause. The server spreads
        # it to the problem's top level (errors.ts extensions.reason → toProblem()).
        return ProxyValidationFailedError(
            detail,
            reason=str(problem["reason"]) if problem.get("reason") else None,
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


def _first_str(problem: dict[str, Any], *keys: str) -> str | None:
    """First non-empty string among `keys`, or None.

    V-815 — lets a reader accept the key the server actually sends while
    keeping an older spelling as a fallback. The tier-limit problem carries
    `resource`; `record_type` was read for a long time and never arrived.
    """
    for key in keys:
        value = problem.get(key)
        if value:
            return str(value)
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
        effective_account: str | None = None,
    ) -> None:
        self._api_key = api_key
        self._effective_account = effective_account
        self._base_url = base_url.rstrip("/")
        self._retry = retry
        self._timeout_s = timeout_s
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
        extra_headers: dict[str, str] | None = None,
    ) -> Any:
        url = self._base_url + path
        headers = _build_headers(
            self._api_key,
            has_body=json_body is not None,
            effective_account=self._effective_account,
        )
        if extra_headers:
            headers.update(extra_headers)

        # Auto-raise the per-request transport timeout when the body carries a
        # long-running-op deadline (timeout_ms / timeout_seconds), so a 30s
        # default never aborts a 90s navigate / wait / login the server would
        # honour. Only when the SDK owns the client (a caller-supplied client
        # owns its own timeouts). httpx merges an unset field from the client
        # default, so passing the raised value is a per-request override.
        request_kwargs: dict[str, Any] = {}
        if self._owns_client:
            raised = _resolve_request_timeout_s(self._timeout_s, json_body)
            if raised is not None:
                request_kwargs["timeout"] = raised

        def _do() -> Any:
            try:
                # Use a streaming context instead of Client.request(), which
                # eagerly buffers the whole body before returning. The shared
                # reader enforces the response ceiling before JSON decoding.
                with self._client.stream(
                    method,
                    url,
                    params=params,
                    json=json_body,
                    headers=headers,
                    **request_kwargs,
                ) as response:
                    content = _read_bounded_response(response)
                    return _decode_or_raise(response, content)
            except httpx.TimeoutException as err:
                raise TransportError("request timed out", status=0) from _scrub_chained_request(err)
            except httpx.HTTPError as err:
                raise TransportError(str(err), status=0) from _scrub_chained_request(err)

        # Retry SAFETY gate — only auto-retry idempotent requests (or a
        # POST/PATCH carrying an Idempotency-Key); a keyless create must
        # not be retried or a transient blip could double-submit it.
        if not _is_retry_safe(method, headers):
            return _do()
        return with_retry(_do, retry or self._retry)

    def request_event_stream(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        json_body: Any | None = None,
        extra_headers: dict[str, str] | None = None,
        stream_timeout_s: float | None = None,
    ) -> Any:
        """Read one heartbeat-backed SSE response through the shared byte cap.

        The stream must end with exactly one ``event: response`` envelope. It is
        deliberately never auto-retried: a lost non-idempotent agent-turn stream
        may have already dispatched browser actions.
        """
        url = self._base_url + path
        headers = _build_headers(
            self._api_key,
            has_body=json_body is not None,
            effective_account=self._effective_account,
        )
        if extra_headers:
            headers.update(extra_headers)
        headers["accept"] = "text/event-stream"
        # httpx's 30s default is a per-read idle deadline, not one absolute
        # wall-clock deadline. The server's 15s comments keep it alive while
        # this bounded reader waits for the terminal event — which is why the
        # reader also enforces an absolute backstop of its own.
        deadline = time.monotonic() + (
            AGENT_MESSAGE_STREAM_TIMEOUT_S if stream_timeout_s is None else stream_timeout_s
        )
        try:
            with self._client.stream(
                method,
                url,
                params=params,
                json=json_body,
                headers=headers,
            ) as response:
                content = _read_bounded_response(response, deadline)
                return _decode_event_stream_or_raise(response, content)
        except httpx.TimeoutException as err:
            raise TransportError("request timed out", status=0) from _scrub_chained_request(err)
        except httpx.HTTPError as err:
            raise TransportError(str(err), status=0) from _scrub_chained_request(err)


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
        effective_account: str | None = None,
    ) -> None:
        self._api_key = api_key
        self._effective_account = effective_account
        self._base_url = base_url.rstrip("/")
        self._retry = retry
        self._timeout_s = timeout_s
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
        extra_headers: dict[str, str] | None = None,
    ) -> Any:
        url = self._base_url + path
        headers = _build_headers(
            self._api_key,
            has_body=json_body is not None,
            effective_account=self._effective_account,
        )
        if extra_headers:
            headers.update(extra_headers)

        # See the sync :meth:`HttpClient.request` — auto-raise the per-request
        # timeout for a body-declared long-running op (only when the SDK owns
        # the client).
        request_kwargs: dict[str, Any] = {}
        if self._owns_client:
            raised = _resolve_request_timeout_s(self._timeout_s, json_body)
            if raised is not None:
                request_kwargs["timeout"] = raised

        async def _do() -> Any:
            try:
                # AsyncClient.request() is eager too; stream and count decoded
                # chunks before retaining them, mirroring the sync path.
                async with self._client.stream(
                    method,
                    url,
                    params=params,
                    json=json_body,
                    headers=headers,
                    **request_kwargs,
                ) as response:
                    content = await _read_bounded_response_async(response)
                    return _decode_or_raise(response, content)
            except httpx.TimeoutException as err:
                raise TransportError("request timed out", status=0) from _scrub_chained_request(err)
            except httpx.HTTPError as err:
                raise TransportError(str(err), status=0) from _scrub_chained_request(err)

        # Retry SAFETY gate — see the sync :meth:`HttpClient.request`.
        if not _is_retry_safe(method, headers):
            return await _do()
        return await with_retry_async(_do, retry or self._retry)

    async def request_event_stream(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        json_body: Any | None = None,
        extra_headers: dict[str, str] | None = None,
        stream_timeout_s: float | None = None,
    ) -> Any:
        """Async mirror of :meth:`HttpClient.request_event_stream`."""
        url = self._base_url + path
        headers = _build_headers(
            self._api_key,
            has_body=json_body is not None,
            effective_account=self._effective_account,
        )
        if extra_headers:
            headers.update(extra_headers)
        headers["accept"] = "text/event-stream"
        deadline = time.monotonic() + (
            AGENT_MESSAGE_STREAM_TIMEOUT_S if stream_timeout_s is None else stream_timeout_s
        )
        try:
            async with self._client.stream(
                method,
                url,
                params=params,
                json=json_body,
                headers=headers,
            ) as response:
                content = await _read_bounded_response_async(response, deadline)
                return _decode_event_stream_or_raise(response, content)
        except httpx.TimeoutException as err:
            raise TransportError("request timed out", status=0) from _scrub_chained_request(err)
        except httpx.HTTPError as err:
            raise TransportError(str(err), status=0) from _scrub_chained_request(err)


# ──────────────────────────────────────────────────────────────────────────
# Shared response handling
# ──────────────────────────────────────────────────────────────────────────


def parse_model(model_cls: type[_ModelT], data: Any) -> _ModelT:
    """Validate a decoded 2xx JSON response body into a generated model.

    Every resource method calls this instead of a raw
    ``Model.model_validate(data)`` so the SDK's documented contract holds:
    "catch :class:`~driftstack.errors.DriftstackError` for any other typed
    problem" (see the module docstring on :mod:`driftstack.errors`). Without
    this chokepoint, a 2xx response that doesn't match the generated schema
    (stale codegen, a server contract drift) would let a raw
    ``pydantic.ValidationError`` escape uncaught, bypassing that contract.

    Re-raises as :class:`TransportError` — a schema mismatch is a transport/
    contract-level failure, not a server-declared problem — while chaining
    the original ``ValidationError`` via ``from err`` so the root cause is
    still inspectable (``err.__cause__``).
    """
    try:
        return model_cls.model_validate(data)
    except pydantic.ValidationError as err:
        raise TransportError(
            "response did not match expected schema",
            status=None,
        ) from err


def _declares_oversized_body(response: httpx.Response) -> bool:
    declared = response.headers.get("content-length")
    return declared is not None and declared.isdecimal() and int(declared) > MAX_RESPONSE_BODY_BYTES


def _body_too_large(status: int) -> TransportError:
    return TransportError(
        f"response body exceeds {MAX_RESPONSE_BODY_BYTES}-byte limit",
        status=status,
    )


def _iter_chunks(response: httpx.Response, deadline: float | None) -> Iterator[bytes]:
    """Arrival-granularity chunks for a deadline-bounded stream; fixed-size otherwise."""
    if deadline is None:
        return response.iter_bytes(chunk_size=_RESPONSE_CHUNK_BYTES)
    return response.iter_bytes()


def _aiter_chunks(response: httpx.Response, deadline: float | None) -> AsyncIterator[bytes]:
    """Async mirror of :func:`_iter_chunks`."""
    if deadline is None:
        return response.aiter_bytes(chunk_size=_RESPONSE_CHUNK_BYTES)
    return response.aiter_bytes()


def _check_stream_deadline(deadline: float | None) -> None:
    """Raise once an event stream has outlived its absolute wall-clock backstop."""
    if deadline is not None and time.monotonic() > deadline:
        raise TransportError(
            "event stream exceeded its absolute timeout without a terminal event",
            status=0,
        )


def _read_bounded_response(response: httpx.Response, deadline: float | None = None) -> bytes:
    """Stream one sync response through the shared decoded-byte ceiling.

    ``deadline`` is an absolute :func:`time.monotonic` instant. It is checked on
    every chunk, which is exactly where it bites: a stream kept alive by
    heartbeat comments never trips httpx's per-read idle timeout, so arriving
    traffic is the only signal available to bound total wall-clock.
    """
    if _declares_oversized_body(response):
        raise _body_too_large(response.status_code)

    body = bytearray()
    # A deadline means this is an event stream, so read at ARRIVAL granularity:
    # a fixed 64 KiB chunk_size buffers until that much data accumulates, and
    # 15s heartbeat comments of a few bytes each would take hours to fill one —
    # the deadline would then be checked far too late to bound anything.
    for chunk in _iter_chunks(response, deadline):
        _check_stream_deadline(deadline)
        if len(body) + len(chunk) > MAX_RESPONSE_BODY_BYTES:
            raise _body_too_large(response.status_code)
        body.extend(chunk)
    return bytes(body)


async def _read_bounded_response_async(
    response: httpx.Response, deadline: float | None = None
) -> bytes:
    """Async mirror of :func:`_read_bounded_response`, same deadline semantics."""
    if _declares_oversized_body(response):
        raise _body_too_large(response.status_code)

    body = bytearray()
    async for chunk in _aiter_chunks(response, deadline):
        _check_stream_deadline(deadline)
        if len(body) + len(chunk) > MAX_RESPONSE_BODY_BYTES:
            raise _body_too_large(response.status_code)
        body.extend(chunk)
    return bytes(body)


def _decode_or_raise(response: httpx.Response, content: bytes) -> Any:
    """2xx → parsed JSON (or None on 204). Anything else → raise typed error."""
    if 200 <= response.status_code < 300:
        if response.status_code == 204 or not content:
            return None
        try:
            return json.loads(content)
        except (json.JSONDecodeError, ValueError) as err:
            raise TransportError(
                "failed to parse JSON response body",
                status=response.status_code,
            ) from err

    raise _error_from_response_data(
        status=response.status_code,
        text=content.decode("utf-8", errors="replace"),
        retry_after_header=response.headers.get("retry-after"),
    )


def _decode_event_stream_or_raise(response: httpx.Response, content: bytes) -> Any:
    """Decode the one terminal response event, or fall back to ordinary JSON."""
    content_type = response.headers.get("content-type", "").lower()
    media_type = content_type.split(";", 1)[0].strip()
    if not 200 <= response.status_code < 300 or media_type != "text/event-stream":
        return _decode_or_raise(response, content)

    text = content.decode("utf-8", errors="replace").replace("\r\n", "\n")
    terminal: dict[str, Any] | None = None
    for block in text.split("\n\n"):
        event = "message"
        data: list[str] = []
        for line in block.split("\n"):
            if line.startswith(":"):
                continue
            if line.startswith("event:"):
                event = line[len("event:") :].strip()
            elif line.startswith("data:"):
                data.append(line[len("data:") :].lstrip())
        if event != "response":
            continue
        if terminal is not None:
            raise TransportError(
                "agent turn stream contained multiple terminal responses",
                status=response.status_code,
            )
        try:
            decoded = json.loads("\n".join(data))
        except (json.JSONDecodeError, ValueError) as err:
            raise TransportError(
                "failed to parse terminal agent turn event",
                status=response.status_code,
            ) from err
        if not isinstance(decoded, dict):
            raise TransportError(
                "terminal agent turn event was not an object",
                status=response.status_code,
            )
        status = decoded.get("status")
        if (
            isinstance(status, bool)
            or not isinstance(status, int)
            or not 100 <= status <= 599
            or "body" not in decoded
        ):
            raise TransportError(
                "terminal agent turn event had an invalid response envelope",
                status=response.status_code,
            )
        terminal = decoded

    if terminal is None:
        raise TransportError(
            "agent turn stream ended without a terminal response",
            status=response.status_code,
        )
    status = terminal["status"]
    body = terminal["body"]
    if 200 <= status < 300:
        return body
    raise _error_from_response_data(
        status=status,
        text=json.dumps(body, separators=(",", ":")),
        retry_after_header=None,
    )

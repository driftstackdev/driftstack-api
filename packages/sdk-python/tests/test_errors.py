"""Error-class hierarchy + problem-type mapping."""

from __future__ import annotations

import pytest

from driftstack.errors import (
    PROBLEM_TYPE_TO_ERROR,
    AuthError,
    ConcurrencyLimitError,
    ConflictError,
    DriftstackError,
    DriverError,
    ExpiredKeyError,
    ForbiddenError,
    InvalidKeyError,
    NotFoundError,
    QuotaExceededError,
    RateLimitError,
    RevokedKeyError,
    SessionDestroyedError,
    SessionNotFoundError,
    SessionTimeoutError,
    TransportError,
    ValidationError,
)
from driftstack.http import _error_from_response_data


def test_subclass_relationships() -> None:
    """The hierarchy matches what callers will catch on."""
    assert issubclass(InvalidKeyError, AuthError)
    assert issubclass(ExpiredKeyError, AuthError)
    assert issubclass(RevokedKeyError, AuthError)
    assert issubclass(ForbiddenError, AuthError)
    assert issubclass(AuthError, DriftstackError)
    assert issubclass(SessionNotFoundError, NotFoundError)
    assert issubclass(NotFoundError, DriftstackError)
    assert issubclass(RateLimitError, DriftstackError)
    assert issubclass(QuotaExceededError, DriftstackError)
    assert issubclass(ConcurrencyLimitError, DriftstackError)
    assert issubclass(ConflictError, DriftstackError)
    assert issubclass(ValidationError, DriftstackError)
    assert issubclass(SessionDestroyedError, DriftstackError)
    assert issubclass(DriverError, DriftstackError)
    assert issubclass(TransportError, DriftstackError)


def test_every_problem_type_maps_to_a_subclass() -> None:
    """The mapping table only lists DriftstackError subclasses."""
    for problem_type, cls in PROBLEM_TYPE_TO_ERROR.items():
        assert issubclass(cls, DriftstackError), f"{problem_type} → {cls!r}"


@pytest.mark.parametrize(
    ("problem_type", "expected_cls"),
    [
        ("https://errors.driftstack.dev/invalid-key", InvalidKeyError),
        ("https://errors.driftstack.dev/expired-key", ExpiredKeyError),
        ("https://errors.driftstack.dev/revoked-key", RevokedKeyError),
        ("https://errors.driftstack.dev/forbidden", ForbiddenError),
        ("https://errors.driftstack.dev/unauthorized", AuthError),
        ("https://errors.driftstack.dev/not-found", NotFoundError),
        ("https://errors.driftstack.dev/conflict", ConflictError),
        ("https://errors.driftstack.dev/validation-failed", ValidationError),
        ("https://errors.driftstack.dev/rate-limited", RateLimitError),
        ("https://errors.driftstack.dev/concurrency-limit", ConcurrencyLimitError),
        ("https://errors.driftstack.dev/tier-limit", QuotaExceededError),
        ("https://errors.driftstack.dev/session-destroyed", SessionDestroyedError),
        ("https://errors.driftstack.dev/driver-error", DriverError),
    ],
)
def test_error_from_response_maps_problem_type(
    problem_type: str, expected_cls: type[DriftstackError]
) -> None:
    body = '{"type":"' + problem_type + '","title":"some title","status":400,"detail":"oops"}'
    err = _error_from_response_data(status=400, text=body, retry_after_header=None)
    assert isinstance(err, expected_cls)
    assert err.message == "oops"
    assert err.problem_type == problem_type


def test_rate_limit_uses_retry_after_header() -> None:
    body = (
        '{"type":"https://errors.driftstack.dev/rate-limited",'
        '"title":"Rate limited","status":429,"detail":"slow down"}'
    )
    err = _error_from_response_data(status=429, text=body, retry_after_header="42")
    assert isinstance(err, RateLimitError)
    assert err.retry_after_seconds == 42


def test_concurrency_limit_extracts_current_and_limit() -> None:
    body = (
        '{"type":"https://errors.driftstack.dev/concurrency-limit",'
        '"title":"limit","status":429,"detail":"too many",'
        '"current_sessions":15,"limit":15}'
    )
    err = _error_from_response_data(status=429, text=body, retry_after_header=None)
    assert isinstance(err, ConcurrencyLimitError)
    assert err.current_sessions == 15
    assert err.limit == 15


def test_quota_exceeded_extracts_fields() -> None:
    body = (
        '{"type":"https://errors.driftstack.dev/tier-limit",'
        '"title":"limit","status":429,"detail":"quota",'
        '"current":1000,"limit":1000,"record_type":"navigate"}'
    )
    err = _error_from_response_data(status=429, text=body, retry_after_header=None)
    assert isinstance(err, QuotaExceededError)
    assert err.current == 1000
    assert err.limit == 1000
    assert err.record_type == "navigate"


def test_session_timeout_extracts_timeout_ms() -> None:
    body = (
        '{"type":"https://errors.driftstack.dev/session-timeout",'
        '"title":"Session timeout","status":504,'
        '"detail":"The operation exceeded the supplied timeout of 30000 ms.",'
        '"timeout_ms":30000}'
    )
    err = _error_from_response_data(status=504, text=body, retry_after_header=None)
    assert isinstance(err, SessionTimeoutError)
    assert err.timeout_ms == 30_000
    assert err.status == 504


def test_unknown_problem_type_falls_back_to_base_class() -> None:
    body = (
        '{"type":"https://errors.driftstack.dev/unknown-future-thing",'
        '"title":"new","status":418,"detail":"teapot"}'
    )
    err = _error_from_response_data(status=418, text=body, retry_after_header=None)
    # Falls back to the base class — caller can still catch DriftstackError.
    assert type(err) is DriftstackError
    assert err.message == "teapot"


def test_non_problem_body_yields_transport_error() -> None:
    err = _error_from_response_data(
        status=502, text="<html>bad gateway</html>", retry_after_header=None
    )
    assert isinstance(err, TransportError)
    assert err.status == 502


def test_empty_body_yields_transport_error() -> None:
    err = _error_from_response_data(status=500, text="", retry_after_header=None)
    assert isinstance(err, TransportError)

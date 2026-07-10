"""Error-class hierarchy + problem-type mapping."""

from __future__ import annotations

import pydantic
import pytest

from driftstack import is_retryable
from driftstack.errors import (
    PROBLEM_TYPE_TO_ERROR,
    AuthError,
    BadRequestError,
    BundledLlmBudgetExhaustedError,
    ConcurrencyLimitError,
    ConflictError,
    DriftstackError,
    DriverError,
    DriverNotIntegratedError,
    EmailAlreadyRegisteredError,
    EmailNotVerifiedError,
    ExpiredKeyError,
    ForbiddenError,
    InvalidAuthTokenError,
    InvalidCredentialsError,
    InvalidKeyError,
    NotFoundError,
    PairModeConflictError,
    PairModeStateInvalidTransitionError,
    ProfileInUseError,
    ProxyValidationFailedError,
    QuotaExceededError,
    RateLimitError,
    RevokedKeyError,
    SessionDestroyedError,
    SessionNotFoundError,
    SessionTimeoutError,
    TransportError,
    ValidationError,
)
from driftstack.http import _error_from_response_data, parse_model


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
    assert issubclass(BadRequestError, DriftstackError)
    # BadRequestError is a SIBLING of ValidationError (both extend
    # DriftstackError directly), NOT a parent/child — so `except
    # DriftstackError` catches both, but neither catches the other.
    assert not issubclass(BadRequestError, ValidationError)
    assert not issubclass(ValidationError, BadRequestError)
    assert issubclass(ValidationError, DriftstackError)
    assert issubclass(SessionDestroyedError, DriftstackError)
    assert issubclass(DriverError, DriftstackError)
    # driver-not-integrated (503) subclasses DriverError so existing
    # `except DriverError` handlers keep catching it (TS parity).
    assert issubclass(DriverNotIntegratedError, DriverError)
    assert issubclass(TransportError, DriftstackError)
    # V-115 — auth-flow inheritance: InvalidCredentialsError extends AuthError
    # so existing `except AuthError` blocks already catch wrong-password
    # failures; EmailNotVerifiedError extends ForbiddenError because the
    # server returns 403 and the semantic is "you authenticated but you're
    # not allowed in yet."
    assert issubclass(EmailAlreadyRegisteredError, DriftstackError)
    assert issubclass(InvalidCredentialsError, AuthError)
    assert issubclass(InvalidAuthTokenError, DriftstackError)
    assert issubclass(EmailNotVerifiedError, ForbiddenError)
    # A3 finding #7 — ProfileInUseError IS a 409 conflict, so it subclasses
    # ConflictError; existing `except ConflictError` handlers still catch it.
    assert issubclass(ProfileInUseError, ConflictError)


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
        ("https://errors.driftstack.dev/bad-request", BadRequestError),
        ("https://errors.driftstack.dev/validation-failed", ValidationError),
        ("https://errors.driftstack.dev/rate-limited", RateLimitError),
        ("https://errors.driftstack.dev/concurrency-limit", ConcurrencyLimitError),
        ("https://errors.driftstack.dev/tier-limit", QuotaExceededError),
        ("https://errors.driftstack.dev/session-destroyed", SessionDestroyedError),
        ("https://errors.driftstack.dev/driver-error", DriverError),
        ("https://errors.driftstack.dev/driver-not-integrated", DriverNotIntegratedError),
        # V-115 — V-079 auth-flow problem types.
        ("https://errors.driftstack.dev/email-already-registered", EmailAlreadyRegisteredError),
        ("https://errors.driftstack.dev/invalid-credentials", InvalidCredentialsError),
        ("https://errors.driftstack.dev/invalid-auth-token", InvalidAuthTokenError),
        ("https://errors.driftstack.dev/email-not-verified", EmailNotVerifiedError),
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


def test_bad_request_maps_to_bad_request_error_not_validation() -> None:
    """The generic `bad-request` problem-type maps to BadRequestError, a
    sibling of ValidationError — NOT ValidationError itself. This aligns
    Python with the TS SDK (which has had both classes); `validation-failed`
    (with a field-level issues list) stays mapped to ValidationError."""
    body = (
        '{"type":"https://errors.driftstack.dev/bad-request",'
        '"title":"Bad Request","status":400,"detail":"malformed"}'
    )
    err = _error_from_response_data(status=400, text=body, retry_after_header=None)
    assert isinstance(err, BadRequestError)
    assert not isinstance(err, ValidationError)
    assert err.status == 400
    assert err.problem_type == "https://errors.driftstack.dev/bad-request"


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


def test_pair_mode_state_invalid_transition_extracts_from_and_transition() -> None:
    """Arc 4 Wave 2.B sub-slice 8.20.k (v2-#8) — Python SDK parity with TS+Go
    on the typed extension fields of the 409 pair-mode error. TS exposes
    ``err.from`` + ``err.transition``; Go exposes ``err.From`` +
    ``err.Transition``; Python (this slice) exposes ``err.from_`` +
    ``err.transition`` (``from_`` because ``from`` is a reserved word).
    """
    body = (
        '{"type":"https://errors.driftstack.dev/pair-mode-invalid-transition",'
        '"title":"Invalid transition","status":409,'
        '"detail":"Invalid pair-mode transition: takeover-request '
        'not allowed from takeover-pending",'
        '"from":"takeover-pending","transition":"takeover-request"}'
    )
    err = _error_from_response_data(status=409, text=body, retry_after_header=None)
    assert isinstance(err, PairModeStateInvalidTransitionError)
    assert err.from_ == "takeover-pending"
    assert err.transition == "takeover-request"
    assert err.status == 409


def test_pair_mode_conflict_extracts_winner_client_id() -> None:
    """Arc 4 Wave 2.B sub-slice 8.20.k.3 (v2-#8) — TS exposes
    ``err.winnerClientId``; Go exposes ``err.WinnerClientID``; Python
    parity-fix exposes snake_case ``err.winner_client_id``."""
    body = (
        '{"type":"https://errors.driftstack.dev/pair-mode-conflict",'
        '"title":"Lock contended","status":409,'
        '"detail":"Another client has the takeover.",'
        '"winner_client_id":"cli_a"}'
    )
    err = _error_from_response_data(status=409, text=body, retry_after_header=None)
    assert isinstance(err, PairModeConflictError)
    assert err.winner_client_id == "cli_a"


def test_bundled_llm_budget_exhausted_extracts_spent_and_cap() -> None:
    """Arc 4 Wave 2.B sub-slice 8.20.k.3 (v2-#8) — TS exposes
    ``err.spentCents`` + ``err.capCents``; Go exposes ``err.SpentCents``
    + ``err.CapCents``; Python parity-fix exposes snake_case
    ``err.spent_cents`` + ``err.cap_cents``."""
    body = (
        '{"type":"https://errors.driftstack.dev/bundled-llm-budget-exhausted",'
        '"title":"Cap reached","status":402,'
        '"detail":"Bundled-LLM monthly cap reached.",'
        '"spent_cents":2050,"cap_cents":2000}'
    )
    err = _error_from_response_data(status=402, text=body, retry_after_header=None)
    assert isinstance(err, BundledLlmBudgetExhaustedError)
    assert err.spent_cents == 2050
    assert err.cap_cents == 2000


def test_bundled_llm_budget_exhausted_missing_fields_default_to_zero() -> None:
    body = (
        '{"type":"https://errors.driftstack.dev/bundled-llm-budget-exhausted",'
        '"title":"Cap reached","status":402,"detail":"…"}'
    )
    err = _error_from_response_data(status=402, text=body, retry_after_header=None)
    assert isinstance(err, BundledLlmBudgetExhaustedError)
    assert err.spent_cents == 0
    assert err.cap_cents == 0


def test_pair_mode_state_invalid_transition_missing_fields_default_to_empty_string() -> None:
    """Defensive: if the server somehow omits from + transition, we
    surface empty strings instead of raising on construction.
    """
    body = (
        '{"type":"https://errors.driftstack.dev/pair-mode-invalid-transition",'
        '"title":"Invalid transition","status":409,"detail":"…"}'
    )
    err = _error_from_response_data(status=409, text=body, retry_after_header=None)
    assert isinstance(err, PairModeStateInvalidTransitionError)
    assert err.from_ == ""
    assert err.transition == ""


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


def test_proxy_validation_failed_extracts_reason() -> None:
    # The server spreads `reason` to the problem's top level (errors.ts
    # extensions.reason → toProblem()); the SDK must surface it as a first-class
    # attribute so customers can branch on the failure cause (cross-SDK parity
    # with TS err.reason / Go err.Reason).
    body = (
        '{"type":"https://errors.driftstack.dev/proxy-validation-failed",'
        '"title":"Proxy validation failed","status":422,'
        '"detail":"The proxy rejected the supplied credentials.",'
        '"reason":"auth_failed","resource":"proxy"}'
    )
    err = _error_from_response_data(status=422, text=body, retry_after_header=None)
    assert isinstance(err, ProxyValidationFailedError)
    assert err.reason == "auth_failed"
    assert err.status == 422


def test_proxy_validation_failed_reason_absent_is_none() -> None:
    # No `reason` in the problem → .reason is None (not a crash on a missing key).
    body = (
        '{"type":"https://errors.driftstack.dev/proxy-validation-failed",'
        '"title":"Proxy validation failed","status":422,'
        '"detail":"The proxy could not be reached."}'
    )
    err = _error_from_response_data(status=422, text=body, retry_after_header=None)
    assert isinstance(err, ProxyValidationFailedError)
    assert err.reason is None


def test_profile_in_use_extracts_active_session_id() -> None:
    # A3 finding #7 — single-active-session-per-profile guard 409. The server
    # spreads `active_session_id` to the problem top level; the SDK surfaces it as
    # a first-class attribute (cross-SDK parity with TS err.activeSessionId / Go
    # err.ActiveSessionID).
    body = (
        '{"type":"https://errors.driftstack.dev/profile-in-use",'
        '"title":"Profile already in use","status":409,'
        '"detail":"This profile already has a live session (ses_abc123).",'
        '"active_session_id":"ses_abc123","resource":"profile"}'
    )
    err = _error_from_response_data(status=409, text=body, retry_after_header=None)
    assert isinstance(err, ProfileInUseError)
    assert isinstance(err, ConflictError)  # catchable as a 409 conflict
    assert err.active_session_id == "ses_abc123"
    assert err.status == 409
    assert is_retryable(err) is False


def test_profile_in_use_active_session_id_absent_is_empty() -> None:
    body = (
        '{"type":"https://errors.driftstack.dev/profile-in-use",'
        '"title":"Profile already in use","status":409}'
    )
    err = _error_from_response_data(status=409, text=body, retry_after_header=None)
    assert isinstance(err, ProfileInUseError)
    assert err.active_session_id == ""


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


# V-490 — public is_retryable predicate. Mirrors the V-489 TS test
# matrix at packages/sdk-typescript/tests/unit/errors.test.ts.
# (Import hoisted to top of module to satisfy ruff E402; section
# comment retained as the original audit anchor.)


def test_is_retryable_true_for_transport() -> None:
    assert is_retryable(TransportError("network down", status=0)) is True


def test_is_retryable_true_for_internal() -> None:
    from driftstack.errors import InternalError

    assert is_retryable(InternalError("upstream", status=500)) is True


def test_is_retryable_true_for_rate_limit() -> None:
    err = RateLimitError("rate limited", retry_after_seconds=5, status=429)
    assert is_retryable(err) is True


def test_is_retryable_false_for_validation() -> None:
    assert is_retryable(ValidationError("bad payload", status=400)) is False


def test_is_retryable_false_for_auth() -> None:
    assert is_retryable(AuthError("unauthorized", status=401)) is False


def test_is_retryable_false_for_not_found() -> None:
    assert is_retryable(NotFoundError("not found", status=404)) is False


def test_is_retryable_false_for_non_driftstack_values() -> None:
    assert is_retryable(Exception("regular")) is False
    assert is_retryable("string") is False
    assert is_retryable(None) is False
    assert is_retryable(42) is False


# ── parse_model — the resource-layer schema-validation chokepoint ─────────
#
# Every ``resources/*.py`` method calls ``parse_model`` instead of a raw
# ``Model.model_validate(data)`` so a 2xx response that doesn't match the
# generated schema raises a typed DriftstackError instead of letting a
# bare ``pydantic.ValidationError`` escape past the SDK's documented
# "catch DriftstackError for any other typed problem" contract.


class _Widget(pydantic.BaseModel):
    name: str
    count: int


def test_parse_model_returns_validated_instance_on_success() -> None:
    result = parse_model(_Widget, {"name": "gizmo", "count": 3})
    assert isinstance(result, _Widget)
    assert result.name == "gizmo"
    assert result.count == 3


def test_parse_model_wraps_validation_error_as_transport_error() -> None:
    """A schema mismatch must raise TransportError (catchable via
    DriftstackError), NOT let pydantic.ValidationError escape raw."""
    with pytest.raises(TransportError) as exc_info:
        parse_model(_Widget, {"name": "gizmo"})  # missing required `count`
    assert isinstance(exc_info.value, DriftstackError)
    assert "schema" in exc_info.value.message


def test_parse_model_chains_original_validation_error_as_cause() -> None:
    """The raw pydantic.ValidationError must still be inspectable via
    ``__cause__`` (raised with ``from err``) so diagnosis isn't lost."""
    with pytest.raises(TransportError) as exc_info:
        parse_model(_Widget, {"name": "gizmo"})
    assert isinstance(exc_info.value.__cause__, pydantic.ValidationError)

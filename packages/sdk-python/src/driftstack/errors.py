"""Error class hierarchy for the Driftstack Python SDK.

Mirrors the server's RFC 7807 problem-types (apps/server/src/lib/errors.ts).
The HTTP layer maps `application/problem+json` responses to the right
subclass; non-HTTP failures (timeouts, parse errors, network) raise
``TransportError``.

Callers can catch with the granularity they need::

    try:
        client.sessions.create()
    except RateLimitError as e:
        time.sleep(e.retry_after_seconds or 1)
    except DriftstackError as e:
        # any other typed problem
        log.error("driftstack call failed: %s", e)
"""

from __future__ import annotations

from typing import Any


def _coerce_int(value: Any) -> int:
    """Best-effort int coercion for typed error-class extensions.
    Returns 0 when the value is missing or non-numeric so a malformed
    problem-json response can't break error-class construction."""
    if value is None:
        return 0
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


class DriftstackError(Exception):
    """Base for every error raised by the Driftstack SDK.

    All HTTP-derived errors carry the parsed problem document so callers
    can read additional fields (``e.problem.get("retry_after_seconds")``,
    ``e.problem.get("current_sessions")``, etc.) without knowing the
    specific subclass shape.
    """

    def __init__(
        self,
        message: str,
        *,
        status: int | None = None,
        problem_type: str | None = None,
        problem: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.status = status
        self.problem_type = problem_type
        self.problem: dict[str, Any] = problem or {}

    def __repr__(self) -> str:  # pragma: no cover - cosmetic
        return f"{type(self).__name__}({self.message!r}, status={self.status})"


# ── Auth (401, 403) ───────────────────────────────────────────────────────


class AuthError(DriftstackError):
    """Base for authentication / authorisation failures."""


class InvalidKeyError(AuthError):
    """The provided API key was not recognised (malformed or unknown)."""


class ExpiredKeyError(AuthError):
    """The API key passed its ``expires_at`` deadline."""


class RevokedKeyError(AuthError):
    """The API key was revoked (DELETE /v1/api-keys/:id)."""


class ForbiddenError(AuthError):
    """The caller is authenticated but lacks the required scope."""


# ── Validation / domain (400, 404, 409, 410) ──────────────────────────────


class BadRequestError(DriftstackError):
    """A generic malformed request (HTTP 400, ``bad-request`` problem-type)
    that did NOT carry a field-level validation breakdown.

    Distinguished from :class:`ValidationError` (the ``validation-failed``
    problem-type, which carries an ``issues`` list) so callers can tell a
    structural "the server couldn't make sense of this request at all"
    failure apart from "these specific fields are invalid". Mirrors the
    TypeScript SDK's ``BadRequestError``. Subclasses ``DriftstackError``
    directly (NOT ``ValidationError``) so existing ``except DriftstackError``
    handlers are unaffected."""


class ValidationError(DriftstackError):
    """Request body or query parameters failed field-level schema validation
    (HTTP 400, ``validation-failed`` problem-type).

    The problem document carries an ``issues`` breakdown (read it via
    ``e.problem.get("issues")``). For a generic 400 with no field-level
    issues the server emits the ``bad-request`` problem-type, which maps to
    :class:`BadRequestError` instead."""


class NotFoundError(DriftstackError):
    """The targeted resource doesn't exist."""


class ConflictError(DriftstackError):
    """The request would violate an invariant (duplicate, capacity, etc.)."""


class SessionNotFoundError(NotFoundError):
    """Specifically: the addressed session id has no row in our store."""


class SessionDestroyedError(DriftstackError):
    """The session was destroyed; further operations on it are rejected (410)."""


class LegalAcceptanceRequiredError(DriftstackError):
    """409 when an operation (e.g. creating an API key) is gated on the
    customer accepting one or more legal documents.

    ``pending_acceptances`` carries the document keys + current versions
    so the client can drive the user through the acceptance flow without
    a follow-up GET.
    """

    def __init__(
        self,
        message: str,
        *,
        pending_acceptances: list[dict[str, str]] | None = None,
        status: int | None = 409,
        problem_type: str | None = None,
        problem: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message, status=status, problem_type=problem_type, problem=problem)
        self.pending_acceptances = pending_acceptances or []


class SessionTimeoutError(DriftstackError):
    """The operation exceeded the per-call ``timeout_ms`` (504).

    Distinguished from ``DriverError`` so customers can react specifically
    to "didn't finish in time" without conflating with downstream driver
    failures. ``timeout_ms`` is the bound the server actually applied
    (may differ from the request if the server clamped it).
    """

    def __init__(
        self,
        message: str,
        *,
        timeout_ms: int | None = None,
        status: int | None = 504,
        problem_type: str | None = None,
        problem: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message, status=status, problem_type=problem_type, problem=problem)
        self.timeout_ms = timeout_ms


# ── Rate / quota (429) ────────────────────────────────────────────────────


class RateLimitError(DriftstackError):
    """Token-bucket rate limit hit. ``retry_after_seconds`` is the hint."""

    def __init__(
        self,
        message: str,
        *,
        retry_after_seconds: int | None = None,
        status: int | None = 429,
        problem_type: str | None = None,
        problem: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message, status=status, problem_type=problem_type, problem=problem)
        self.retry_after_seconds = retry_after_seconds


class QuotaExceededError(DriftstackError):
    """Per-period usage quota exhausted."""

    def __init__(
        self,
        message: str,
        *,
        current: int | None = None,
        limit: int | None = None,
        record_type: str | None = None,
        status: int | None = 429,
        problem_type: str | None = None,
        problem: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message, status=status, problem_type=problem_type, problem=problem)
        self.current = current
        self.limit = limit
        self.record_type = record_type


class ConcurrencyLimitError(DriftstackError):
    """Active-session count would exceed the tier's concurrent limit."""

    def __init__(
        self,
        message: str,
        *,
        current_sessions: int | None = None,
        limit: int | None = None,
        status: int | None = 429,
        problem_type: str | None = None,
        problem: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message, status=status, problem_type=problem_type, problem=problem)
        self.current_sessions = current_sessions
        self.limit = limit


class StorageQuotaExceededError(DriftstackError):
    """doc-150 item 6 — per-account profile-storage quota reached at session-launch.

    409 Conflict. Raised when a profile-backed session-create would grow the
    account's stored state past its tier's hard cap. ``used_bytes`` /
    ``cap_bytes`` / ``tier`` surface the overage. Only profile-backed launches
    raise this; enterprise is soft-only and never does.
    """

    def __init__(
        self,
        message: str,
        *,
        used_bytes: int | None = None,
        cap_bytes: int | None = None,
        tier: str | None = None,
        status: int | None = 409,
        problem_type: str | None = None,
        problem: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message, status=status, problem_type=problem_type, problem=problem)
        self.used_bytes = used_bytes
        self.cap_bytes = cap_bytes
        self.tier = tier


class ProxyValidationFailedError(DriftstackError):
    """422 — the proxy on a launch failed the server's LIVE pre-launch test.

    The server connected THROUGH the proxy and ran a real egress round-trip before
    dispatching; it failed, so the launch was BLOCKED (no session, no worker).
    ``reason`` is a stable enum for branching: ``"unreachable"`` (check
    host/port/online), ``"auth_failed"`` (re-enter credentials), ``"timeout"``
    (proxy slow/down), or ``"egress_blocked"`` (proxy connects but its upstream
    can't reach the internet). Fix the proxy, then launch again.
    """

    def __init__(
        self,
        message: str,
        *,
        reason: str | None = None,
        status: int | None = 422,
        problem_type: str | None = None,
        problem: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message, status=status, problem_type=problem_type, problem=problem)
        self.reason = reason


class ProfileInUseError(ConflictError):
    """409 — A3 finding #7 single-active-session-per-profile guard.

    A session-create carried a ``profile_id`` that already has a live (non-
    terminal) session for the account. Two sessions on the same profile would both
    restore + overwrite the same saved cookie/state blob (losing the customer's
    logins), so the launch is REFUSED. ``active_session_id`` is the id of the live
    session (e.g. ``ses_…`` / ``agt_…``) — end it (or wait for it to finish) before
    launching another. A create without a profile_id never raises this.

    Subclasses :class:`ConflictError` (it IS a 409 conflict) so existing
    ``except ConflictError`` handlers still catch it.

    Cross-SDK parity: TS exposes ``err.activeSessionId``; Go exposes
    ``err.ActiveSessionID``; Python exposes snake_case ``err.active_session_id``.
    """

    def __init__(
        self,
        message: str,
        *,
        status: int | None = 409,
        problem_type: str | None = None,
        problem: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message, status=status, problem_type=problem_type, problem=problem)
        p = problem or {}
        self.active_session_id: str = str(p.get("active_session_id", ""))


# ── Driver / upstream (502) ───────────────────────────────────────────────


class DriverError(DriftstackError):
    """The driver returned an unrecoverable error during the operation."""


class DriverNotIntegratedError(DriverError):
    """The requested driver is recognised but not integrated in this
    deployment (HTTP 503, ``driver-not-integrated`` problem-type).

    Mirrors the TypeScript SDK's ``DriverNotIntegratedError`` taxonomy.
    Subclasses :class:`DriverError` (NOT ``DriftstackError`` directly) so
    existing ``except DriverError`` handlers keep catching it — customers
    who don't care about the distinction see no behaviour change."""


# ── Transport (network, timeout, parse) ───────────────────────────────────


class TransportError(DriftstackError):
    """A network-level or response-parsing failure that didn't reach the server.

    Distinguished from server-returned errors so retry logic can decide
    whether the request was idempotent enough to retry without surprises.
    """


# ── Auth-flow errors (V-079; SDK normalization V-115) ────────────────────


class EmailAlreadyRegisteredError(DriftstackError):
    """Signup attempted with an email already on file."""


class InvalidCredentialsError(AuthError):
    """Login failed — email or password incorrect."""


class InvalidAuthTokenError(DriftstackError):
    """Token (verification, magic link, password reset) is invalid, expired, or already used."""


class EmailNotVerifiedError(ForbiddenError):
    """Login attempted before email verification step completed."""


# V-439 — additional typed problem types matching Go SDK V-438 coverage.


class FeatureUnavailableError(DriftstackError):
    """Endpoint requires infrastructure not configured in this deployment
    (e.g. avatar uploads when R2 isn't wired). HTTP 503."""


class MfaStepUpRequiredError(DriftstackError):
    """V-353e — operation requires a fresh MFA proof (15-minute step-up
    freshness window). Customer should call POST /v1/auth/mfa/step-up
    with a TOTP code and retry the original request."""


class InternalError(DriftstackError):
    """Unhandled server-side error. Detail message may be sanitized;
    check Driftstack status / contact support if this persists."""


class BundledLlmBudgetExhaustedError(DriftstackError):
    """Arc 1 sub-slice 6.8 (v2-#6) — bundled-LLM monthly cap reached
    (HTTP 402). Customer recovery paths in the problem-detail string:
    raise cap via PATCH /v1/account/me/bundled-llm-settings, supply a
    BYOK key (header or stored), or wait for next calendar month.

    Cross-SDK parity: TS exposes ``err.spentCents`` + ``err.capCents``;
    Go exposes ``err.SpentCents`` + ``err.CapCents``; Python exposes
    snake_case ``err.spent_cents`` + ``err.cap_cents``.
    """

    def __init__(
        self,
        message: str,
        *,
        status: int | None = 402,
        problem_type: str | None = None,
        problem: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message, status=status, problem_type=problem_type, problem=problem)
        p = problem or {}
        self.spent_cents: int = _coerce_int(p.get("spent_cents"))
        self.cap_cents: int = _coerce_int(p.get("cap_cents"))


class BundledLlmConsentRequiredError(DriftstackError):
    """Arc 1 sub-slice 6.8 (v2-#6) — deployment offers bundled-LLM but
    the customer hasn't opted in (HTTP 402). Recovery: PATCH /v1/account/
    me/bundled-llm-settings with {"consent": true} OR PUT a BYOK key."""


class PairModeConflictError(DriftstackError):
    """Arc 2 sub-slice 8.10 (v2-#8) — pair-mode takeover lost the
    SET-NX-EX lock race. HTTP 409.

    Cross-SDK parity: TS exposes ``err.winnerClientId``; Go exposes
    ``err.WinnerClientID``; Python exposes snake_case
    ``err.winner_client_id`` — identifies who currently holds the
    takeover so the dashboard can render "user X is taking over".
    """

    def __init__(
        self,
        message: str,
        *,
        status: int | None = 409,
        problem_type: str | None = None,
        problem: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message, status=status, problem_type=problem_type, problem=problem)
        p = problem or {}
        self.winner_client_id: str = str(p.get("winner_client_id", ""))


class PairModeStateInvalidTransitionError(DriftstackError):
    """Arc 2 sub-slice 8.10 (v2-#8) — invalid pair-mode transition.
    HTTP 409. Extensions: ``from_`` (current state, named ``from_``
    because ``from`` is a reserved word in Python) + ``transition``
    (the rejected action).

    Cross-SDK parity: TS exposes ``err.from`` + ``err.transition``;
    Go exposes ``err.From`` + ``err.Transition``. Python parity-fix
    parses the same fields off the problem-json envelope at
    construction time so customers can branch on the typed error
    without re-reading the raw problem dict.
    """

    def __init__(
        self,
        message: str,
        *,
        status: int | None = 409,
        problem_type: str | None = None,
        problem: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message, status=status, problem_type=problem_type, problem=problem)
        p = problem or {}
        self.from_: str = str(p.get("from", ""))
        self.transition: str = str(p.get("transition", ""))


class ByokAnthropicRequiredError(DriftstackError):
    """v2-#24 — Q.1.d (2026-05-17) — agent-sessions message turn cannot
    resolve an Anthropic API key. BYOK-for-v1.0 Tier-3 verdict means
    the customer MUST supply their own key (via stored
    /v1/account/me/byok-anthropic-key OR per-request
    ``x-byok-anthropic-api-key`` header). HTTP 502 — the agent layer is
    operational but cannot serve this customer's turn without a key."""


# ── Mapping problem-type URI → subclass ──────────────────────────────────

# Keep the mapping in one place for ease of audit + extension. The HTTP
# layer in `driftstack.http` consults this; the keys match the server
# constants in apps/server/src/lib/problem-types.ts.

PROBLEM_TYPE_TO_ERROR: dict[str, type[DriftstackError]] = {
    "https://errors.driftstack.dev/bad-request": BadRequestError,
    "https://errors.driftstack.dev/unauthorized": AuthError,
    "https://errors.driftstack.dev/forbidden": ForbiddenError,
    "https://errors.driftstack.dev/not-found": NotFoundError,
    "https://errors.driftstack.dev/conflict": ConflictError,
    "https://errors.driftstack.dev/rate-limited": RateLimitError,
    "https://errors.driftstack.dev/concurrency-limit": ConcurrencyLimitError,
    "https://errors.driftstack.dev/tier-limit": QuotaExceededError,
    # doc-150 item 6 — per-account profile-storage quota (409 at session-launch).
    "https://errors.driftstack.dev/storage-quota-exceeded": StorageQuotaExceededError,
    # Live pre-launch proxy validation (422 at launch).
    "https://errors.driftstack.dev/proxy-validation-failed": ProxyValidationFailedError,
    # A3 finding #7 — single-active-session-per-profile guard (409 at launch).
    "https://errors.driftstack.dev/profile-in-use": ProfileInUseError,
    "https://errors.driftstack.dev/revoked-key": RevokedKeyError,
    "https://errors.driftstack.dev/expired-key": ExpiredKeyError,
    "https://errors.driftstack.dev/invalid-key": InvalidKeyError,
    "https://errors.driftstack.dev/session-destroyed": SessionDestroyedError,
    "https://errors.driftstack.dev/session-timeout": SessionTimeoutError,
    "https://errors.driftstack.dev/legal-acceptance-required": LegalAcceptanceRequiredError,
    "https://errors.driftstack.dev/driver-error": DriverError,
    "https://errors.driftstack.dev/driver-not-integrated": DriverNotIntegratedError,
    "https://errors.driftstack.dev/validation-failed": ValidationError,
    # V-115: V-079 auth-flow problem types.
    "https://errors.driftstack.dev/email-already-registered": EmailAlreadyRegisteredError,
    "https://errors.driftstack.dev/invalid-credentials": InvalidCredentialsError,
    "https://errors.driftstack.dev/invalid-auth-token": InvalidAuthTokenError,
    "https://errors.driftstack.dev/email-not-verified": EmailNotVerifiedError,
    # V-439: ops-flow problem types.
    "https://errors.driftstack.dev/feature-unavailable": FeatureUnavailableError,
    "https://errors.driftstack.dev/mfa-step-up-required": MfaStepUpRequiredError,
    "https://errors.driftstack.dev/internal": InternalError,
    # v2-#24: Q.1.d BYOK Anthropic key path — closes TS/Python parity.
    "https://errors.driftstack.dev/byok-anthropic-required": ByokAnthropicRequiredError,
    # Arc 1 sub-slice 6.8 (v2-#6) — bundled-LLM 402 paths.
    "https://errors.driftstack.dev/bundled-llm-budget-exhausted": BundledLlmBudgetExhaustedError,
    "https://errors.driftstack.dev/bundled-llm-consent-required": BundledLlmConsentRequiredError,
    # Arc 2 sub-slice 8.10 (v2-#8) — pair-mode 409 paths.
    "https://errors.driftstack.dev/pair-mode-conflict": PairModeConflictError,
    "https://errors.driftstack.dev/pair-mode-invalid-transition": (
        PairModeStateInvalidTransitionError
    ),
}


# V-490 — public retry predicate. Mirrors the V-489 TS implementation
# (packages/sdk-typescript/src/errors.ts:isRetryable). Returns True for
# error kinds where a retry stands a reasonable chance of succeeding;
# False otherwise. Non-DriftstackError values return False.
#
# Retryable: TransportError (network failure), InternalError (5xx),
# RateLimitError (429 with Retry-After hint).
#
# NOT retryable: ValidationError, AuthError, NotFoundError,
# ConflictError, ConcurrencyLimitError (state-driven, not transient),
# all auth-flow errors, FeatureUnavailableError (config gate),
# MfaStepUpRequiredError (needs the customer to step up).
_RETRYABLE_TYPES: tuple[type[DriftstackError], ...] = (
    TransportError,
    InternalError,
    RateLimitError,
)


def is_retryable(err: object) -> bool:
    """Return True iff ``err`` is a DriftstackError whose kind is retryable.

    Use this from your own retry/backoff loop when the built-in retry in
    ``driftstack.retry`` doesn't fit. Honour ``RateLimitError.retry_after_seconds``
    for the wait between attempts when it's set.

    Non-DriftstackError values (regular Exceptions, None, primitives) return
    False — the SDK wraps known errors in DriftstackError, so a non-DS error
    is something the caller threw and the caller should decide how to handle.
    """
    return isinstance(err, _RETRYABLE_TYPES)

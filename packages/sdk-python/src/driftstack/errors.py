"""Error class hierarchy for the Driftstack Python SDK.

Mirrors the API's RFC 7807 problem types.
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


def _coerce_optional_int(value: Any) -> int | None:
    """Like :func:`_coerce_int`, but ``None`` stays ``None`` rather than
    becoming 0 — for fields whose ABSENCE is meaningful (e.g. a 'balance'
    refusal carries no ``debt_credits`` at all, which must not read as a
    debt of exactly zero)."""
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


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
    """403 — the key is valid but may not do this.

    Usually a missing scope or a plan without the feature. On an agent session
    it can also mean the chosen model needs your own Anthropic key: check
    :attr:`requires_own_key`.

    Subclasses :class:`AuthError`, so ``except AuthError`` catches it too — put
    ``except ForbiddenError`` first when you handle it differently.
    """

    @property
    def requires_own_key(self) -> bool:
        """True when an Opus-class model was refused because it runs only on your
        own Anthropic key and the session or turn would have run on Driftstack's
        included AI. Add a key (stored, or ``byok_api_key=`` on the call) or pick
        another model. False for every other 403."""
        return self.problem.get("requires_own_key") is True

    @property
    def model(self) -> str | None:
        """The model that was refused, when :attr:`requires_own_key` is true."""
        value = self.problem.get("model")
        return value if isinstance(value, str) else None


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
    """409 — the request conflicts with the current state.

    On an agent-session message the properties below say which conflict it is;
    each is ``None`` (or ``False``) when the server did not send it.
    """

    @property
    def turn_in_progress(self) -> bool:
        """True when another message is still running on this agent session.
        Wait for it to finish (or stop it), then send again."""
        return self.problem.get("turn_in_progress") is True

    @property
    def session_status(self) -> str | None:
        """Set when the agent session is not active (``"closed"`` or
        ``"paused"``): it already was when the message arrived, or this turn
        ended it — for example its token budget ran out. An open string."""
        value = self.problem.get("session_status")
        return value if isinstance(value, str) else None

    @property
    def closed_reason(self) -> str | None:
        """Why the session ended, when :attr:`session_status` is ``"closed"``
        and the session records a reason: the same value
        ``agent_sessions.get(id)`` returns as ``closed_reason``
        (``"customer-closed"``, ``"budget-exhausted"``, ``"transcript-limit"``,
        …), so no second call is needed. An open string; ``None`` for a paused
        session and on older servers."""
        value = self.problem.get("closed_reason")
        return value if isinstance(value, str) else None

    @property
    def idempotency_status(self) -> str | None:
        """Set when the conflict is about the Idempotency-Key: ``"in_progress"``
        (the first request with this key is still running — retry the SAME key
        later and it replays the result) or ``"mismatch"`` (the key was already
        used for a different request). An open string."""
        value = self.problem.get("idempotency_status")
        return value if isinstance(value, str) else None

    @property
    def ai_control_unavailable(self) -> bool:
        """True when AI control of the session changed while the turn was
        running, so it stopped early. Check :attr:`partial_results` first."""
        return self.problem.get("ai_control_unavailable") is True

    @property
    def phase(self) -> str | None:
        """Where the turn was when AI control changed. An open string."""
        value = self.problem.get("phase")
        return value if isinstance(value, str) else None

    @property
    def tokens_consumed(self) -> int | None:
        """Tokens the turn spent before it ended, when it did any work."""
        value = self.problem.get("tokens_consumed")
        if isinstance(value, bool) or not isinstance(value, int):
            return None
        return value

    @property
    def usage(self) -> dict[str, Any] | None:
        """The turn's usage block, when it did any work."""
        value = self.problem.get("usage")
        return value if isinstance(value, dict) else None

    @property
    def partial_results(self) -> list[dict[str, Any]] | None:
        """Steps that ran before the turn ended, when any did. Do not repeat
        them without checking the page."""
        value = self.problem.get("partial_results")
        if not isinstance(value, list):
            return None
        return [r for r in value if isinstance(r, dict)]


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
    """Per-account profile-storage quota reached at session-launch.

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
    """409 — single-active-session-per-profile guard.

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


# ── Transport (network, timeout, parse) ───────────────────────────────────


class TransportError(DriftstackError):
    """A network-level or response-parsing failure that didn't reach the server.

    Distinguished from server-returned errors so retry logic can decide
    whether the request was idempotent enough to retry without surprises.
    """


# ── Auth-flow errors (normalized to typed classes) ───────────────────────


class EmailAlreadyRegisteredError(DriftstackError):
    """Signup attempted with an email already on file."""


class InvalidCredentialsError(AuthError):
    """Login failed — email or password incorrect."""


class InvalidAuthTokenError(DriftstackError):
    """Token (verification, magic link, password reset) is invalid, expired, or already used."""


class EmailNotVerifiedError(ForbiddenError):
    """Login attempted before email verification step completed."""


# Additional typed problem types, matching the Go SDK's coverage.


class FeatureUnavailableError(DriftstackError):
    """Endpoint requires infrastructure not configured in this deployment
    (e.g. avatar uploads when R2 isn't wired). HTTP 503."""

    @property
    def stop_unconfirmed(self) -> bool:
        """True only on the 503 ``agent_sessions.stop()`` gets when the stop
        could not be confirmed just now: the turn may still be running, so call
        ``stop()`` again. False for every other 503 of this class — including
        "AI is not enabled", where calling again would not help — which is why
        ``is_retryable`` stays false for the class and this flag exists."""
        return self.problem.get("stop_unconfirmed") is True


class MfaStepUpRequiredError(DriftstackError):
    """Operation requires a fresh MFA proof (15-minute step-up
    freshness window). Customer should call POST /v1/auth/mfa/step-up
    with a TOTP code and retry the original request."""


class InternalError(DriftstackError):
    """Unhandled server-side error. Detail message may be sanitized;
    check Driftstack status / contact support if this persists."""


class BundledLlmBudgetExhaustedError(DriftstackError):
    """402 — the account's monthly budget for Driftstack's included AI is used
    up. Raise the cap (PATCH /v1/account/me/bundled-llm-settings), use your own
    Anthropic key (stored, or ``byok_api_key=`` on the call), or wait for the
    next calendar month.

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
    """402 — the turn would run on Driftstack's included AI, but the account
    has not opted in to it. Opt in (PATCH /v1/account/me/bundled-llm-settings
    with ``{"consent": true}``) or use your own Anthropic key."""


class AiCreditsExhaustedError(DriftstackError):
    """402 — a MOVED account's turn could not be funded from its AI credits.

    ``reason`` tells the three shapes apart:

    - ``"balance"`` — nothing left to spend; ``available_credits`` /
      ``required_credits`` say how far short. ``resets_at``, when present, is
      when the next grant lands.
    - ``"debt"`` — the account owes credits back (``debt_reason``
      ``"payment_reversed"`` or ``"plan_change"``) and spends nothing until it
      is repaid.
    - ``"task_too_large"`` — this one request would not fit even at the
      model's maximum reservation. Shortening the request is the only fix.

    Distinct from :class:`BundledLlmBudgetExhaustedError`: that type is the
    LEGACY monthly soft cap and never applies once an account is moved onto
    credits.
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
        self.reason: str = str(p.get("reason", "balance"))
        debt_reason = p.get("debt_reason")
        self.debt_reason: str | None = str(debt_reason) if debt_reason is not None else None
        self.available_credits: int | None = _coerce_optional_int(p.get("available_credits"))
        self.required_credits: int | None = _coerce_optional_int(p.get("required_credits"))
        self.debt_credits: int | None = _coerce_optional_int(p.get("debt_credits"))
        resets_at = p.get("resets_at")
        self.resets_at: str | None = str(resets_at) if resets_at is not None else None


class PairModeConflictError(DriftstackError):
    """Pair-mode takeover lost the race to another client. HTTP 409.

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
    """Invalid pair-mode transition.
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
    """502 — the turn has no usable AI key. Two cases, told apart by
    :attr:`key_rejected`:

    - false — there is no key to run on: none on the request, none stored, and
      Driftstack's included AI is not available to the account (a plan that runs
      AI only on its own key is answered this way too). Store your Anthropic key
      (PUT /v1/account/me/byok-anthropic-key) or send it with the call
      (``byok_api_key=``).
    - true — Anthropic refused YOUR key on the turn's first planning call.
      :attr:`key_source` says which key and :attr:`key_rejected_reason` why.

    No step ran in either case. ``is_retryable`` is false although the status is
    a 502: sending the same request again gets the same answer until the key is
    added, replaced or fixed.
    """

    @property
    def key_rejected(self) -> bool:
        """True when Anthropic refused your own key; false when there was no key."""
        return self.problem.get("key_rejected") is True

    @property
    def key_source(self) -> str | None:
        """Which key was refused: ``"header"`` (the ``byok_api_key`` sent with
        the call) or ``"stored"`` (the one saved on the account). An open
        string; ``None`` unless :attr:`key_rejected`."""
        value = self.problem.get("key_source")
        return value if isinstance(value, str) else None

    @property
    def key_rejected_reason(self) -> str | None:
        """Why it was refused: ``"invalid_or_unauthorized"`` (invalid, revoked,
        or not permitted to run the model — replace it) or ``"billing"`` (the
        Anthropic account behind it cannot pay for the call — fix billing with
        Anthropic). An open string; ``None`` unless :attr:`key_rejected`."""
        value = self.problem.get("key_rejected_reason")
        return value if isinstance(value, str) else None


# ── Mapping problem-type URI → subclass ──────────────────────────────────

# Keep the mapping in one place for ease of audit + extension. The HTTP
# layer in `driftstack.http` consults this; the keys are the problem-type
# URIs the API returns.

PROBLEM_TYPE_TO_ERROR: dict[str, type[DriftstackError]] = {
    "https://errors.driftstack.dev/bad-request": BadRequestError,
    "https://errors.driftstack.dev/unauthorized": AuthError,
    "https://errors.driftstack.dev/forbidden": ForbiddenError,
    "https://errors.driftstack.dev/not-found": NotFoundError,
    "https://errors.driftstack.dev/conflict": ConflictError,
    "https://errors.driftstack.dev/rate-limited": RateLimitError,
    "https://errors.driftstack.dev/concurrency-limit": ConcurrencyLimitError,
    "https://errors.driftstack.dev/tier-limit": QuotaExceededError,
    # Per-account profile-storage quota (409 at session-launch).
    "https://errors.driftstack.dev/storage-quota-exceeded": StorageQuotaExceededError,
    # Live pre-launch proxy validation (422 at launch).
    "https://errors.driftstack.dev/proxy-validation-failed": ProxyValidationFailedError,
    # Single-active-session-per-profile guard (409 at launch).
    "https://errors.driftstack.dev/profile-in-use": ProfileInUseError,
    "https://errors.driftstack.dev/revoked-key": RevokedKeyError,
    "https://errors.driftstack.dev/expired-key": ExpiredKeyError,
    "https://errors.driftstack.dev/invalid-key": InvalidKeyError,
    "https://errors.driftstack.dev/session-destroyed": SessionDestroyedError,
    "https://errors.driftstack.dev/session-timeout": SessionTimeoutError,
    "https://errors.driftstack.dev/legal-acceptance-required": LegalAcceptanceRequiredError,
    "https://errors.driftstack.dev/driver-error": DriverError,
    "https://errors.driftstack.dev/driver-not-integrated": DriverError,
    "https://errors.driftstack.dev/validation-failed": ValidationError,
    # Auth-flow problem types.
    "https://errors.driftstack.dev/email-already-registered": EmailAlreadyRegisteredError,
    "https://errors.driftstack.dev/invalid-credentials": InvalidCredentialsError,
    "https://errors.driftstack.dev/invalid-auth-token": InvalidAuthTokenError,
    "https://errors.driftstack.dev/email-not-verified": EmailNotVerifiedError,
    # Ops-flow problem types.
    "https://errors.driftstack.dev/feature-unavailable": FeatureUnavailableError,
    "https://errors.driftstack.dev/mfa-step-up-required": MfaStepUpRequiredError,
    "https://errors.driftstack.dev/internal": InternalError,
    # BYOK Anthropic key path.
    "https://errors.driftstack.dev/byok-anthropic-required": ByokAnthropicRequiredError,
    # Bundled-LLM 402 paths.
    "https://errors.driftstack.dev/bundled-llm-budget-exhausted": BundledLlmBudgetExhaustedError,
    "https://errors.driftstack.dev/bundled-llm-consent-required": BundledLlmConsentRequiredError,
    # Pair-mode 409 paths.
    "https://errors.driftstack.dev/pair-mode-conflict": PairModeConflictError,
    "https://errors.driftstack.dev/pair-mode-invalid-transition": (
        PairModeStateInvalidTransitionError
    ),
    # AI credits (402), dark until launch.
    "https://errors.driftstack.dev/ai-credits-exhausted": AiCreditsExhaustedError,
}


# The public retry predicate. Mirrors the TS implementation's
# `isRetryable`. Returns True for
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

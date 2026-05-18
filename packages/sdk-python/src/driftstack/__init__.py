"""Driftstack Python SDK.

Customer-facing entry points re-exported here so callers can write::

    from driftstack import Driftstack, AsyncDriftstack, DriftstackError

Resource accessors live on the client instance::

    client = Driftstack(api_key="ds_live_...")
    session = client.sessions.create()
    client.sessions.navigate(session.id, url="https://example.com")
    client.sessions.destroy(session.id)
"""

from __future__ import annotations

from driftstack._version import __version__
from driftstack.client import AsyncDriftstack, Driftstack
from driftstack.errors import (
    AuthError,
    BundledLlmBudgetExhaustedError,
    BundledLlmConsentRequiredError,
    ByokAnthropicRequiredError,
    ConcurrencyLimitError,
    ConflictError,
    DriftstackError,
    DriverError,
    EmailAlreadyRegisteredError,
    EmailNotVerifiedError,
    ExpiredKeyError,
    FeatureUnavailableError,
    ForbiddenError,
    InternalError,
    InvalidAuthTokenError,
    InvalidCredentialsError,
    InvalidKeyError,
    LegalAcceptanceRequiredError,
    MfaStepUpRequiredError,
    NotFoundError,
    PairModeConflictError,
    PairModeStateInvalidTransitionError,
    QuotaExceededError,
    RateLimitError,
    RevokedKeyError,
    SessionDestroyedError,
    SessionNotFoundError,
    SessionTimeoutError,
    TransportError,
    ValidationError,
    is_retryable,
)
from driftstack.webhook_signature import verify_webhook_signature

__all__ = [
    "__version__",
    "Driftstack",
    "AsyncDriftstack",
    "DriftstackError",
    "AuthError",
    "ForbiddenError",
    "InvalidKeyError",
    "ExpiredKeyError",
    "RevokedKeyError",
    "ConflictError",
    "NotFoundError",
    "RateLimitError",
    "QuotaExceededError",
    "ConcurrencyLimitError",
    "SessionNotFoundError",
    "SessionDestroyedError",
    "SessionTimeoutError",
    "LegalAcceptanceRequiredError",
    "DriverError",
    "ValidationError",
    "TransportError",
    "EmailAlreadyRegisteredError",
    "EmailNotVerifiedError",
    "InvalidAuthTokenError",
    "InvalidCredentialsError",
    "FeatureUnavailableError",
    "InternalError",
    "MfaStepUpRequiredError",
    "ByokAnthropicRequiredError",
    "BundledLlmBudgetExhaustedError",
    "BundledLlmConsentRequiredError",
    "PairModeConflictError",
    "PairModeStateInvalidTransitionError",
    "is_retryable",
    "verify_webhook_signature",
]

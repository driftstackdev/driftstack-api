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
    ConcurrencyLimitError,
    ConflictError,
    DriftstackError,
    DriverError,
    EmailAlreadyRegisteredError,
    EmailNotVerifiedError,
    ExpiredKeyError,
    ForbiddenError,
    InvalidAuthTokenError,
    InvalidCredentialsError,
    InvalidKeyError,
    LegalAcceptanceRequiredError,
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
    "verify_webhook_signature",
]

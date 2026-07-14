"""Driftstack Python SDK.

Customer-facing entry points re-exported here so callers can write::

    from driftstack import Driftstack, AsyncDriftstack, DriftstackError

Resource accessors live on the client instance::

    client = Driftstack(api_key="ds_live_...")
    session = client.sessions.create()
    client.sessions.navigate(session.id, {"url": "https://example.com"})
    client.sessions.destroy(session.id)
"""

from __future__ import annotations

from driftstack._version import __version__
from driftstack.client import AsyncDriftstack, Driftstack
from driftstack.errors import (
    AuthError,
    BadRequestError,
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
    ProfileInUseError,
    ProxyValidationFailedError,
    QuotaExceededError,
    RateLimitError,
    RevokedKeyError,
    SessionDestroyedError,
    SessionNotFoundError,
    SessionTimeoutError,
    StorageQuotaExceededError,
    TransportError,
    ValidationError,
    is_retryable,
)
from driftstack.resources.agent_sessions import LiveKitInfo
from driftstack.resources.api_keys import ApiKeyList
from driftstack.resources.archetypes import ListArchetypesResponse, PublicArchetype
from driftstack.resources.sessions import SessionsListPage
from driftstack.resources.team import (
    AcceptInviteResponse,
    TeamInvite,
    TeamInvitesList,
    TeamMember,
    TeamMembersList,
    TeamOwner,
    TeamOwnersList,
)
from driftstack.resources.webhooks import WebhookDeliveryListPage, WebhookEndpointList
from driftstack.webhook_signature import verify_webhook_signature

__all__ = [
    "__version__",
    "Driftstack",
    "AsyncDriftstack",
    "DriftstackError",
    "AuthError",
    "BadRequestError",
    "ForbiddenError",
    "InvalidKeyError",
    "ExpiredKeyError",
    "RevokedKeyError",
    "ConflictError",
    "NotFoundError",
    "RateLimitError",
    "QuotaExceededError",
    "ConcurrencyLimitError",
    "StorageQuotaExceededError",
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
    "ProfileInUseError",
    "ProxyValidationFailedError",
    "LiveKitInfo",
    "ListArchetypesResponse",
    "PublicArchetype",
    # Customer-facing pydantic models — used as return types on
    # client.*.method() so callers can annotate handlers without
    # deep-importing via driftstack.resources.*.
    "AcceptInviteResponse",
    "ApiKeyList",
    "SessionsListPage",
    "TeamInvite",
    "TeamInvitesList",
    "TeamMember",
    "TeamMembersList",
    "TeamOwner",
    "TeamOwnersList",
    "WebhookDeliveryListPage",
    "WebhookEndpointList",
    "is_retryable",
    "verify_webhook_signature",
]

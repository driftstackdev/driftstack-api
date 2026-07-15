"""Top-level Driftstack client.

Two parallel classes — :class:`Driftstack` (sync, ``httpx.Client``)
and :class:`AsyncDriftstack` (async, ``httpx.AsyncClient``). Mirrors
the pattern used by Stripe-Python, OpenAI-Python, Anthropic-Python.

Every accessor below is backed by its synchronous and asynchronous
resource implementation. Constructor, authentication, transport and
resource behavior are covered by the SDK test suite.
"""

from __future__ import annotations

from typing import Any

import httpx

from driftstack.http import AsyncHttpClient, HttpClient
from driftstack.resources.account import AccountResource, AsyncAccountResource
from driftstack.resources.agent_sessions import (
    AgentSessionsResource,
    AsyncAgentSessionsResource,
)
from driftstack.resources.api_keys import ApiKeysResource, AsyncApiKeysResource
from driftstack.resources.archetypes import ArchetypesResource, AsyncArchetypesResource
from driftstack.resources.audit_log import AsyncAuditLogResource, AuditLogResource
from driftstack.resources.auth import AsyncAuthResource, AuthResource
from driftstack.resources.billing import AsyncBillingResource, BillingResource
from driftstack.resources.crypto_orders import (
    AsyncCryptoOrdersResource,
    CryptoOrdersResource,
)
from driftstack.resources.egress import AsyncEgressResource, EgressResource
from driftstack.resources.email_preferences import (
    AsyncEmailPreferencesResource,
    EmailPreferencesResource,
)
from driftstack.resources.legal import AsyncLegalResource, LegalResource
from driftstack.resources.mfa import AsyncMfaResource, MfaResource
from driftstack.resources.profile_snapshots import (
    AsyncProfileSnapshotsResource,
    ProfileSnapshotsResource,
)
from driftstack.resources.profiles import AsyncProfilesResource, ProfilesResource
from driftstack.resources.recipes import (
    AsyncRecipesResource,
    RecipesResource,
)
from driftstack.resources.sessions import AsyncSessionsResource, SessionsResource
from driftstack.resources.team import AsyncTeamResource, TeamResource
from driftstack.resources.usage import AsyncUsageResource, UsageResource
from driftstack.resources.webhooks import AsyncWebhooksResource, WebhooksResource
from driftstack.retry import RetryConfig

DEFAULT_BASE_URL = "https://api.driftstack.dev"


def _validate_api_key(api_key: str) -> None:
    if not api_key or not isinstance(api_key, str):
        raise TypeError("Driftstack: api_key is required and must be a string")


# ──────────────────────────────────────────────────────────────────────────
# Sync
# ──────────────────────────────────────────────────────────────────────────


class Driftstack:
    """Synchronous Driftstack API client.

    Example::

        from driftstack import Driftstack

        client = Driftstack(api_key="ds_live_…")
        session = client.sessions.create()
        client.sessions.navigate(session.id, {"url": "https://example.com"})
        client.sessions.destroy(session.id)
    """

    def __init__(
        self,
        api_key: str,
        *,
        base_url: str = DEFAULT_BASE_URL,
        timeout_s: float = 30.0,
        retry: RetryConfig | None = None,
        http_client: httpx.Client | None = None,
        effective_account: str | None = None,
    ) -> None:
        _validate_api_key(api_key)
        self._http = HttpClient(
            api_key,
            base_url=base_url,
            timeout_s=timeout_s,
            retry=retry,
            effective_account=effective_account,
            client=http_client,
        )
        self.sessions = SessionsResource(self._http)
        self.archetypes = ArchetypesResource(self._http)
        self.api_keys = ApiKeysResource(self._http)
        self.usage = UsageResource(self._http)
        self.webhooks = WebhooksResource(self._http)
        self.profiles = ProfilesResource(self._http)
        # V-312 — immutable point-in-time profile snapshots.
        self.profile_snapshots = ProfileSnapshotsResource(self._http)
        self.billing = BillingResource(self._http)
        # V-666 — crypto-checkout / crypto-orders.
        self.crypto_orders = CryptoOrdersResource(self._http)
        self.auth = AuthResource(self._http)
        # V-385 / V-434 — /v1/account/me rich-shape read.
        self.account = AccountResource(self._http)
        # V-353b / V-448 — MFA enrollment management.
        self.mfa = MfaResource(self._http)
        # V-216 / V-449 — audit-log read + iterate.
        self.audit_log = AuditLogResource(self._http)
        # V-204 / V-449 — email preferences.
        self.email_preferences = EmailPreferencesResource(self._http)
        # V-049 / V-458 — legal acceptance.
        self.legal = LegalResource(self._http)
        # V-298c — Team RBAC. Auth path integration is V-298d.
        self.team = TeamResource(self._http)
        # EG-API-1.2/1.3 — customer-configurable egress (planning 133).
        self.egress = EgressResource(self._http)
        # AI-D — agent chat sessions (planning 132 §"Phase 7").
        self.agent_sessions = AgentSessionsResource(self._http)
        # AI-B4 — write-only recipe library (snapshot agent-session
        # intent_log + transcript for later replay).
        self.recipes = RecipesResource(self._http)

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> Driftstack:
        return self

    def __exit__(self, *_excinfo: Any) -> None:
        self.close()


# ──────────────────────────────────────────────────────────────────────────
# Async
# ──────────────────────────────────────────────────────────────────────────


class AsyncDriftstack:
    """Async Driftstack API client. asyncio-compatible."""

    def __init__(
        self,
        api_key: str,
        *,
        base_url: str = DEFAULT_BASE_URL,
        timeout_s: float = 30.0,
        retry: RetryConfig | None = None,
        http_client: httpx.AsyncClient | None = None,
        effective_account: str | None = None,
    ) -> None:
        _validate_api_key(api_key)
        self._http = AsyncHttpClient(
            api_key,
            base_url=base_url,
            timeout_s=timeout_s,
            retry=retry,
            effective_account=effective_account,
            client=http_client,
        )
        self.sessions = AsyncSessionsResource(self._http)
        self.archetypes = AsyncArchetypesResource(self._http)
        self.api_keys = AsyncApiKeysResource(self._http)
        self.usage = AsyncUsageResource(self._http)
        self.webhooks = AsyncWebhooksResource(self._http)
        self.profiles = AsyncProfilesResource(self._http)
        # V-312 — immutable point-in-time profile snapshots.
        self.profile_snapshots = AsyncProfileSnapshotsResource(self._http)
        self.billing = AsyncBillingResource(self._http)
        # V-666 — crypto-checkout / crypto-orders.
        self.crypto_orders = AsyncCryptoOrdersResource(self._http)
        self.auth = AsyncAuthResource(self._http)
        # V-385 / V-434 — /v1/account/me rich-shape read.
        self.account = AsyncAccountResource(self._http)
        # V-353b / V-448 — MFA enrollment management.
        self.mfa = AsyncMfaResource(self._http)
        # V-216 / V-449 — audit-log read + iterate.
        self.audit_log = AsyncAuditLogResource(self._http)
        # V-204 / V-449 — email preferences.
        self.email_preferences = AsyncEmailPreferencesResource(self._http)
        # V-049 / V-458 — legal acceptance.
        self.legal = AsyncLegalResource(self._http)
        # V-298c — Team RBAC. Auth path integration is V-298d.
        self.team = AsyncTeamResource(self._http)
        # EG-API-1.2/1.3 — customer-configurable egress (planning 133).
        self.egress = AsyncEgressResource(self._http)
        # AI-D — agent chat sessions (planning 132 §"Phase 7").
        self.agent_sessions = AsyncAgentSessionsResource(self._http)
        # AI-B4 — write-only recipe library.
        self.recipes = AsyncRecipesResource(self._http)

    async def aclose(self) -> None:
        await self._http.aclose()

    async def __aenter__(self) -> AsyncDriftstack:
        return self

    async def __aexit__(self, *_excinfo: Any) -> None:
        await self.aclose()

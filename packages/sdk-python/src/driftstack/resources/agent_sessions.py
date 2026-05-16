"""AgentSessions resource — /v1/agent-sessions/* (AI-D, planning 132 §"Phase 7").

Mirrors the TypeScript AgentSessionsResource (commit aadc3ffb). Server
registers the route surface as 503 ``FeatureUnavailable`` stubs until
the LLM key path is enabled on the deployment; SDK surface is stable so
consumers compile ahead of time.

Discriminated message response: branch on ``["kind"]`` —
``plan-executed`` (carries ``intents`` + ``results`` + ``ok``),
``clarify`` (``clarifying_question``), or ``refuse`` (``refuse_reason``).
"""

from __future__ import annotations

from typing import Any
from urllib.parse import quote

from driftstack.http import AsyncHttpClient, HttpClient
from driftstack.resources._common import coerce_body


class AgentSessionsResource:
    """Synchronous AI-chat agent-sessions resource."""

    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def create(self, body: dict[str, Any] | None = None) -> dict[str, Any]:
        """Create a new agent chat session.

        Body shape (all fields optional): ``{"driftstack_session_id"?: ...,
        "token_budget"?: int}``.
        """
        return self._http.request(
            "POST", "/v1/agent-sessions", json_body=coerce_body(body or {})
        )

    def get(self, agent_session_id: str) -> dict[str, Any]:
        """Read agent session state."""
        return self._http.request(
            "GET", f"/v1/agent-sessions/{quote(agent_session_id, safe='')}"
        )

    def message(
        self,
        agent_session_id: str,
        user_message: str,
        *,
        byok_api_key: str | None = None,
    ) -> dict[str, Any]:
        """Run one decompose→execute turn against the agent session.

        Returns a discriminated body keyed by ``kind``. Closed sessions
        return 409 Conflict — start a new session.

        ``byok_api_key`` (optional, BYOK Tier-3 LOCKED 2026-05-16) is
        forwarded as the ``x-byok-anthropic-api-key`` request header so
        callers don't have to construct it by hand. NEVER logged by
        the SDK; arrives over TLS to the control plane.
        """
        extra_headers = (
            {"x-byok-anthropic-api-key": byok_api_key} if byok_api_key is not None else None
        )
        return self._http.request(
            "POST",
            f"/v1/agent-sessions/{quote(agent_session_id, safe='')}/message",
            json_body=coerce_body({"user_message": user_message}),
            extra_headers=extra_headers,
        )

    def close(self, agent_session_id: str) -> None:
        """Close the agent session (idempotent)."""
        self._http.request(
            "DELETE", f"/v1/agent-sessions/{quote(agent_session_id, safe='')}"
        )


class AsyncAgentSessionsResource:
    """Async AI-chat agent-sessions resource."""

    def __init__(self, http: AsyncHttpClient) -> None:
        self._http = http

    async def create(self, body: dict[str, Any] | None = None) -> dict[str, Any]:
        return await self._http.request(
            "POST", "/v1/agent-sessions", json_body=coerce_body(body or {})
        )

    async def get(self, agent_session_id: str) -> dict[str, Any]:
        return await self._http.request(
            "GET", f"/v1/agent-sessions/{quote(agent_session_id, safe='')}"
        )

    async def message(
        self,
        agent_session_id: str,
        user_message: str,
        *,
        byok_api_key: str | None = None,
    ) -> dict[str, Any]:
        extra_headers = (
            {"x-byok-anthropic-api-key": byok_api_key} if byok_api_key is not None else None
        )
        return await self._http.request(
            "POST",
            f"/v1/agent-sessions/{quote(agent_session_id, safe='')}/message",
            json_body=coerce_body({"user_message": user_message}),
            extra_headers=extra_headers,
        )

    async def close(self, agent_session_id: str) -> None:
        await self._http.request(
            "DELETE", f"/v1/agent-sessions/{quote(agent_session_id, safe='')}"
        )

"""Recipes resource — /v1/recipes (AI-B4, write-only at v1.0).

Mirrors the TypeScript RecipesResource. Server registers the route as
a 503 ``FeatureUnavailable`` stub until both ``recipesRepo`` and
``agentSessionsRepo`` are wired in AppDeps; SDK surface is stable so
consumers compile ahead of time.

V1.0 scope is intentionally narrow — ``create`` only. Read / list /
execute / delete surfaces are v1.1 D2/D3.
"""

from __future__ import annotations

from typing import Any

from driftstack.http import AsyncHttpClient, HttpClient
from driftstack.resources._common import coerce_body


class RecipesResource:
    """Synchronous AI-B4 recipe library."""

    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def create(
        self,
        *,
        agent_session_id: str,
        label: str,
        description: str | None = None,
    ) -> dict[str, Any]:
        """Snapshot a finished agent_session's intent_log + transcript.

        Returns the inserted ``Recipe`` payload (id + account_id +
        agent_session_id + label + description + intent_count +
        timestamps).

        Server-side: cross-account access on ``agent_session_id``
        returns 404 (not 403) by design — existence isn't leaked.
        """
        body: dict[str, Any] = {
            "agent_session_id": agent_session_id,
            "label": label,
        }
        if description is not None:
            body["description"] = description
        return self._http.request("POST", "/v1/recipes", json_body=coerce_body(body))


class AsyncRecipesResource:
    """Async AI-B4 recipe library."""

    def __init__(self, http: AsyncHttpClient) -> None:
        self._http = http

    async def create(
        self,
        *,
        agent_session_id: str,
        label: str,
        description: str | None = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {
            "agent_session_id": agent_session_id,
            "label": label,
        }
        if description is not None:
            body["description"] = description
        return await self._http.request("POST", "/v1/recipes", json_body=coerce_body(body))

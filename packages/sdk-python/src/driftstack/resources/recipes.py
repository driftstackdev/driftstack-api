"""Recipes resource — /v1/recipes (AI-B4).

Mirrors the TypeScript RecipesResource. Server registers the routes as
503 ``FeatureUnavailable`` stubs until both ``recipesRepo`` and
``agentSessionsRepo`` are wired in AppDeps; SDK surface is stable so
consumers compile ahead of time.

Surface: ``create`` + ``list`` + ``get`` + ``delete`` (the
read/management path was pulled forward from the v1.1 D2/D3 defer —
V-530.I/.J). Recipe EXECUTION stays v1.1 (gated on the harness executor).
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Iterator
from typing import Any
from urllib.parse import quote, urlencode

from driftstack.http import AsyncHttpClient, HttpClient
from driftstack.pagination import aiterate_paginated, iterate_paginated
from driftstack.resources._common import coerce_body


def _encode_query(query: dict[str, Any]) -> str:
    items: list[tuple[str, str]] = []
    for key, value in query.items():
        if value is None:
            continue
        items.append((key, str(value)))
    return urlencode(items)


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

    def list(self, *, limit: int | None = None, cursor: str | None = None) -> dict[str, Any]:
        """List the account's recipes, newest first. Cursor-paginated."""
        qs = _encode_query({"limit": limit, "cursor": cursor})
        path = "/v1/recipes" + (f"?{qs}" if qs else "")
        return self._http.request("GET", path)

    def iterate(self, *, limit: int | None = None) -> Iterator[dict[str, Any]]:
        """Lazily walk every recipe, handling cursor handoff."""

        def fetch_page(cursor: str | None) -> dict[str, Any]:
            return self.list(limit=limit, cursor=cursor)

        return iterate_paginated(fetch_page)

    def get(self, recipe_id: str) -> dict[str, Any]:
        """Fetch one recipe with its public ``intent_log``.

        Sensitive type steps retain their selector and ``sensitive`` marker but
        omit the optional value. Exact replay values stay encrypted server-side.

        404 if missing or owned by another account (existence not leaked).
        """
        return self._http.request("GET", f"/v1/recipes/{quote(recipe_id, safe='')}")

    def delete(self, recipe_id: str) -> None:
        """Delete a recipe. 404 if missing or owned by another account."""
        self._http.request("DELETE", f"/v1/recipes/{quote(recipe_id, safe='')}")

    def suggest(self, agent_session_id: str) -> dict[str, Any]:
        """Doc-132 §5.2 (recipe auto-generation) v1.0 slice.

        Fetch a deterministic label/description suggestion derived from
        the session's own intent_log (same assembly ``create`` uses).
        Read-only; safe to call speculatively before deciding to save.
        Returns ``suggested_label`` / ``suggested_description`` /
        ``intent_count``.
        """
        return self._http.request(
            "GET", f"/v1/agent-sessions/{quote(agent_session_id, safe='')}/recipe-suggestion"
        )


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

    async def list(self, *, limit: int | None = None, cursor: str | None = None) -> dict[str, Any]:
        qs = _encode_query({"limit": limit, "cursor": cursor})
        path = "/v1/recipes" + (f"?{qs}" if qs else "")
        return await self._http.request("GET", path)

    def iterate(self, *, limit: int | None = None) -> AsyncIterator[dict[str, Any]]:
        """Async variant of :meth:`RecipesResource.iterate`."""

        async def fetch_page(cursor: str | None) -> dict[str, Any]:
            return await self.list(limit=limit, cursor=cursor)

        return aiterate_paginated(fetch_page)

    async def get(self, recipe_id: str) -> dict[str, Any]:
        return await self._http.request("GET", f"/v1/recipes/{quote(recipe_id, safe='')}")

    async def delete(self, recipe_id: str) -> None:
        await self._http.request("DELETE", f"/v1/recipes/{quote(recipe_id, safe='')}")

    async def suggest(self, agent_session_id: str) -> dict[str, Any]:
        """Async variant of :meth:`RecipesResource.suggest`."""
        return await self._http.request(
            "GET", f"/v1/agent-sessions/{quote(agent_session_id, safe='')}/recipe-suggestion"
        )

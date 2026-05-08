"""Profiles resource — /v1/profiles (V-081).

Type annotations on request/response bodies use ``dict[str, Any]``
pending the next ``scripts/generate.sh`` regeneration pass that
will add ``Profile`` / ``CreateProfileRequest`` / ``UpdateProfileRequest``
Pydantic models to ``_generated/models.py``. The runtime path
already returns the parsed JSON shape; type-strictness lands on the
next regen.
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


class ProfilesResource:
    """Synchronous profiles resource."""

    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def create(self, body: dict[str, Any]) -> dict[str, Any]:
        """Create a profile. Tier-limit enforced server-side."""
        return self._http.request("POST", "/v1/profiles", json_body=coerce_body(body))

    def list(self, *, limit: int | None = None, cursor: str | None = None) -> dict[str, Any]:
        """List profiles for the current account."""
        qs = _encode_query({"limit": limit, "cursor": cursor})
        path = "/v1/profiles" + (f"?{qs}" if qs else "")
        return self._http.request("GET", path)

    def iterate(self, *, limit: int | None = None) -> Iterator[dict[str, Any]]:
        """Lazily walk every profile, handling cursor handoff."""

        def fetch_page(cursor: str | None) -> dict[str, Any]:
            return self.list(limit=limit, cursor=cursor)

        return iterate_paginated(fetch_page)

    def get(self, profile_id: str) -> dict[str, Any]:
        return self._http.request("GET", f"/v1/profiles/{quote(profile_id, safe='')}")

    def update(self, profile_id: str, body: dict[str, Any]) -> dict[str, Any]:
        return self._http.request(
            "PATCH",
            f"/v1/profiles/{quote(profile_id, safe='')}",
            json_body=coerce_body(body),
        )

    def delete(self, profile_id: str) -> None:
        self._http.request("DELETE", f"/v1/profiles/{quote(profile_id, safe='')}")

    def clone(self, profile_id: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        """V-313 — duplicate a profile. Server auto-derives "(copy)" / "(copy 2)" /
        ... name when ``body["name"]`` is omitted. Tier-cap + name-conflict
        checked the same as ``create``."""
        return self._http.request(
            "POST",
            f"/v1/profiles/{quote(profile_id, safe='')}/clone",
            json_body=coerce_body(body or {}),
        )


class AsyncProfilesResource:
    """Async profiles resource."""

    def __init__(self, http: AsyncHttpClient) -> None:
        self._http = http

    async def create(self, body: dict[str, Any]) -> dict[str, Any]:
        return await self._http.request("POST", "/v1/profiles", json_body=coerce_body(body))

    async def list(self, *, limit: int | None = None, cursor: str | None = None) -> dict[str, Any]:
        qs = _encode_query({"limit": limit, "cursor": cursor})
        path = "/v1/profiles" + (f"?{qs}" if qs else "")
        return await self._http.request("GET", path)

    def iterate(self, *, limit: int | None = None) -> AsyncIterator[dict[str, Any]]:
        """Async variant of :meth:`ProfilesResource.iterate`."""

        async def fetch_page(cursor: str | None) -> dict[str, Any]:
            return await self.list(limit=limit, cursor=cursor)

        return aiterate_paginated(fetch_page)

    async def get(self, profile_id: str) -> dict[str, Any]:
        return await self._http.request("GET", f"/v1/profiles/{quote(profile_id, safe='')}")

    async def update(self, profile_id: str, body: dict[str, Any]) -> dict[str, Any]:
        return await self._http.request(
            "PATCH",
            f"/v1/profiles/{quote(profile_id, safe='')}",
            json_body=coerce_body(body),
        )

    async def delete(self, profile_id: str) -> None:
        await self._http.request("DELETE", f"/v1/profiles/{quote(profile_id, safe='')}")

    async def clone(self, profile_id: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        return await self._http.request(
            "POST",
            f"/v1/profiles/{quote(profile_id, safe='')}/clone",
            json_body=coerce_body(body or {}),
        )

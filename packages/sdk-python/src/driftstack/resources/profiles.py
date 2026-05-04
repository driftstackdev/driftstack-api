"""Profiles resource — /v1/profiles (V-081).

Type annotations on request/response bodies use ``dict[str, Any]``
pending the next ``scripts/generate.sh`` regeneration pass that
will add ``Profile`` / ``CreateProfileRequest`` / ``UpdateProfileRequest``
Pydantic models to ``_generated/models.py``. The runtime path
already returns the parsed JSON shape; type-strictness lands on the
next regen.
"""

from __future__ import annotations

from typing import Any
from urllib.parse import quote, urlencode

from driftstack.http import AsyncHttpClient, HttpClient
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

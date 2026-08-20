"""Profile snapshots resource — /v1/profiles/:id/snapshots +
/v1/profile-snapshots (V-312). Immutable point-in-time copies of
saved profiles.

Type annotations on request/response bodies use ``dict[str, Any]``
pending the next ``scripts/generate.sh`` regeneration pass that
will add ``ProfileSnapshot`` Pydantic models to ``_generated/models.py``.
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


class ProfileSnapshotsResource:
    """Synchronous profile snapshots resource."""

    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def capture(self, profile_id: str, body: dict[str, Any]) -> dict[str, Any]:
        """Capture a snapshot of an existing profile."""
        return self._http.request(
            "POST",
            f"/v1/profiles/{quote(profile_id, safe='')}/snapshots",
            json_body=coerce_body(body),
        )

    def list_for_profile(
        self,
        profile_id: str,
        *,
        limit: int | None = None,
        cursor: str | None = None,
    ) -> dict[str, Any]:
        """List snapshots for one profile, newest-first."""
        qs = _encode_query({"limit": limit, "cursor": cursor})
        path = f"/v1/profiles/{quote(profile_id, safe='')}/snapshots"
        if qs:
            path = f"{path}?{qs}"
        return self._http.request("GET", path)

    def list(self, *, limit: int | None = None, cursor: str | None = None) -> dict[str, Any]:
        """List every snapshot owned by the EFFECTIVE account.

        Your own account, or the owner you are acting as via
        ``X-Driftstack-Account``. V-1121 — this said "the calling
        account"; the handler resolves the team header first.
        """
        qs = _encode_query({"limit": limit, "cursor": cursor})
        path = "/v1/profile-snapshots" + (f"?{qs}" if qs else "")
        return self._http.request("GET", path)

    def iterate(self, *, limit: int | None = None) -> Iterator[dict[str, Any]]:
        """Lazily walk every snapshot, handling cursor handoff."""

        def fetch_page(cursor: str | None) -> dict[str, Any]:
            return self.list(limit=limit, cursor=cursor)

        return iterate_paginated(fetch_page)

    def get(self, snapshot_id: str) -> dict[str, Any]:
        return self._http.request("GET", f"/v1/profile-snapshots/{quote(snapshot_id, safe='')}")

    def restore(self, snapshot_id: str, body: dict[str, Any]) -> dict[str, Any]:
        """Restore into a new profile. Tier-cap + name-conflict checked."""
        return self._http.request(
            "POST",
            f"/v1/profile-snapshots/{quote(snapshot_id, safe='')}/restore",
            json_body=coerce_body(body),
        )

    def delete(self, snapshot_id: str) -> None:
        self._http.request("DELETE", f"/v1/profile-snapshots/{quote(snapshot_id, safe='')}")


class AsyncProfileSnapshotsResource:
    """Async profile snapshots resource."""

    def __init__(self, http: AsyncHttpClient) -> None:
        self._http = http

    async def capture(self, profile_id: str, body: dict[str, Any]) -> dict[str, Any]:
        return await self._http.request(
            "POST",
            f"/v1/profiles/{quote(profile_id, safe='')}/snapshots",
            json_body=coerce_body(body),
        )

    async def list_for_profile(
        self,
        profile_id: str,
        *,
        limit: int | None = None,
        cursor: str | None = None,
    ) -> dict[str, Any]:
        qs = _encode_query({"limit": limit, "cursor": cursor})
        path = f"/v1/profiles/{quote(profile_id, safe='')}/snapshots"
        if qs:
            path = f"{path}?{qs}"
        return await self._http.request("GET", path)

    async def list(self, *, limit: int | None = None, cursor: str | None = None) -> dict[str, Any]:
        qs = _encode_query({"limit": limit, "cursor": cursor})
        path = "/v1/profile-snapshots" + (f"?{qs}" if qs else "")
        return await self._http.request("GET", path)

    def iterate(self, *, limit: int | None = None) -> AsyncIterator[dict[str, Any]]:
        async def fetch_page(cursor: str | None) -> dict[str, Any]:
            return await self.list(limit=limit, cursor=cursor)

        return aiterate_paginated(fetch_page)

    async def get(self, snapshot_id: str) -> dict[str, Any]:
        return await self._http.request(
            "GET", f"/v1/profile-snapshots/{quote(snapshot_id, safe='')}"
        )

    async def restore(self, snapshot_id: str, body: dict[str, Any]) -> dict[str, Any]:
        return await self._http.request(
            "POST",
            f"/v1/profile-snapshots/{quote(snapshot_id, safe='')}/restore",
            json_body=coerce_body(body),
        )

    async def delete(self, snapshot_id: str) -> None:
        await self._http.request("DELETE", f"/v1/profile-snapshots/{quote(snapshot_id, safe='')}")

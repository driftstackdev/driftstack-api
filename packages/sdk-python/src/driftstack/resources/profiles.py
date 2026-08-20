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
        """List profiles for the EFFECTIVE account.

        Your own account, or the owner you are acting as via
        ``X-Driftstack-Account``.
        """
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

    def list_trash(self) -> dict[str, Any]:
        """L4b recycle bin — the account's trashed profiles, newest first.

        Each carries ``deleted_at``. Returns a ``{"data": [...]}`` envelope.
        """
        return self._http.request("GET", "/v1/profiles/trash")

    def restore(self, profile_id: str) -> dict[str, Any]:
        """L4b recycle bin — restore a trashed profile (clears ``deleted_at``).

        404 if there's no trashed profile with that id; 409 if a live profile
        already holds the name (rename it first).
        """
        return self._http.request("POST", f"/v1/profiles/{quote(profile_id, safe='')}/restore")

    def purge(self, profile_id: str) -> None:
        """L4b recycle bin — permanently delete a trashed profile, freeing its
        cap slot immediately (trashed profiles otherwise count toward the tier
        limit until the 30-day auto-purge). 404 if no trashed profile has that
        id. Irreversible.
        """
        self._http.request("DELETE", f"/v1/profiles/{quote(profile_id, safe='')}/purge")

    def launch(self, profile_id: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        """2026-05-20 — antidetect-browser-style one-shot launch. Creates a
        session bound to this profile (archetype + metadata inherited).
        ``body`` accepts an optional ``label`` override; everything else
        flows from the profile. Returns the freshly-minted Session.

        Per-session customer-configurable egress is NOT available on this
        resource yet -- ``/v1/sessions``'s execution backend has no
        driver-layer proxy plumbing today, so a ``proxy`` key in ``body``
        would silently do nothing (the server drops it after a presence
        check). If you need customer-controlled egress today, use
        :meth:`AgentSessionsResource.create` with ``proxy_id`` instead --
        that resource dispatches to the real device fleet and routes
        traffic through one of your saved account proxies.
        """
        return self._http.request(
            "POST",
            f"/v1/profiles/{quote(profile_id, safe='')}/launch",
            json_body=coerce_body(body or {}),
        )

    def clone(self, profile_id: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        """V-313 — duplicate a profile. Server auto-derives "(copy)" / "(copy 2)" /
        ... name when ``body["name"]`` is omitted. Tier-cap + name-conflict
        checked the same as ``create``."""
        return self._http.request(
            "POST",
            f"/v1/profiles/{quote(profile_id, safe='')}/clone",
            json_body=coerce_body(body or {}),
        )

    def export(self, profile_id: str) -> dict[str, Any]:
        """V-480 — export this profile as a versioned, metadata-only JSON
        envelope. Feed the result to :meth:`import_` (in any account) to mint a
        fresh profile from it."""
        return self._http.request("GET", f"/v1/profiles/{quote(profile_id, safe='')}/export")

    def import_(self, body: dict[str, Any]) -> dict[str, Any]:
        """V-480 — import a profile from a v1 export envelope
        (``{"envelope": ..., "name_override"?: ...}``), minting a fresh profile
        in the EFFECTIVE account — your own, or the owner you are acting as via
        ``X-Driftstack-Account``. ``import`` is a Python keyword, hence ``import_``."""
        return self._http.request("POST", "/v1/profiles/import", json_body=coerce_body(body))

    def transfer(self, profile_id: str, body: dict[str, Any]) -> dict[str, Any]:
        """V-666 — transfer a profile to another account by ``recipient_account_id``
        (``acc_<uuid>``). Mints a copy in the recipient's account; returns
        ``{"new_profile": ..., "recipient_account_id": ...}``."""
        return self._http.request(
            "POST",
            f"/v1/profiles/{quote(profile_id, safe='')}/transfer",
            json_body=coerce_body(body),
        )

    def trim(self, profile_id: str) -> dict[str, Any]:
        """doc-150 §8 — "Clear cache, keep logins". Reclaims a profile's
        re-fetchable caches (HTTP/media/DOMCache/service-workers) WITHOUT
        touching logins, localStorage, IndexedDB or open tabs — the headline
        reclaim action when an account is over its storage cap. The server
        always responds 200 with a DISCRIMINATED body; branch on
        ``result["status"]`` (``ok`` → ``size_bytes`` + ``bytes_reclaimed``;
        ``unavailable`` / ``error`` → ``reason``; ``timeout``), not the HTTP
        code. On ``ok`` the profile's ``size_bytes`` is updated server-side."""
        return self._http.request("POST", f"/v1/profiles/{quote(profile_id, safe='')}/trim")


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

    async def list_trash(self) -> dict[str, Any]:
        """Async mirror — L4b recycle bin: the account's trashed profiles,
        newest first. Each carries ``deleted_at``. Returns ``{"data": [...]}``.
        """
        return await self._http.request("GET", "/v1/profiles/trash")

    async def restore(self, profile_id: str) -> dict[str, Any]:
        """Async mirror — L4b recycle bin: restore a trashed profile (clears
        ``deleted_at``). 404 if no trashed profile with that id; 409 if a live
        profile already holds the name (rename it first).
        """
        return await self._http.request(
            "POST", f"/v1/profiles/{quote(profile_id, safe='')}/restore"
        )

    async def purge(self, profile_id: str) -> None:
        """Async mirror — L4b recycle bin: permanently delete a trashed profile,
        freeing its cap slot immediately. 404 if no trashed profile has that id.
        Irreversible.
        """
        await self._http.request("DELETE", f"/v1/profiles/{quote(profile_id, safe='')}/purge")

    async def launch(self, profile_id: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        """Async mirror — same Slice 2 antidetect launch semantics as sync."""
        return await self._http.request(
            "POST",
            f"/v1/profiles/{quote(profile_id, safe='')}/launch",
            json_body=coerce_body(body or {}),
        )

    async def clone(self, profile_id: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        return await self._http.request(
            "POST",
            f"/v1/profiles/{quote(profile_id, safe='')}/clone",
            json_body=coerce_body(body or {}),
        )

    async def export(self, profile_id: str) -> dict[str, Any]:
        """Async mirror — V-480 metadata-only export envelope."""
        return await self._http.request("GET", f"/v1/profiles/{quote(profile_id, safe='')}/export")

    async def import_(self, body: dict[str, Any]) -> dict[str, Any]:
        """Async mirror — V-480 import from a v1 export envelope."""
        return await self._http.request("POST", "/v1/profiles/import", json_body=coerce_body(body))

    async def transfer(self, profile_id: str, body: dict[str, Any]) -> dict[str, Any]:
        """Async mirror — V-666 transfer to another account by recipient_account_id."""
        return await self._http.request(
            "POST",
            f"/v1/profiles/{quote(profile_id, safe='')}/transfer",
            json_body=coerce_body(body),
        )

    async def trim(self, profile_id: str) -> dict[str, Any]:
        """Async mirror — doc-150 §8 "Clear cache, keep logins". Reclaims a
        profile's re-fetchable caches WITHOUT touching logins/localStorage/
        IndexedDB/open tabs. Always 200 with a DISCRIMINATED body; branch on
        ``result["status"]``, not the HTTP code."""
        return await self._http.request("POST", f"/v1/profiles/{quote(profile_id, safe='')}/trim")

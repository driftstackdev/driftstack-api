"""Audit log resource — /v1/account/audit-log (V-216 / V-449).

Append-only event ledger for compliance / monitoring. Returns
``dict[str, Any]`` pending the next regen pass.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Iterator
from typing import Any
from urllib.parse import urlencode

from driftstack.http import AsyncHttpClient, HttpClient
from driftstack.pagination import aiterate_paginated, iterate_paginated


def _qs(query: dict[str, Any]) -> str:
    items: list[tuple[str, str]] = []
    for k, v in query.items():
        if v is None:
            continue
        items.append((k, str(v)))
    return urlencode(items)


class AuditLogResource:
    """Synchronous audit-log resource."""

    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def list(
        self,
        *,
        limit: int | None = None,
        cursor: str | None = None,
        action: str | None = None,
    ) -> dict[str, Any]:
        """List audit-log entries newest-first. ``action`` filters to a single event type."""
        qs = _qs({"limit": limit, "cursor": cursor, "action": action})
        path = "/v1/account/audit-log" + (f"?{qs}" if qs else "")
        return self._http.request("GET", path)

    def iterate(
        self,
        *,
        limit: int | None = None,
        action: str | None = None,
    ) -> Iterator[dict[str, Any]]:
        """Lazily walk every audit-log page."""

        def fetch_page(cursor: str | None) -> dict[str, Any]:
            return self.list(limit=limit, cursor=cursor, action=action)

        return iterate_paginated(fetch_page)

    def export(self) -> dict[str, Any]:
        """V-462 / V-297 — bulk-export the calling account's audit log as
        a JSON envelope (GDPR Article 20 portability). Single call; up to
        10,000 rows; ``truncated`` is True when older entries were
        omitted. The CSV branch is not exposed here — hit
        ``/v1/account/audit-log/export?format=csv`` directly with the
        bearer for browser-driven spreadsheet downloads.
        """
        return self._http.request("GET", "/v1/account/audit-log/export?format=json")


class AsyncAuditLogResource:
    """Async audit-log resource."""

    def __init__(self, http: AsyncHttpClient) -> None:
        self._http = http

    async def list(
        self,
        *,
        limit: int | None = None,
        cursor: str | None = None,
        action: str | None = None,
    ) -> dict[str, Any]:
        qs = _qs({"limit": limit, "cursor": cursor, "action": action})
        path = "/v1/account/audit-log" + (f"?{qs}" if qs else "")
        return await self._http.request("GET", path)

    def iterate(
        self,
        *,
        limit: int | None = None,
        action: str | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        async def fetch_page(cursor: str | None) -> dict[str, Any]:
            return await self.list(limit=limit, cursor=cursor, action=action)

        return aiterate_paginated(fetch_page)

    async def export(self) -> dict[str, Any]:
        """V-462 / V-297 — async mirror of ``AuditLogResource.export``."""
        return await self._http.request("GET", "/v1/account/audit-log/export?format=json")

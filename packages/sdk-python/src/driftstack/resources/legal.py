"""Legal resource — /v1/legal/* (V-049 / V-458).

Customer acceptance of legal documents (ToS / Privacy / DPA / AUP).
Document content is served separately on the marketing site; this
resource handles the catalog + acceptance machinery.
"""

from __future__ import annotations

from typing import Any

from driftstack.http import AsyncHttpClient, HttpClient
from driftstack.resources._common import coerce_body


class LegalResource:
    """Synchronous legal-acceptance resource."""

    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def documents(self) -> dict[str, Any]:
        """List the legal-document catalog."""
        return self._http.request("GET", "/v1/legal/documents")

    def required(self) -> dict[str, Any]:
        """List documents the calling account must accept (or re-accept)."""
        return self._http.request("GET", "/v1/legal/required")

    def accept(self, body: dict[str, Any]) -> dict[str, Any]:
        """Record acceptance of a (document, version, content_hash) tuple.

        Body: ``{"document_key": "...", "version": "...", "content_hash": "<64-hex>"}``.
        Returns 201 with the persisted record.
        """
        return self._http.request("POST", "/v1/legal/accept", json_body=coerce_body(body))


class AsyncLegalResource:
    """Async legal-acceptance resource."""

    def __init__(self, http: AsyncHttpClient) -> None:
        self._http = http

    async def documents(self) -> dict[str, Any]:
        return await self._http.request("GET", "/v1/legal/documents")

    async def required(self) -> dict[str, Any]:
        return await self._http.request("GET", "/v1/legal/required")

    async def accept(self, body: dict[str, Any]) -> dict[str, Any]:
        return await self._http.request("POST", "/v1/legal/accept", json_body=coerce_body(body))

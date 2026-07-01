"""API keys resource — /v1/api-keys."""

from __future__ import annotations

from typing import Any
from urllib.parse import quote

from pydantic import BaseModel

from driftstack._generated.models import ApiKey, CreateApiKeyRequest, CreateApiKeyResponse
from driftstack.http import AsyncHttpClient, HttpClient, parse_model
from driftstack.resources._common import coerce_body


class ApiKeyList(BaseModel):
    """Response shape for ``GET /v1/api-keys``."""

    data: list[ApiKey]


class RotateApiKeyResponse(CreateApiKeyResponse):
    """V-296 — response shape for ``POST /v1/api-keys/:id/rotate``.

    Extends ``CreateApiKeyResponse`` with the previous-key reference and
    the timestamp at which the previous key auto-revokes via the
    ``expires_at``-driven auth gate.
    """

    rotated_from: str
    grace_period_ends_at: str


class ApiKeysResource:
    """Synchronous API keys resource."""

    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def create(self, body: CreateApiKeyRequest | dict[str, Any]) -> CreateApiKeyResponse:
        """Create an API key.

        Plaintext is in the response — store it now, it cannot be
        retrieved later. Requires the ``account_owner`` scope on the calling key.
        """
        data = self._http.request("POST", "/v1/api-keys", json_body=coerce_body(body))
        return parse_model(CreateApiKeyResponse, data)

    def list(self) -> ApiKeyList:
        """List API keys for the current account. Plaintext never included."""
        data = self._http.request("GET", "/v1/api-keys")
        return parse_model(ApiKeyList, data)

    def revoke(self, key_id: str) -> None:
        """Revoke an API key. Idempotent — revoking an already-revoked key is a no-op."""
        self._http.request("DELETE", f"/v1/api-keys/{quote(key_id, safe='')}")

    def rotate(self, key_id: str, *, name: str | None = None) -> RotateApiKeyResponse:
        """V-296 — rotate an API key with a 24h grace period.

        Mints a fresh plaintext + sets the OLD key's ``expires_at`` to
        ``now + 24h``. Both keys work concurrently during the grace
        window; deploy the new key, then the old key auto-revokes at
        the grace boundary. Plaintext is in the response — store it now.
        """
        body: dict[str, Any] = {}
        if name is not None:
            body["name"] = name
        data = self._http.request(
            "POST",
            f"/v1/api-keys/{quote(key_id, safe='')}/rotate",
            json_body=body,
        )
        return parse_model(RotateApiKeyResponse, data)


class AsyncApiKeysResource:
    """Async API keys resource."""

    def __init__(self, http: AsyncHttpClient) -> None:
        self._http = http

    async def create(self, body: CreateApiKeyRequest | dict[str, Any]) -> CreateApiKeyResponse:
        data = await self._http.request("POST", "/v1/api-keys", json_body=coerce_body(body))
        return parse_model(CreateApiKeyResponse, data)

    async def list(self) -> ApiKeyList:
        data = await self._http.request("GET", "/v1/api-keys")
        return parse_model(ApiKeyList, data)

    async def revoke(self, key_id: str) -> None:
        await self._http.request("DELETE", f"/v1/api-keys/{quote(key_id, safe='')}")

    async def rotate(self, key_id: str, *, name: str | None = None) -> RotateApiKeyResponse:
        """V-296 — async rotate. See :meth:`ApiKeysResource.rotate`."""
        body: dict[str, Any] = {}
        if name is not None:
            body["name"] = name
        data = await self._http.request(
            "POST",
            f"/v1/api-keys/{quote(key_id, safe='')}/rotate",
            json_body=body,
        )
        return parse_model(RotateApiKeyResponse, data)

"""API keys resource — /v1/api-keys."""

from __future__ import annotations

from typing import Any
from urllib.parse import quote

from pydantic import BaseModel

from driftstack._generated.models import ApiKey, CreateApiKeyRequest, CreateApiKeyResponse
from driftstack.http import AsyncHttpClient, HttpClient
from driftstack.resources._common import coerce_body


class ApiKeyList(BaseModel):
    """Response shape for ``GET /v1/api-keys``."""

    data: list[ApiKey]


class ApiKeysResource:
    """Synchronous API keys resource."""

    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def create(self, body: CreateApiKeyRequest | dict[str, Any]) -> CreateApiKeyResponse:
        """Create an API key.

        Plaintext is in the response — store it now, it cannot be
        retrieved later. Requires the ``admin`` scope on the calling key.
        """
        data = self._http.request("POST", "/v1/api-keys", json_body=coerce_body(body))
        return CreateApiKeyResponse.model_validate(data)

    def list(self) -> ApiKeyList:
        """List API keys for the current account. Plaintext never included."""
        data = self._http.request("GET", "/v1/api-keys")
        return ApiKeyList.model_validate(data)

    def revoke(self, key_id: str) -> None:
        """Revoke an API key. Idempotent — revoking an already-revoked key is a no-op."""
        self._http.request("DELETE", f"/v1/api-keys/{quote(key_id, safe='')}")


class AsyncApiKeysResource:
    """Async API keys resource."""

    def __init__(self, http: AsyncHttpClient) -> None:
        self._http = http

    async def create(self, body: CreateApiKeyRequest | dict[str, Any]) -> CreateApiKeyResponse:
        data = await self._http.request("POST", "/v1/api-keys", json_body=coerce_body(body))
        return CreateApiKeyResponse.model_validate(data)

    async def list(self) -> ApiKeyList:
        data = await self._http.request("GET", "/v1/api-keys")
        return ApiKeyList.model_validate(data)

    async def revoke(self, key_id: str) -> None:
        await self._http.request("DELETE", f"/v1/api-keys/{quote(key_id, safe='')}")

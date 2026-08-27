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

        .. warning::
           Two things ``now + 24h`` does not say, both of which bite only
           when the key already carries an ``expires_at`` (optional at
           create time, so most keys do not):

           - The grace never EXTENDS an expiry. It is
             ``min(now + 24h, the key's own expires_at)``, so rotating a
             key that expires in an hour buys an hour, not a day.
           - The successor INHERITS that same ``expires_at``. Rotating a
             key because it is about to expire does not hand you a
             longer-lived one.

        Rotation also DE-ESCALATES (V-775): ``driftstack_internal_admin``
        is dropped and the legacy ``admin`` alias becomes
        ``account_owner``, which carries the same customer authority.
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

"""ApiKeys resource tests."""

from __future__ import annotations

import httpx
import pytest
import respx

from driftstack import AsyncDriftstack, Driftstack
from driftstack._generated.models import CreateApiKeyResponse
from driftstack.resources.api_keys import ApiKeyList

API_KEY = "ds_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
BASE = "https://api.test"

KEY_ROW: dict = {
    "id": "key_00000000-0000-4000-8000-000000000001",
    "name": "ci-key",
    "key_prefix": "ds_live_aaaaaa",
    "scopes": ["read", "write"],
    "last_used_at": None,
    "revoked_at": None,
    "expires_at": None,
    "created_at": "2026-05-02T10:00:00Z",
}


def test_sync_create_returns_plaintext_response() -> None:
    response = {**KEY_ROW, "plaintext": "ds_live_secretsecretsecretsecretsecretsec"}
    with respx.mock(base_url=BASE) as mock:
        mock.post("/v1/api-keys").mock(return_value=httpx.Response(201, json=response))
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            result = client.api_keys.create({"name": "ci-key", "scopes": ["read", "write"]})
        assert isinstance(result, CreateApiKeyResponse)
        assert result.plaintext.startswith("ds_live_")


def test_sync_list() -> None:
    page = {"data": [KEY_ROW]}
    with respx.mock(base_url=BASE) as mock:
        mock.get("/v1/api-keys").mock(return_value=httpx.Response(200, json=page))
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            result = client.api_keys.list()
        assert isinstance(result, ApiKeyList)
        assert len(result.data) == 1


def test_sync_revoke() -> None:
    with respx.mock(base_url=BASE) as mock:
        mock.delete("/v1/api-keys/key_xx").mock(return_value=httpx.Response(204))
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            result = client.api_keys.revoke("key_xx")
        assert result is None


@pytest.mark.asyncio
async def test_async_create() -> None:
    response = {**KEY_ROW, "plaintext": "ds_live_secretsecretsecretsecretsecretsec"}
    with respx.mock(base_url=BASE) as mock:
        mock.post("/v1/api-keys").mock(return_value=httpx.Response(201, json=response))
        async with AsyncDriftstack(api_key=API_KEY, base_url=BASE) as client:
            result = await client.api_keys.create({"name": "ci-key", "scopes": ["read"]})
        assert isinstance(result, CreateApiKeyResponse)


@pytest.mark.asyncio
async def test_async_revoke() -> None:
    with respx.mock(base_url=BASE) as mock:
        mock.delete("/v1/api-keys/key_xx").mock(return_value=httpx.Response(204))
        async with AsyncDriftstack(api_key=API_KEY, base_url=BASE) as client:
            result = await client.api_keys.revoke("key_xx")
        assert result is None

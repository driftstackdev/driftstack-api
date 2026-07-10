"""Auth-flow resource tests — cli-authorize + audit-log export.

Mirrors the V-466 TS / V-466.go wire-shape coverage on the Python SDK.
"""

from __future__ import annotations

import httpx
import pytest
import respx

from driftstack import AsyncDriftstack, Driftstack

API_KEY = "ds_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
BASE = "https://api.test"


# V-460 — CLI / GUI activation flow.


def test_sync_cli_authorize_initiate() -> None:
    response = {
        "code": "cliauth_abc",
        "browser_url": "https://app.driftstack.dev/cli/authorize?code=cliauth_abc",
        "expires_at": "2026-05-09T18:05:00Z",
    }
    with respx.mock(base_url=BASE) as mock:
        route = mock.post("/v1/auth/cli-authorize/initiate").mock(
            return_value=httpx.Response(200, json=response),
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            result = client.auth.cli_authorize_initiate(
                {"state": "csrfnonce-1234567890abcdef", "client_label": "Test CLI"}
            )
        assert route.called
        assert result["code"] == "cliauth_abc"


def test_sync_cli_authorize_exchange_pending() -> None:
    with respx.mock(base_url=BASE) as mock:
        mock.post("/v1/auth/cli-authorize/exchange").mock(
            return_value=httpx.Response(200, json={"status": "pending"}),
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            result = client.auth.cli_authorize_exchange(
                {"code": "cliauth_abc", "state": "csrfnonce-1234567890abcdef"}
            )
        assert result == {"status": "pending"}
        assert "api_key" not in result


def test_sync_cli_authorize_exchange_bound() -> None:
    bound = {
        "status": "bound",
        "api_key": "sk_test_REDACTED",
        "account_id": "acc_abc",
    }
    with respx.mock(base_url=BASE) as mock:
        mock.post("/v1/auth/cli-authorize/exchange").mock(
            return_value=httpx.Response(200, json=bound),
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            result = client.auth.cli_authorize_exchange(
                {"code": "cliauth_abc", "state": "csrfnonce-1234567890abcdef"}
            )
        assert result["status"] == "bound"
        assert result["api_key"] == "sk_test_REDACTED"
        assert result["account_id"] == "acc_abc"


def test_sync_cli_authorize_bind() -> None:
    response = {
        "ok": True,
        "account_id": "acc_abc",
        "expires_at": "2026-05-09T18:05:00Z",
    }
    with respx.mock(base_url=BASE) as mock:
        route = mock.post("/v1/auth/cli-authorize/bind").mock(
            return_value=httpx.Response(200, json=response),
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            result = client.auth.cli_authorize_bind(
                {
                    "code": "cliauth_abc",
                    "state": "csrfnonce-1234567890abcdef",
                    "scopes": ["account_owner"],
                }
            )
        assert route.called
        assert result["ok"] is True
        assert result["account_id"] == "acc_abc"


@pytest.mark.asyncio
async def test_async_cli_authorize_initiate() -> None:
    response = {
        "code": "cliauth_xyz",
        "browser_url": "https://app.driftstack.dev/cli/authorize?code=cliauth_xyz",
        "expires_at": "2026-05-09T18:10:00Z",
    }
    with respx.mock(base_url=BASE) as mock:
        mock.post("/v1/auth/cli-authorize/initiate").mock(
            return_value=httpx.Response(200, json=response),
        )
        async with AsyncDriftstack(api_key=API_KEY, base_url=BASE) as client:
            result = await client.auth.cli_authorize_initiate(
                {"state": "csrfnonce-fedcba0987654321"}
            )
        assert result["code"] == "cliauth_xyz"


# V-462 — audit-log export.


def test_sync_audit_log_export() -> None:
    response = {
        "generated_at": "2026-05-09T18:00:00Z",
        "account_id": "acc_abc",
        "row_count": 1,
        "truncated": False,
        "data": [
            {
                "id": "11111111-1111-1111-1111-111111111111",
                "account_id": "acc_abc",
                "actor_type": "customer",
                "actor_account_id": "acc_abc",
                "actor_key_id": None,
                "action": "profile.created",
                "target_resource_id": "profile_xyz",
                "payload": None,
                "ip_address": None,
                "user_agent": None,
                "timestamp": "2026-05-09T17:00:00Z",
            }
        ],
    }
    with respx.mock(base_url=BASE) as mock:
        route = mock.get("/v1/account/audit-log/export").mock(
            return_value=httpx.Response(200, json=response),
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            result = client.audit_log.export()
        assert route.called
        assert "format=json" in str(route.calls[0].request.url)
        assert result.row_count == 1
        assert result.truncated is False
        assert result.data[0].action == "profile.created"


def test_sync_audit_log_export_truncated() -> None:
    response = {
        "generated_at": "2026-05-09T18:00:00Z",
        "account_id": "acc_abc",
        "row_count": 10000,
        "truncated": True,
        "data": [],
    }
    with respx.mock(base_url=BASE) as mock:
        mock.get("/v1/account/audit-log/export").mock(
            return_value=httpx.Response(200, json=response),
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            result = client.audit_log.export()
        assert result.truncated is True
        assert result.row_count == 10000


@pytest.mark.asyncio
async def test_async_audit_log_export() -> None:
    response = {
        "generated_at": "2026-05-09T18:00:00Z",
        "account_id": "acc_abc",
        "row_count": 0,
        "truncated": False,
        "data": [],
    }
    with respx.mock(base_url=BASE) as mock:
        mock.get("/v1/account/audit-log/export").mock(
            return_value=httpx.Response(200, json=response),
        )
        async with AsyncDriftstack(api_key=API_KEY, base_url=BASE) as client:
            result = await client.audit_log.export()
        assert result.row_count == 0

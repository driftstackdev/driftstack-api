"""Auth-flow resource tests — cli-authorize + audit-log export.

Mirrors the V-466 TS / V-466.go wire-shape coverage on the Python SDK.
"""

from __future__ import annotations

import json

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
        route = mock.post("/v1/auth/cli-authorize/bind-device-code").mock(
            return_value=httpx.Response(200, json=response),
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            result = client.auth.cli_authorize_bind(
                {
                    "code": "cliauth_abc",
                    "state": "csrfnonce-1234567890abcdef",
                    "user_code": "ABCD-EFGH",
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
        assert result["row_count"] == 1
        assert result["truncated"] is False
        assert result["data"][0]["action"] == "profile.created"


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
        assert result["truncated"] is True
        assert result["row_count"] == 10000


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
        assert result["row_count"] == 0


# ── verify_email / refresh / mfa_challenge / mfa_step_up were the four auth
# ── methods with no test in EITHER the Python or the Go SDK (V-1979). Before
# ── this, the Python auth suite covered only the three cli-authorize methods.

SESSION: dict = {
    "token": "ds_web_abcdefghijklmnopqrstuvwxyz",
    "expires_at": "2026-05-16T18:00:00Z",
    "account_id": "acc_00000000-0000-4000-8000-000000000001",
}


def test_sync_verify_email_posts_the_token_and_returns_a_session() -> None:
    with respx.mock(base_url=BASE) as mock:
        route = mock.post("/v1/auth/verify-email").mock(
            return_value=httpx.Response(200, json={"session": SESSION})
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            out = client.auth.verify_email({"token": "tok_1"})
        assert route.called
        assert json.loads(route.calls[0].request.content) == {"token": "tok_1"}
        # Verifying an email mints a web session; dropping it would leave the
        # caller authenticated on the server and holding nothing.
        assert out["session"]["token"] == SESSION["token"]


def test_sync_refresh_posts_the_old_token_and_returns_the_rotated_one() -> None:
    rotated = {**SESSION, "token": "ds_web_rotatedrotatedrotatedrotated"}
    with respx.mock(base_url=BASE) as mock:
        route = mock.post("/v1/auth/refresh").mock(
            return_value=httpx.Response(200, json={"session": rotated})
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            out = client.auth.refresh({"token": "ds_web_old"})
        assert route.called
        assert json.loads(route.calls[0].request.content) == {"token": "ds_web_old"}
        # The whole point of a refresh is the NEW token. Returning the old one,
        # or dropping the field, silently pins a caller to an expiring session.
        assert out["session"]["token"] == rotated["token"]
        assert out["session"]["expires_at"] == SESSION["expires_at"]


def test_sync_mfa_challenge_forwards_exactly_the_factor_supplied() -> None:
    """`code` and `recovery_code` are alternatives. A challenge answered with a
    TOTP code must put NO recovery_code on the wire — sending an empty one beside
    a real code is a different request than the caller made."""
    with respx.mock(base_url=BASE) as mock:
        route = mock.post("/v1/auth/mfa/challenge").mock(
            return_value=httpx.Response(200, json={"session": SESSION, "via": "totp"})
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            out = client.auth.mfa_challenge({"challenge_token": "chal_1", "code": "123456"})
        sent = json.loads(route.calls[0].request.content)
        assert sent == {"challenge_token": "chal_1", "code": "123456"}
        assert "recovery_code" not in sent
        assert out["via"] == "totp"


def test_sync_mfa_challenge_recovery_path_carries_no_code() -> None:
    """The mirror of the arm above — the recovery answer must not carry `code`."""
    with respx.mock(base_url=BASE) as mock:
        route = mock.post("/v1/auth/mfa/challenge").mock(
            return_value=httpx.Response(200, json={"session": SESSION, "via": "recovery"})
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            out = client.auth.mfa_challenge(
                {"challenge_token": "chal_1", "recovery_code": "rec-aaaa-bbbb"}
            )
        sent = json.loads(route.calls[0].request.content)
        assert sent == {"challenge_token": "chal_1", "recovery_code": "rec-aaaa-bbbb"}
        assert "code" not in sent
        assert out["via"] == "recovery"


def test_sync_mfa_step_up_posts_to_the_step_up_route() -> None:
    with respx.mock(base_url=BASE) as mock:
        route = mock.post("/v1/auth/mfa/step-up").mock(
            return_value=httpx.Response(
                200, json={"via": "totp", "mfa_satisfied_at": "2026-05-16T18:00:00Z"}
            )
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            out = client.auth.mfa_step_up({"code": "123456"})
        assert route.called
        assert json.loads(route.calls[0].request.content) == {"code": "123456"}
        # mfa_satisfied_at is how a caller knows how long the step-up lasts.
        assert out["mfa_satisfied_at"] == "2026-05-16T18:00:00Z"


@pytest.mark.asyncio
async def test_async_refresh_posts_to_the_refresh_route() -> None:
    """Each async method is a separate implementation and therefore a separate
    chance to point at the wrong route."""
    rotated = {**SESSION, "token": "ds_web_rotatedrotatedrotatedrotated"}
    with respx.mock(base_url=BASE) as mock:
        route = mock.post("/v1/auth/refresh").mock(
            return_value=httpx.Response(200, json={"session": rotated})
        )
        async with AsyncDriftstack(api_key=API_KEY, base_url=BASE) as client:
            out = await client.auth.refresh({"token": "ds_web_old"})
        assert route.called
        assert out["session"]["token"] == rotated["token"]


@pytest.mark.asyncio
async def test_async_mfa_step_up_posts_to_the_step_up_route() -> None:
    with respx.mock(base_url=BASE) as mock:
        route = mock.post("/v1/auth/mfa/step-up").mock(
            return_value=httpx.Response(
                200, json={"via": "totp", "mfa_satisfied_at": "2026-05-16T18:00:00Z"}
            )
        )
        async with AsyncDriftstack(api_key=API_KEY, base_url=BASE) as client:
            out = await client.auth.mfa_step_up({"code": "123456"})
        assert route.called
        assert out["via"] == "totp"

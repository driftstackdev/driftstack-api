"""AccountResource tests.

Pin the wire surface of the 8 sync + 8 async account methods. The
existing test suite covered ApiKeys / AgentSessions / Recipes /
Sessions / Webhooks / Auth / Team / Usage / Egress / CryptoOrders
resources directly but had no AccountResource coverage — the
generated Account *model* (test_generated_models.py) was tested,
but the HTTP-method wrappers around /v1/account/* weren't.

Coverage:
  - me() → GET /v1/account/me
  - update_me() → PATCH /v1/account/me with json body
  - upload_avatar() → POST /v1/account/me/avatar with json body
  - clear_avatar() → DELETE /v1/account/me/avatar, returns None
  - list_web_sessions() → GET /v1/account/web-sessions
  - revoke_web_session(id) → DELETE /v1/account/web-sessions/<id>
    + URL-encodes the id (quote with safe='')
  - revoke_all_other_web_sessions() → DELETE /v1/account/web-sessions
    (no path segment)
  - rate_limits() → GET /v1/account/rate-limits

  + the 8-mirror async paths.
"""

from __future__ import annotations

import httpx
import pytest
import respx

from driftstack import AsyncDriftstack, Driftstack

API_KEY = "ds_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
BASE = "https://api.test"

ACCOUNT_BODY: dict = {
    "id": "acc_00000000-0000-4000-8000-000000000001",
    "email": "tester@example.com",
    "name": "CI Tester",
    "tier": "api_builder",
    "status": "active",
    "timezone": None,
    "slug": None,
    "region": None,
    "avatar_url": None,
    "mfa_enrolled": False,
    "concurrent_session_cap": 8,
    "concurrent_session_active": 0,
    "profile_cap": 100,
    "profile_count": 0,
    "teams": [],
}


def test_sync_me_hits_get_account_me() -> None:
    with respx.mock(base_url=BASE) as mock:
        route = mock.get("/v1/account/me").mock(
            return_value=httpx.Response(200, json=ACCOUNT_BODY),
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            result = client.account.me()
        assert route.called
        assert result["id"] == ACCOUNT_BODY["id"]
        assert result["tier"] == "api_builder"


def test_sync_update_me_sends_patch_with_body() -> None:
    updated = {**ACCOUNT_BODY, "name": "Updated"}
    with respx.mock(base_url=BASE) as mock:
        route = mock.patch("/v1/account/me").mock(
            return_value=httpx.Response(200, json=updated),
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            result = client.account.update_me({"name": "Updated"})
        assert route.called
        assert result["name"] == "Updated"


def test_sync_upload_avatar_sends_post() -> None:
    response = {
        "avatar_url": "https://r2-fake/avatars/x.png",
        "content_type": "image/png",
        "bytes": 1024,
    }
    with respx.mock(base_url=BASE) as mock:
        mock.post("/v1/account/me/avatar").mock(
            return_value=httpx.Response(200, json=response),
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            result = client.account.upload_avatar(
                {"data_base64": "ZmFrZQ==", "content_type": "image/png"},
            )
        assert result["bytes"] == 1024
        assert result["content_type"] == "image/png"


def test_sync_clear_avatar_sends_delete_and_returns_none() -> None:
    with respx.mock(base_url=BASE) as mock:
        route = mock.delete("/v1/account/me/avatar").mock(
            return_value=httpx.Response(204),
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            result = client.account.clear_avatar()
        assert route.called
        assert result is None


def test_sync_list_web_sessions_hits_get_endpoint() -> None:
    body = {"data": [{"id": "wsess_x", "current": True}]}
    with respx.mock(base_url=BASE) as mock:
        mock.get("/v1/account/web-sessions").mock(
            return_value=httpx.Response(200, json=body),
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            result = client.account.list_web_sessions()
        assert result["data"][0]["current"] is True


def test_sync_revoke_web_session_url_encodes_the_id() -> None:
    # Customer-provided id MUST land url-quoted; safe='' encodes
    # everything that's not alphanumeric or _-.~ so path-segment
    # integrity holds even with weird customer inputs. We pin the
    # encoded form on the raw URL string (httpx's req.url.path
    # may normalise some encodings back).
    captured_raw: list[str] = []
    with respx.mock(base_url=BASE) as mock:
        mock.delete(url__regex=r".*").mock(
            side_effect=lambda req: (
                captured_raw.append(req.url.raw_path.decode("ascii")) or httpx.Response(204)
            ),
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            client.account.revoke_web_session("wsess with spaces")
        # raw_path preserves the percent-encoded form sent on the wire.
        assert captured_raw == ["/v1/account/web-sessions/wsess%20with%20spaces"]


def test_sync_revoke_web_session_url_encodes_slashes_defensively() -> None:
    # A `/` in the id would be catastrophic if not encoded — the
    # request would target a different route entirely. safe='' ensures
    # path-segment integrity.
    captured_raw: list[str] = []
    with respx.mock(base_url=BASE) as mock:
        mock.delete(url__regex=r".*").mock(
            side_effect=lambda req: (
                captured_raw.append(req.url.raw_path.decode("ascii")) or httpx.Response(204)
            ),
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            client.account.revoke_web_session("wsess/escape")
        # safe='' encodes / as %2F — the id stays one path segment.
        assert captured_raw == ["/v1/account/web-sessions/wsess%2Fescape"]


def test_sync_revoke_all_other_web_sessions_hits_collection_delete() -> None:
    with respx.mock(base_url=BASE) as mock:
        route = mock.delete("/v1/account/web-sessions").mock(
            return_value=httpx.Response(200, json={"revoked": 3}),
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            result = client.account.revoke_all_other_web_sessions()
        assert route.called
        assert result is None  # method signature returns None


def test_sync_rate_limits_hits_get_account_rate_limits() -> None:
    body = {"buckets": {"global": {"capacity": 100, "refill_per_second": 10}}}
    with respx.mock(base_url=BASE) as mock:
        mock.get("/v1/account/rate-limits").mock(return_value=httpx.Response(200, json=body))
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            result = client.account.rate_limits()
        assert result["buckets"]["global"]["capacity"] == 100


@pytest.mark.asyncio
async def test_async_me() -> None:
    with respx.mock(base_url=BASE) as mock:
        mock.get("/v1/account/me").mock(return_value=httpx.Response(200, json=ACCOUNT_BODY))
        async with AsyncDriftstack(api_key=API_KEY, base_url=BASE) as client:
            result = await client.account.me()
        assert result["id"] == ACCOUNT_BODY["id"]


@pytest.mark.asyncio
async def test_async_update_me() -> None:
    updated = {**ACCOUNT_BODY, "timezone": "Europe/Amsterdam"}
    with respx.mock(base_url=BASE) as mock:
        mock.patch("/v1/account/me").mock(return_value=httpx.Response(200, json=updated))
        async with AsyncDriftstack(api_key=API_KEY, base_url=BASE) as client:
            result = await client.account.update_me({"timezone": "Europe/Amsterdam"})
        assert result["timezone"] == "Europe/Amsterdam"


@pytest.mark.asyncio
async def test_async_upload_avatar() -> None:
    response = {
        "avatar_url": "https://r2-fake/avatars/y.jpg",
        "content_type": "image/jpeg",
        "bytes": 2048,
    }
    with respx.mock(base_url=BASE) as mock:
        mock.post("/v1/account/me/avatar").mock(
            return_value=httpx.Response(200, json=response),
        )
        async with AsyncDriftstack(api_key=API_KEY, base_url=BASE) as client:
            result = await client.account.upload_avatar(
                {"data_base64": "ZmFrZTI=", "content_type": "image/jpeg"},
            )
        assert result["content_type"] == "image/jpeg"


@pytest.mark.asyncio
async def test_async_clear_avatar() -> None:
    with respx.mock(base_url=BASE) as mock:
        route = mock.delete("/v1/account/me/avatar").mock(
            return_value=httpx.Response(204),
        )
        async with AsyncDriftstack(api_key=API_KEY, base_url=BASE) as client:
            result = await client.account.clear_avatar()
        assert route.called
        assert result is None


@pytest.mark.asyncio
async def test_async_list_web_sessions() -> None:
    body = {"data": []}
    with respx.mock(base_url=BASE) as mock:
        mock.get("/v1/account/web-sessions").mock(
            return_value=httpx.Response(200, json=body),
        )
        async with AsyncDriftstack(api_key=API_KEY, base_url=BASE) as client:
            result = await client.account.list_web_sessions()
        assert result["data"] == []


@pytest.mark.asyncio
async def test_async_revoke_web_session_url_encodes() -> None:
    captured_raw: list[str] = []
    with respx.mock(base_url=BASE) as mock:
        mock.delete(url__regex=r".*").mock(
            side_effect=lambda req: (
                captured_raw.append(req.url.raw_path.decode("ascii")) or httpx.Response(204)
            ),
        )
        async with AsyncDriftstack(api_key=API_KEY, base_url=BASE) as client:
            await client.account.revoke_web_session("wsess/escape")
        # safe='' encodes / so path-segment integrity holds even when
        # a customer-provided id contains a slash.
        assert captured_raw == ["/v1/account/web-sessions/wsess%2Fescape"]


@pytest.mark.asyncio
async def test_async_revoke_all_other_web_sessions() -> None:
    with respx.mock(base_url=BASE) as mock:
        route = mock.delete("/v1/account/web-sessions").mock(
            return_value=httpx.Response(200, json={"revoked": 0}),
        )
        async with AsyncDriftstack(api_key=API_KEY, base_url=BASE) as client:
            result = await client.account.revoke_all_other_web_sessions()
        assert route.called
        assert result is None


@pytest.mark.asyncio
async def test_async_rate_limits() -> None:
    body = {"buckets": {}}
    with respx.mock(base_url=BASE) as mock:
        mock.get("/v1/account/rate-limits").mock(return_value=httpx.Response(200, json=body))
        async with AsyncDriftstack(api_key=API_KEY, base_url=BASE) as client:
            result = await client.account.rate_limits()
        assert result == body

"""Egress resource tests — Python SDK parity with TS SDK EgressResource."""

from __future__ import annotations

import httpx
import pytest
import respx

from driftstack import AsyncDriftstack, Driftstack

API_KEY = "ds_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
BASE = "https://api.test"


CONFIG = {
    "session_id": "ses_xyz",
    "proxy": {
        "type": "socks5",
        "socks5": {"host": "proxy.example.com", "port": 1080, "udp_associate": True},
    },
    "egress_safeguard": {
        "block_direct_internet": True,
        "block_unproxied_dns": True,
        "block_webrtc_stun_leakage": True,
    },
}

ATTACH_REPLY = {
    "type": "socks5",
    "safeguards": {
        "block_direct_internet": True,
        "block_unproxied_dns": True,
        "block_webrtc_stun_leakage": True,
    },
}


# ──────────────────────────────────────────────────────────────────────────
# Sync
# ──────────────────────────────────────────────────────────────────────────


def test_sync_attach_to_session_posts_config() -> None:
    with respx.mock(base_url=BASE) as mock:
        route = mock.post("/v1/sessions/ses_xyz/proxy").mock(
            return_value=httpx.Response(200, json=ATTACH_REPLY),
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            out = client.egress.attach_to_session("ses_xyz", CONFIG)
        assert out == ATTACH_REPLY
        assert route.called


def test_sync_attach_url_encodes_session_id() -> None:
    with respx.mock(base_url=BASE) as mock:
        route = mock.post("/v1/sessions/ses%20with%20space/proxy").mock(
            return_value=httpx.Response(200, json=ATTACH_REPLY),
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            client.egress.attach_to_session("ses with space", CONFIG)
        assert route.called


def test_sync_get_session_proxy() -> None:
    with respx.mock(base_url=BASE) as mock:
        route = mock.get("/v1/sessions/ses_xyz/proxy").mock(
            return_value=httpx.Response(200, json=ATTACH_REPLY),
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            out = client.egress.get_session_proxy("ses_xyz")
        assert out == ATTACH_REPLY
        assert route.called


def test_sync_create_proxy_posts_flat_body() -> None:
    body = {"label": "team SOCKS5", "scheme": "socks5", "host": "x.example", "port": 1080}
    saved = {"id": "apx_1", "label": "team SOCKS5", "scheme": "socks5", "has_password": False}
    with respx.mock(base_url=BASE) as mock:
        route = mock.post("/v1/account/me/proxies").mock(
            return_value=httpx.Response(201, json=saved),
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            out = client.egress.create_proxy(body)
        assert out == saved
        assert route.called


def test_sync_list_proxies_returns_empty_list() -> None:
    with respx.mock(base_url=BASE) as mock:
        mock.get("/v1/account/me/proxies").mock(
            return_value=httpx.Response(200, json={"data": []}),
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            out = client.egress.list_proxies()
        assert out == {"data": []}


def test_sync_update_proxy_puts_body() -> None:
    with respx.mock(base_url=BASE) as mock:
        route = mock.put("/v1/account/me/proxies/apx_1").mock(
            return_value=httpx.Response(200, json={"id": "apx_1", "label": "renamed"}),
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            client.egress.update_proxy("apx_1", {"label": "renamed"})
        assert route.called


def test_sync_delete_proxy() -> None:
    with respx.mock(base_url=BASE) as mock:
        route = mock.delete("/v1/account/me/proxies/apx_1").mock(
            return_value=httpx.Response(204),
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            client.egress.delete_proxy("apx_1")
        assert route.called


def test_sync_test_proxy_posts() -> None:
    with respx.mock(base_url=BASE) as mock:
        mock.post("/v1/account/me/proxies/apx_1/test").mock(
            return_value=httpx.Response(200, json={"ok": True, "latency_ms": 42}),
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            out = client.egress.test_proxy("apx_1")
        assert out == {"ok": True, "latency_ms": 42}


# ──────────────────────────────────────────────────────────────────────────
# Async parity
# ──────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_async_attach_to_session_posts_config() -> None:
    with respx.mock(base_url=BASE) as mock:
        route = mock.post("/v1/sessions/ses_xyz/proxy").mock(
            return_value=httpx.Response(200, json=ATTACH_REPLY),
        )
        async with AsyncDriftstack(api_key=API_KEY, base_url=BASE) as client:
            out = await client.egress.attach_to_session("ses_xyz", CONFIG)
        assert out == ATTACH_REPLY
        assert route.called


@pytest.mark.asyncio
async def test_async_list_proxies() -> None:
    with respx.mock(base_url=BASE) as mock:
        mock.get("/v1/account/me/proxies").mock(
            return_value=httpx.Response(200, json={"data": []}),
        )
        async with AsyncDriftstack(api_key=API_KEY, base_url=BASE) as client:
            out = await client.egress.list_proxies()
        assert out == {"data": []}

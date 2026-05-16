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


def test_sync_save_proxy_posts_body() -> None:
    body = {"label": "team SOCKS5", "proxy": CONFIG["proxy"]}
    saved = {"id": "proxy_1", "label": "team SOCKS5", "type": "socks5"}
    with respx.mock(base_url=BASE) as mock:
        route = mock.post("/v1/proxies").mock(return_value=httpx.Response(201, json=saved))
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            out = client.egress.save_proxy(body)
        assert out == saved
        assert route.called


def test_sync_list_saved_proxies_returns_empty_list() -> None:
    with respx.mock(base_url=BASE) as mock:
        mock.get("/v1/proxies").mock(return_value=httpx.Response(200, json={"data": []}))
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            out = client.egress.list_saved_proxies()
        assert out == {"data": []}


def test_sync_delete_saved_proxy() -> None:
    with respx.mock(base_url=BASE) as mock:
        route = mock.delete("/v1/proxies/proxy_1").mock(return_value=httpx.Response(204))
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            client.egress.delete_saved_proxy("proxy_1")
        assert route.called


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
async def test_async_list_saved_proxies() -> None:
    with respx.mock(base_url=BASE) as mock:
        mock.get("/v1/proxies").mock(return_value=httpx.Response(200, json={"data": []}))
        async with AsyncDriftstack(api_key=API_KEY, base_url=BASE) as client:
            out = await client.egress.list_saved_proxies()
        assert out == {"data": []}

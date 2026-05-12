"""Crypto-orders resource tests — V-666 Python SDK parity."""

from __future__ import annotations

import httpx
import pytest
import respx

from driftstack import AsyncDriftstack, Driftstack

API_KEY = "ds_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
BASE = "https://api.test"


ENVELOPE = {
    "id": "co_test_1",
    "status": "awaiting_payment",
    "created_at": "2026-05-12T00:00:00Z",
    "fiat_cents": 999,
    "currency": "usd",
    "asset": "usdc",
    "amount_atomic": "100000",
    "deposit_address": "0xabc",
    "expires_at": "2026-05-12T01:00:00Z",
}


# ──────────────────────────────────────────────────────────────────────────
# Quote
# ──────────────────────────────────────────────────────────────────────────


def test_sync_quote_posts_body() -> None:
    quote_response = {"fiat_cents": 999, "asset": "usdc", "min_atomic": "100000"}
    with respx.mock(base_url=BASE) as mock:
        route = mock.post("/v1/billing/crypto-checkout/quote").mock(
            return_value=httpx.Response(200, json=quote_response),
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            out = client.crypto_orders.quote({"tier": "api_builder", "asset": "usdc"})
        assert out == quote_response
        assert route.called


# ──────────────────────────────────────────────────────────────────────────
# Create checkout — idempotency-key passthrough (V-666.AO)
# ──────────────────────────────────────────────────────────────────────────


def test_sync_create_checkout_forwards_idempotency_key() -> None:
    seen: list[str | None] = []

    def _handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.headers.get("idempotency-key"))
        return httpx.Response(200, json=ENVELOPE)

    with respx.mock(base_url=BASE) as mock:
        mock.post("/v1/billing/crypto-checkout").mock(side_effect=_handler)
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            out = client.crypto_orders.create_checkout(
                {"tier": "api_builder", "asset": "usdc"},
                idempotency_key="abc-123",
            )
        assert out == ENVELOPE
        assert seen == ["abc-123"]


def test_sync_create_checkout_without_idempotency_key_omits_header() -> None:
    seen: list[str | None] = []

    def _handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.headers.get("idempotency-key"))
        return httpx.Response(200, json=ENVELOPE)

    with respx.mock(base_url=BASE) as mock:
        mock.post("/v1/billing/crypto-checkout").mock(side_effect=_handler)
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            client.crypto_orders.create_checkout({"tier": "api_builder", "asset": "usdc"})
        assert seen == [None]


# ──────────────────────────────────────────────────────────────────────────
# List — query passthrough + iterate (V-666.G / .BR / .BU / .BX)
# ──────────────────────────────────────────────────────────────────────────


def test_sync_list_passes_through_filters() -> None:
    seen: list[dict[str, str]] = []

    def _handler(request: httpx.Request) -> httpx.Response:
        seen.append(dict(request.url.params))
        return httpx.Response(200, json={"orders": [ENVELOPE], "next_cursor": None})

    with respx.mock(base_url=BASE) as mock:
        mock.get("/v1/billing/crypto-orders").mock(side_effect=_handler)
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            client.crypto_orders.list(
                limit=10,
                status="paid",
                cursor="cur-1",
                created_after="2026-05-01T00:00:00Z",
                created_before="2026-06-01T00:00:00Z",
            )
        assert seen == [
            {
                "limit": "10",
                "status": "paid",
                "cursor": "cur-1",
                "created_after": "2026-05-01T00:00:00Z",
                "created_before": "2026-06-01T00:00:00Z",
            }
        ]


def test_sync_list_omits_unset_params() -> None:
    seen: list[str] = []

    def _handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        return httpx.Response(200, json={"orders": [], "next_cursor": None})

    with respx.mock(base_url=BASE) as mock:
        mock.get("/v1/billing/crypto-orders").mock(side_effect=_handler)
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            client.crypto_orders.list()
        # No query string at all when no opts are passed.
        assert seen == [f"{BASE}/v1/billing/crypto-orders"]


def test_sync_iterate_walks_cursor_pages() -> None:
    pages = [
        {"orders": [{"id": "co_1"}], "next_cursor": "c1"},
        {"orders": [{"id": "co_2"}, {"id": "co_3"}], "next_cursor": "c2"},
        {"orders": [{"id": "co_4"}], "next_cursor": None},
    ]
    seen_cursors: list[str | None] = []

    def _handler(request: httpx.Request) -> httpx.Response:
        seen_cursors.append(request.url.params.get("cursor"))
        return httpx.Response(200, json=pages[len(seen_cursors) - 1])

    with respx.mock(base_url=BASE) as mock:
        mock.get("/v1/billing/crypto-orders").mock(side_effect=_handler)
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            ids = [o["id"] for o in client.crypto_orders.iterate(limit=10)]
        assert ids == ["co_1", "co_2", "co_3", "co_4"]
        assert seen_cursors == [None, "c1", "c2"]


def test_sync_iterate_stops_immediately_on_empty_page() -> None:
    with respx.mock(base_url=BASE) as mock:
        mock.get("/v1/billing/crypto-orders").mock(
            return_value=httpx.Response(200, json={"orders": [], "next_cursor": None}),
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            assert list(client.crypto_orders.iterate()) == []


# ──────────────────────────────────────────────────────────────────────────
# Get / receipt / cancel / update_note — path encoding
# ──────────────────────────────────────────────────────────────────────────


def test_sync_get_quotes_order_id() -> None:
    seen: list[bytes] = []

    def _handler(request: httpx.Request) -> httpx.Response:
        # `.raw_path` preserves percent-encoding; `.path` decodes it.
        seen.append(request.url.raw_path)
        return httpx.Response(200, json=ENVELOPE)

    # The id contains a slash — quote(..., safe='') must percent-encode
    # it so the server sees a single path segment, not nested routes.
    weird_id = "co/with/slash"
    with respx.mock(base_url=BASE) as mock:
        mock.get(url__regex=r"/v1/billing/crypto-orders/.+").mock(side_effect=_handler)
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            client.crypto_orders.get(weird_id)
        assert seen == [b"/v1/billing/crypto-orders/co%2Fwith%2Fslash"]


def test_sync_receipt_path() -> None:
    receipt = {"order_id": "co_1", "issued_at": "2026-05-12T00:00:00Z"}
    with respx.mock(base_url=BASE) as mock:
        route = mock.get("/v1/billing/crypto-orders/co_1/receipt").mock(
            return_value=httpx.Response(200, json=receipt),
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            assert client.crypto_orders.receipt("co_1") == receipt
        assert route.called


def test_sync_cancel_path() -> None:
    cancelled = {"id": "co_1", "status": "cancelled"}
    with respx.mock(base_url=BASE) as mock:
        route = mock.post("/v1/billing/crypto-orders/co_1/cancel").mock(
            return_value=httpx.Response(200, json=cancelled),
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            assert client.crypto_orders.cancel("co_1") == cancelled
        assert route.called


def test_sync_update_note_patches() -> None:
    seen_bodies: list[dict[str, str] | None] = []

    def _handler(request: httpx.Request) -> httpx.Response:
        import json as _json

        seen_bodies.append(_json.loads(request.content.decode()) if request.content else None)
        return httpx.Response(200, json={**ENVELOPE, "note": "hello"})

    with respx.mock(base_url=BASE) as mock:
        mock.patch("/v1/billing/crypto-orders/co_1").mock(side_effect=_handler)
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            out = client.crypto_orders.update_note("co_1", {"note": "hello"})
        assert out["note"] == "hello"
        assert seen_bodies == [{"note": "hello"}]


# ──────────────────────────────────────────────────────────────────────────
# Async parity smoke tests
# ──────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_async_list_and_iterate() -> None:
    pages = [
        {"orders": [{"id": "co_a"}], "next_cursor": "c1"},
        {"orders": [{"id": "co_b"}], "next_cursor": None},
    ]
    call_count = {"n": 0}

    def _handler(request: httpx.Request) -> httpx.Response:
        idx = call_count["n"]
        call_count["n"] += 1
        return httpx.Response(200, json=pages[idx])

    with respx.mock(base_url=BASE) as mock:
        mock.get("/v1/billing/crypto-orders").mock(side_effect=_handler)
        async with AsyncDriftstack(api_key=API_KEY, base_url=BASE) as client:
            ids: list[str] = []
            async for order in client.crypto_orders.iterate(limit=5):
                ids.append(order["id"])
        assert ids == ["co_a", "co_b"]


@pytest.mark.asyncio
async def test_async_create_checkout_forwards_idempotency_key() -> None:
    seen: list[str | None] = []

    def _handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.headers.get("idempotency-key"))
        return httpx.Response(200, json=ENVELOPE)

    with respx.mock(base_url=BASE) as mock:
        mock.post("/v1/billing/crypto-checkout").mock(side_effect=_handler)
        async with AsyncDriftstack(api_key=API_KEY, base_url=BASE) as client:
            await client.crypto_orders.create_checkout(
                {"tier": "api_builder", "asset": "usdc"},
                idempotency_key="async-key",
            )
        assert seen == ["async-key"]

"""HTTP retry-SAFETY gate tests.

The SDK auto-retries transient failures (5xx / network blips) — but only
for requests that are safe to re-attempt: idempotent methods, or a
POST/PATCH that carries an Idempotency-Key (the server replays the
original response on that key). A keyless create must be sent exactly
once, or a transient blip could double-submit it.

These drive the gate through the public resource surface (crypto-orders,
which returns raw dicts so there's no pydantic decode in the way) and
assert the on-the-wire attempt count via respx route.call_count.
"""

from __future__ import annotations

import httpx
import pytest
import respx

from driftstack import AsyncDriftstack, Driftstack
from driftstack.errors import TransportError
from driftstack.retry import RetryConfig

API_KEY = "ds_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
BASE = "https://api.test"
ENVELOPE = {"id": "co_test_1", "status": "awaiting_payment"}

# Tight retry so the tests don't actually sleep.
_RETRY = RetryConfig(max_retries=2, initial_delay_ms=1, max_delay_ms=2)


def test_idempotent_get_is_retried() -> None:
    """A GET is idempotent → the loop recovers from a transient blip."""
    with respx.mock(base_url=BASE) as mock:
        route = mock.get("/v1/billing/crypto-orders/co_x").mock(
            side_effect=[
                httpx.ConnectError("connection refused"),
                httpx.Response(200, json=ENVELOPE),
            ]
        )
        with Driftstack(api_key=API_KEY, base_url=BASE, retry=_RETRY) as client:
            order = client.crypto_orders.get("co_x")
        assert order["id"] == "co_test_1"
        assert route.call_count == 2  # one fail + one success


def test_keyless_post_is_not_retried() -> None:
    """A keyless create POST must be sent exactly once (no double-submit)."""
    with respx.mock(base_url=BASE) as mock:
        route = mock.post("/v1/billing/crypto-checkout").mock(
            side_effect=[
                httpx.ConnectError("connection refused"),
                httpx.Response(200, json=ENVELOPE),  # never reached
            ]
        )
        with Driftstack(api_key=API_KEY, base_url=BASE, retry=_RETRY) as client:
            with pytest.raises(TransportError):
                client.crypto_orders.create_checkout({"tier": "api_builder", "asset": "usdc"})
        assert route.call_count == 1  # the blip surfaced, no retry


def test_keyed_post_is_retried() -> None:
    """A POST carrying an Idempotency-Key IS retry-safe (server replays)."""
    with respx.mock(base_url=BASE) as mock:
        route = mock.post("/v1/billing/crypto-checkout").mock(
            side_effect=[
                httpx.ConnectError("connection refused"),
                httpx.Response(200, json=ENVELOPE),
            ]
        )
        with Driftstack(api_key=API_KEY, base_url=BASE, retry=_RETRY) as client:
            order = client.crypto_orders.create_checkout(
                {"tier": "api_builder", "asset": "usdc"},
                idempotency_key="idem-abc-123",
            )
        assert order["id"] == "co_test_1"
        assert route.call_count == 2


@pytest.mark.asyncio
async def test_async_keyless_post_is_not_retried() -> None:
    """The async client gates retries identically to the sync client."""
    with respx.mock(base_url=BASE) as mock:
        route = mock.post("/v1/billing/crypto-checkout").mock(
            side_effect=[
                httpx.ConnectError("connection refused"),
                httpx.Response(200, json=ENVELOPE),  # never reached
            ]
        )
        async with AsyncDriftstack(api_key=API_KEY, base_url=BASE, retry=_RETRY) as client:
            with pytest.raises(TransportError):
                await client.crypto_orders.create_checkout({"tier": "api_builder", "asset": "usdc"})
        assert route.call_count == 1

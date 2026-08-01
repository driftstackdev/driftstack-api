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
from driftstack.http import _is_retry_safe
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


# ── PATCH, at the predicate level ──────────────────────────────────────
#
# The tests above drive the gate through resource methods, which reach it via
# GET and POST only. PATCH is excluded from the idempotent set by OMISSION and
# nothing asserted it — so adding "PATCH" to that set would change customer-
# visible behaviour with the whole suite still green. PATCH matters as much as
# POST here: patch bodies are commonly relative rather than absolute, so a
# replayed PATCH can apply an increment twice.
#
# Asserted against `_is_retry_safe` directly because no resource method issues a
# PATCH today; routing it through a resource would test the resource, not the
# gate.


def test_keyless_patch_is_not_retry_safe() -> None:
    """PATCH without an Idempotency-Key must not be auto-retried."""
    assert _is_retry_safe("PATCH", {}) is False
    assert _is_retry_safe("PATCH", {"content-type": "application/json"}) is False


def test_keyed_patch_is_retry_safe() -> None:
    """The differential arm: with a key the server replays, so PATCH is safe.

    Without this, the assertion above is equally satisfied by a gate that
    refuses everything — which would disable retries entirely and turn every
    transient blip into a customer-visible failure.
    """
    assert _is_retry_safe("PATCH", {"Idempotency-Key": "idem-abc123"}) is True


def test_patch_key_match_is_case_insensitive() -> None:
    """HTTP header names are case-insensitive; retry safety must not hinge on
    how the caller capitalised the key."""
    for spelling in ("idempotency-key", "IDEMPOTENCY-KEY", "Idempotency-Key"):
        assert _is_retry_safe("PATCH", {spelling: "idem-abc123"}) is True


def test_blank_key_is_not_retry_safe() -> None:
    """A present-but-blank key must not switch retries on.

    The server treats an empty / whitespace-only ``Idempotency-Key`` as ABSENT:
    it stores no dedup record and replays nothing. A blank key is therefore the
    worst case — no server-side protection, yet a header-name-only check read it
    as licence to retry, so an unset variable arriving as ``""`` turned a single
    POST into an auto-retried one that could mint duplicates.
    """
    for blank in ("", " ", "\t", "\n", "   "):
        for method in ("POST", "PATCH"):
            assert _is_retry_safe(method, {"Idempotency-Key": blank}) is False


def test_padded_but_real_key_is_retry_safe() -> None:
    """The differential arm: the server trims before keying, so surrounding
    whitespace around a real key must not disable retries."""
    assert _is_retry_safe("POST", {"Idempotency-Key": "  idem-abc123  "}) is True

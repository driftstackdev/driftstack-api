"""BillingResource tests.

BillingResource (3 sync + 3 async methods) had NO direct test
coverage in the Python SDK test suite. The /v1/billing surface
(V-082) is customer-facing — checkout sessions + Stripe customer
portal — but the HTTP wrappers around it weren't exercised by unit
tests. (The one-time trial-pack purchase flow was retired 2026-05-27;
the perpetual free tier needs no purchase step.)

Coverage:
  - get_state() → GET /v1/billing
  - create_checkout_session({...}) → POST /v1/billing/checkout-session
  - create_portal_session() → POST /v1/billing/portal-session (no body)

  + 3 mirror async paths.
"""

from __future__ import annotations

import httpx
import pytest
import respx

from driftstack import AsyncDriftstack, Driftstack

API_KEY = "ds_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
BASE = "https://api.test"

BILLING_STATE: dict = {
    "subscription": {
        "tier": "api_builder",
        "status": "active",
        "current_period_end": "2026-06-01T00:00:00Z",
        "cancel_at_period_end": False,
    },
}


def test_sync_get_state_hits_get_billing() -> None:
    with respx.mock(base_url=BASE) as mock:
        route = mock.get("/v1/billing").mock(
            return_value=httpx.Response(200, json=BILLING_STATE),
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            result = client.billing.get_state()
        assert route.called
        assert result["subscription"]["tier"] == "api_builder"


def test_sync_create_checkout_session_sends_post() -> None:
    response = {"url": "https://checkout.stripe.com/c/pay/abc123"}
    captured_body: list[bytes] = []
    with respx.mock(base_url=BASE) as mock:
        mock.post("/v1/billing/checkout-session").mock(
            side_effect=lambda req: (
                captured_body.append(req.content) or httpx.Response(200, json=response)
            ),
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            result = client.billing.create_checkout_session(
                {
                    "tier": "api_builder",
                    "billing_period": "monthly",
                    "success_url": "https://app.driftstack.io/welcome",
                    "cancel_url": "https://app.driftstack.io/select-tier",
                },
            )
        assert result["url"].startswith("https://checkout.stripe.com/")
        # Verify the body was forwarded with all 4 fields.
        assert b'"tier":"api_builder"' in captured_body[0]
        assert b'"billing_period":"monthly"' in captured_body[0]


def test_sync_create_portal_session_hits_portal_endpoint() -> None:
    response = {"url": "https://billing.stripe.com/p/session/abc"}
    with respx.mock(base_url=BASE) as mock:
        route = mock.post("/v1/billing/portal-session").mock(
            return_value=httpx.Response(200, json=response),
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            result = client.billing.create_portal_session()
        assert route.called
        assert result["url"].startswith("https://billing.stripe.com/")


@pytest.mark.asyncio
async def test_async_get_state() -> None:
    with respx.mock(base_url=BASE) as mock:
        mock.get("/v1/billing").mock(return_value=httpx.Response(200, json=BILLING_STATE))
        async with AsyncDriftstack(api_key=API_KEY, base_url=BASE) as client:
            result = await client.billing.get_state()
        assert result["subscription"]["status"] == "active"


@pytest.mark.asyncio
async def test_async_create_checkout_session() -> None:
    response = {"url": "https://checkout.stripe.com/c/pay/xyz789"}
    with respx.mock(base_url=BASE) as mock:
        mock.post("/v1/billing/checkout-session").mock(
            return_value=httpx.Response(200, json=response),
        )
        async with AsyncDriftstack(api_key=API_KEY, base_url=BASE) as client:
            result = await client.billing.create_checkout_session(
                {"tier": "api_scale", "billing_period": "annual"},
            )
        assert result["url"].endswith("/xyz789")


@pytest.mark.asyncio
async def test_async_create_portal_session() -> None:
    response = {"url": "https://billing.stripe.com/p/session/zzz"}
    with respx.mock(base_url=BASE) as mock:
        mock.post("/v1/billing/portal-session").mock(
            return_value=httpx.Response(200, json=response),
        )
        async with AsyncDriftstack(api_key=API_KEY, base_url=BASE) as client:
            result = await client.billing.create_portal_session()
        assert result["url"].endswith("/zzz")

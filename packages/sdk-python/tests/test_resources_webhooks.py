"""Webhooks resource tests."""

from __future__ import annotations

import httpx
import pytest
import respx

from driftstack import AsyncDriftstack, Driftstack
from driftstack._generated.models import (
    CreateWebhookResponse,
    WebhookDelivery,
    WebhookEndpoint,
)
from driftstack.resources.webhooks import WebhookDeliveryListPage, WebhookEndpointList

API_KEY = "ds_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
BASE = "https://api.test"

ENDPOINT: dict = {
    "id": "whk_00000000-0000-4000-8000-000000000001",
    "url": "https://customer.test/hook",
    "secret_prefix": "whsec_aaaaaa",
    # V-359 — rotation grace state. Both null when no rotation in flight.
    "prev_secret_prefix": None,
    "rotation_grace_expires_at": None,
    "events": ["session.completed"],
    "description": None,
    "active": True,
    "consecutive_failures": 0,
    "last_success_at": None,
    "last_failure_at": None,
    "disabled_at": None,
    # V-185 — aggregate delivery counts.
    "delivery_counts": {"delivered": 0, "failed": 0, "dlq": 0},
    "created_at": "2026-05-02T10:00:00Z",
}

DELIVERY: dict = {
    "id": "wdl_00000000-0000-4000-8000-000000000001",
    "webhook_id": "whk_00000000-0000-4000-8000-000000000001",
    "event_id": "11111111-2222-3333-4444-555555555555",
    "event_type": "session.completed",
    "status": "delivered",
    "attempts": 1,
    "next_attempt_at": "2026-05-02T10:00:00Z",
    "last_response_status": 200,
    "last_response_excerpt": None,
    "last_error": None,
    "delivered_at": "2026-05-02T10:00:00Z",
    "created_at": "2026-05-02T10:00:00Z",
}


def test_sync_create_returns_secret_once() -> None:
    response = {**ENDPOINT, "secret": "whsec_secretsecretsecretsecretsecretsec"}
    with respx.mock(base_url=BASE) as mock:
        mock.post("/v1/webhooks").mock(return_value=httpx.Response(201, json=response))
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            result = client.webhooks.create(
                {"url": "https://customer.test/hook", "events": ["session.completed"]}
            )
        assert isinstance(result, CreateWebhookResponse)
        assert result.secret.startswith("whsec_")


def test_sync_list() -> None:
    page = {"data": [ENDPOINT, ENDPOINT]}
    with respx.mock(base_url=BASE) as mock:
        mock.get("/v1/webhooks").mock(return_value=httpx.Response(200, json=page))
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            result = client.webhooks.list()
        assert isinstance(result, WebhookEndpointList)
        assert len(result.data) == 2


def test_sync_get() -> None:
    with respx.mock(base_url=BASE) as mock:
        mock.get("/v1/webhooks/whk_xx").mock(return_value=httpx.Response(200, json=ENDPOINT))
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            result = client.webhooks.get("whk_xx")
        assert isinstance(result, WebhookEndpoint)


def test_sync_delete() -> None:
    with respx.mock(base_url=BASE) as mock:
        mock.delete("/v1/webhooks/whk_xx").mock(return_value=httpx.Response(204))
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            result = client.webhooks.delete("whk_xx")
        assert result is None


def test_sync_list_deliveries_with_status_filter() -> None:
    page = {"data": [DELIVERY], "has_more": False, "next_cursor": None}
    with respx.mock(base_url=BASE) as mock:
        route = mock.get("/v1/webhooks/whk_xx/deliveries").mock(
            return_value=httpx.Response(200, json=page)
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            result = client.webhooks.list_deliveries("whk_xx", {"status": "delivered", "limit": 25})
        assert isinstance(result, WebhookDeliveryListPage)
        assert isinstance(result.data[0], WebhookDelivery)
        # The status filter is on the wire.
        q = route.calls[0].request.url.query.decode()
        assert "status=delivered" in q
        assert "limit=25" in q


@pytest.mark.asyncio
async def test_async_create() -> None:
    response = {**ENDPOINT, "secret": "whsec_secretsecretsecretsecretsecretsec"}
    with respx.mock(base_url=BASE) as mock:
        mock.post("/v1/webhooks").mock(return_value=httpx.Response(201, json=response))
        async with AsyncDriftstack(api_key=API_KEY, base_url=BASE) as client:
            result = await client.webhooks.create(
                {"url": "https://customer.test/hook", "events": ["session.completed"]}
            )
        assert isinstance(result, CreateWebhookResponse)


@pytest.mark.asyncio
async def test_async_list_deliveries() -> None:
    page = {"data": [DELIVERY], "has_more": False, "next_cursor": None}
    with respx.mock(base_url=BASE) as mock:
        mock.get("/v1/webhooks/whk_xx/deliveries").mock(return_value=httpx.Response(200, json=page))
        async with AsyncDriftstack(api_key=API_KEY, base_url=BASE) as client:
            result = await client.webhooks.list_deliveries("whk_xx")
        assert isinstance(result, WebhookDeliveryListPage)


# V-307 — replay flow tests.


def test_sync_replay_delivery() -> None:
    pending = {**DELIVERY, "status": "pending", "attempts": 0, "delivered_at": None}
    with respx.mock(base_url=BASE) as mock:
        route = mock.post("/v1/webhook-deliveries/wdl_xx/replay").mock(
            return_value=httpx.Response(200, json=pending),
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            result = client.webhooks.replay_delivery("wdl_xx")
        assert route.called
        assert isinstance(result, WebhookDelivery)
        assert result.status == "pending"


@pytest.mark.asyncio
async def test_async_replay_delivery() -> None:
    pending = {**DELIVERY, "status": "pending", "attempts": 0, "delivered_at": None}
    with respx.mock(base_url=BASE) as mock:
        mock.post("/v1/webhook-deliveries/wdl_xx/replay").mock(
            return_value=httpx.Response(200, json=pending),
        )
        async with AsyncDriftstack(api_key=API_KEY, base_url=BASE) as client:
            result = await client.webhooks.replay_delivery("wdl_xx")
        assert result.status == "pending"


# V-463 — webhooks.send_test test ping.


def test_sync_send_test() -> None:
    receipt = {
        "delivery_id": "wdl_test1",
        "event_id": "evt_test1",
        "event_type": "test.ping",
    }
    with respx.mock(base_url=BASE) as mock:
        route = mock.post("/v1/webhooks/whk_xx/test").mock(
            return_value=httpx.Response(200, json=receipt),
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            result = client.webhooks.send_test("whk_xx")
        assert route.called
        assert result["event_type"] == "test.ping"
        assert result["delivery_id"] == "wdl_test1"


@pytest.mark.asyncio
async def test_async_send_test() -> None:
    receipt = {
        "delivery_id": "wdl_test2",
        "event_id": "evt_test2",
        "event_type": "test.ping",
    }
    with respx.mock(base_url=BASE) as mock:
        mock.post("/v1/webhooks/whk_xx/test").mock(
            return_value=httpx.Response(200, json=receipt),
        )
        async with AsyncDriftstack(api_key=API_KEY, base_url=BASE) as client:
            result = await client.webhooks.send_test("whk_xx")
        assert result["event_type"] == "test.ping"


# V-464 — webhooks.update partial-update.


def test_sync_update_partial() -> None:
    updated = {**ENDPOINT, "description": "after-update", "active": False}
    with respx.mock(base_url=BASE) as mock:
        route = mock.patch("/v1/webhooks/whk_xx").mock(
            return_value=httpx.Response(200, json=updated),
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            result = client.webhooks.update(
                "whk_xx", {"description": "after-update", "active": False}
            )
        assert route.called
        assert isinstance(result, WebhookEndpoint)
        assert result.description == "after-update"
        assert result.active is False


@pytest.mark.asyncio
async def test_async_update_partial() -> None:
    updated = {**ENDPOINT, "description": "from-async-test"}
    with respx.mock(base_url=BASE) as mock:
        mock.patch("/v1/webhooks/whk_xx").mock(
            return_value=httpx.Response(200, json=updated),
        )
        async with AsyncDriftstack(api_key=API_KEY, base_url=BASE) as client:
            result = await client.webhooks.update("whk_xx", {"description": "from-async-test"})
        assert result.description == "from-async-test"


# ── rotate_secret shipped with NO test in ANY of the three SDKs (V-1978). It is
# ── the one operation here that mints a credential, and its response is the ONLY
# ── time the plaintext secret is returned — a client that dropped a field would
# ── lose a secret the server will not show again.

ROTATED: dict = {
    "id": "whk_00000000-0000-4000-8000-000000000001",
    "secret": "whsec_freshsecretfreshsecretfreshsecret",
    "secret_prefix": "whsec_fr",
    "prev_secret_prefix": "whsec_aA",
    "grace_expires_at": "2026-05-10T18:00:00Z",
}


def test_sync_rotate_secret_posts_empty_body_and_returns_the_plaintext() -> None:
    with respx.mock(base_url=BASE) as mock:
        route = mock.post(
            "/v1/webhooks/whk_00000000-0000-4000-8000-000000000001/rotate-secret"
        ).mock(return_value=httpx.Response(200, json=ROTATED))
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            out = client.webhooks.rotate_secret("whk_00000000-0000-4000-8000-000000000001")
        assert route.called
        assert route.calls[0].request.method == "POST"
        assert route.calls[0].request.content == b"{}"
        # Both prefixes and the grace deadline are what a caller needs to keep
        # verifying deliveries signed with the OLD secret during the dual-sign
        # window; dropping any of them silently breaks verification at rollover.
        assert out == ROTATED


def test_sync_rotate_secret_url_encodes_the_webhook_id() -> None:
    with respx.mock(base_url=BASE) as mock:
        route = mock.post("/v1/webhooks/whk%2Fwith%20space/rotate-secret").mock(
            return_value=httpx.Response(200, json=ROTATED)
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            client.webhooks.rotate_secret("whk/with space")
        assert route.called


@pytest.mark.asyncio
async def test_async_rotate_secret_posts_empty_body() -> None:
    """The async mirror is a separate method and therefore a separate chance to
    send no body at all."""
    with respx.mock(base_url=BASE) as mock:
        route = mock.post(
            "/v1/webhooks/whk_00000000-0000-4000-8000-000000000001/rotate-secret"
        ).mock(return_value=httpx.Response(200, json=ROTATED))
        async with AsyncDriftstack(api_key=API_KEY, base_url=BASE) as client:
            out = await client.webhooks.rotate_secret("whk_00000000-0000-4000-8000-000000000001")
        assert route.calls[0].request.content == b"{}"
        assert out == ROTATED

"""Webhooks resource — /v1/webhooks."""

from __future__ import annotations

from collections.abc import AsyncIterator, Iterator
from typing import Any
from urllib.parse import quote

from pydantic import BaseModel

from driftstack._generated.models import (
    CreateWebhookRequest,
    CreateWebhookResponse,
    ListDeliveriesQuery,
    WebhookDelivery,
    WebhookEndpoint,
)
from driftstack.http import AsyncHttpClient, HttpClient, parse_model
from driftstack.pagination import aiterate_paginated, iterate_paginated
from driftstack.resources._common import coerce_body, coerce_query


class WebhookEndpointList(BaseModel):
    """Response shape for ``GET /v1/webhooks``."""

    data: list[WebhookEndpoint]


class WebhookDeliveryListPage(BaseModel):
    """Response shape for ``GET /v1/webhooks/{id}/deliveries``."""

    data: list[WebhookDelivery]
    has_more: bool
    next_cursor: str | None


def _webhook_path(webhook_id: str, suffix: str = "") -> str:
    return f"/v1/webhooks/{quote(webhook_id, safe='')}{suffix}"


class WebhooksResource:
    """Synchronous webhooks resource."""

    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def create(self, body: CreateWebhookRequest | dict[str, Any]) -> CreateWebhookResponse:
        """Create a webhook subscription.

        Plaintext signing secret is returned ONCE; store it now — it
        cannot be retrieved later. Requires the ``account_owner`` scope.
        """
        data = self._http.request("POST", "/v1/webhooks", json_body=coerce_body(body))
        return parse_model(CreateWebhookResponse, data)

    def list(self) -> WebhookEndpointList:
        data = self._http.request("GET", "/v1/webhooks")
        return parse_model(WebhookEndpointList, data)

    def get(self, webhook_id: str) -> WebhookEndpoint:
        data = self._http.request("GET", _webhook_path(webhook_id))
        return parse_model(WebhookEndpoint, data)

    def delete(self, webhook_id: str) -> None:
        """Soft-delete (disable) the endpoint. Idempotent."""
        self._http.request("DELETE", _webhook_path(webhook_id))

    def list_deliveries(
        self,
        webhook_id: str,
        query: ListDeliveriesQuery | dict[str, Any] | None = None,
    ) -> WebhookDeliveryListPage:
        data = self._http.request(
            "GET",
            _webhook_path(webhook_id, "/deliveries"),
            params=coerce_query(query),
        )
        return parse_model(WebhookDeliveryListPage, data)

    def iterate_deliveries(
        self,
        webhook_id: str,
        *,
        limit: int | None = None,
        status: str | None = None,
    ) -> Iterator[WebhookDelivery]:
        """Lazily walk every delivery for an endpoint.

        Filter by ``status`` (e.g. ``'dlq'``) to walk just one bucket;
        the filter threads through every page.
        """

        def fetch_page(cursor: str | None) -> WebhookDeliveryListPage:
            params: dict[str, Any] = {}
            if limit is not None:
                params["limit"] = limit
            if status is not None:
                params["status"] = status
            if cursor is not None:
                params["cursor"] = cursor
            return self.list_deliveries(webhook_id, params)

        return iterate_paginated(fetch_page)

    def replay_delivery(self, delivery_id: str) -> WebhookDelivery:
        """V-307 — replay a webhook delivery.

        Resets the delivery to ``pending`` so the worker re-fires it.
        Account-scoped: the delivery must belong to an endpoint the
        calling account owns.
        """
        data = self._http.request(
            "POST",
            f"/v1/webhook-deliveries/{quote(delivery_id, safe='')}/replay",
            json_body={},
        )
        return parse_model(WebhookDelivery, data)

    def rotate_secret(self, webhook_id: str) -> dict[str, Any]:
        """V-359 — rotate the webhook signing secret.

        Returns the fresh plaintext (shown ONCE) plus grace metadata:
        the previous secret stays active for 24h
        (``grace_expires_at``) during which Driftstack dual-signs
        every outbound delivery (both new + old HMAC). Roll the new
        secret across your verifier infra inside that window.
        """
        return self._http.request("POST", _webhook_path(webhook_id, "/rotate-secret"), json_body={})

    def send_test(self, webhook_id: str) -> dict[str, Any]:
        """V-356 — send a synthetic ``test.ping`` event to the endpoint.

        Bypasses subscription so customers can verify their handler
        is reachable + signature-valid before depending on it for
        real events. Returns ``{delivery_id, event_id, event_type}``.
        """
        return self._http.request("POST", _webhook_path(webhook_id, "/test"), json_body={})

    def update(self, webhook_id: str, body: dict[str, Any]) -> WebhookEndpoint:
        """V-351 — partial-update a webhook endpoint.

        At least one of ``url``, ``events``, ``description``, or
        ``active`` must be present. The signing secret is NOT rotated
        by update; use :meth:`rotate_secret` for that. Disabled
        endpoints cannot be updated (returns 409).
        """
        data = self._http.request("PATCH", _webhook_path(webhook_id), json_body=coerce_body(body))
        return parse_model(WebhookEndpoint, data)


class AsyncWebhooksResource:
    """Async webhooks resource."""

    def __init__(self, http: AsyncHttpClient) -> None:
        self._http = http

    async def create(self, body: CreateWebhookRequest | dict[str, Any]) -> CreateWebhookResponse:
        data = await self._http.request("POST", "/v1/webhooks", json_body=coerce_body(body))
        return parse_model(CreateWebhookResponse, data)

    async def list(self) -> WebhookEndpointList:
        data = await self._http.request("GET", "/v1/webhooks")
        return parse_model(WebhookEndpointList, data)

    async def get(self, webhook_id: str) -> WebhookEndpoint:
        data = await self._http.request("GET", _webhook_path(webhook_id))
        return parse_model(WebhookEndpoint, data)

    async def delete(self, webhook_id: str) -> None:
        await self._http.request("DELETE", _webhook_path(webhook_id))

    async def list_deliveries(
        self,
        webhook_id: str,
        query: ListDeliveriesQuery | dict[str, Any] | None = None,
    ) -> WebhookDeliveryListPage:
        data = await self._http.request(
            "GET",
            _webhook_path(webhook_id, "/deliveries"),
            params=coerce_query(query),
        )
        return parse_model(WebhookDeliveryListPage, data)

    def iterate_deliveries(
        self,
        webhook_id: str,
        *,
        limit: int | None = None,
        status: str | None = None,
    ) -> AsyncIterator[WebhookDelivery]:
        """Async variant of :meth:`WebhooksResource.iterate_deliveries`."""

        async def fetch_page(cursor: str | None) -> WebhookDeliveryListPage:
            params: dict[str, Any] = {}
            if limit is not None:
                params["limit"] = limit
            if status is not None:
                params["status"] = status
            if cursor is not None:
                params["cursor"] = cursor
            return await self.list_deliveries(webhook_id, params)

        return aiterate_paginated(fetch_page)

    async def replay_delivery(self, delivery_id: str) -> WebhookDelivery:
        """V-307 — async replay. See :meth:`WebhooksResource.replay_delivery`."""
        data = await self._http.request(
            "POST",
            f"/v1/webhook-deliveries/{quote(delivery_id, safe='')}/replay",
            json_body={},
        )
        return parse_model(WebhookDelivery, data)

    async def rotate_secret(self, webhook_id: str) -> dict[str, Any]:
        """V-359 — async secret rotation. See :meth:`WebhooksResource.rotate_secret`."""
        return await self._http.request(
            "POST", _webhook_path(webhook_id, "/rotate-secret"), json_body={}
        )

    async def send_test(self, webhook_id: str) -> dict[str, Any]:
        """V-356 — async test ping. See :meth:`WebhooksResource.send_test`."""
        return await self._http.request("POST", _webhook_path(webhook_id, "/test"), json_body={})

    async def update(self, webhook_id: str, body: dict[str, Any]) -> WebhookEndpoint:
        """V-351 — async partial-update. See :meth:`WebhooksResource.update`."""
        data = await self._http.request(
            "PATCH", _webhook_path(webhook_id), json_body=coerce_body(body)
        )
        return parse_model(WebhookEndpoint, data)

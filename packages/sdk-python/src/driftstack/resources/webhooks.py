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
from driftstack.http import AsyncHttpClient, HttpClient
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
        cannot be retrieved later. Requires the ``admin`` scope.
        """
        data = self._http.request("POST", "/v1/webhooks", json_body=coerce_body(body))
        return CreateWebhookResponse.model_validate(data)

    def list(self) -> WebhookEndpointList:
        data = self._http.request("GET", "/v1/webhooks")
        return WebhookEndpointList.model_validate(data)

    def get(self, webhook_id: str) -> WebhookEndpoint:
        data = self._http.request("GET", _webhook_path(webhook_id))
        return WebhookEndpoint.model_validate(data)

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
        return WebhookDeliveryListPage.model_validate(data)

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


class AsyncWebhooksResource:
    """Async webhooks resource."""

    def __init__(self, http: AsyncHttpClient) -> None:
        self._http = http

    async def create(self, body: CreateWebhookRequest | dict[str, Any]) -> CreateWebhookResponse:
        data = await self._http.request("POST", "/v1/webhooks", json_body=coerce_body(body))
        return CreateWebhookResponse.model_validate(data)

    async def list(self) -> WebhookEndpointList:
        data = await self._http.request("GET", "/v1/webhooks")
        return WebhookEndpointList.model_validate(data)

    async def get(self, webhook_id: str) -> WebhookEndpoint:
        data = await self._http.request("GET", _webhook_path(webhook_id))
        return WebhookEndpoint.model_validate(data)

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
        return WebhookDeliveryListPage.model_validate(data)

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

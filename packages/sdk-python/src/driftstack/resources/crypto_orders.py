"""Crypto-orders resource — /v1/billing/crypto-* (V-666).

Customer-facing only; admin endpoints aren't exposed here (use the
OpenAPI spec at ``/openapi.json`` directly).

V-666.AO — ``create_checkout`` accepts an ``idempotency_key`` keyword
that's forwarded as the ``Idempotency-Key`` header so retries don't
mint duplicate orders.

V-666.BU — ``list`` accepts ``cursor`` for cursor-pagination;
``iterate`` walks every page until ``next_cursor`` is null. The
response envelope keys its rows off ``orders`` (not the standard
``data``), so iteration adapts the page shape and delegates to the
shared :func:`iterate_paginated` helper — that way this endpoint gets
the same non-advancing-cursor guard as every other list.

Crypto payments are non-refundable.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Iterator
from typing import Any
from urllib.parse import quote, urlencode

from driftstack.http import AsyncHttpClient, HttpClient
from driftstack.pagination import aiterate_paginated, iterate_paginated
from driftstack.resources._common import coerce_body


def _qs(query: dict[str, Any]) -> str:
    items: list[tuple[str, str]] = []
    for k, v in query.items():
        if v is None:
            continue
        items.append((k, str(v)))
    return urlencode(items)


def _list_path(
    *,
    limit: int | None,
    status: str | None,
    cursor: str | None,
    created_after: str | None,
    created_before: str | None,
) -> str:
    qs = _qs(
        {
            "limit": limit,
            "status": status,
            "cursor": cursor,
            "created_after": created_after,
            "created_before": created_before,
        }
    )
    return "/v1/billing/crypto-orders" + (f"?{qs}" if qs else "")


class CryptoOrdersResource:
    """Synchronous crypto-orders resource."""

    def __init__(self, http: HttpClient) -> None:
        self._http = http

    # Requires read:billing; broad read/account_owner also satisfy it.
    def quote(self, body: dict[str, Any]) -> dict[str, Any]:
        """V-666.H — preview the fiat-cents price + crypto pay-range without minting an order."""
        return self._http.request(
            "POST",
            "/v1/billing/crypto-checkout/quote",
            json_body=coerce_body(body),
        )

    def create_checkout(
        self,
        body: dict[str, Any],
        *,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        """V-666.C — mint a new crypto order.

        Pass ``idempotency_key`` to dedupe network retries — the server
        returns the original order on replay, never a second one. With a
        key the HTTP layer is allowed to retry transient failures safely;
        without one this create is sent exactly once (no double-submit).
        """
        return self._http.request(
            "POST",
            "/v1/billing/crypto-checkout",
            json_body=coerce_body(body),
            extra_headers=(
                {"idempotency-key": idempotency_key} if idempotency_key is not None else None
            ),
        )

    def list(
        self,
        *,
        limit: int | None = None,
        status: str | None = None,
        cursor: str | None = None,
        created_after: str | None = None,
        created_before: str | None = None,
    ) -> dict[str, Any]:
        """V-666.G / .BR / .BU / .BX — list the caller's crypto orders newest-first."""
        return self._http.request(
            "GET",
            _list_path(
                limit=limit,
                status=status,
                cursor=cursor,
                created_after=created_after,
                created_before=created_before,
            ),
        )

    def iterate(
        self,
        *,
        limit: int | None = None,
        status: str | None = None,
        created_after: str | None = None,
        created_before: str | None = None,
    ) -> Iterator[dict[str, Any]]:
        """V-666.BU — lazily walk every order across cursor pages.

        Yields envelopes one at a time so the caller can break early.
        Cursor handoff is managed internally; callers MUST NOT pass
        ``cursor`` to this method (use :meth:`list` if you need a
        single page).
        """

        def _fetch(cursor: str | None) -> dict[str, Any]:
            page = self.list(
                limit=limit,
                status=status,
                cursor=cursor,
                created_after=created_after,
                created_before=created_before,
            )
            # Adapt the crypto envelope (`orders`) onto the shared
            # paginator's expected `data` key so it gets the guard.
            return {"data": page.get("orders", []), "next_cursor": page.get("next_cursor")}

        return iterate_paginated(_fetch)

    def get(self, order_id: str) -> dict[str, Any]:
        """V-666.G — read a single order envelope."""
        return self._http.request(
            "GET",
            f"/v1/billing/crypto-orders/{quote(order_id, safe='')}",
        )

    def update_note(self, order_id: str, body: dict[str, Any]) -> dict[str, Any]:
        """V-666.Q — update the customer-facing free-text note."""
        return self._http.request(
            "PATCH",
            f"/v1/billing/crypto-orders/{quote(order_id, safe='')}",
            json_body=coerce_body(body),
        )

    def cancel(self, order_id: str) -> dict[str, Any]:
        """V-666.J — abandon a pending order (self-service)."""
        return self._http.request(
            "POST",
            f"/v1/billing/crypto-orders/{quote(order_id, safe='')}/cancel",
        )

    def receipt(self, order_id: str) -> dict[str, Any]:
        """V-666.M — fetch the JSON receipt."""
        return self._http.request(
            "GET",
            f"/v1/billing/crypto-orders/{quote(order_id, safe='')}/receipt",
        )


class AsyncCryptoOrdersResource:
    """Async mirror of :class:`CryptoOrdersResource`."""

    def __init__(self, http: AsyncHttpClient) -> None:
        self._http = http

    async def quote(self, body: dict[str, Any]) -> dict[str, Any]:
        return await self._http.request(
            "POST",
            "/v1/billing/crypto-checkout/quote",
            json_body=coerce_body(body),
        )

    async def create_checkout(
        self,
        body: dict[str, Any],
        *,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        return await self._http.request(
            "POST",
            "/v1/billing/crypto-checkout",
            json_body=coerce_body(body),
            extra_headers=(
                {"idempotency-key": idempotency_key} if idempotency_key is not None else None
            ),
        )

    async def list(
        self,
        *,
        limit: int | None = None,
        status: str | None = None,
        cursor: str | None = None,
        created_after: str | None = None,
        created_before: str | None = None,
    ) -> dict[str, Any]:
        return await self._http.request(
            "GET",
            _list_path(
                limit=limit,
                status=status,
                cursor=cursor,
                created_after=created_after,
                created_before=created_before,
            ),
        )

    def iterate(
        self,
        *,
        limit: int | None = None,
        status: str | None = None,
        created_after: str | None = None,
        created_before: str | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        async def _fetch(cursor: str | None) -> dict[str, Any]:
            page = await self.list(
                limit=limit,
                status=status,
                cursor=cursor,
                created_after=created_after,
                created_before=created_before,
            )
            # Adapt the crypto envelope (`orders`) onto the shared
            # paginator's expected `data` key so it gets the guard.
            return {"data": page.get("orders", []), "next_cursor": page.get("next_cursor")}

        return aiterate_paginated(_fetch)

    async def get(self, order_id: str) -> dict[str, Any]:
        return await self._http.request(
            "GET",
            f"/v1/billing/crypto-orders/{quote(order_id, safe='')}",
        )

    async def update_note(self, order_id: str, body: dict[str, Any]) -> dict[str, Any]:
        return await self._http.request(
            "PATCH",
            f"/v1/billing/crypto-orders/{quote(order_id, safe='')}",
            json_body=coerce_body(body),
        )

    async def cancel(self, order_id: str) -> dict[str, Any]:
        return await self._http.request(
            "POST",
            f"/v1/billing/crypto-orders/{quote(order_id, safe='')}/cancel",
        )

    async def receipt(self, order_id: str) -> dict[str, Any]:
        return await self._http.request(
            "GET",
            f"/v1/billing/crypto-orders/{quote(order_id, safe='')}/receipt",
        )

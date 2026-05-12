"""Crypto-orders resource — /v1/billing/crypto-* (V-666).

Customer-facing only; admin endpoints aren't exposed here (use the
OpenAPI spec at ``/openapi.json`` directly).

V-666.AO — ``create_checkout`` accepts an ``idempotency_key`` keyword
that's forwarded as the ``Idempotency-Key`` header so retries don't
mint duplicate orders.

V-666.BU — ``list`` accepts ``cursor`` for cursor-pagination;
``iterate`` walks every page until ``next_cursor`` is null. The
response envelope is ``{"orders": [...], "next_cursor": ...}``, which
is why this resource hand-rolls iteration rather than using the
shared ``iterate_paginated`` helper (that one keys off ``data``).

Crypto payments are non-refundable.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Iterator
from typing import Any
from urllib.parse import quote, urlencode

from driftstack.http import AsyncHttpClient, HttpClient
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
        returns the original order on replay, never a second one.
        """
        # The wrapped HttpClient.request() doesn't accept arbitrary
        # headers, so we drive the underlying httpx.Client directly for
        # the one-shot Idempotency-Key case. Falls back to the standard
        # path when no header is needed.
        if idempotency_key is None:
            return self._http.request(
                "POST",
                "/v1/billing/crypto-checkout",
                json_body=coerce_body(body),
            )
        return _post_with_headers(
            self._http,
            "/v1/billing/crypto-checkout",
            json_body=coerce_body(body),
            headers={"idempotency-key": idempotency_key},
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

        def _walk() -> Iterator[dict[str, Any]]:
            cursor: str | None = None
            while True:
                page = self.list(
                    limit=limit,
                    status=status,
                    cursor=cursor,
                    created_after=created_after,
                    created_before=created_before,
                )
                yield from page.get("orders", [])
                next_cursor = page.get("next_cursor")
                if next_cursor is None:
                    return
                cursor = next_cursor

        return _walk()

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
        if idempotency_key is None:
            return await self._http.request(
                "POST",
                "/v1/billing/crypto-checkout",
                json_body=coerce_body(body),
            )
        return await _apost_with_headers(
            self._http,
            "/v1/billing/crypto-checkout",
            json_body=coerce_body(body),
            headers={"idempotency-key": idempotency_key},
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
        async def _walk() -> AsyncIterator[dict[str, Any]]:
            cursor: str | None = None
            while True:
                page = await self.list(
                    limit=limit,
                    status=status,
                    cursor=cursor,
                    created_after=created_after,
                    created_before=created_before,
                )
                for order in page.get("orders", []):
                    yield order
                next_cursor = page.get("next_cursor")
                if next_cursor is None:
                    return
                cursor = next_cursor

        return _walk()

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


# ──────────────────────────────────────────────────────────────────────────
# Idempotency-Key header escape hatch.
#
# HttpClient.request() doesn't accept arbitrary headers — adding the
# parameter to every resource would broaden the public surface and the
# only place we need it today is create_checkout (V-666.AO). Drive the
# underlying httpx.Client here, reusing the same auth + UA the
# wrapper builds; the wrapper's retry/error mapping is bypassed
# deliberately for these requests (idempotent retries should come from
# the customer's outer retry loop, not the SDK).
# ──────────────────────────────────────────────────────────────────────────


def _post_with_headers(
    http: HttpClient,
    path: str,
    *,
    json_body: Any,
    headers: dict[str, str],
) -> Any:
    from driftstack.http import _build_headers, _decode_or_raise  # noqa: PLC0415

    merged = _build_headers(http._api_key, has_body=json_body is not None)  # noqa: SLF001
    merged.update(headers)
    response = http._client.request(  # noqa: SLF001
        "POST",
        http._base_url + path,  # noqa: SLF001
        json=json_body,
        headers=merged,
    )
    return _decode_or_raise(response)


async def _apost_with_headers(
    http: AsyncHttpClient,
    path: str,
    *,
    json_body: Any,
    headers: dict[str, str],
) -> Any:
    from driftstack.http import _build_headers, _decode_or_raise  # noqa: PLC0415

    merged = _build_headers(http._api_key, has_body=json_body is not None)  # noqa: SLF001
    merged.update(headers)
    response = await http._client.request(  # noqa: SLF001
        "POST",
        http._base_url + path,  # noqa: SLF001
        json=json_body,
        headers=merged,
    )
    return _decode_or_raise(response)

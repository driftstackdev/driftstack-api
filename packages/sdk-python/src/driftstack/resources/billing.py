"""Billing resource — /v1/billing (V-082).

``dict[str, Any]`` typing pending the next regen pass.
"""

from __future__ import annotations

from typing import Any

from driftstack.http import AsyncHttpClient, HttpClient
from driftstack.resources._common import coerce_body


class BillingResource:
    """Synchronous billing resource."""

    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def get_state(self) -> dict[str, Any]:
        """Current subscription mirror + trial-pack state."""
        return self._http.request("GET", "/v1/billing")

    def create_checkout_session(self, body: dict[str, Any]) -> dict[str, Any]:
        """Start a paid-tier subscription Checkout session.

        Body shape: ``{"tier": "...", "billing_period": "monthly"|"annual",
        "success_url"?: ..., "cancel_url"?: ...}``.
        """
        return self._http.request(
            "POST", "/v1/billing/checkout-session", json_body=coerce_body(body)
        )

    def start_trial_pack(self, body: dict[str, Any] | None = None) -> dict[str, Any]:
        """Start the $2.99 trial-pack one-time purchase (per ADR-003)."""
        return self._http.request(
            "POST", "/v1/billing/trial-pack", json_body=coerce_body(body or {})
        )

    def create_portal_session(self) -> dict[str, Any]:
        """Open a Stripe Customer Portal session for the calling account."""
        return self._http.request("POST", "/v1/billing/portal-session")


class AsyncBillingResource:
    """Async billing resource."""

    def __init__(self, http: AsyncHttpClient) -> None:
        self._http = http

    async def get_state(self) -> dict[str, Any]:
        return await self._http.request("GET", "/v1/billing")

    async def create_checkout_session(self, body: dict[str, Any]) -> dict[str, Any]:
        return await self._http.request(
            "POST", "/v1/billing/checkout-session", json_body=coerce_body(body)
        )

    async def start_trial_pack(self, body: dict[str, Any] | None = None) -> dict[str, Any]:
        return await self._http.request(
            "POST", "/v1/billing/trial-pack", json_body=coerce_body(body or {})
        )

    async def create_portal_session(self) -> dict[str, Any]:
        return await self._http.request("POST", "/v1/billing/portal-session")

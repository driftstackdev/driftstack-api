"""Egress resource — /v1/sessions/{id}/proxy + /v1/proxies (planning 133).

Customer-configurable egress (SOCKS5 / OpenVPN / WireGuard). Mirrors
the TypeScript ``EgressResource`` (commit 041ef7a9). Activation gate
on the server returns 503 ``FeatureUnavailable`` until a concrete
backend is wired; the SDK surface is stable so consumers compile
ahead of time.

SECURITY: list/get responses NEVER echo raw secret material
(SOCKS5 password, OpenVPN .ovpn body, WireGuard private_key);
re-enter to update.
"""

from __future__ import annotations

from typing import Any
from urllib.parse import quote

from driftstack.http import AsyncHttpClient, HttpClient
from driftstack.resources._common import coerce_body


class EgressResource:
    """Synchronous egress resource."""

    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def attach_to_session(self, session_id: str, config: dict[str, Any]) -> dict[str, Any]:
        """Attach a customer-configured proxy to an existing session.

        ``config`` MUST conform to ``SessionEgressConfig``:
        ``{"session_id": "...", "proxy": {"type": "...", ...},
        "egress_safeguard": {...}}``. The body's ``session_id`` MUST
        match the URL ``session_id`` or the server rejects with 400.
        """
        return self._http.request(
            "POST",
            f"/v1/sessions/{quote(session_id, safe='')}/proxy",
            json_body=coerce_body(config),
        )

    def get_session_proxy(self, session_id: str) -> dict[str, Any]:
        """Read the session's current proxy summary (type + safeguards)."""
        return self._http.request("GET", f"/v1/sessions/{quote(session_id, safe='')}/proxy")

    def save_proxy(self, body: dict[str, Any]) -> dict[str, Any]:
        """Save a reusable proxy config.

        Body shape: ``{"label": "...", "proxy": {...}}``.
        """
        return self._http.request("POST", "/v1/proxies", json_body=coerce_body(body))

    def list_saved_proxies(self) -> dict[str, Any]:
        """List the calling account's saved proxy summaries."""
        return self._http.request("GET", "/v1/proxies")

    def delete_saved_proxy(self, proxy_id: str) -> None:
        """Delete a saved proxy by id."""
        self._http.request("DELETE", f"/v1/proxies/{quote(proxy_id, safe='')}")


class AsyncEgressResource:
    """Async egress resource."""

    def __init__(self, http: AsyncHttpClient) -> None:
        self._http = http

    async def attach_to_session(
        self, session_id: str, config: dict[str, Any]
    ) -> dict[str, Any]:
        return await self._http.request(
            "POST",
            f"/v1/sessions/{quote(session_id, safe='')}/proxy",
            json_body=coerce_body(config),
        )

    async def get_session_proxy(self, session_id: str) -> dict[str, Any]:
        return await self._http.request(
            "GET", f"/v1/sessions/{quote(session_id, safe='')}/proxy"
        )

    async def save_proxy(self, body: dict[str, Any]) -> dict[str, Any]:
        return await self._http.request("POST", "/v1/proxies", json_body=coerce_body(body))

    async def list_saved_proxies(self) -> dict[str, Any]:
        return await self._http.request("GET", "/v1/proxies")

    async def delete_saved_proxy(self, proxy_id: str) -> None:
        await self._http.request("DELETE", f"/v1/proxies/{quote(proxy_id, safe='')}")

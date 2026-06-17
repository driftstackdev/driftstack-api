"""Egress resource — customer egress surface.

1. Per-session proxy attach (/v1/sessions/{id}/proxy).
2. Saved proxy library — CRUD + a reachability test over the account's
   reusable proxy configs (/v1/account/me/proxies). This is the LIVE
   account-proxies API (shipped) — the same backend the desktop app +
   dashboard use, replacing the older /v1/proxies stub.

Mirrors the TypeScript ``EgressResource``.

SECURITY: the secret-bearing fields (SOCKS5 ``password``, OpenVPN
``config_blob``, WireGuard ``private_key``) are write-only — wrapped
server-side under the account key, never echoed back. List/get return
metadata only (+ ``has_password`` / ``has_secret``).
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

    def list_proxies(self) -> dict[str, Any]:
        """List the calling account's saved proxies (metadata only)."""
        return self._http.request("GET", "/v1/account/me/proxies")

    def create_proxy(self, body: dict[str, Any]) -> dict[str, Any]:
        """Create a saved proxy.

        Flat body: ``{"label", "scheme", "host", "port", "username"?,
        "password"?, "openvpn"?, "wireguard"?}``. The ``password`` / VPN
        secret fields are write-only (wrapped server-side, never echoed).
        """
        return self._http.request("POST", "/v1/account/me/proxies", json_body=coerce_body(body))

    def update_proxy(self, proxy_id: str, body: dict[str, Any]) -> dict[str, Any]:
        """Update a saved proxy. Omitted fields stay; a secret set to
        ``None`` clears it, a string (re)wraps it."""
        return self._http.request(
            "PUT",
            f"/v1/account/me/proxies/{quote(proxy_id, safe='')}",
            json_body=coerce_body(body),
        )

    def delete_proxy(self, proxy_id: str) -> None:
        """Delete a saved proxy by id."""
        self._http.request("DELETE", f"/v1/account/me/proxies/{quote(proxy_id, safe='')}")

    def test_proxy(self, proxy_id: str) -> dict[str, Any]:
        """Server-side reachability probe (SSRF-guarded). 200 either way:
        ``{"ok": true, "latency_ms"}`` or ``{"ok": false, "reason"}``."""
        return self._http.request("POST", f"/v1/account/me/proxies/{quote(proxy_id, safe='')}/test")


class AsyncEgressResource:
    """Async egress resource."""

    def __init__(self, http: AsyncHttpClient) -> None:
        self._http = http

    async def attach_to_session(self, session_id: str, config: dict[str, Any]) -> dict[str, Any]:
        return await self._http.request(
            "POST",
            f"/v1/sessions/{quote(session_id, safe='')}/proxy",
            json_body=coerce_body(config),
        )

    async def get_session_proxy(self, session_id: str) -> dict[str, Any]:
        return await self._http.request("GET", f"/v1/sessions/{quote(session_id, safe='')}/proxy")

    async def list_proxies(self) -> dict[str, Any]:
        return await self._http.request("GET", "/v1/account/me/proxies")

    async def create_proxy(self, body: dict[str, Any]) -> dict[str, Any]:
        return await self._http.request(
            "POST", "/v1/account/me/proxies", json_body=coerce_body(body)
        )

    async def update_proxy(self, proxy_id: str, body: dict[str, Any]) -> dict[str, Any]:
        return await self._http.request(
            "PUT",
            f"/v1/account/me/proxies/{quote(proxy_id, safe='')}",
            json_body=coerce_body(body),
        )

    async def delete_proxy(self, proxy_id: str) -> None:
        await self._http.request("DELETE", f"/v1/account/me/proxies/{quote(proxy_id, safe='')}")

    async def test_proxy(self, proxy_id: str) -> dict[str, Any]:
        return await self._http.request(
            "POST", f"/v1/account/me/proxies/{quote(proxy_id, safe='')}/test"
        )

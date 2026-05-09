"""Account resource — /v1/account/* (V-385 / V-428 / V-434 / V-450).

V-450 extends to cover update-me, avatar upload+clear, web-sessions
list+revoke, and rate-limits read.

Type annotations on the response use ``dict[str, Any]`` pending the
next ``scripts/generate.sh`` regen pass.
"""

from __future__ import annotations

from typing import Any
from urllib.parse import quote

from driftstack.http import AsyncHttpClient, HttpClient
from driftstack.resources._common import coerce_body


class AccountResource:
    """Synchronous account resource."""

    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def me(self) -> dict[str, Any]:
        """Read the calling account's full self-visible state.

        Returns 15+ fields incl. ``id``, ``email``, ``name``, ``tier``,
        ``status``, ``timezone`` (V-352), ``slug`` (V-298a),
        ``region`` (V-298b), ``avatar_url`` (V-352b),
        ``mfa_enrolled`` (V-353h), ``concurrent_session_cap`` /
        ``concurrent_session_active`` / ``profile_cap`` /
        ``profile_count``, and ``teams`` (V-326c).

        Bearer-authenticated; never honors the X-Driftstack-Account
        team-RBAC header (always returns the caller's own account).
        """
        return self._http.request("GET", "/v1/account/me")

    def update_me(self, body: dict[str, Any]) -> dict[str, Any]:
        """V-352 — partial update of the calling account
        (name / timezone / slug / region). Pass ``null`` to clear a
        nullable field; at least one field required.
        """
        return self._http.request("PATCH", "/v1/account/me", json_body=coerce_body(body))

    def upload_avatar(self, body: dict[str, Any]) -> dict[str, Any]:
        """V-352b — upload (or replace) the calling account avatar.
        Body: ``{"data_base64": "...", "content_type": "image/png|jpeg|webp"}``.
        Returns ``{"avatar_url": ..., "content_type": ..., "bytes": ...}``.
        """
        return self._http.request(
            "POST", "/v1/account/me/avatar", json_body=coerce_body(body)
        )

    def clear_avatar(self) -> None:
        """V-352b — clear the avatar pointer."""
        self._http.request("DELETE", "/v1/account/me/avatar")

    def list_web_sessions(self) -> dict[str, Any]:
        """V-355 — list active dashboard sign-ins. The calling
        session is marked with ``current: true``."""
        return self._http.request("GET", "/v1/account/web-sessions")

    def revoke_web_session(self, session_id: str) -> None:
        """V-355 — revoke a single web session by id. Idempotent."""
        self._http.request("DELETE", f"/v1/account/web-sessions/{quote(session_id, safe='')}")

    def revoke_all_other_web_sessions(self) -> None:
        """V-355 — revoke every web session except the calling one."""
        self._http.request("DELETE", "/v1/account/web-sessions")

    def rate_limits(self) -> dict[str, Any]:
        """V-258 — read effective rate-limit config."""
        return self._http.request("GET", "/v1/account/rate-limits")


class AsyncAccountResource:
    """Async account resource."""

    def __init__(self, http: AsyncHttpClient) -> None:
        self._http = http

    async def me(self) -> dict[str, Any]:
        return await self._http.request("GET", "/v1/account/me")

    async def update_me(self, body: dict[str, Any]) -> dict[str, Any]:
        return await self._http.request("PATCH", "/v1/account/me", json_body=coerce_body(body))

    async def upload_avatar(self, body: dict[str, Any]) -> dict[str, Any]:
        return await self._http.request(
            "POST", "/v1/account/me/avatar", json_body=coerce_body(body)
        )

    async def clear_avatar(self) -> None:
        await self._http.request("DELETE", "/v1/account/me/avatar")

    async def list_web_sessions(self) -> dict[str, Any]:
        return await self._http.request("GET", "/v1/account/web-sessions")

    async def revoke_web_session(self, session_id: str) -> None:
        await self._http.request(
            "DELETE", f"/v1/account/web-sessions/{quote(session_id, safe='')}"
        )

    async def revoke_all_other_web_sessions(self) -> None:
        await self._http.request("DELETE", "/v1/account/web-sessions")

    async def rate_limits(self) -> dict[str, Any]:
        return await self._http.request("GET", "/v1/account/rate-limits")

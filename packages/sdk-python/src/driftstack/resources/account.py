"""Account resource — /v1/account/*.

The resource extends to cover update-me, avatar upload+clear, web-sessions
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
        ``status``, ``timezone``, ``slug``,
        ``region``, ``avatar_url``,
        ``mfa_enrolled``, ``concurrent_session_cap`` /
        ``concurrent_session_active`` / ``profile_cap`` /
        ``profile_count``, and ``teams``.

        Bearer-authenticated; never honors the X-Driftstack-Account
        team-RBAC header (always returns the caller's own account).
        """
        return self._http.request("GET", "/v1/account/me")

    def update_me(self, body: dict[str, Any]) -> dict[str, Any]:
        """Partial update of the calling account
        (name / timezone / slug / region). Pass ``null`` to clear a
        nullable field; at least one field required.
        """
        return self._http.request("PATCH", "/v1/account/me", json_body=coerce_body(body))

    def upload_avatar(self, body: dict[str, Any]) -> dict[str, Any]:
        """Upload (or replace) the calling account avatar.
        Body: ``{"data_base64": "...", "content_type": "image/png|jpeg|webp"}``.
        Returns ``{"avatar_url": ..., "content_type": ..., "bytes": ...}``.
        """
        return self._http.request("POST", "/v1/account/me/avatar", json_body=coerce_body(body))

    def clear_avatar(self) -> None:
        """Clear the avatar pointer."""
        self._http.request("DELETE", "/v1/account/me/avatar")

    def list_web_sessions(self) -> dict[str, Any]:
        """List active dashboard sign-ins. The calling
        session is marked with ``current: true``."""
        return self._http.request("GET", "/v1/account/web-sessions")

    def revoke_web_session(self, session_id: str) -> None:
        """Revoke a single web session by id. Idempotent."""
        self._http.request("DELETE", f"/v1/account/web-sessions/{quote(session_id, safe='')}")

    def revoke_all_other_web_sessions(self) -> None:
        """Revoke every web session except the calling one."""
        # `?keep=current` is REQUIRED by the endpoint; without it the server
        # answers 400 "Bulk revoke requires `?keep=current`".
        self._http.request("DELETE", "/v1/account/web-sessions", params={"keep": "current"})

    def rate_limits(self) -> dict[str, Any]:
        """Read effective rate-limit config."""
        return self._http.request("GET", "/v1/account/rate-limits")

    def get_bundled_llm_settings(self) -> dict[str, Any]:
        """Read current bundled-LLM consent + monthly cap."""
        return self._http.request("GET", "/v1/account/me/bundled-llm-settings")

    def update_bundled_llm_settings(self, body: dict[str, Any]) -> dict[str, Any]:
        """Flip consent and/or raise/lower the monthly cap.
        account_owner scope required server-side."""
        return self._http.request(
            "PATCH", "/v1/account/me/bundled-llm-settings", json_body=coerce_body(body)
        )

    def get_bundled_llm_status(self) -> dict[str, Any]:
        """Consent + cap + month-to-date spend +
        remaining headroom, for the "you've used $X of $Y" display."""
        return self._http.request("GET", "/v1/account/me/bundled-llm-status")

    def get_byok_anthropic_key(self) -> dict[str, Any]:
        """AI-CHAT BYOK — metadata only (has_key/set_at/last_used_at); never
        the plaintext key. Broad read or account_owner scope required server-side."""
        return self._http.request("GET", "/v1/account/me/byok-anthropic-key")

    def set_byok_anthropic_key(self, api_key: str) -> dict[str, Any]:
        """AI-CHAT BYOK — set or rotate the account's own Anthropic key.
        account_owner scope required server-side."""
        return self._http.request(
            "PUT", "/v1/account/me/byok-anthropic-key", json_body={"api_key": api_key}
        )

    def clear_byok_anthropic_key(self) -> None:
        """AI-CHAT BYOK — clear the stored key. Idempotent.
        account_owner scope required server-side."""
        self._http.request("DELETE", "/v1/account/me/byok-anthropic-key")

    def test_byok_anthropic_key(self) -> dict[str, Any]:
        """AI-CHAT BYOK — connection test against the stored key, without
        ever echoing it back. account_owner scope required server-side."""
        return self._http.request("POST", "/v1/account/me/byok-anthropic-key/test")


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
        await self._http.request("DELETE", f"/v1/account/web-sessions/{quote(session_id, safe='')}")

    async def revoke_all_other_web_sessions(self) -> None:
        await self._http.request("DELETE", "/v1/account/web-sessions", params={"keep": "current"})

    async def rate_limits(self) -> dict[str, Any]:
        return await self._http.request("GET", "/v1/account/rate-limits")

    async def get_bundled_llm_settings(self) -> dict[str, Any]:
        return await self._http.request("GET", "/v1/account/me/bundled-llm-settings")

    async def update_bundled_llm_settings(self, body: dict[str, Any]) -> dict[str, Any]:
        return await self._http.request(
            "PATCH", "/v1/account/me/bundled-llm-settings", json_body=coerce_body(body)
        )

    async def get_bundled_llm_status(self) -> dict[str, Any]:
        return await self._http.request("GET", "/v1/account/me/bundled-llm-status")

    async def get_byok_anthropic_key(self) -> dict[str, Any]:
        return await self._http.request("GET", "/v1/account/me/byok-anthropic-key")

    async def set_byok_anthropic_key(self, api_key: str) -> dict[str, Any]:
        return await self._http.request(
            "PUT", "/v1/account/me/byok-anthropic-key", json_body={"api_key": api_key}
        )

    async def clear_byok_anthropic_key(self) -> None:
        await self._http.request("DELETE", "/v1/account/me/byok-anthropic-key")

    async def test_byok_anthropic_key(self) -> dict[str, Any]:
        return await self._http.request("POST", "/v1/account/me/byok-anthropic-key/test")

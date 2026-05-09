"""Account resource — /v1/account/* (V-385 / V-428 / V-434).

`me()` reads the calling account's full self-visible state, including
the V-298a slug, V-298b region, V-352b avatar URL, V-353h MFA flag,
and V-326c team memberships beyond the lean AccountSchema.

Type annotations on the response use ``dict[str, Any]`` pending the
next ``scripts/generate.sh`` regen pass — the rich /me response is
not yet typed in the generated Pydantic models because the schema
isn't part of the lean AccountSchema source-of-truth.
"""

from __future__ import annotations

from typing import Any

from driftstack.http import AsyncHttpClient, HttpClient


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


class AsyncAccountResource:
    """Async account resource."""

    def __init__(self, http: AsyncHttpClient) -> None:
        self._http = http

    async def me(self) -> dict[str, Any]:
        return await self._http.request("GET", "/v1/account/me")

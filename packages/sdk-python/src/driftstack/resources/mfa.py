"""MFA enrollment resource — /v1/account/mfa/* (V-353b / V-448).

Pairs with ``client.auth.mfa_challenge`` (login MFA exchange) +
``client.auth.mfa_step_up`` (V-353e step-up gate).

Returns ``dict[str, Any]`` pending the next ``scripts/generate.sh``
regen pass — the rich enrollment shapes will surface as Pydantic
models then.
"""

from __future__ import annotations

from typing import Any

from driftstack.http import AsyncHttpClient, HttpClient
from driftstack.resources._common import coerce_body


class MfaResource:
    """Synchronous MFA enrollment resource."""

    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def status(self) -> dict[str, Any]:
        """Read MFA enrollment state for the calling account."""
        return self._http.request("GET", "/v1/account/mfa")

    def enroll(self) -> dict[str, Any]:
        """Start TOTP enrollment. Returns otpauth URI + base32 secret
        (shown ONCE). Customer scans the URI in their authenticator,
        then calls :meth:`verify` with the first 6-digit code."""
        return self._http.request("POST", "/v1/account/mfa/enroll", json_body={})

    def verify(self, body: dict[str, Any]) -> dict[str, Any]:
        """Confirm enrollment with the first code. Returns 10 single-
        use recovery codes (shown ONCE)."""
        return self._http.request("POST", "/v1/account/mfa/verify", json_body=coerce_body(body))

    def disable(self, body: dict[str, Any]) -> None:
        """Disable MFA. Step-up gated (V-353e); call
        ``client.auth.mfa_step_up`` first if the 15-minute window is
        stale. Recovery codes are invalidated."""
        self._http.request("DELETE", "/v1/account/mfa", json_body=coerce_body(body))

    def regenerate_recovery_codes(self) -> dict[str, Any]:
        """Mint 10 fresh recovery codes. Old codes invalidated."""
        return self._http.request(
            "POST", "/v1/account/mfa/recovery-codes/regenerate", json_body={}
        )


class AsyncMfaResource:
    """Async MFA enrollment resource."""

    def __init__(self, http: AsyncHttpClient) -> None:
        self._http = http

    async def status(self) -> dict[str, Any]:
        return await self._http.request("GET", "/v1/account/mfa")

    async def enroll(self) -> dict[str, Any]:
        return await self._http.request("POST", "/v1/account/mfa/enroll", json_body={})

    async def verify(self, body: dict[str, Any]) -> dict[str, Any]:
        return await self._http.request(
            "POST", "/v1/account/mfa/verify", json_body=coerce_body(body)
        )

    async def disable(self, body: dict[str, Any]) -> None:
        await self._http.request("DELETE", "/v1/account/mfa", json_body=coerce_body(body))

    async def regenerate_recovery_codes(self) -> dict[str, Any]:
        return await self._http.request(
            "POST", "/v1/account/mfa/recovery-codes/regenerate", json_body={}
        )

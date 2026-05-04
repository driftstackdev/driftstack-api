"""Auth-flow resource — /v1/auth/* (V-079).

These endpoints don't require an API key (they ARE the auth gate).
The SDK's HTTP layer always sends the Authorization header; the
server ignores it on these public routes. The resource exists for
ergonomics + type symmetry with the TypeScript SDK.

``dict[str, Any]`` typing pending the next regen pass.
"""

from __future__ import annotations

from typing import Any

from driftstack.http import AsyncHttpClient, HttpClient
from driftstack.resources._common import coerce_body


class AuthResource:
    """Synchronous auth-flow resource."""

    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def signup(self, body: dict[str, Any]) -> dict[str, Any]:
        return self._http.request("POST", "/v1/auth/signup", json_body=coerce_body(body))

    def verify_email(self, body: dict[str, Any]) -> dict[str, Any]:
        return self._http.request("POST", "/v1/auth/verify-email", json_body=coerce_body(body))

    def login(self, body: dict[str, Any]) -> dict[str, Any]:
        return self._http.request("POST", "/v1/auth/login", json_body=coerce_body(body))

    def request_magic_link(self, body: dict[str, Any]) -> dict[str, Any]:
        return self._http.request(
            "POST", "/v1/auth/magic-link/request", json_body=coerce_body(body)
        )

    def consume_magic_link(self, body: dict[str, Any]) -> dict[str, Any]:
        return self._http.request(
            "POST", "/v1/auth/magic-link/consume", json_body=coerce_body(body)
        )

    def request_password_reset(self, body: dict[str, Any]) -> dict[str, Any]:
        return self._http.request(
            "POST", "/v1/auth/password-reset/request", json_body=coerce_body(body)
        )

    def confirm_password_reset(self, body: dict[str, Any]) -> dict[str, Any]:
        return self._http.request(
            "POST", "/v1/auth/password-reset/confirm", json_body=coerce_body(body)
        )

    def refresh(self, body: dict[str, Any]) -> dict[str, Any]:
        return self._http.request("POST", "/v1/auth/refresh", json_body=coerce_body(body))

    def logout(self, body: dict[str, Any]) -> dict[str, Any]:
        return self._http.request("POST", "/v1/auth/logout", json_body=coerce_body(body))


class AsyncAuthResource:
    """Async auth-flow resource."""

    def __init__(self, http: AsyncHttpClient) -> None:
        self._http = http

    async def signup(self, body: dict[str, Any]) -> dict[str, Any]:
        return await self._http.request("POST", "/v1/auth/signup", json_body=coerce_body(body))

    async def verify_email(self, body: dict[str, Any]) -> dict[str, Any]:
        return await self._http.request(
            "POST", "/v1/auth/verify-email", json_body=coerce_body(body)
        )

    async def login(self, body: dict[str, Any]) -> dict[str, Any]:
        return await self._http.request("POST", "/v1/auth/login", json_body=coerce_body(body))

    async def request_magic_link(self, body: dict[str, Any]) -> dict[str, Any]:
        return await self._http.request(
            "POST", "/v1/auth/magic-link/request", json_body=coerce_body(body)
        )

    async def consume_magic_link(self, body: dict[str, Any]) -> dict[str, Any]:
        return await self._http.request(
            "POST", "/v1/auth/magic-link/consume", json_body=coerce_body(body)
        )

    async def request_password_reset(self, body: dict[str, Any]) -> dict[str, Any]:
        return await self._http.request(
            "POST", "/v1/auth/password-reset/request", json_body=coerce_body(body)
        )

    async def confirm_password_reset(self, body: dict[str, Any]) -> dict[str, Any]:
        return await self._http.request(
            "POST", "/v1/auth/password-reset/confirm", json_body=coerce_body(body)
        )

    async def refresh(self, body: dict[str, Any]) -> dict[str, Any]:
        return await self._http.request("POST", "/v1/auth/refresh", json_body=coerce_body(body))

    async def logout(self, body: dict[str, Any]) -> dict[str, Any]:
        return await self._http.request("POST", "/v1/auth/logout", json_body=coerce_body(body))

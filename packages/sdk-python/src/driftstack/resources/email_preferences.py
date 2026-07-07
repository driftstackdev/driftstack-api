"""Email preferences resource — /v1/account/email-preferences (V-204 / V-449).

Per-event opt-in/opt-out toggles for non-critical customer emails.
Critical emails (verification / password-reset / billing-failure)
are not opt-outable; they aren't in the OptOutableEmailEvent enum on purpose.
"""

from __future__ import annotations

from typing import Any

from driftstack.http import AsyncHttpClient, HttpClient
from driftstack.resources._common import coerce_body


class EmailPreferencesResource:
    """Synchronous email-preferences resource."""

    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def list(self) -> dict[str, Any]:
        """Read all opt-out toggles. Defaults opted-in for unset rows."""
        return self._http.request("GET", "/v1/account/email-preferences")

    def set(self, body: dict[str, Any]) -> None:
        """Set opt-in/opt-out for a single event type.

        ``body``: ``{"event_type": "...", "opted_in": True|False}``

        Returns ``None`` — the server replies ``204 No Content``
        with an empty body. Call :meth:`list` afterwards if you
        need the post-update state.
        """
        self._http.request("PUT", "/v1/account/email-preferences", json_body=coerce_body(body))

    def opt_out(self, event_type: str) -> None:
        """Convenience: opt out of a single event type."""
        self.set({"event_type": event_type, "opted_in": False})

    def opt_in(self, event_type: str) -> None:
        """Convenience: opt back in to a single event type."""
        self.set({"event_type": event_type, "opted_in": True})


class AsyncEmailPreferencesResource:
    """Async email-preferences resource."""

    def __init__(self, http: AsyncHttpClient) -> None:
        self._http = http

    async def list(self) -> dict[str, Any]:
        return await self._http.request("GET", "/v1/account/email-preferences")

    async def set(self, body: dict[str, Any]) -> None:
        """Async mirror of :meth:`EmailPreferencesResource.set`.

        Returns ``None`` — the server replies ``204 No Content``.
        """
        await self._http.request(
            "PUT", "/v1/account/email-preferences", json_body=coerce_body(body)
        )

    async def opt_out(self, event_type: str) -> None:
        await self.set({"event_type": event_type, "opted_in": False})

    async def opt_in(self, event_type: str) -> None:
        await self.set({"event_type": event_type, "opted_in": True})

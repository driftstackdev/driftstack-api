"""Top-level Driftstack client.

Two parallel classes — :class:`Driftstack` (sync, ``httpx.Client``)
and :class:`AsyncDriftstack` (async, ``httpx.AsyncClient``). Mirrors
the pattern used by Stripe-Python, OpenAI-Python, Anthropic-Python.

Resource accessors are placeholders in this commit — full
implementations land in PY2. The constructor + auth + transport
plumbing is covered by the smoke tests in this commit.
"""

from __future__ import annotations

from typing import Any

import httpx

from driftstack.http import AsyncHttpClient, HttpClient
from driftstack.retry import RetryConfig

DEFAULT_BASE_URL = "https://api.driftstack.dev"


def _validate_api_key(api_key: str) -> None:
    if not api_key or not isinstance(api_key, str):
        raise TypeError("Driftstack: api_key is required and must be a string")


# ──────────────────────────────────────────────────────────────────────────
# Sync
# ──────────────────────────────────────────────────────────────────────────


class Driftstack:
    """Synchronous Driftstack API client.

    Example::

        from driftstack import Driftstack

        client = Driftstack(api_key="ds_live_…")
        # PY2 will land:
        #   session = client.sessions.create()
        #   client.sessions.navigate(session.id, url="https://example.com")
    """

    def __init__(
        self,
        api_key: str,
        *,
        base_url: str = DEFAULT_BASE_URL,
        timeout_s: float = 30.0,
        retry: RetryConfig | None = None,
        http_client: httpx.Client | None = None,
    ) -> None:
        _validate_api_key(api_key)
        self._http = HttpClient(
            api_key,
            base_url=base_url,
            timeout_s=timeout_s,
            retry=retry,
            client=http_client,
        )

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> Driftstack:
        return self

    def __exit__(self, *_excinfo: Any) -> None:
        self.close()


# ──────────────────────────────────────────────────────────────────────────
# Async
# ──────────────────────────────────────────────────────────────────────────


class AsyncDriftstack:
    """Async Driftstack API client. asyncio-compatible."""

    def __init__(
        self,
        api_key: str,
        *,
        base_url: str = DEFAULT_BASE_URL,
        timeout_s: float = 30.0,
        retry: RetryConfig | None = None,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        _validate_api_key(api_key)
        self._http = AsyncHttpClient(
            api_key,
            base_url=base_url,
            timeout_s=timeout_s,
            retry=retry,
            client=http_client,
        )

    async def aclose(self) -> None:
        await self._http.aclose()

    async def __aenter__(self) -> AsyncDriftstack:
        return self

    async def __aexit__(self, *_excinfo: Any) -> None:
        await self.aclose()

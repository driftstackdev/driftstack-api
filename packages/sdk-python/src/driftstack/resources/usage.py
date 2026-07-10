"""Usage resource — /v1/usage + /v1/usage/series."""

from __future__ import annotations

from typing import Any
from urllib.parse import urlencode

from driftstack._generated.models import UsagePeriodSummary
from driftstack.http import AsyncHttpClient, HttpClient, parse_model


class UsageResource:
    """Synchronous usage resource."""

    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def current_period(self) -> UsagePeriodSummary:
        """Current calendar-month UTC totals + tier quotas."""
        data = self._http.request("GET", "/v1/usage")
        return parse_model(UsagePeriodSummary, data)

    def series(self, *, days: int | None = None) -> dict[str, Any]:
        """V-452 — daily-bucketed usage time series. ``days`` is 1-90;
        default 30. Returns ``{"from_date", "to_date", "buckets"}``.
        """
        path = "/v1/usage/series"
        if days is not None:
            path = f"{path}?{urlencode({'days': days})}"
        return self._http.request("GET", path)


class AsyncUsageResource:
    """Async usage resource."""

    def __init__(self, http: AsyncHttpClient) -> None:
        self._http = http

    async def current_period(self) -> UsagePeriodSummary:
        data = await self._http.request("GET", "/v1/usage")
        return parse_model(UsagePeriodSummary, data)

    async def series(self, *, days: int | None = None) -> dict[str, Any]:
        path = "/v1/usage/series"
        if days is not None:
            path = f"{path}?{urlencode({'days': days})}"
        return await self._http.request("GET", path)

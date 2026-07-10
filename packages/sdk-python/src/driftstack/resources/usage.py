"""Usage resource — /v1/usage + /v1/usage/series."""

from __future__ import annotations

from urllib.parse import urlencode

from pydantic import BaseModel

from driftstack._generated.models import UsagePeriodSummary
from driftstack.http import AsyncHttpClient, HttpClient, parse_model


class UsageDailyBucket(BaseModel):
    """One UTC-day bucket in a :class:`UsageSeriesResponse`.

    Mirrors api-types ``UsageDailyBucketSchema``. ``date`` is
    ``YYYY-MM-DD``; ``totals`` maps each usage-record type to its count
    for the day (zero-usage days are present with an empty ``totals``).
    """

    date: str
    totals: dict[str, int]


class UsageSeriesResponse(BaseModel):
    """Response shape for ``GET /v1/usage/series`` (V-452 / V-170).

    Mirrors api-types ``UsageSeriesResponseSchema`` — TS/Go already
    return this typed. ``to_date`` is exclusive, ``from_date``
    inclusive; ``buckets`` is contiguous, one per UTC day.
    """

    from_date: str
    to_date: str
    buckets: list[UsageDailyBucket]


class UsageResource:
    """Synchronous usage resource."""

    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def current_period(self) -> UsagePeriodSummary:
        """Current calendar-month UTC totals + tier quotas."""
        data = self._http.request("GET", "/v1/usage")
        return parse_model(UsagePeriodSummary, data)

    def series(self, *, days: int | None = None) -> UsageSeriesResponse:
        """V-452 — daily-bucketed usage time series. ``days`` is 1-90;
        default 30. Returns ``{from_date, to_date, buckets}``.
        """
        path = "/v1/usage/series"
        if days is not None:
            path = f"{path}?{urlencode({'days': days})}"
        data = self._http.request("GET", path)
        return parse_model(UsageSeriesResponse, data)


class AsyncUsageResource:
    """Async usage resource."""

    def __init__(self, http: AsyncHttpClient) -> None:
        self._http = http

    async def current_period(self) -> UsagePeriodSummary:
        data = await self._http.request("GET", "/v1/usage")
        return parse_model(UsagePeriodSummary, data)

    async def series(self, *, days: int | None = None) -> UsageSeriesResponse:
        path = "/v1/usage/series"
        if days is not None:
            path = f"{path}?{urlencode({'days': days})}"
        data = await self._http.request("GET", path)
        return parse_model(UsageSeriesResponse, data)

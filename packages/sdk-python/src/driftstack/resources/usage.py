"""Usage resource — /v1/usage."""

from __future__ import annotations

from driftstack._generated.models import UsagePeriodSummary
from driftstack.http import AsyncHttpClient, HttpClient


class UsageResource:
    """Synchronous usage resource."""

    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def current_period(self) -> UsagePeriodSummary:
        """Current calendar-month UTC totals + tier quotas."""
        data = self._http.request("GET", "/v1/usage")
        return UsagePeriodSummary.model_validate(data)


class AsyncUsageResource:
    """Async usage resource."""

    def __init__(self, http: AsyncHttpClient) -> None:
        self._http = http

    async def current_period(self) -> UsagePeriodSummary:
        data = await self._http.request("GET", "/v1/usage")
        return UsagePeriodSummary.model_validate(data)

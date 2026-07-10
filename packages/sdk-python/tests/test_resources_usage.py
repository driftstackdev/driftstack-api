"""Usage resource tests."""

from __future__ import annotations

import httpx
import pytest
import respx

from driftstack import AsyncDriftstack, Driftstack, UsageSeriesResponse
from driftstack._generated.models import UsagePeriodSummary

SERIES: dict = {
    "from_date": "2026-05-01",
    "to_date": "2026-06-01",
    "buckets": [
        {"date": "2026-05-01", "totals": {"navigate": 3}},
        {"date": "2026-05-02", "totals": {}},
    ],
}

API_KEY = "ds_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
BASE = "https://api.test"

USAGE: dict = {
    "period_start": "2026-05-01T00:00:00Z",
    "period_end": "2026-06-01T00:00:00Z",
    "tier": "api_builder",
    "totals": {
        "session_minute": 0,
        "navigate": 0,
        "interact": 0,
        "wait": 0,
        "state_capture": 0,
        "screenshot_capture": 0,
    },
    "quotas": {
        "session_minute": 6000,
        "navigate": 25000,
        "interact": 50000,
        "wait": 50000,
        "state_capture": 25000,
        "screenshot_capture": 12500,
    },
}


def test_sync_current_period() -> None:
    with respx.mock(base_url=BASE) as mock:
        mock.get("/v1/usage").mock(return_value=httpx.Response(200, json=USAGE))
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            result = client.usage.current_period()
        assert isinstance(result, UsagePeriodSummary)
        assert result.tier == "api_builder"


@pytest.mark.asyncio
async def test_async_current_period() -> None:
    with respx.mock(base_url=BASE) as mock:
        mock.get("/v1/usage").mock(return_value=httpx.Response(200, json=USAGE))
        async with AsyncDriftstack(api_key=API_KEY, base_url=BASE) as client:
            result = await client.usage.current_period()
        assert isinstance(result, UsagePeriodSummary)


def test_sync_series_returns_typed_model() -> None:
    captured_paths: list[str] = []
    with respx.mock(base_url=BASE) as mock:
        mock.get(url__regex=r"/v1/usage/series.*").mock(
            side_effect=lambda req: (
                captured_paths.append(req.url.raw_path.decode("ascii"))
                or httpx.Response(200, json=SERIES)
            ),
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            result = client.usage.series(days=2)
        assert isinstance(result, UsageSeriesResponse)
        assert result.from_date == "2026-05-01"
        assert result.buckets[0].totals["navigate"] == 3
        assert result.buckets[1].totals == {}
        assert captured_paths == ["/v1/usage/series?days=2"]


@pytest.mark.asyncio
async def test_async_series_returns_typed_model() -> None:
    with respx.mock(base_url=BASE) as mock:
        mock.get(url__regex=r"/v1/usage/series.*").mock(
            return_value=httpx.Response(200, json=SERIES),
        )
        async with AsyncDriftstack(api_key=API_KEY, base_url=BASE) as client:
            result = await client.usage.series()
        assert isinstance(result, UsageSeriesResponse)
        assert result.to_date == "2026-06-01"

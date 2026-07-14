"""Archetype discovery resource tests."""

from __future__ import annotations

import httpx
import pytest
import respx

from driftstack import AsyncDriftstack, Driftstack, ListArchetypesResponse

API_KEY = "ds_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
BASE = "https://api.test"
CATALOG = {
    "default_archetype_id": "iphone17_ios18_7_safari26_4",
    "data": [
        {
            "id": "iphone17_ios18_7_safari26_4",
            "display_label": "iPhone 17 / iOS 18.7 / Safari 26.4",
            "device": "iPhone 17",
            "ios_version": "18.7",
            "safari_version": "26.4",
            "canvas_family": "B",
            "status": "launch",
            "is_default": True,
        }
    ],
}


def test_sync_list() -> None:
    with respx.mock(base_url=BASE) as mock:
        route = mock.get("/v1/archetypes").mock(return_value=httpx.Response(200, json=CATALOG))
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            result = client.archetypes.list()
    assert route.called
    assert isinstance(result, ListArchetypesResponse)
    assert result.data[0].is_default is True


@pytest.mark.asyncio
async def test_async_list() -> None:
    with respx.mock(base_url=BASE) as mock:
        route = mock.get("/v1/archetypes").mock(return_value=httpx.Response(200, json=CATALOG))
        async with AsyncDriftstack(api_key=API_KEY, base_url=BASE) as client:
            result = await client.archetypes.list()
    assert route.called
    assert result.default_archetype_id == CATALOG["default_archetype_id"]

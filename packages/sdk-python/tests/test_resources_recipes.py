"""Recipes resource tests — Python SDK parity with TS SDK RecipesResource (Q.5.d)."""

from __future__ import annotations

import httpx
import pytest
import respx

from driftstack import AsyncDriftstack, Driftstack

API_KEY = "ds_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
BASE = "https://api.test"


RECIPE_ENVELOPE = {
    "id": "rec_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    "account_id": "acc_1",
    "agent_session_id": "agt_inmem_00000001",
    "label": "login flow snapshot",
    "description": None,
    "intent_count": 3,
    "created_at": "2026-05-17T12:00:00Z",
    "updated_at": "2026-05-17T12:00:00Z",
}


def test_sync_create_label_only() -> None:
    captured: dict[str, object] = {}

    def _capture(request: httpx.Request) -> httpx.Response:
        import json as _json

        captured["body"] = _json.loads(request.content)
        return httpx.Response(201, json=RECIPE_ENVELOPE)

    with respx.mock(base_url=BASE) as mock:
        route = mock.post("/v1/recipes").mock(side_effect=_capture)
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            out = client.recipes.create(
                agent_session_id="agt_inmem_00000001",
                label="login flow snapshot",
            )
        assert out["id"].startswith("rec_")
        assert route.called
        # description is OMITTED when not supplied — clean wire shape.
        assert captured["body"] == {
            "agent_session_id": "agt_inmem_00000001",
            "label": "login flow snapshot",
        }


def test_sync_create_with_description() -> None:
    captured: dict[str, object] = {}

    def _capture(request: httpx.Request) -> httpx.Response:
        import json as _json

        captured["body"] = _json.loads(request.content)
        return httpx.Response(201, json=RECIPE_ENVELOPE)

    with respx.mock(base_url=BASE) as mock:
        route = mock.post("/v1/recipes").mock(side_effect=_capture)
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            client.recipes.create(
                agent_session_id="agt_inmem_00000001",
                label="login flow",
                description="Logs into the test account.",
            )
        assert route.called
        assert captured["body"] == {
            "agent_session_id": "agt_inmem_00000001",
            "label": "login flow",
            "description": "Logs into the test account.",
        }


@pytest.mark.asyncio
async def test_async_create_label_only() -> None:
    with respx.mock(base_url=BASE) as mock:
        route = mock.post("/v1/recipes").mock(
            return_value=httpx.Response(201, json=RECIPE_ENVELOPE),
        )
        async with AsyncDriftstack(api_key=API_KEY, base_url=BASE) as client:
            out = await client.recipes.create(
                agent_session_id="agt_inmem_00000001",
                label="x",
            )
        assert out["id"].startswith("rec_")
        assert route.called


@pytest.mark.asyncio
async def test_async_create_with_description() -> None:
    captured: dict[str, object] = {}

    def _capture(request: httpx.Request) -> httpx.Response:
        import json as _json

        captured["body"] = _json.loads(request.content)
        return httpx.Response(201, json=RECIPE_ENVELOPE)

    with respx.mock(base_url=BASE) as mock:
        route = mock.post("/v1/recipes").mock(side_effect=_capture)
        async with AsyncDriftstack(api_key=API_KEY, base_url=BASE) as client:
            await client.recipes.create(
                agent_session_id="agt_inmem_00000001",
                label="x",
                description="d",
            )
        assert route.called
        assert captured["body"] == {
            "agent_session_id": "agt_inmem_00000001",
            "label": "x",
            "description": "d",
        }

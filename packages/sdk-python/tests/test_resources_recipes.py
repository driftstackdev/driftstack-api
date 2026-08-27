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


SUGGESTION_ENVELOPE = {
    "suggested_label": "Fill form on example.com",
    "suggested_description": "Navigates to example.com, fills 1 field.",
    "intent_count": 4,
}


def test_sync_suggest_url_encodes_the_session_id() -> None:
    with respx.mock(base_url=BASE) as mock:
        route = mock.get(
            "/v1/agent-sessions/agt%2Fwith%20space/recipe-suggestion",
        ).mock(return_value=httpx.Response(200, json=SUGGESTION_ENVELOPE))
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            out = client.recipes.suggest("agt/with space")
        assert route.called
        assert out == SUGGESTION_ENVELOPE


@pytest.mark.asyncio
async def test_async_suggest_url_encodes_the_session_id() -> None:
    with respx.mock(base_url=BASE) as mock:
        route = mock.get(
            "/v1/agent-sessions/agt%2Fwith%20space/recipe-suggestion",
        ).mock(return_value=httpx.Response(200, json=SUGGESTION_ENVELOPE))
        async with AsyncDriftstack(api_key=API_KEY, base_url=BASE) as client:
            out = await client.recipes.suggest("agt/with space")
        assert route.called
        assert out == SUGGESTION_ENVELOPE


# ── Pagination. `list` and `iterate` had no arms at all: the three tests above
# ── covered create and suggest only, so nothing asserted that a caller's limit or
# ── cursor ever reached the wire. The TS SDK carried the identical gap (V-1974).


def test_sync_list_with_no_arguments_sends_no_query() -> None:
    """The absent direction. `list()` must put no key on the URL — an empty
    `?limit=&cursor=` would be a different request, and `?limit=None` a guaranteed
    400."""
    with respx.mock(base_url=BASE) as mock:
        route = mock.get("/v1/recipes").mock(
            return_value=httpx.Response(
                200, json={"data": [], "has_more": False, "next_cursor": None}
            )
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            client.recipes.list()
        assert route.called
        assert dict(route.calls[0].request.url.params) == {}


def test_sync_list_forwards_limit_alone_without_inventing_a_cursor() -> None:
    with respx.mock(base_url=BASE) as mock:
        route = mock.get("/v1/recipes").mock(
            return_value=httpx.Response(
                200, json={"data": [], "has_more": False, "next_cursor": None}
            )
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            client.recipes.list(limit=25)
        assert dict(route.calls[0].request.url.params) == {"limit": "25"}


def test_sync_list_forwards_cursor_alone_without_inventing_a_limit() -> None:
    with respx.mock(base_url=BASE) as mock:
        route = mock.get("/v1/recipes").mock(
            return_value=httpx.Response(
                200, json={"data": [], "has_more": False, "next_cursor": None}
            )
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            client.recipes.list(cursor="cur_2")
        assert dict(route.calls[0].request.url.params) == {"cursor": "cur_2"}


def test_sync_iterate_threads_next_cursor_into_the_following_page() -> None:
    """The load-bearing one: page 2 must carry the cursor page 1 returned. Drop
    that handoff and the walk either repeats page 1 forever or stops early, and a
    count of yielded items alone cannot tell the difference."""
    page_1 = {"data": [dict(RECIPE_ENVELOPE, id="rec_1")], "has_more": True, "next_cursor": "cur_2"}
    page_2 = {"data": [dict(RECIPE_ENVELOPE, id="rec_2")], "has_more": False, "next_cursor": None}
    with respx.mock(base_url=BASE) as mock:
        route = mock.get("/v1/recipes").mock(
            side_effect=[
                httpx.Response(200, json=page_1),
                httpx.Response(200, json=page_2),
            ]
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            out = [r["id"] for r in client.recipes.iterate(limit=1)]
        assert out == ["rec_1", "rec_2"]
        assert dict(route.calls[0].request.url.params) == {"limit": "1"}
        assert dict(route.calls[1].request.url.params) == {"limit": "1", "cursor": "cur_2"}


@pytest.mark.asyncio
async def test_async_list_forwards_cursor_alone() -> None:
    """The async list is a separate method and therefore a separate chance to omit
    the query."""
    with respx.mock(base_url=BASE) as mock:
        route = mock.get("/v1/recipes").mock(
            return_value=httpx.Response(
                200, json={"data": [], "has_more": False, "next_cursor": None}
            )
        )
        async with AsyncDriftstack(api_key=API_KEY, base_url=BASE) as client:
            await client.recipes.list(cursor="cur_2")
        assert dict(route.calls[0].request.url.params) == {"cursor": "cur_2"}


@pytest.mark.asyncio
async def test_async_iterate_threads_next_cursor() -> None:
    page_1 = {"data": [dict(RECIPE_ENVELOPE, id="rec_1")], "has_more": True, "next_cursor": "cur_2"}
    page_2 = {"data": [dict(RECIPE_ENVELOPE, id="rec_2")], "has_more": False, "next_cursor": None}
    with respx.mock(base_url=BASE) as mock:
        route = mock.get("/v1/recipes").mock(
            side_effect=[
                httpx.Response(200, json=page_1),
                httpx.Response(200, json=page_2),
            ]
        )
        async with AsyncDriftstack(api_key=API_KEY, base_url=BASE) as client:
            out = [r["id"] async for r in client.recipes.iterate(limit=1)]
        assert out == ["rec_1", "rec_2"]
        assert dict(route.calls[1].request.url.params) == {"limit": "1", "cursor": "cur_2"}

"""Cursor-pagination iterator tests (V-126).

Sync + async parity tests for ``iterate_paginated`` /
``aiterate_paginated``. Mirrors the TS SDK's V-118 test surface.
"""

from __future__ import annotations

from typing import Any

import pytest

from driftstack.errors import TransportError
from driftstack.pagination import aiterate_paginated, iterate_paginated

# ── sync ──────────────────────────────────────────────────────────────


def test_iterate_paginated_walks_single_page() -> None:
    fetch_calls: list[str | None] = []

    def fetch_page(cursor: str | None) -> dict[str, Any]:
        fetch_calls.append(cursor)
        return {"data": [1, 2, 3], "next_cursor": None}

    collected = list(iterate_paginated(fetch_page))
    assert collected == [1, 2, 3]
    assert fetch_calls == [None]


def test_iterate_paginated_walks_multiple_pages() -> None:
    pages = [
        {"data": ["a", "b"], "next_cursor": "cur_2"},
        {"data": ["c", "d"], "next_cursor": "cur_3"},
        {"data": ["e"], "next_cursor": None},
    ]
    fetch_calls: list[str | None] = []
    page_iter = iter(pages)

    def fetch_page(cursor: str | None) -> dict[str, Any]:
        fetch_calls.append(cursor)
        return next(page_iter)

    collected = list(iterate_paginated(fetch_page))
    assert collected == ["a", "b", "c", "d", "e"]
    assert fetch_calls == [None, "cur_2", "cur_3"]


def test_iterate_paginated_empty_first_page() -> None:
    def fetch_page(cursor: str | None) -> dict[str, Any]:
        return {"data": [], "next_cursor": None}

    assert list(iterate_paginated(fetch_page)) == []


def test_iterate_paginated_intermediate_empty_pages() -> None:
    pages = [
        {"data": [], "next_cursor": "cur_2"},
        {"data": [42], "next_cursor": None},
    ]
    page_iter = iter(pages)

    def fetch_page(cursor: str | None) -> dict[str, Any]:
        return next(page_iter)

    assert list(iterate_paginated(fetch_page)) == [42]


def test_iterate_paginated_propagates_errors() -> None:
    def fetch_page(cursor: str | None) -> dict[str, Any]:
        raise RuntimeError("network blip")

    with pytest.raises(RuntimeError, match="network blip"):
        list(iterate_paginated(fetch_page))


def test_iterate_paginated_consumer_break_stops_fetching() -> None:
    pages = [
        {"data": [1, 2, 3], "next_cursor": "cur_2"},
        {"data": [4, 5, 6], "next_cursor": None},
    ]
    fetch_calls = 0
    page_iter = iter(pages)

    def fetch_page(cursor: str | None) -> dict[str, Any]:
        nonlocal fetch_calls
        fetch_calls += 1
        return next(page_iter)

    for n in iterate_paginated(fetch_page):
        if n == 2:
            break
    # We never advanced past the first page.
    assert fetch_calls == 1


def test_iterate_paginated_supports_attribute_style_pages() -> None:
    """Pydantic-model-style pages (with .data / .next_cursor attributes)
    work via the same helper.
    """

    class FakePage:
        def __init__(self, data: list[int], next_cursor: str | None) -> None:
            self.data = data
            self.next_cursor = next_cursor

    pages = [
        FakePage([10, 20], "cur_2"),
        FakePage([30], None),
    ]
    page_iter = iter(pages)

    def fetch_page(cursor: str | None) -> FakePage:
        return next(page_iter)

    assert list(iterate_paginated(fetch_page)) == [10, 20, 30]


# ── async ─────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_aiterate_paginated_walks_single_page() -> None:
    fetch_calls: list[str | None] = []

    async def fetch_page(cursor: str | None) -> dict[str, Any]:
        fetch_calls.append(cursor)
        return {"data": [1, 2, 3], "next_cursor": None}

    collected: list[int] = []
    async for n in aiterate_paginated(fetch_page):
        collected.append(n)
    assert collected == [1, 2, 3]
    assert fetch_calls == [None]


@pytest.mark.asyncio
async def test_aiterate_paginated_walks_multiple_pages() -> None:
    pages = [
        {"data": ["a", "b"], "next_cursor": "cur_2"},
        {"data": ["c", "d"], "next_cursor": None},
    ]
    fetch_calls: list[str | None] = []
    page_iter = iter(pages)

    async def fetch_page(cursor: str | None) -> dict[str, Any]:
        fetch_calls.append(cursor)
        return next(page_iter)

    collected: list[str] = []
    async for s in aiterate_paginated(fetch_page):
        collected.append(s)
    assert collected == ["a", "b", "c", "d"]
    assert fetch_calls == [None, "cur_2"]


# ── non-advancing-cursor guard (no infinite hang) ─────────────────────


def test_iterate_paginated_raises_on_non_advancing_cursor() -> None:
    """A buggy server returning the same non-null cursor forever must raise,
    not spin forever and hang the caller."""
    fetch_calls: list[str | None] = []

    def fetch_page(cursor: str | None) -> dict[str, Any]:
        fetch_calls.append(cursor)
        return {"data": [1], "next_cursor": "stuck"}

    collected: list[int] = []

    def run() -> None:
        for n in iterate_paginated(fetch_page):
            collected.append(n)

    with pytest.raises(TransportError):
        run()
    # First page yielded, second fetch saw the same cursor and bailed — not ∞.
    assert fetch_calls == [None, "stuck"]
    assert collected == [1, 1]


@pytest.mark.asyncio
async def test_aiterate_paginated_raises_on_non_advancing_cursor() -> None:
    fetch_calls: list[str | None] = []

    async def fetch_page(cursor: str | None) -> dict[str, Any]:
        fetch_calls.append(cursor)
        return {"data": [1], "next_cursor": "stuck"}

    collected: list[int] = []

    async def run() -> None:
        async for n in aiterate_paginated(fetch_page):
            collected.append(n)

    with pytest.raises(TransportError):
        await run()
    assert fetch_calls == [None, "stuck"]
    assert collected == [1, 1]

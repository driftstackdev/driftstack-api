"""Cursor-pagination iterator helpers.

Driftstack list endpoints return
``{ data: [...], next_cursor: str | None }``. Hand-
rolled while-loops over ``next_cursor`` are easy to bug on (cursor
handoff, forgetting to break on null). These helpers wrap the pattern:
sync version returns a regular generator; async version returns an
async generator.

The helpers duck-type the page object — any pydantic ``BaseModel`` with
``.data`` / ``.next_cursor`` attributes works, as does a raw ``dict``
with the same keys. Resources that return raw dictionaries intentionally
retain forward compatibility with additional response fields.

Usage::

    for session in client.sessions.iterate(limit=50):
        ...

    async for session in aclient.sessions.iterate(limit=50):
        ...
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Awaitable, Callable, Iterator
from typing import Any, TypeVar

from .errors import TransportError

T = TypeVar("T")

# Guard message for a non-advancing cursor. Keyset pagination always returns a
# strictly-new next_cursor, so the SAME cursor coming back means a server /
# proxy / cache bug. Without the guard the loop would spin forever and hang the
# caller; we raise a clear error instead of an undiagnosable hang.
_CURSOR_STALL_MSG = "pagination did not advance: the server returned the same cursor twice"


def _extract_data(page: Any) -> list[Any]:
    if isinstance(page, dict):
        return list(page.get("data", []))
    return list(page.data)


def _extract_next_cursor(page: Any) -> str | None:
    if isinstance(page, dict):
        return page.get("next_cursor")
    return page.next_cursor  # type: ignore[no-any-return]


def iterate_paginated(
    fetch_page: Callable[[str | None], Any],
) -> Iterator[T]:
    """Walk every page of a cursor-paginated list endpoint.

    ``fetch_page(None)`` is called for the first page; subsequent calls
    pass the previous page's ``next_cursor``. Stops as soon as
    ``next_cursor`` is None. Errors from ``fetch_page`` propagate.

    Page object can be a pydantic ``BaseModel`` (attributes) or a raw
    ``dict`` (keys); both are duck-typed.
    """
    cursor: str | None = None
    while True:
        page = fetch_page(cursor)
        yield from _extract_data(page)
        next_cursor = _extract_next_cursor(page)
        # An empty-string cursor is "no more pages", not a cursor. Treating it
        # as one restarts the walk: the server decodes an empty cursor as
        # "first page", so the iterator cycles c1 -> "" -> c1 forever, yielding
        # duplicates. The stall guard below cannot catch that, because
        # consecutive cursors differ. sdk-go already stops here.
        if next_cursor is None or next_cursor == "":
            return
        if next_cursor == cursor:
            raise TransportError(_CURSOR_STALL_MSG, status=0)
        cursor = next_cursor


async def aiterate_paginated(
    fetch_page: Callable[[str | None], Awaitable[Any]],
) -> AsyncIterator[T]:
    """Async variant of :func:`iterate_paginated`. Same semantics."""
    cursor: str | None = None
    while True:
        page = await fetch_page(cursor)
        for item in _extract_data(page):
            yield item
        next_cursor = _extract_next_cursor(page)
        # An empty-string cursor is "no more pages", not a cursor. Treating it
        # as one restarts the walk: the server decodes an empty cursor as
        # "first page", so the iterator cycles c1 -> "" -> c1 forever, yielding
        # duplicates. The stall guard below cannot catch that, because
        # consecutive cursors differ. sdk-go already stops here.
        if next_cursor is None or next_cursor == "":
            return
        if next_cursor == cursor:
            raise TransportError(_CURSOR_STALL_MSG, status=0)
        cursor = next_cursor


__all__ = ["iterate_paginated", "aiterate_paginated"]

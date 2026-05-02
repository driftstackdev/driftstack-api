"""Shared helpers for the resource layer.

Customers can pass either a Pydantic model OR a dict to mutating
methods. Both serialise to the same JSON shape on the wire — the
helper here normalises before hand-off to httpx.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel


def coerce_body(body: BaseModel | dict[str, Any] | None) -> dict[str, Any] | None:
    """Convert a Pydantic model or dict to the dict that httpx will JSON-encode.

    ``None`` round-trips as ``None`` so a route with no body works
    without callers having to pass an empty dict.

    Pydantic models go through ``model_dump(mode="json", exclude_none=True)``
    so optional unset fields don't pollute the wire payload (e.g.
    ``CreateSessionRequest()`` shouldn't emit ``{"label": null}``).
    """
    if body is None:
        return None
    if isinstance(body, BaseModel):
        return body.model_dump(mode="json", exclude_none=True)
    return body


def coerce_query(query: BaseModel | dict[str, Any] | None) -> dict[str, Any] | None:
    """Same as :func:`coerce_body` but for query-string params."""
    if query is None:
        return None
    if isinstance(query, BaseModel):
        return query.model_dump(mode="json", exclude_none=True)
    return {k: v for k, v in query.items() if v is not None}

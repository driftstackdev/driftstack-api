"""Public browser archetype discovery — ``GET /v1/archetypes``."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel

from driftstack.http import AsyncHttpClient, HttpClient, parse_model


class PublicArchetype(BaseModel):
    id: str
    display_label: str
    device: str
    ios_version: str
    safari_version: str
    canvas_family: Literal["A", "B"]
    status: Literal["launch", "available"]
    is_default: bool


class ListArchetypesResponse(BaseModel):
    default_archetype_id: str
    data: list[PublicArchetype]


class ArchetypesResource:
    """Synchronous server-authoritative archetype catalog."""

    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def list(self) -> ListArchetypesResponse:
        data = self._http.request("GET", "/v1/archetypes")
        return parse_model(ListArchetypesResponse, data)


class AsyncArchetypesResource:
    """Asynchronous server-authoritative archetype catalog."""

    def __init__(self, http: AsyncHttpClient) -> None:
        self._http = http

    async def list(self) -> ListArchetypesResponse:
        data = await self._http.request("GET", "/v1/archetypes")
        return parse_model(ListArchetypesResponse, data)

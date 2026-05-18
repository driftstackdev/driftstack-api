"""LegalResource tests.

LegalResource (3 sync + 3 async methods) had NO direct test
coverage. The /v1/legal/* surface (V-049 / V-458) is customer-
facing legal-acceptance machinery — ToS / Privacy / DPA / AUP
acceptance tracking — but the HTTP wrappers were untested.

Coverage:
  - documents() → GET /v1/legal/documents
  - required() → GET /v1/legal/required
  - accept({...}) → POST /v1/legal/accept with json body

  + 3 mirror async paths.
"""

from __future__ import annotations

import httpx
import pytest
import respx

from driftstack import AsyncDriftstack, Driftstack

API_KEY = "ds_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
BASE = "https://api.test"


DOCUMENTS_BODY: dict = {
    "data": [
        {"document_key": "tos", "current_version": "1.0", "current_content_hash": "a" * 64},
        {"document_key": "privacy", "current_version": "1.0", "current_content_hash": "b" * 64},
        {"document_key": "dpa", "current_version": "1.0", "current_content_hash": "c" * 64},
        {"document_key": "aup", "current_version": "1.0", "current_content_hash": "d" * 64},
    ],
}


def test_sync_documents_hits_get_legal_documents() -> None:
    with respx.mock(base_url=BASE) as mock:
        route = mock.get("/v1/legal/documents").mock(
            return_value=httpx.Response(200, json=DOCUMENTS_BODY),
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            result = client.legal.documents()
        assert route.called
        assert len(result["data"]) == 4
        assert {d["document_key"] for d in result["data"]} == {"tos", "privacy", "dpa", "aup"}


def test_sync_required_hits_get_legal_required() -> None:
    body = {"data": [{"document_key": "tos", "version": "1.0", "content_hash": "a" * 64}]}
    with respx.mock(base_url=BASE) as mock:
        route = mock.get("/v1/legal/required").mock(
            return_value=httpx.Response(200, json=body),
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            result = client.legal.required()
        assert route.called
        assert result["data"][0]["document_key"] == "tos"


def test_sync_accept_sends_post_with_body() -> None:
    response = {
        "id": "legacc_00000000-0000-4000-8000-000000000001",
        "document_key": "tos",
        "version": "1.0",
        "content_hash": "a" * 64,
        "accepted_at": "2026-05-19T00:00:00Z",
    }
    captured_body: list[bytes] = []
    with respx.mock(base_url=BASE) as mock:
        mock.post("/v1/legal/accept").mock(
            side_effect=lambda req: (
                captured_body.append(req.content) or httpx.Response(201, json=response)
            ),
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            result = client.legal.accept(
                {"document_key": "tos", "version": "1.0", "content_hash": "a" * 64},
            )
        assert result["id"].startswith("legacc_")
        assert result["document_key"] == "tos"
        # Body forwarded verbatim — all 3 fields land on the wire.
        assert b'"document_key":"tos"' in captured_body[0]
        assert b'"version":"1.0"' in captured_body[0]
        assert b'"content_hash":"' + b"a" * 64 + b'"' in captured_body[0]


@pytest.mark.asyncio
async def test_async_documents() -> None:
    with respx.mock(base_url=BASE) as mock:
        mock.get("/v1/legal/documents").mock(
            return_value=httpx.Response(200, json=DOCUMENTS_BODY),
        )
        async with AsyncDriftstack(api_key=API_KEY, base_url=BASE) as client:
            result = await client.legal.documents()
        assert len(result["data"]) == 4


@pytest.mark.asyncio
async def test_async_required() -> None:
    body = {"data": []}
    with respx.mock(base_url=BASE) as mock:
        mock.get("/v1/legal/required").mock(return_value=httpx.Response(200, json=body))
        async with AsyncDriftstack(api_key=API_KEY, base_url=BASE) as client:
            result = await client.legal.required()
        assert result["data"] == []


@pytest.mark.asyncio
async def test_async_accept() -> None:
    response = {
        "id": "legacc_xyz",
        "document_key": "privacy",
        "version": "1.0",
        "content_hash": "b" * 64,
        "accepted_at": "2026-05-19T00:00:00Z",
    }
    with respx.mock(base_url=BASE) as mock:
        mock.post("/v1/legal/accept").mock(return_value=httpx.Response(201, json=response))
        async with AsyncDriftstack(api_key=API_KEY, base_url=BASE) as client:
            result = await client.legal.accept(
                {"document_key": "privacy", "version": "1.0", "content_hash": "b" * 64},
            )
        assert result["document_key"] == "privacy"

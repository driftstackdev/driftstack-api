"""AuditLogResource tests.

AuditLogResource (3 sync + 3 async methods) had NO direct test
coverage. The /v1/account/audit-log surface (V-216 + V-449) is
customer-facing compliance tooling — but the HTTP wrappers were
untested.

Coverage:
  - list() → GET /v1/account/audit-log (no qs)
  - list(limit=, cursor=, action=) → GET with query-string params
  - list(limit=None, cursor=None) → no qs (None values skipped)
  - iterate(action=) → paginates via list()
  - export() → GET /v1/account/audit-log/export?format=json (V-462)

  + 3 mirror async paths.

Key invariants pinned:
  - _qs() drops None values (so absent kwargs don't show as
    `?limit=None` on the wire)
  - export() pins `?format=json` (the CSV branch is intentionally
    not exposed via the SDK; customers needing CSV hit the URL
    directly with their bearer)
"""

from __future__ import annotations

import httpx
import pytest
import respx

from driftstack import AsyncDriftstack, Driftstack

API_KEY = "ds_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
BASE = "https://api.test"

AUDIT_ENTRY: dict = {
    "id": "audit_00000000-0000-4000-8000-000000000001",
    "account_id": "acc_00000000-0000-4000-8000-000000000001",
    "actor_type": "customer",
    "actor_account_id": "acc_00000000-0000-4000-8000-000000000001",
    "actor_key_id": "key_xxx",
    "action": "api_key.minted",
    "target_resource_id": "key_xxx",
    "payload": None,
    "ip_address": None,
    "user_agent": None,
    "timestamp": "2026-05-19T00:00:00Z",
}


def test_sync_list_no_args_sends_bare_path() -> None:
    captured_paths: list[str] = []
    with respx.mock(base_url=BASE) as mock:
        mock.get(url__regex=r"/v1/account/audit-log.*").mock(
            side_effect=lambda req: (
                captured_paths.append(req.url.raw_path.decode("ascii"))
                or httpx.Response(200, json={"data": [], "next_cursor": None})
            ),
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            client.audit_log.list()
        # No kwargs → no qs.
        assert captured_paths == ["/v1/account/audit-log"]


def test_sync_list_with_kwargs_emits_query_string() -> None:
    captured_paths: list[str] = []
    with respx.mock(base_url=BASE) as mock:
        mock.get(url__regex=r"/v1/account/audit-log.*").mock(
            side_effect=lambda req: (
                captured_paths.append(req.url.raw_path.decode("ascii"))
                or httpx.Response(200, json={"data": [AUDIT_ENTRY], "next_cursor": None})
            ),
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            result = client.audit_log.list(
                limit=50,
                cursor="ctok_abc",
                action="api_key.minted",
            )
        assert result["data"][0]["action"] == "api_key.minted"
        # Order is dict-insertion order: limit, cursor, action.
        assert captured_paths == [
            "/v1/account/audit-log?limit=50&cursor=ctok_abc&action=api_key.minted",
        ]


def test_sync_list_drops_none_values_from_qs() -> None:
    # If a caller threads `action=None`, that key MUST NOT appear
    # on the wire — otherwise the server's Zod parser would see
    # `?action=None` and reject it as a malformed filter.
    captured_paths: list[str] = []
    with respx.mock(base_url=BASE) as mock:
        mock.get(url__regex=r"/v1/account/audit-log.*").mock(
            side_effect=lambda req: (
                captured_paths.append(req.url.raw_path.decode("ascii"))
                or httpx.Response(200, json={"data": [], "next_cursor": None})
            ),
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            client.audit_log.list(limit=20, action=None)
        # action=None dropped; only limit on the wire.
        assert captured_paths == ["/v1/account/audit-log?limit=20"]


def test_sync_iterate_walks_pages_via_cursor() -> None:
    # 2-page iterate: first page returns next_cursor='c1', second
    # returns next_cursor=None. iterate_paginated should follow.
    page1 = {"data": [{**AUDIT_ENTRY, "id": "audit_1"}], "next_cursor": "c1"}
    page2 = {"data": [{**AUDIT_ENTRY, "id": "audit_2"}], "next_cursor": None}
    with respx.mock(base_url=BASE) as mock:
        mock.get(url__regex=r"/v1/account/audit-log\?limit=1$").mock(
            return_value=httpx.Response(200, json=page1),
        )
        mock.get(url__regex=r"/v1/account/audit-log\?limit=1&cursor=c1$").mock(
            return_value=httpx.Response(200, json=page2),
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            entries = list(client.audit_log.iterate(limit=1))
        assert [e["id"] for e in entries] == ["audit_1", "audit_2"]


def test_sync_export_pins_format_json_qs() -> None:
    # The Python SDK intentionally only exposes the JSON-envelope
    # branch (CSV is browser-driven). Pin the `?format=json` so
    # drift to `?format=csv` (or missing qs) trips this test.
    captured_paths: list[str] = []
    with respx.mock(base_url=BASE) as mock:
        mock.get(url__regex=r"/v1/account/audit-log/export.*").mock(
            side_effect=lambda req: (
                captured_paths.append(req.url.raw_path.decode("ascii"))
                or httpx.Response(
                    200,
                    json={
                        "generated_at": "2026-05-19T00:00:00Z",
                        "account_id": "acc_x",
                        "row_count": 1,
                        "truncated": False,
                        "data": [AUDIT_ENTRY],
                    },
                )
            ),
        )
        with Driftstack(api_key=API_KEY, base_url=BASE) as client:
            result = client.audit_log.export()
        assert captured_paths == ["/v1/account/audit-log/export?format=json"]
        assert result["row_count"] == 1
        assert result["truncated"] is False


@pytest.mark.asyncio
async def test_async_list_no_args() -> None:
    captured_paths: list[str] = []
    with respx.mock(base_url=BASE) as mock:
        mock.get(url__regex=r"/v1/account/audit-log.*").mock(
            side_effect=lambda req: (
                captured_paths.append(req.url.raw_path.decode("ascii"))
                or httpx.Response(200, json={"data": [], "next_cursor": None})
            ),
        )
        async with AsyncDriftstack(api_key=API_KEY, base_url=BASE) as client:
            await client.audit_log.list()
        assert captured_paths == ["/v1/account/audit-log"]


@pytest.mark.asyncio
async def test_async_list_with_kwargs() -> None:
    captured_paths: list[str] = []
    with respx.mock(base_url=BASE) as mock:
        mock.get(url__regex=r"/v1/account/audit-log.*").mock(
            side_effect=lambda req: (
                captured_paths.append(req.url.raw_path.decode("ascii"))
                or httpx.Response(200, json={"data": [], "next_cursor": None})
            ),
        )
        async with AsyncDriftstack(api_key=API_KEY, base_url=BASE) as client:
            await client.audit_log.list(limit=10, action="account.login")
        assert captured_paths == [
            "/v1/account/audit-log?limit=10&action=account.login",
        ]


@pytest.mark.asyncio
async def test_async_iterate_walks_pages() -> None:
    page1 = {"data": [{**AUDIT_ENTRY, "id": "audit_a"}], "next_cursor": "c2"}
    page2 = {"data": [{**AUDIT_ENTRY, "id": "audit_b"}], "next_cursor": None}
    with respx.mock(base_url=BASE) as mock:
        mock.get(url__regex=r"/v1/account/audit-log\?limit=1$").mock(
            return_value=httpx.Response(200, json=page1),
        )
        mock.get(url__regex=r"/v1/account/audit-log\?limit=1&cursor=c2$").mock(
            return_value=httpx.Response(200, json=page2),
        )
        async with AsyncDriftstack(api_key=API_KEY, base_url=BASE) as client:
            entries = []
            async for e in client.audit_log.iterate(limit=1):
                entries.append(e)
        assert [e["id"] for e in entries] == ["audit_a", "audit_b"]


@pytest.mark.asyncio
async def test_async_export() -> None:
    captured_paths: list[str] = []
    with respx.mock(base_url=BASE) as mock:
        mock.get(url__regex=r"/v1/account/audit-log/export.*").mock(
            side_effect=lambda req: (
                captured_paths.append(req.url.raw_path.decode("ascii"))
                or httpx.Response(
                    200,
                    json={
                        "generated_at": "2026-05-19T00:00:00Z",
                        "account_id": "acc_x",
                        "row_count": 0,
                        "truncated": False,
                        "data": [],
                    },
                )
            ),
        )
        async with AsyncDriftstack(api_key=API_KEY, base_url=BASE) as client:
            result = await client.audit_log.export()
        assert captured_paths == ["/v1/account/audit-log/export?format=json"]
        assert result["data"] == []

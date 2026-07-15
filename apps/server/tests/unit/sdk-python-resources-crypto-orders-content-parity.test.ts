// W584.B (W654-deepened) — drift guard for packages/sdk-python/src/
// driftstack/resources/crypto_orders.py. V-666 crypto-orders Python
// parity.
//
// W654 splits the original 8 it() blocks into 19 focused per-concept
// blocks + pins previously-implicit invariants:
//
//   • V-666.AO Idempotency-Key (audit 2026-06-23 — the escape hatch
//     was REMOVED) — create_checkout accepts an optional
//     idempotency_key kwarg, conditionally injected via the standard
//     request(extra_headers=...) path (request() now accepts headers).
//     Pinned: the kwarg keyword name, the header name forwarded
//     ("idempotency-key" lowercase), the conditional injection, and a
//     negative guard that the old _post_with_headers / _apost_with_headers
//     / direct httpx._client reach DO NOT come back. Retry-safety is the
//     request-agnostic gate in the HTTP layer (a keyless create is sent
//     once), NOT a per-resource bypass.
//   • V-666.BU cursor walker — the envelope keys rows off "orders" NOT
//     the standard "data", so iterate ADAPTS the orders→data shape in a
//     _fetch closure and DELEGATES to the shared iterate_paginated /
//     aiterate_paginated helper (inheriting its non-advancing-cursor
//     guard). Pinned because drift to dropping the adapter would iterate
//     an empty list (the data key doesn't exist on this envelope).
//   • iterate "callers MUST NOT pass cursor" framing pinned — the
//     internal cursor handoff is private; exposing it would let
//     callers accidentally skip pages.
//   • "Crypto payments are non-refundable" framing pinned — this
//     is the buyer's-remorse warning that justifies the V-666.J
//     self-service cancel-while-pending flow (the only out).
//   • Per-verb blocks for the 8-verb surface (quote / create_
//     checkout / list / iterate / get / update_note / cancel /
//     receipt) — each with V-anchor + wire path + quote(safe='')
//     URL-escape on per-id sub-routes.
//   • Escape-hatch REMOVAL pinned — the old _post_with_headers /
//     _apost_with_headers helpers (which late-imported _build_headers +
//     _decode_or_raise and drove http._client directly) are gone; a
//     negative-assertion block guards that the bypass can't return,
//     since it was a non-idempotent retry surface the audit closed.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/resources/crypto_orders.py');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W584.B packages/sdk-python/src/driftstack/resources/crypto_orders.py content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path + module docstring V-666 anchor + customer-facing-only framing (admin endpoints NOT exposed here)', () => {
    expect(existsSync(LIB)).toBe(true);
    expect(body).toMatch(/^"""Crypto-orders resource — \/v1\/billing\/crypto-\* \(V-666\)\.\n/);
    expect(body).toMatch(
      /Customer-facing only; admin endpoints aren't exposed here \(use the\s*\nOpenAPI spec at ``\/openapi\.json`` directly\)\./,
    );
  });

  it('V-666.AO Idempotency-Key kwarg framing pinned per-line: kwarg name + header forwarded + "retries don\'t mint duplicate orders" claim. Load-bearing because customers driving the SDK from a retry-on-failure pattern would otherwise mint multiple charges for one intent.', () => {
    expect(body).toMatch(
      /V-666\.AO — ``create_checkout`` accepts an ``idempotency_key`` keyword\s*\nthat's forwarded as the ``Idempotency-Key`` header so retries don't\s*\nmint duplicate orders\./,
    );
  });

  it('V-666.BU cursor walker framing — the orders-keyed envelope is pinned + the rationale that iterate() ADAPTS the orders→data shape and DELEGATES to the shared iterate_paginated helper (so it inherits the non-advancing-cursor guard every other list has). Drift to dropping the adapter (handing the raw orders envelope to the data-keyed helper) would silently iterate an empty list.', () => {
    expect(body).toMatch(
      /V-666\.BU — ``list`` accepts ``cursor`` for cursor-pagination;\s*\n``iterate`` walks every page until ``next_cursor`` is null\. The\s*\nresponse envelope keys its rows off ``orders`` \(not the standard\s*\n``data``\), so iteration adapts the page shape and delegates to the\s*\nshared :func:`iterate_paginated` helper — that way this endpoint gets\s*\nthe same non-advancing-cursor guard as every other list\./,
    );
  });

  it('CRITICAL "Crypto payments are non-refundable" framing pinned. This is the buyer\'s-remorse warning that justifies why V-666.J self-service cancel-while-pending exists (it\'s the ONLY out — once paid, no refund). Drift to dropping the framing would lose the legal disclosure surface.', () => {
    expect(body).toMatch(/Crypto payments are non-refundable\./);
  });

  it("Imports — __future__ annotations + AsyncIterator/Iterator + urllib.parse quote+urlencode + 2-class HTTP client + coerce_body. urlencode imported because _qs builds the query string manually (the SDK doesn't use httpx's params= for this resource because order-of-params matters for response cache keys).", () => {
    expect(body).toMatch(/^from __future__ import annotations$/m);
    expect(body).toMatch(/^from collections\.abc import AsyncIterator, Iterator$/m);
    expect(body).toMatch(/^from typing import Any$/m);
    expect(body).toMatch(/^from urllib\.parse import quote, urlencode$/m);
    expect(body).toMatch(/^from driftstack\.http import AsyncHttpClient, HttpClient$/m);
    expect(body).toMatch(/^from driftstack\.resources\._common import coerce_body$/m);
  });

  it('_qs helper — skip-None + urlencode. CRITICAL: None values DROPPED from the query string (not serialized as "limit=None"). Drift to including None would send the literal string "None" as a query value, breaking server-side parsing.', () => {
    expect(body).toMatch(
      /^def _qs\(query: dict\[str, Any\]\) -> str:\s*\n\s*items: list\[tuple\[str, str\]\] = \[\]\s*\n\s*for k, v in query\.items\(\):\s*\n\s*if v is None:\s*\n\s*continue\s*\n\s*items\.append\(\(k, str\(v\)\)\)\s*\n\s*return urlencode\(items\)$/m,
    );
  });

  it('_list_path helper — 5 keyword-only filters (limit/status/cursor/created_after/created_before) + cursor handed in alongside the user-facing filters (V-666.BU). Returns either "/v1/billing/crypto-orders?qs" OR bare "/v1/billing/crypto-orders" when qs is empty. The conditional `?` matters — appending an empty `?` to the URL would break some HTTP clients\' caching keys.', () => {
    expect(body).toMatch(
      /^def _list_path\(\s*\n\s*\*,\s*\n\s*limit: int \| None,\s*\n\s*status: str \| None,\s*\n\s*cursor: str \| None,\s*\n\s*created_after: str \| None,\s*\n\s*created_before: str \| None,\s*\n\) -> str:\s*\n\s*qs = _qs\(\s*\n\s*\{\s*\n\s*"limit": limit,\s*\n\s*"status": status,\s*\n\s*"cursor": cursor,\s*\n\s*"created_after": created_after,\s*\n\s*"created_before": created_before,\s*\n\s*\}\s*\n\s*\)\s*\n\s*return "\/v1\/billing\/crypto-orders" \+ \(f"\?\{qs\}" if qs else ""\)$/m,
    );
  });

  it('CryptoOrdersResource (sync) class declaration + __init__(http: HttpClient). Stateless wrapper.', () => {
    expect(body).toMatch(/^class CryptoOrdersResource:$/m);
    expect(body).toMatch(/^ {4}"""Synchronous crypto-orders resource\."""$/m);
    expect(body).toMatch(
      /^ {4}def __init__\(self, http: HttpClient\) -> None:\s*\n\s*self\._http = http$/m,
    );
  });

  it('Sync quote — V-666.H POST /v1/billing/crypto-checkout/quote. Authoritative fiat-price preview without minting an order.', () => {
    expect(body).toMatch(
      /def quote\(self, body: dict\[str, Any\]\) -> dict\[str, Any\]:\s*\n\s*"""V-666\.H — preview the authoritative fiat price without minting an order\."""\s*\n\s*return self\._http\.request\(\s*\n\s*"POST",\s*\n\s*"\/v1\/billing\/crypto-checkout\/quote",\s*\n\s*json_body=coerce_body\(body\),\s*\n\s*\)/,
    );
  });

  it('Sync create_checkout — V-666.C POST /v1/billing/crypto-checkout with optional idempotency_key keyword-only kwarg. SINGLE path now (audit 2026-06-23 — the _post_with_headers escape hatch was removed): request(..., extra_headers=({"idempotency-key": key} if key is not None else None)) — the header is conditionally injected. Retry-safety lives in the HTTP layer: a keyed create may retry transient failures safely; a keyless one is sent exactly once (no double-submit). Drift to dropping the conditional would always-send the header (overhead + server dedup confusion) or lose it.', () => {
    expect(body).toMatch(
      /def create_checkout\(\s*\n\s*self,\s*\n\s*body: dict\[str, Any\],\s*\n\s*\*,\s*\n\s*idempotency_key: str \| None = None,\s*\n\s*\) -> dict\[str, Any\]:\s*\n\s*"""V-666\.C — mint a new crypto order\.\s*\n\s*\n\s*Pass ``idempotency_key`` to dedupe network retries — the server\s*\n\s*returns the original order on replay, never a second one\. With a\s*\n\s*key the HTTP layer is allowed to retry transient failures safely;\s*\n\s*without one this create is sent exactly once \(no double-submit\)\.\s*\n\s*"""/,
    );
    expect(body).toMatch(
      /return self\._http\.request\(\s*\n\s*"POST",\s*\n\s*"\/v1\/billing\/crypto-checkout",\s*\n\s*json_body=coerce_body\(body\),\s*\n\s*extra_headers=\(\s*\n\s*\{"idempotency-key": idempotency_key\} if idempotency_key is not None else None\s*\n\s*\),\s*\n\s*\)/,
    );
  });

  it('Sync list — V-666.G/.BR/.BU/.BX GET with 5 keyword-only filters + "newest-first" ordering pinned. Drift to oldest-first would silently invert the customer\'s mental model (most-recent orders first is what dashboards show).', () => {
    expect(body).toMatch(
      /def list\(\s*\n\s*self,\s*\n\s*\*,\s*\n\s*limit: int \| None = None,\s*\n\s*status: str \| None = None,\s*\n\s*cursor: str \| None = None,\s*\n\s*created_after: str \| None = None,\s*\n\s*created_before: str \| None = None,\s*\n\s*\) -> dict\[str, Any\]:\s*\n\s*"""V-666\.G \/ \.BR \/ \.BU \/ \.BX — list the caller's crypto orders newest-first\."""/,
    );
    expect(body).toMatch(
      /return self\._http\.request\(\s*\n\s*"GET",\s*\n\s*_list_path\(\s*\n\s*limit=limit,\s*\n\s*status=status,\s*\n\s*cursor=cursor,\s*\n\s*created_after=created_after,\s*\n\s*created_before=created_before,\s*\n\s*\),\s*\n\s*\)/,
    );
  });

  it('Sync iterate — V-666.BU now ADAPTS the orders→data envelope in a _fetch closure and DELEGATES to the shared iterate_paginated helper (audit 2026-06-23 — was a hand-rolled _walk loop), so it inherits the non-advancing-cursor guard. CRITICAL invariants: (1) "callers MUST NOT pass cursor" — internal-only handoff; (2) the adapter maps `page.get("orders", [])` onto the helper\'s "data" key (envelope-shape bridge) + forwards next_cursor; (3) the shared helper terminates cleanly on a null/non-advancing cursor (drift to dropping the adapter would iterate an empty list).', () => {
    expect(body).toMatch(
      /def iterate\(\s*\n\s*self,\s*\n\s*\*,\s*\n\s*limit: int \| None = None,\s*\n\s*status: str \| None = None,\s*\n\s*created_after: str \| None = None,\s*\n\s*created_before: str \| None = None,\s*\n\s*\) -> Iterator\[dict\[str, Any\]\]:\s*\n\s*"""V-666\.BU — lazily walk every order across cursor pages\./,
    );
    expect(body).toMatch(
      /Yields envelopes one at a time so the caller can break early\.\s*\n\s*Cursor handoff is managed internally; callers MUST NOT pass\s*\n\s*``cursor`` to this method \(use :meth:`list` if you need a\s*\n\s*single page\)\./,
    );
    // The orders→data adapter closure (bridges the envelope shape) + delegation
    // to the shared guarded paginator.
    expect(body).toMatch(
      /def _fetch\(cursor: str \| None\) -> dict\[str, Any\]:\s*\n\s*page = self\.list\(\s*\n\s*limit=limit,\s*\n\s*status=status,\s*\n\s*cursor=cursor,\s*\n\s*created_after=created_after,\s*\n\s*created_before=created_before,\s*\n\s*\)[\s\S]*?return \{"data": page\.get\("orders", \[\]\), "next_cursor": page\.get\("next_cursor"\)\}/,
    );
    expect(body).toMatch(/return iterate_paginated\(_fetch\)/);
  });

  it("Sync get — V-666.G GET /v1/billing/crypto-orders/{quote(order_id, safe='')} returns single order envelope. URL-escape quotes the order_id with NO safe-chars — drift to safe='/' would let \"abc/../../admin\" traverse into the admin namespace.", () => {
    expect(body).toMatch(
      /def get\(self, order_id: str\) -> dict\[str, Any\]:\s*\n\s*"""V-666\.G — read a single order envelope\."""\s*\n\s*return self\._http\.request\(\s*\n\s*"GET",\s*\n\s*f"\/v1\/billing\/crypto-orders\/\{quote\(order_id, safe=''\)\}",\s*\n\s*\)/,
    );
  });

  it('Sync update_note — V-666.Q PATCH /v1/billing/crypto-orders/{quoted_id}. Customer-facing free-text note (drift to admin-only would break the dashboard\'s "add reference" feature). Note is unstructured so PATCH is the right verb — drift to PUT would force full replacement instead of partial update.', () => {
    expect(body).toMatch(
      /def update_note\(self, order_id: str, body: dict\[str, Any\]\) -> dict\[str, Any\]:\s*\n\s*"""V-666\.Q — update the customer-facing free-text note\."""\s*\n\s*return self\._http\.request\(\s*\n\s*"PATCH",\s*\n\s*f"\/v1\/billing\/crypto-orders\/\{quote\(order_id, safe=''\)\}",\s*\n\s*json_body=coerce_body\(body\),\s*\n\s*\)/,
    );
  });

  it('Sync cancel — V-666.J POST /v1/billing/crypto-orders/{quoted_id}/cancel WITH NO body. CRITICAL: "abandon a pending order (self-service)". This is the ONLY out for non-refundable crypto charges — drift to requiring a body or admin-only access would break the buyer\'s last-resort UX. POST not DELETE because it transitions order state, not deletes the row (audit-log preservation).', () => {
    expect(body).toMatch(
      /def cancel\(self, order_id: str\) -> dict\[str, Any\]:\s*\n\s*"""V-666\.J — abandon a pending order \(self-service\)\."""\s*\n\s*return self\._http\.request\(\s*\n\s*"POST",\s*\n\s*f"\/v1\/billing\/crypto-orders\/\{quote\(order_id, safe=''\)\}\/cancel",\s*\n\s*\)/,
    );
  });

  it('Sync receipt — V-666.M GET /v1/billing/crypto-orders/{quoted_id}/receipt. Returns the JSON receipt (NOT the PDF — PDF download lives elsewhere). JSON is what the dashboard uses for the receipt-detail view; drift to returning a binary blob would break content-negotiation.', () => {
    expect(body).toMatch(
      /def receipt\(self, order_id: str\) -> dict\[str, Any\]:\s*\n\s*"""V-666\.M — fetch the JSON receipt\."""\s*\n\s*return self\._http\.request\(\s*\n\s*"GET",\s*\n\s*f"\/v1\/billing\/crypto-orders\/\{quote\(order_id, safe=''\)\}\/receipt",\s*\n\s*\)/,
    );
  });

  it('AsyncCryptoOrdersResource — class declaration + __init__(http: AsyncHttpClient) + async mirror. create_checkout async uses request(extra_headers=...) with the conditional idempotency-key injection, mirroring sync (the audit removed the _apost_with_headers escape hatch). iterate stays a SYNC def returning AsyncIterator[dict[str, Any]] via an async _fetch adapter (orders→data) delegating to the shared aiterate_paginated helper.', () => {
    expect(body).toMatch(/^class AsyncCryptoOrdersResource:$/m);
    expect(body).toMatch(/^ {4}"""Async mirror of :class:`CryptoOrdersResource`\."""$/m);
    expect(body).toMatch(
      /^ {4}def __init__\(self, http: AsyncHttpClient\) -> None:\s*\n\s*self\._http = http$/m,
    );
    // async create_checkout — request(extra_headers conditional), mirroring sync.
    expect(body).toMatch(
      /return await self\._http\.request\(\s*\n\s*"POST",\s*\n\s*"\/v1\/billing\/crypto-checkout",\s*\n\s*json_body=coerce_body\(body\),\s*\n\s*extra_headers=\(\s*\n\s*\{"idempotency-key": idempotency_key\} if idempotency_key is not None else None\s*\n\s*\),\s*\n\s*\)/,
    );
    // iterate is a sync def returning an AsyncIterator.
    expect(body).toMatch(
      /def iterate\(\s*\n\s*self,\s*\n\s*\*,\s*\n\s*limit: int \| None = None,\s*\n\s*status: str \| None = None,\s*\n\s*created_after: str \| None = None,\s*\n\s*created_before: str \| None = None,\s*\n\s*\) -> AsyncIterator\[dict\[str, Any\]\]:/,
    );
    // async _fetch adapter (orders→data) + delegation to the shared async paginator.
    expect(body).toMatch(
      /async def _fetch\(cursor: str \| None\) -> dict\[str, Any\]:[\s\S]*?return \{"data": page\.get\("orders", \[\]\), "next_cursor": page\.get\("next_cursor"\)\}\s*\n\s*\n\s*return aiterate_paginated\(_fetch\)/,
    );
  });

  it('Idempotency-Key escape hatch REMOVED (audit 2026-06-23) — create_checkout now goes through the standard request(extra_headers=...) path, so the resource no longer reaches into httpx._client directly. CRITICAL negative invariants (the bypass MUST NOT come back): no _post_with_headers / _apost_with_headers helpers, no _build_headers / _decode_or_raise SLF001 internal reach, no direct http._client.request. The retry-SAFETY gate in the HTTP layer (request-agnostic) — NOT a per-resource bypass — is what keeps a keyless create single-shot. Positive: the conditional idempotency-key injection appears in BOTH sync + async create_checkout.', () => {
    // The escape hatch + its internal-reach are gone — drift back to it would
    // re-introduce a non-idempotent retry surface the audit closed.
    expect(body).not.toMatch(/_post_with_headers/);
    expect(body).not.toMatch(/_apost_with_headers/);
    expect(body).not.toMatch(/_build_headers/);
    expect(body).not.toMatch(/_decode_or_raise/);
    expect(body).not.toMatch(/http\._client\.request/);
    // The replacement: conditional idempotency-key via request(extra_headers),
    // present EXACTLY twice (sync + async create_checkout).
    const injections =
      body.match(
        /extra_headers=\(\s*\n\s*\{"idempotency-key": idempotency_key\} if idempotency_key is not None else None\s*\n\s*\),/g,
      ) ?? [];
    expect(
      injections.length,
      'sync + async create_checkout both inject the key conditionally',
    ).toBe(2);
  });

  it('8-verb inventory drift guard — sync defines exactly 9 method defs (8 verbs + __init__); async defines the same 9. Verb-mix invariants: 2 quote()-named verb-conflict-avoidance (the method is called .quote() but also imports urllib.parse.quote — the test confirms BOTH meanings coexist). 5 distinct wire paths: checkout/quote + checkout + crypto-orders (list) + crypto-orders/{id} (3 sub-paths: bare/cancel/receipt).', () => {
    const syncStart = body.indexOf('class CryptoOrdersResource:');
    const asyncStart = body.indexOf('class AsyncCryptoOrdersResource:');
    expect(syncStart, 'expected sync class to come first').toBeGreaterThan(0);
    expect(asyncStart, 'expected async class to come after sync class').toBeGreaterThan(syncStart);
    const syncBody = body.slice(syncStart, asyncStart);
    // The async class is now the last thing in the file (the _post_with_headers
    // escape-hatch module funcs that used to follow it were removed in the audit).
    const asyncBody = body.slice(asyncStart);
    const syncDefs = (syncBody.match(/^ {4}(?:async )?def [a-z_]+\(/gm) ?? []).length;
    expect(syncDefs, 'expected 9 sync method defs (8 verbs + __init__)').toBe(9);
    const asyncDefs = (asyncBody.match(/^ {4}(?:async )?def [a-z_]+\(/gm) ?? []).length;
    expect(asyncDefs, 'expected 9 async method defs (8 verbs + __init__)').toBe(9);
    // urllib.parse.quote() must appear at least 8× (4 per-id sub-routes × sync+async).
    const quoteCalls = (body.match(/quote\(order_id, safe=''\)/g) ?? []).length;
    expect(
      quoteCalls,
      'expected 8 quote(order_id, safe="") calls (4 per-id routes × sync+async)',
    ).toBe(8);
  });
});

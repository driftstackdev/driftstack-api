// W584.B — drift guard for packages/sdk-python/src/resources/crypto_orders.py.
// V-666 CryptoOrdersResource Python parity. Drift here either drops
// the V-666.AO Idempotency-Key escape hatch, breaks the V-666.BU
// hand-rolled cursor walker, or unsets the non-refundable framing.
//
//   • Customer-facing only; admin endpoints aren't exposed.
//   • V-666.AO Idempotency-Key kwarg on create_checkout drives
//     httpx.Client directly via _post_with_headers/_apost_with_
//     headers escape hatches (HttpClient.request doesn't accept
//     arbitrary headers).
//   • V-666.BU iterate() hand-rolls cursor pagination because the
//     envelope shape is {"orders": ..., "next_cursor": ...}, not
//     the shared {"data": ..., ...} that iterate_paginated keys off.
//   • 8 verbs each: quote / create_checkout / list / iterate / get
//     / update_note / cancel / receipt.
//   • Crypto payments are non-refundable.

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

  it('Module docstring + V-666 framing + customer-facing-only + V-666.AO Idempotency-Key + V-666.BU cursor walker + non-refundable rails pinned', () => {
    expect(body).toMatch(/^"""Crypto-orders resource — \/v1\/billing\/crypto-\* \(V-666\)\.\n/);
    expect(body).toMatch(/Customer-facing only; admin endpoints aren't exposed here \(use the/);
    expect(body).toMatch(/OpenAPI spec at ``\/openapi\.json`` directly\)\./);
    expect(body).toMatch(/V-666\.AO — ``create_checkout`` accepts an ``idempotency_key`` keyword/);
    expect(body).toMatch(/that's forwarded as the ``Idempotency-Key`` header so retries don't/);
    expect(body).toMatch(/mint duplicate orders\./);
    expect(body).toMatch(/V-666\.BU — ``list`` accepts ``cursor`` for cursor-pagination;/);
    expect(body).toMatch(/``iterate`` walks every page until ``next_cursor`` is null\. The/);
    expect(body).toMatch(
      /response envelope is ``\{"orders": \[\.\.\.\], "next_cursor": \.\.\.\}``, which/,
    );
    expect(body).toMatch(/is why this resource hand-rolls iteration rather than using the/);
    expect(body).toMatch(/shared ``iterate_paginated`` helper \(that one keys off ``data``\)\./);
    expect(body).toMatch(/Crypto payments are non-refundable\./);
  });

  it('Helpers: _qs skip-None+urlencode + _list_path kwarg-only with 5 filters (limit/status/cursor/created_after/created_before) + cycle through "/v1/billing/crypto-orders"', () => {
    expect(body).toMatch(
      /^def _qs\(query: dict\[str, Any\]\) -> str:\s*\n\s*items: list\[tuple\[str, str\]\] = \[\]\s*\n\s*for k, v in query\.items\(\):\s*\n\s*if v is None:\s*\n\s*continue\s*\n\s*items\.append\(\(k, str\(v\)\)\)\s*\n\s*return urlencode\(items\)/m,
    );
    expect(body).toMatch(
      /^def _list_path\(\s*\n\s*\*,\s*\n\s*limit: int \| None,\s*\n\s*status: str \| None,\s*\n\s*cursor: str \| None,\s*\n\s*created_after: str \| None,\s*\n\s*created_before: str \| None,\s*\n\) -> str:/m,
    );
    expect(body).toMatch(/return "\/v1\/billing\/crypto-orders" \+ \(f"\?\{qs\}" if qs else ""\)/);
  });

  it('Sync CryptoOrdersResource: V-666.H quote() preview + V-666.C create_checkout with optional idempotency_key escape hatch + V-666.G/.BR/.BU/.BX list with 5 filters', () => {
    expect(body).toMatch(/^class CryptoOrdersResource:$/m);
    expect(body).toMatch(
      /def quote\(self, body: dict\[str, Any\]\) -> dict\[str, Any\]:\s*\n\s*"""V-666\.H — preview the fiat-cents price \+ crypto pay-range without minting an order\."""/,
    );
    expect(body).toMatch(
      /"POST",\s*\n\s*"\/v1\/billing\/crypto-checkout\/quote",\s*\n\s*json_body=coerce_body\(body\)/,
    );
    expect(body).toMatch(
      /def create_checkout\(\s*\n\s*self,\s*\n\s*body: dict\[str, Any\],\s*\n\s*\*,\s*\n\s*idempotency_key: str \| None = None,\s*\n\s*\) -> dict\[str, Any\]:/,
    );
    expect(body).toMatch(/"""V-666\.C — mint a new crypto order\./);
    expect(body).toMatch(/Pass ``idempotency_key`` to dedupe network retries — the server/);
    expect(body).toMatch(/returns the original order on replay, never a second one\./);
    expect(body).toMatch(/if idempotency_key is None:/);
    expect(body).toMatch(/"\/v1\/billing\/crypto-checkout"/);
    expect(body).toMatch(
      /return _post_with_headers\(\s*\n\s*self\._http,\s*\n\s*"\/v1\/billing\/crypto-checkout",\s*\n\s*json_body=coerce_body\(body\),\s*\n\s*headers=\{"idempotency-key": idempotency_key\},\s*\n\s*\)/,
    );
    expect(body).toMatch(
      /"""V-666\.G \/ \.BR \/ \.BU \/ \.BX — list the caller's crypto orders newest-first\."""/,
    );
  });

  it('Sync V-666.BU iterate() hand-rolls cursor pagination via _walk() closure: yield from page.get("orders", []) + break on next_cursor None — callers MUST NOT pass cursor', () => {
    expect(body).toMatch(
      /def iterate\(\s*\n\s*self,\s*\n\s*\*,\s*\n\s*limit: int \| None = None,\s*\n\s*status: str \| None = None,\s*\n\s*created_after: str \| None = None,\s*\n\s*created_before: str \| None = None,\s*\n\s*\) -> Iterator\[dict\[str, Any\]\]:/,
    );
    expect(body).toMatch(/"""V-666\.BU — lazily walk every order across cursor pages\./);
    expect(body).toMatch(/Yields envelopes one at a time so the caller can break early\./);
    expect(body).toMatch(/Cursor handoff is managed internally; callers MUST NOT pass/);
    expect(body).toMatch(/``cursor`` to this method \(use :meth:`list` if you need a/);
    expect(body).toMatch(/single page\)\./);
    expect(body).toMatch(
      /def _walk\(\) -> Iterator\[dict\[str, Any\]\]:\s*\n\s*cursor: str \| None = None\s*\n\s*while True:/,
    );
    expect(body).toMatch(/yield from page\.get\("orders", \[\]\)/);
    expect(body).toMatch(
      /next_cursor = page\.get\("next_cursor"\)\s*\n\s*if next_cursor is None:\s*\n\s*return\s*\n\s*cursor = next_cursor/,
    );
  });

  it('Sync per-order verbs: V-666.G get + V-666.Q update_note + V-666.J cancel (POST without body) + V-666.M receipt — all quote()-escaped order_id', () => {
    expect(body).toMatch(/def get\(self, order_id: str\) -> dict\[str, Any\]:/);
    expect(body).toMatch(/"""V-666\.G — read a single order envelope\."""/);
    expect(body).toMatch(/f"\/v1\/billing\/crypto-orders\/\{quote\(order_id, safe=''\)\}"/);
    expect(body).toMatch(/def update_note\(self, order_id: str, body: dict\[str, Any\]\)/);
    expect(body).toMatch(/"""V-666\.Q — update the customer-facing free-text note\."""/);
    expect(body).toMatch(/def cancel\(self, order_id: str\) -> dict\[str, Any\]:/);
    expect(body).toMatch(/"""V-666\.J — abandon a pending order \(self-service\)\."""/);
    expect(body).toMatch(/f"\/v1\/billing\/crypto-orders\/\{quote\(order_id, safe=''\)\}\/cancel"/);
    expect(body).toMatch(/def receipt\(self, order_id: str\) -> dict\[str, Any\]:/);
    expect(body).toMatch(/"""V-666\.M — fetch the JSON receipt\."""/);
    expect(body).toMatch(
      /f"\/v1\/billing\/crypto-orders\/\{quote\(order_id, safe=''\)\}\/receipt"/,
    );
  });

  it('Async AsyncCryptoOrdersResource mirrors sync 8-verb surface; _apost_with_headers async escape hatch for V-666.AO; iterate yields one-at-a-time via async _walk', () => {
    expect(body).toMatch(/^class AsyncCryptoOrdersResource:$/m);
    expect(body).toMatch(/"""Async mirror of :class:`CryptoOrdersResource`\."""/);
    expect(body).toMatch(
      /return await _apost_with_headers\(\s*\n\s*self\._http,\s*\n\s*"\/v1\/billing\/crypto-checkout",\s*\n\s*json_body=coerce_body\(body\),\s*\n\s*headers=\{"idempotency-key": idempotency_key\},\s*\n\s*\)/,
    );
    expect(body).toMatch(
      /def iterate\(\s*\n\s*self,\s*\n\s*\*,\s*\n\s*limit: int \| None = None,\s*\n\s*status: str \| None = None,\s*\n\s*created_after: str \| None = None,\s*\n\s*created_before: str \| None = None,\s*\n\s*\) -> AsyncIterator\[dict\[str, Any\]\]:/,
    );
    expect(body).toMatch(/async def _walk\(\) -> AsyncIterator\[dict\[str, Any\]\]:/);
    expect(body).toMatch(/for order in page\.get\("orders", \[\]\):\s*\n\s*yield order/);
  });

  it('_post_with_headers + _apost_with_headers escape hatches: late-import _build_headers + _decode_or_raise + merge headers + drive http._client.request directly; retry/error mapping intentionally bypassed (customers run their own outer retry)', () => {
    expect(body).toMatch(/# Idempotency-Key header escape hatch\./);
    expect(body).toMatch(/# HttpClient\.request\(\) doesn't accept arbitrary headers — adding the/);
    expect(body).toMatch(/# parameter to every resource would broaden the public surface and the/);
    expect(body).toMatch(
      /# only place we need it today is create_checkout \(V-666\.AO\)\. Drive the/,
    );
    expect(body).toMatch(/# underlying httpx\.Client here, reusing the same auth \+ UA the/);
    expect(body).toMatch(/# wrapper builds; the wrapper's retry\/error mapping is bypassed/);
    expect(body).toMatch(/# deliberately for these requests \(idempotent retries should come from/);
    expect(body).toMatch(/# the customer's outer retry loop, not the SDK\)\./);
    expect(body).toMatch(
      /from driftstack\.http import _build_headers, _decode_or_raise {2}# noqa: PLC0415/,
    );
    expect(body).toMatch(
      /merged = _build_headers\(http\._api_key, has_body=json_body is not None\) {2}# noqa: SLF001/,
    );
    expect(body).toMatch(/merged\.update\(headers\)/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});

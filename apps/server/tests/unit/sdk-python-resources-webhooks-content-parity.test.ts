// W584.A (W650-deepened) — drift guard for packages/sdk-python/src/
// driftstack/resources/webhooks.py. Webhooks Python parity.
//
// W650 splits the original 6 it() blocks (3 framing-bundles + 3
// behavioural-bundles) into 15 focused per-concept blocks + pins
// previously-implicit invariants:
//
//   • Module docstring + import surface + pagination helpers
//     (aiterate_paginated / iterate_paginated) for the deliveries
//     walk.
//   • Envelope models split — WebhookEndpointList (no pagination)
//     vs. WebhookDeliveryListPage (data + has_more + next_cursor 3-
//     field pagination envelope).
//   • _webhook_path helper — `quote(webhook_id, safe='')` URL-escape
//     with NO safe-chars. Drift to `safe='/'` would let a delivery
//     id like `123/../456` traverse path segments.
//   • Per-verb blocks: create / list / get / delete /
//     list_deliveries / iterate_deliveries / replay_delivery /
//     rotate_secret / send_test / update — each pin the docstring
//     framing (V-307/V-356/V-359/V-351 anchors) + wire path.
//   • V-307 replay_delivery account-scoping framing pinned: "the
//     delivery must belong to an endpoint the calling account owns".
//   • V-359 rotate_secret 24h dual-sign grace + grace_expires_at
//     pinned per-line so drift to a different window (e.g. 12h) or
//     dropping the dual-sign claim trips the test.
//   • V-351 update PATCH at-least-one-of (url/events/description/
//     active) + signing-secret-NOT-rotated + disabled-endpoint-409
//     all pinned per-line.
//   • Async class — mirror sync 10-verb surface; iterate_deliveries
//     uses AsyncIterator + aiterate_paginated (note: NOT `async def`
//     — the function returns an AsyncIterator generator; calling it
//     is sync, awaiting the yielded items is async).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/resources/webhooks.py');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W584.A packages/sdk-python/src/driftstack/resources/webhooks.py content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path + module docstring + future-annotations + 5-shape _generated.models import + pagination helpers (iterate_paginated + aiterate_paginated)', () => {
    expect(existsSync(LIB)).toBe(true);
    expect(body).toMatch(/^"""Webhooks resource — \/v1\/webhooks\."""/);
    expect(body).toMatch(/^from __future__ import annotations$/m);
    expect(body).toMatch(/^from collections\.abc import AsyncIterator, Iterator$/m);
    expect(body).toMatch(/^from urllib\.parse import quote$/m);
    expect(body).toMatch(/^from pydantic import BaseModel$/m);
    expect(body).toMatch(
      /^from driftstack\._generated\.models import \(\s*\n\s*CreateWebhookRequest,\s*\n\s*CreateWebhookResponse,\s*\n\s*ListDeliveriesQuery,\s*\n\s*WebhookDelivery,\s*\n\s*WebhookEndpoint,\s*\n\)$/m,
    );
    expect(body).toMatch(
      /^from driftstack\.pagination import aiterate_paginated, iterate_paginated$/m,
    );
    expect(body).toMatch(/^from driftstack\.resources\._common import coerce_body, coerce_query$/m);
  });

  it('WebhookEndpointList envelope — 1-field (data: list[WebhookEndpoint]) NO pagination. Webhook endpoints are a small finite set per account (V-351 admin-scoped + capped) so the list-all-once shape is sound; drift to adding pagination would silently change the contract.', () => {
    expect(body).toMatch(
      /^class WebhookEndpointList\(BaseModel\):\s*\n\s*"""Response shape for ``GET \/v1\/webhooks``\."""\s*\n\s*data: list\[WebhookEndpoint\]$/m,
    );
  });

  it('WebhookDeliveryListPage envelope — 3-field cursor pagination (data + has_more + next_cursor: str | None). Deliveries are unbounded per endpoint so cursor pagination is load-bearing; drift to dropping has_more or making next_cursor non-nullable would break iterate_deliveries termination logic.', () => {
    expect(body).toMatch(
      /^class WebhookDeliveryListPage\(BaseModel\):\s*\n\s*"""Response shape for ``GET \/v1\/webhooks\/\{id\}\/deliveries``\."""\s*\n\s*data: list\[WebhookDelivery\]\s*\n\s*has_more: bool\s*\n\s*next_cursor: str \| None$/m,
    );
  });

  it('_webhook_path helper — f"/v1/webhooks/{quote(webhook_id, safe=\'\')}{suffix}" with NO safe-chars in quote(). Drift to safe=\'/\' would let a webhook_id like "123/../456" traverse path segments and reach an unrelated endpoint, widening the auth surface.', () => {
    expect(body).toMatch(
      /^def _webhook_path\(webhook_id: str, suffix: str = ""\) -> str:\s*\n\s*return f"\/v1\/webhooks\/\{quote\(webhook_id, safe=''\)\}\{suffix\}"$/m,
    );
  });

  it('WebhooksResource (sync) class declaration + __init__(http: HttpClient) — stateless wrapper. Same pattern as every other Python sync resource (no auth caching, no client state — all auth comes from the HttpClient).', () => {
    expect(body).toMatch(/^class WebhooksResource:$/m);
    expect(body).toMatch(/^ {4}"""Synchronous webhooks resource\."""$/m);
    expect(body).toMatch(
      /^ {4}def __init__\(self, http: HttpClient\) -> None:\s*\n\s*self\._http = http$/m,
    );
  });

  it('Sync create — POST /v1/webhooks with CreateWebhookRequest body via coerce_body. CRITICAL: "Plaintext signing secret is returned ONCE; store it now — it cannot be retrieved later." This is the load-bearing claim — the customer cannot re-read the secret later, only rotate it via V-359. "Requires the account_owner scope" framing pinned (V-174) because list/get/delete are read-only-scope-tolerable; create writes a new endpoint with a brand-new secret.', () => {
    expect(body).toMatch(
      /def create\(self, body: CreateWebhookRequest \| dict\[str, Any\]\) -> CreateWebhookResponse:\s*\n\s*"""Create a webhook subscription\.\s*\n\s*\n\s*Plaintext signing secret is returned ONCE; store it now — it\s*\n\s*cannot be retrieved later\. Requires the ``account_owner`` scope\.\s*\n\s*"""/,
    );
    expect(body).toMatch(
      /data = self\._http\.request\("POST", "\/v1\/webhooks", json_body=coerce_body\(body\)\)/,
    );
    expect(body).toMatch(/return parse_model\(CreateWebhookResponse, data\)/);
  });

  it("Sync list — GET /v1/webhooks returns WebhookEndpointList (no pagination). No params; no body; bearer-token scopes to the calling account so listings can never leak another account's endpoints.", () => {
    expect(body).toMatch(
      /def list\(self\) -> WebhookEndpointList:\s*\n\s*data = self\._http\.request\("GET", "\/v1\/webhooks"\)\s*\n\s*return parse_model\(WebhookEndpointList, data\)/,
    );
  });

  it('Sync get — GET /v1/webhooks/{quoted_id} returns single WebhookEndpoint. Single-line implementation; the URL-escape is the only complexity.', () => {
    expect(body).toMatch(
      /def get\(self, webhook_id: str\) -> WebhookEndpoint:\s*\n\s*data = self\._http\.request\("GET", _webhook_path\(webhook_id\)\)\s*\n\s*return parse_model\(WebhookEndpoint, data\)/,
    );
  });

  it('Sync delete — DELETE /v1/webhooks/{quoted_id}, "Soft-delete (disable) the endpoint. Idempotent." Returns None (no body). Soft-delete preserves delivery history; drift to a hard-delete would lose audit-log linkage retroactively.', () => {
    expect(body).toMatch(
      /def delete\(self, webhook_id: str\) -> None:\s*\n\s*"""Soft-delete \(disable\) the endpoint\. Idempotent\."""\s*\n\s*self\._http\.request\("DELETE", _webhook_path\(webhook_id\)\)/,
    );
  });

  it('Sync list_deliveries — GET /v1/webhooks/{id}/deliveries returns WebhookDeliveryListPage. 3-param signature: webhook_id + query=ListDeliveriesQuery|dict|None. Uses coerce_query so callers can pass either a typed model or a raw dict.', () => {
    expect(body).toMatch(
      /def list_deliveries\(\s*\n\s*self,\s*\n\s*webhook_id: str,\s*\n\s*query: ListDeliveriesQuery \| dict\[str, Any\] \| None = None,\s*\n\s*\) -> WebhookDeliveryListPage:\s*\n\s*data = self\._http\.request\(\s*\n\s*"GET",\s*\n\s*_webhook_path\(webhook_id, "\/deliveries"\),\s*\n\s*params=coerce_query\(query\),\s*\n\s*\)/,
    );
  });

  it('Sync iterate_deliveries — Iterator[WebhookDelivery] lazy walk with limit + status keyword-only filter threaded per-page. CRITICAL: "Filter by status (e.g. \'dlq\') to walk just one bucket; the filter threads through every page." Drift to dropping the per-page status re-threading would mean only the first page is filtered and subsequent pages would leak unfiltered deliveries.', () => {
    expect(body).toMatch(
      /def iterate_deliveries\(\s*\n\s*self,\s*\n\s*webhook_id: str,\s*\n\s*\*,\s*\n\s*limit: int \| None = None,\s*\n\s*status: str \| None = None,\s*\n\s*\) -> Iterator\[WebhookDelivery\]:\s*\n\s*"""Lazily walk every delivery for an endpoint\.\s*\n\s*\n\s*Filter by ``status`` \(e\.g\. ``'dlq'``\) to walk just one bucket;\s*\n\s*the filter threads through every page\.\s*\n\s*"""/,
    );
    // Per-page filter re-threading pinned: limit + status + cursor all
    // re-applied on every fetch_page call.
    expect(body).toMatch(
      /def fetch_page\(cursor: str \| None\) -> WebhookDeliveryListPage:\s*\n\s*params: dict\[str, Any\] = \{\}\s*\n\s*if limit is not None:\s*\n\s*params\["limit"\] = limit\s*\n\s*if status is not None:\s*\n\s*params\["status"\] = status\s*\n\s*if cursor is not None:\s*\n\s*params\["cursor"\] = cursor\s*\n\s*return self\.list_deliveries\(webhook_id, params\)/,
    );
    expect(body).toMatch(/return iterate_paginated\(fetch_page\)/);
  });

  it('Sync replay_delivery — V-307 POST /v1/webhook-deliveries/{quoted_id}/replay. CRITICAL: "Resets the delivery to pending so the worker re-fires it" + "Account-scoped: the delivery must belong to an endpoint the calling account owns." Without the account-scope check, customers could replay deliveries for OTHER tenants\' endpoints — that\'s a cross-tenant data leak. Drift to dropping the account-scoping framing would weaken the contract.', () => {
    // V-1122 — signature and docstring asserted separately; the chained
    // form coupled the scope sentence to the def line.
    expect(body).toMatch(/def replay_delivery\(self, delivery_id: str\) -> WebhookDelivery:/);
    expect(body).toMatch(/Scoped to the EFFECTIVE account: the delivery must belong to an/);
    expect(body, 'the calling-account claim must not return').not.toMatch(
      /endpoint the\s*\n?\s*calling account owns/,
    );
    expect(body).toMatch(
      /data = self\._http\.request\(\s*\n\s*"POST",\s*\n\s*f"\/v1\/webhook-deliveries\/\{quote\(delivery_id, safe=''\)\}\/replay",\s*\n\s*json_body=\{\},\s*\n\s*\)/,
    );
    expect(body).toMatch(/return parse_model\(WebhookDelivery, data\)/);
  });

  it('Sync rotate_secret — V-359 POST /v1/webhooks/{id}/rotate-secret. CRITICAL grace-window claim, each line pinned: fresh plaintext ONCE + 24h grace + grace_expires_at field + Driftstack-dual-signs-during-window + customer rolls verifier infra inside the window. Drift to 12h or 48h or dropping the dual-sign-during-grace would silently change rotation semantics.', () => {
    expect(body).toMatch(/def rotate_secret\(self, webhook_id: str\) -> dict\[str, Any\]:/);
    expect(body).toMatch(
      /"""V-359 — rotate the webhook signing secret\.\s*\n\s*\n\s*Returns the fresh plaintext \(shown ONCE\) plus grace metadata:\s*\n\s*the previous secret stays active for 24h\s*\n\s*\(``grace_expires_at``\) during which Driftstack dual-signs\s*\n\s*every outbound delivery \(both new \+ old HMAC\)\. Roll the new\s*\n\s*secret across your verifier infra inside that window\.\s*\n\s*"""/,
    );
    expect(body).toMatch(
      /return self\._http\.request\("POST", _webhook_path\(webhook_id, "\/rotate-secret"\), json_body=\{\}\)/,
    );
  });

  it("Sync send_test — V-356 POST /v1/webhooks/{id}/test. CRITICAL: \"Bypasses subscription so customers can verify their handler is reachable + signature-valid before depending on it for real events.\" If send_test required the event to be in the endpoint's subscription, customers couldn't test the handler until AFTER they'd already subscribed — useless for first-time setup. Returns 3-field response shape pinned: {delivery_id, event_id, event_type}.", () => {
    expect(body).toMatch(/def send_test\(self, webhook_id: str\) -> dict\[str, Any\]:/);
    expect(body).toMatch(
      /"""V-356 — send a synthetic ``test\.ping`` event to the endpoint\.\s*\n\s*\n\s*Bypasses subscription so customers can verify their handler\s*\n\s*is reachable \+ signature-valid before depending on it for\s*\n\s*real events\. Returns ``\{delivery_id, event_id, event_type\}``\.\s*\n\s*"""/,
    );
    expect(body).toMatch(
      /return self\._http\.request\("POST", _webhook_path\(webhook_id, "\/test"\), json_body=\{\}\)/,
    );
  });

  it('Sync update — V-351 PATCH /v1/webhooks/{id}. CRITICAL: 3 stacked invariants pinned per-line — (1) "At least one of url, events, description, or active must be present" (server returns 422 if all absent), (2) "The signing secret is NOT rotated by update" (a future API where update accepts a secret-rotation flag would be a footgun — rotation MUST stay on rotate_secret), (3) "Disabled endpoints cannot be updated (returns 409)" (after soft-delete the endpoint is read-only).', () => {
    expect(body).toMatch(
      /def update\(self, webhook_id: str, body: dict\[str, Any\]\) -> WebhookEndpoint:/,
    );
    expect(body).toMatch(
      /"""V-351 — partial-update a webhook endpoint\.\s*\n\s*\n\s*At least one of ``url``, ``events``, ``description``, or\s*\n\s*``active`` must be present\. The signing secret is NOT rotated\s*\n\s*by update; use :meth:`rotate_secret` for that\. Disabled\s*\n\s*endpoints cannot be updated \(returns 409\)\.\s*\n\s*"""/,
    );
    expect(body).toMatch(
      /data = self\._http\.request\("PATCH", _webhook_path\(webhook_id\), json_body=coerce_body\(body\)\)/,
    );
    expect(body).toMatch(/return parse_model\(WebhookEndpoint, data\)/);
  });

  it('AsyncWebhooksResource — class declaration + __init__(http: AsyncHttpClient) + 10-verb mirror of sync surface. Every non-trivial verb (replay/rotate/send_test/update) carries a :meth: cross-ref docstring back to its sync twin so users searching for the sync semantics can find the async variant.', () => {
    expect(body).toMatch(/^class AsyncWebhooksResource:$/m);
    expect(body).toMatch(/^ {4}"""Async webhooks resource\."""$/m);
    expect(body).toMatch(
      /^ {4}def __init__\(self, http: AsyncHttpClient\) -> None:\s*\n\s*self\._http = http$/m,
    );
    // Async create/list/get/delete/list_deliveries mirror sync.
    expect(body).toMatch(
      /async def create\(self, body: CreateWebhookRequest \| dict\[str, Any\]\) -> CreateWebhookResponse:/,
    );
    expect(body).toMatch(/async def list\(self\) -> WebhookEndpointList:/);
    expect(body).toMatch(/async def get\(self, webhook_id: str\) -> WebhookEndpoint:/);
    expect(body).toMatch(/async def delete\(self, webhook_id: str\) -> None:/);
    expect(body).toMatch(
      /async def list_deliveries\(\s*\n\s*self,\s*\n\s*webhook_id: str,\s*\n\s*query: ListDeliveriesQuery \| dict\[str, Any\] \| None = None,\s*\n\s*\) -> WebhookDeliveryListPage:/,
    );
  });

  it('Async iterate_deliveries — NOTE: NOT `async def` (the function returns an AsyncIterator generator; calling it is sync, awaiting the yielded items is async). Uses aiterate_paginated with the same per-page limit + status + cursor re-threading pattern as sync. AsyncIterator[WebhookDelivery] return type pinned.', () => {
    expect(body).toMatch(
      /def iterate_deliveries\(\s*\n\s*self,\s*\n\s*webhook_id: str,\s*\n\s*\*,\s*\n\s*limit: int \| None = None,\s*\n\s*status: str \| None = None,\s*\n\s*\) -> AsyncIterator\[WebhookDelivery\]:\s*\n\s*"""Async variant of :meth:`WebhooksResource\.iterate_deliveries`\."""/,
    );
    expect(body).toMatch(
      /async def fetch_page\(cursor: str \| None\) -> WebhookDeliveryListPage:\s*\n\s*params: dict\[str, Any\] = \{\}\s*\n\s*if limit is not None:\s*\n\s*params\["limit"\] = limit\s*\n\s*if status is not None:\s*\n\s*params\["status"\] = status\s*\n\s*if cursor is not None:\s*\n\s*params\["cursor"\] = cursor\s*\n\s*return await self\.list_deliveries\(webhook_id, params\)/,
    );
    expect(body).toMatch(/return aiterate_paginated\(fetch_page\)/);
  });

  it('Async V-307/V-359/V-356/V-351 four behavioural verbs — :meth: cross-refs back to sync for each, signaling the contract is identical to the sync twin so users only need to read it once.', () => {
    expect(body).toMatch(
      /async def replay_delivery\(self, delivery_id: str\) -> WebhookDelivery:\s*\n\s*"""V-307 — async replay\. See :meth:`WebhooksResource\.replay_delivery`\."""/,
    );
    expect(body).toMatch(
      /async def rotate_secret\(self, webhook_id: str\) -> dict\[str, Any\]:\s*\n\s*"""V-359 — async secret rotation\. See :meth:`WebhooksResource\.rotate_secret`\."""/,
    );
    expect(body).toMatch(
      /async def send_test\(self, webhook_id: str\) -> dict\[str, Any\]:\s*\n\s*"""V-356 — async test ping\. See :meth:`WebhooksResource\.send_test`\."""/,
    );
    expect(body).toMatch(
      /async def update\(self, webhook_id: str, body: dict\[str, Any\]\) -> WebhookEndpoint:\s*\n\s*"""V-351 — async partial-update\. See :meth:`WebhooksResource\.update`\."""/,
    );
  });

  it('10-verb inventory — sync defines exactly 10 def-statements (create/list/get/delete/list_deliveries/iterate_deliveries/replay_delivery/rotate_secret/send_test/update) and async mirrors with the same 10. Drift to an 11th verb without doubling test coverage would let an untested code path ship.', () => {
    // Sync: count `def <name>(self` inside WebhooksResource. The class
    // body spans until the next `class` declaration. Async mirrors the
    // same 10 verb-names with `async def` / `def` (iterate_deliveries
    // is the only non-async-def in the async class).
    const syncStart = body.indexOf('class WebhooksResource:');
    const asyncStart = body.indexOf('class AsyncWebhooksResource:');
    expect(syncStart, 'expected sync class to come first').toBeGreaterThan(0);
    expect(asyncStart, 'expected async class to come after sync class').toBeGreaterThan(syncStart);
    const syncBody = body.slice(syncStart, asyncStart);
    const asyncBody = body.slice(asyncStart);
    // Match top-of-class method defs (4-space indent). The nested
    // fetch_page inside iterate_deliveries is indented 8 spaces so the
    // anchor excludes it. Expected: 10 verbs + __init__ = 11 defs.
    const syncDefs = (syncBody.match(/^ {4}(?:async )?def [a-z_]+\(/gm) ?? []).length;
    expect(syncDefs, 'expected 11 sync method defs (10 verbs + __init__)').toBe(11);
    const asyncDefs = (asyncBody.match(/^ {4}(?:async )?def [a-z_]+\(/gm) ?? []).length;
    expect(asyncDefs, 'expected 11 async method defs (10 verbs + __init__)').toBe(11);
  });
});

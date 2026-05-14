// W581.A (W644-deepened) — drift guard for packages/sdk-python/src/driftstack/resources/api_keys.py.
// V-296 ApiKeysResource Python parity.
//
// W644 splits the 6 it() blocks (where sync + async classes each
// bundled all verbs into one big block) into 13 focused per-verb +
// per-model blocks + pins previously-implicit invariants:
//
//   • Plaintext-once contract on BOTH create AND rotate (mirrors
//     sdk-go W628 — both verbs surface plaintext, both must warn).
//   • V-296 24h-grace-window rotate contract: old key auto-revokes
//     via the existing expires_at-driven auth gate (no separate
//     sweeper job).
//   • RotateApiKeyResponse INHERITS from CreateApiKeyResponse + adds
//     rotated_from + grace_period_ends_at — drift to inheriting
//     from BaseModel would lose the parent's plaintext fields.
//   • rotate kwarg-only `name` param + conditional `if name is not
//     None: body["name"] = name` — omitting kwarg DEFERS to server-
//     side "preserve old name" default.
//   • quote(key_id, safe='') on BOTH revoke AND rotate so a malformed
//     id cannot inject path traversal.
//   • revoke returns None (Python 204-no-content idiom; same pattern
//     as team.remove_member).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/resources/api_keys.py');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W581.A packages/sdk-python/src/driftstack/resources/api_keys.py content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path + module docstring /v1/api-keys scope (single-line, no V-anchor framing in the docstring — the V-anchors live on the rotate method)', () => {
    expect(existsSync(LIB)).toBe(true);
    expect(body).toMatch(/^"""API keys resource — \/v1\/api-keys\."""/);
  });

  it('Imports — 6-line surface: __future__ + Any + urllib.parse.quote + pydantic BaseModel + 3 generated models (ApiKey + CreateApiKeyRequest + CreateApiKeyResponse) + Async/Sync HttpClient + coerce_body. CRITICAL: the 3 generated models import from driftstack._generated.models — drift to a hand-rolled CreateApiKeyResponse would mean the SDK and the OpenAPI spec have diverged.', () => {
    expect(body).toMatch(/^from __future__ import annotations$/m);
    expect(body).toMatch(/^from typing import Any$/m);
    expect(body).toMatch(/^from urllib\.parse import quote$/m);
    expect(body).toMatch(/^from pydantic import BaseModel$/m);
    expect(body).toMatch(
      /^from driftstack\._generated\.models import ApiKey, CreateApiKeyRequest, CreateApiKeyResponse$/m,
    );
    expect(body).toMatch(/^from driftstack\.http import AsyncHttpClient, HttpClient$/m);
    expect(body).toMatch(/^from driftstack\.resources\._common import coerce_body$/m);
  });

  it("ApiKeyList — list response envelope. BaseModel with data: list[ApiKey] field. Pinned shape so a regen can't silently drop the data field or rename it (would break customers iterating `for k in result.data:`).", () => {
    expect(body).toMatch(/^class ApiKeyList\(BaseModel\):$/m);
    expect(body).toMatch(/"""Response shape for ``GET \/v1\/api-keys``\."""/);
    expect(body).toMatch(/data: list\[ApiKey\]/);
  });

  it('RotateApiKeyResponse — V-296 rotation envelope. INHERITS from CreateApiKeyResponse (NOT BaseModel) so it picks up the plaintext + id fields from the create response, THEN adds rotated_from + grace_period_ends_at. Drift to inheriting from BaseModel would lose the plaintext-once-from-parent invariant. Both new fields are str (timestamps as ISO strings, per Python SDK convention).', () => {
    expect(body).toMatch(/^class RotateApiKeyResponse\(CreateApiKeyResponse\):$/m);
    expect(body).toMatch(/"""V-296 — response shape for ``POST \/v1\/api-keys\/:id\/rotate``\./);
    expect(body).toMatch(/Extends ``CreateApiKeyResponse`` with the previous-key reference and/);
    expect(body).toMatch(/the timestamp at which the previous key auto-revokes via the/);
    expect(body).toMatch(/``expires_at``-driven auth gate\./);
    expect(body).toMatch(/rotated_from: str/);
    expect(body).toMatch(/grace_period_ends_at: str/);
  });

  it('ApiKeysResource sync class shell + HttpClient injection', () => {
    expect(body).toMatch(/^class ApiKeysResource:$/m);
    expect(body).toMatch(/"""Synchronous API keys resource\."""/);
    expect(body).toMatch(
      /def __init__\(self, http: HttpClient\) -> None:\s*\n\s*self\._http = http/,
    );
  });

  it('create (sync) — POST /v1/api-keys with body type `CreateApiKeyRequest | dict[str, Any]` (pydantic-or-dict polymorphism via coerce_body). Plaintext-once-only contract pinned: "store it now, it cannot be retrieved later." Admin-scope on the calling key required. model_validate-at-boundary returns CreateApiKeyResponse.', () => {
    expect(body).toMatch(
      /def create\(self, body: CreateApiKeyRequest \| dict\[str, Any\]\) -> CreateApiKeyResponse:/,
    );
    expect(body).toMatch(/"""Create an API key\./);
    expect(body).toMatch(/Plaintext is in the response — store it now, it cannot be/);
    expect(body).toMatch(/retrieved later\. Requires the ``admin`` scope on the calling key\./);
    expect(body).toMatch(
      /data = self\._http\.request\("POST", "\/v1\/api-keys", json_body=coerce_body\(body\)\)\s*\n\s*return CreateApiKeyResponse\.model_validate\(data\)/,
    );
  });

  it('list (sync) — GET /v1/api-keys returns ApiKeyList. Plaintext NEVER included framing pinned in docstring — reassurance that listing is safe to call frequently. Account-scoped via bearer; same /v1/api-keys path as create so the API is REST-canonical (collection root for both verbs).', () => {
    expect(body).toMatch(/def list\(self\) -> ApiKeyList:/);
    expect(body).toMatch(
      /"""List API keys for the current account\. Plaintext never included\."""/,
    );
    expect(body).toMatch(
      /data = self\._http\.request\("GET", "\/v1\/api-keys"\)\s*\n\s*return ApiKeyList\.model_validate\(data\)/,
    );
  });

  it(`revoke (sync) — DELETE /v1/api-keys/{quote(key_id, safe='')}. Returns None (Python 204-no-content idiom). Idempotent ("revoking an already-revoked key is a no-op") pinned in docstring. CRITICAL: safe='' kwarg on quote() means EVEN '/' gets percent-encoded — drift to default quote would let '/' through, enabling path traversal.`, () => {
    expect(body).toMatch(
      /def revoke\(self, key_id: str\) -> None:\s*\n\s*"""Revoke an API key\. Idempotent — revoking an already-revoked key is a no-op\."""\s*\n\s*self\._http\.request\("DELETE", f"\/v1\/api-keys\/\{quote\(key_id, safe=''\)\}"\)/,
    );
  });

  it('rotate (sync) — V-296 POST /v1/api-keys/{quote(key_id)}/rotate with kwarg-only name. CRITICAL V-296 24h-grace contract pinned: "Mints a fresh plaintext + sets the OLD key\'s expires_at to now + 24h. Both keys work concurrently during the grace window; deploy the new key, then the old key auto-revokes at the grace boundary." Auto-revoke happens via the EXISTING expires_at-driven auth gate — no separate sweeper job. Plaintext-once-on-rotate is the second time the warning fires (first was create).', () => {
    expect(body).toMatch(
      /def rotate\(self, key_id: str, \*, name: str \| None = None\) -> RotateApiKeyResponse:/,
    );
    expect(body).toMatch(/"""V-296 — rotate an API key with a 24h grace period\./);
    expect(body).toMatch(/Mints a fresh plaintext \+ sets the OLD key's ``expires_at`` to/);
    expect(body).toMatch(/``now \+ 24h``\. Both keys work concurrently during the grace/);
    expect(body).toMatch(/window; deploy the new key, then the old key auto-revokes at/);
    expect(body).toMatch(/the grace boundary\. Plaintext is in the response — store it now\./);
  });

  it('rotate name-kwarg conditional wiring + quote-escaped path + RotateApiKeyResponse model_validate. CRITICAL: `if name is not None: body["name"] = name` — omitting the kwarg DEFERS to server-side "preserve old name" default (no client-side default that could drift from server). quote(safe="") on key_id segment same as revoke.', () => {
    expect(body).toMatch(
      /body: dict\[str, Any\] = \{\}\s*\n\s*if name is not None:\s*\n\s*body\["name"\] = name/,
    );
    expect(body).toMatch(
      /data = self\._http\.request\(\s*\n\s*"POST",\s*\n\s*f"\/v1\/api-keys\/\{quote\(key_id, safe=''\)\}\/rotate",\s*\n\s*json_body=body,\s*\n\s*\)\s*\n\s*return RotateApiKeyResponse\.model_validate\(data\)/,
    );
  });

  it('AsyncApiKeysResource — class shell + AsyncHttpClient injection. Mirrors sync class.', () => {
    expect(body).toMatch(/^class AsyncApiKeysResource:$/m);
    expect(body).toMatch(/"""Async API keys resource\."""/);
    expect(body).toMatch(
      /def __init__\(self, http: AsyncHttpClient\) -> None:\s*\n\s*self\._http = http/,
    );
  });

  it('async create + list + revoke — awaited verb twins. Same wire paths + same coerce_body wrapping + same quote-escaped key_id + same model_validate at boundary. async revoke returns None (matches sync).', () => {
    expect(body).toMatch(
      /async def create\(self, body: CreateApiKeyRequest \| dict\[str, Any\]\) -> CreateApiKeyResponse:\s*\n\s*data = await self\._http\.request\("POST", "\/v1\/api-keys", json_body=coerce_body\(body\)\)\s*\n\s*return CreateApiKeyResponse\.model_validate\(data\)/,
    );
    expect(body).toMatch(
      /async def list\(self\) -> ApiKeyList:\s*\n\s*data = await self\._http\.request\("GET", "\/v1\/api-keys"\)\s*\n\s*return ApiKeyList\.model_validate\(data\)/,
    );
    expect(body).toMatch(
      /async def revoke\(self, key_id: str\) -> None:\s*\n\s*await self\._http\.request\("DELETE", f"\/v1\/api-keys\/\{quote\(key_id, safe=''\)\}"\)/,
    );
  });

  it('async rotate — V-296 awaited POST twin with short ":meth: cross-ref" docstring (delegates to the sync method\'s full docstring rather than duplicating). Same conditional name-kwarg wiring + same quote-escaped path + same RotateApiKeyResponse return shape.', () => {
    expect(body).toMatch(
      /async def rotate\(self, key_id: str, \*, name: str \| None = None\) -> RotateApiKeyResponse:\s*\n\s*"""V-296 — async rotate\. See :meth:`ApiKeysResource\.rotate`\."""/,
    );
    expect(body).toMatch(
      /body: dict\[str, Any\] = \{\}\s*\n\s*if name is not None:\s*\n\s*body\["name"\] = name\s*\n\s*data = await self\._http\.request\(\s*\n\s*"POST",\s*\n\s*f"\/v1\/api-keys\/\{quote\(key_id, safe=''\)\}\/rotate",\s*\n\s*json_body=body,\s*\n\s*\)\s*\n\s*return RotateApiKeyResponse\.model_validate\(data\)/,
    );
  });
});

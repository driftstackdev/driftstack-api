// W581.A — drift guard for packages/sdk-python/src/resources/api_keys.py.
// V-296 ApiKeysResource Python parity. Drift here either drops the
// 24h-grace rotate flow (admin scope + previous-key reference +
// grace_period_ends_at) or breaks the plaintext-once-only contract
// for create.
//
//   • Two paired classes: ApiKeysResource (sync) + AsyncApiKeysResource.
//   • RotateApiKeyResponse extends CreateApiKeyResponse with rotated_from +
//     grace_period_ends_at (V-296 24h grace window).
//   • 4 verbs each: create / list / revoke / rotate.
//   • Plaintext-once-only contract: response carries plaintext, never re-
//     retrievable later; admin scope required on the caller.
//   • Generated-model validation: ApiKey, CreateApiKeyRequest,
//     CreateApiKeyResponse from driftstack._generated.models.

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

  it('Module docstring + /v1/api-keys scope + imports (pydantic BaseModel + ApiKey/CreateApiKeyRequest/CreateApiKeyResponse generated + AsyncHttpClient/HttpClient + coerce_body + quote) pinned', () => {
    expect(body).toMatch(/^"""API keys resource — \/v1\/api-keys\."""/);
    expect(body).toMatch(/^from __future__ import annotations$/m);
    expect(body).toMatch(/^from urllib\.parse import quote$/m);
    expect(body).toMatch(/^from pydantic import BaseModel$/m);
    expect(body).toMatch(
      /^from driftstack\._generated\.models import ApiKey, CreateApiKeyRequest, CreateApiKeyResponse$/m,
    );
    expect(body).toMatch(/^from driftstack\.http import AsyncHttpClient, HttpClient$/m);
    expect(body).toMatch(/^from driftstack\.resources\._common import coerce_body$/m);
  });

  it('ApiKeyList shape pinned: BaseModel with data: list[ApiKey] — list response envelope for GET /v1/api-keys', () => {
    expect(body).toMatch(/^class ApiKeyList\(BaseModel\):$/m);
    expect(body).toMatch(/"""Response shape for ``GET \/v1\/api-keys``\."""/);
    expect(body).toMatch(/data: list\[ApiKey\]/);
  });

  it('RotateApiKeyResponse V-296 shape pinned: extends CreateApiKeyResponse with rotated_from + grace_period_ends_at (24h auto-revoke gate via expires_at)', () => {
    expect(body).toMatch(/^class RotateApiKeyResponse\(CreateApiKeyResponse\):$/m);
    expect(body).toMatch(/"""V-296 — response shape for ``POST \/v1\/api-keys\/:id\/rotate``\./);
    expect(body).toMatch(/Extends ``CreateApiKeyResponse`` with the previous-key reference and/);
    expect(body).toMatch(/the timestamp at which the previous key auto-revokes via the/);
    expect(body).toMatch(/``expires_at``-driven auth gate\./);
    expect(body).toMatch(/rotated_from: str/);
    expect(body).toMatch(/grace_period_ends_at: str/);
  });

  it('Sync ApiKeysResource: 4 verbs (create POST + list GET + revoke DELETE idempotent + rotate POST V-296 24h grace) with quote()-escaped key_id + model_validate roundtrip + admin-scope create framing', () => {
    expect(body).toMatch(/^class ApiKeysResource:$/m);
    expect(body).toMatch(
      /def create\(self, body: CreateApiKeyRequest \| dict\[str, Any\]\) -> CreateApiKeyResponse:/,
    );
    expect(body).toMatch(/"""Create an API key\./);
    expect(body).toMatch(/Plaintext is in the response — store it now, it cannot be/);
    expect(body).toMatch(/retrieved later\. Requires the ``admin`` scope on the calling key\./);
    expect(body).toMatch(
      /data = self\._http\.request\("POST", "\/v1\/api-keys", json_body=coerce_body\(body\)\)/,
    );
    expect(body).toMatch(/return CreateApiKeyResponse\.model_validate\(data\)/);
    expect(body).toMatch(/def list\(self\) -> ApiKeyList:/);
    expect(body).toMatch(
      /data = self\._http\.request\("GET", "\/v1\/api-keys"\)\s*\n\s*return ApiKeyList\.model_validate\(data\)/,
    );
    expect(body).toMatch(
      /def revoke\(self, key_id: str\) -> None:\s*\n\s*"""Revoke an API key\. Idempotent — revoking an already-revoked key is a no-op\."""\s*\n\s*self\._http\.request\("DELETE", f"\/v1\/api-keys\/\{quote\(key_id, safe=''\)\}"\)/,
    );
    expect(body).toMatch(
      /def rotate\(self, key_id: str, \*, name: str \| None = None\) -> RotateApiKeyResponse:/,
    );
    expect(body).toMatch(/"""V-296 — rotate an API key with a 24h grace period\./);
    expect(body).toMatch(/Mints a fresh plaintext \+ sets the OLD key's ``expires_at`` to/);
    expect(body).toMatch(/``now \+ 24h``\. Both keys work concurrently during the grace/);
    expect(body).toMatch(/window; deploy the new key, then the old key auto-revokes at/);
    expect(body).toMatch(/the grace boundary\. Plaintext is in the response — store it now\./);
    expect(body).toMatch(/f"\/v1\/api-keys\/\{quote\(key_id, safe=''\)\}\/rotate"/);
    expect(body).toMatch(/return RotateApiKeyResponse\.model_validate\(data\)/);
  });

  it('Async AsyncApiKeysResource mirrors sync surface with awaited calls + V-296 async rotate refers via :meth: cross-ref', () => {
    expect(body).toMatch(/^class AsyncApiKeysResource:$/m);
    expect(body).toMatch(
      /async def create\(self, body: CreateApiKeyRequest \| dict\[str, Any\]\) -> CreateApiKeyResponse:\s*\n\s*data = await self\._http\.request\("POST", "\/v1\/api-keys", json_body=coerce_body\(body\)\)\s*\n\s*return CreateApiKeyResponse\.model_validate\(data\)/,
    );
    expect(body).toMatch(
      /async def list\(self\) -> ApiKeyList:\s*\n\s*data = await self\._http\.request\("GET", "\/v1\/api-keys"\)\s*\n\s*return ApiKeyList\.model_validate\(data\)/,
    );
    expect(body).toMatch(
      /async def revoke\(self, key_id: str\) -> None:\s*\n\s*await self\._http\.request\("DELETE", f"\/v1\/api-keys\/\{quote\(key_id, safe=''\)\}"\)/,
    );
    expect(body).toMatch(
      /async def rotate\(self, key_id: str, \*, name: str \| None = None\) -> RotateApiKeyResponse:\s*\n\s*"""V-296 — async rotate\. See :meth:`ApiKeysResource\.rotate`\."""/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});

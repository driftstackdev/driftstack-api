// W580.A — drift guard for packages/sdk-python/src/resources/legal.py.
// V-049/V-458 LegalResource Python parity with the TS LegalResource
// (W428.B). Drift here either breaks the sync/async paired-class
// contract or strips the 3-verb surface (documents / required /
// accept), losing the consumer-side acceptance machinery.
//
//   • Module docstring frames V-049 / V-458 acceptance machinery.
//   • Two paired classes: LegalResource (sync) + AsyncLegalResource.
//   • 3 verbs each: documents / required / accept.
//   • accept body carries (document_key, version, content_hash).
//   • Imports: AsyncHttpClient + HttpClient + coerce_body (sibling
//     resources/_common helper).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/resources/legal.py');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W580.A packages/sdk-python/src/driftstack/resources/legal.py content parity', () => {
  const body = read(LIB);

  it('Module docstring + V-049/V-458 framing + ToS/Privacy/DPA/AUP + marketing-site-serves-content + this-resource-handles-catalog+acceptance pinned', () => {
    expect(body).toMatch(/^"""Legal resource — \/v1\/legal\/\* \(V-049 \/ V-458\)\.\n/);
    expect(body).toMatch(
      /Customer acceptance of legal documents \(ToS \/ Privacy \/ DPA \/ AUP\)\./,
    );
    expect(body).toMatch(/Document content is served separately on the marketing site; this/);
    expect(body).toMatch(/resource handles the catalog \+ acceptance machinery\./);
  });

  it('Imports: AsyncHttpClient + HttpClient + coerce_body from sibling _common helper; from __future__ annotations', () => {
    expect(body).toMatch(/^from __future__ import annotations$/m);
    expect(body).toMatch(/^from typing import Any$/m);
    expect(body).toMatch(/^from driftstack\.http import AsyncHttpClient, HttpClient$/m);
    expect(body).toMatch(/^from driftstack\.resources\._common import coerce_body$/m);
  });

  it('Sync LegalResource class: constructor takes HttpClient + 3 verbs (documents GET /v1/legal/documents + required GET /v1/legal/required + accept POST /v1/legal/accept with coerce_body)', () => {
    expect(body).toMatch(/^class LegalResource:$/m);
    expect(body).toMatch(/"""Synchronous legal-acceptance resource\."""/);
    expect(body).toMatch(
      /def __init__\(self, http: HttpClient\) -> None:\s*\n\s*self\._http = http/,
    );
    expect(body).toMatch(
      /def documents\(self\) -> dict\[str, Any\]:\s*\n\s*"""List the legal-document catalog\."""\s*\n\s*return self\._http\.request\("GET", "\/v1\/legal\/documents"\)/,
    );
    expect(body).toMatch(
      /def required\(self\) -> dict\[str, Any\]:\s*\n\s*"""List documents the calling account must accept \(or re-accept\)\."""\s*\n\s*return self\._http\.request\("GET", "\/v1\/legal\/required"\)/,
    );
    expect(body).toMatch(/def accept\(self, body: dict\[str, Any\]\) -> dict\[str, Any\]:/);
    expect(body).toMatch(/"""Record acceptance of a \(document, version, content_hash\) tuple\./);
    expect(body).toMatch(
      /Body: ``\{"document_key": "\.\.\.", "version": "\.\.\.", "content_hash": "<64-hex>"\}``\./,
    );
    expect(body).toMatch(/Returns 201 with the persisted record\./);
    expect(body).toMatch(
      /return self\._http\.request\("POST", "\/v1\/legal\/accept", json_body=coerce_body\(body\)\)/,
    );
  });

  it('Async AsyncLegalResource class: constructor takes AsyncHttpClient + 3 awaited verbs mirroring sync surface', () => {
    expect(body).toMatch(/^class AsyncLegalResource:$/m);
    expect(body).toMatch(/"""Async legal-acceptance resource\."""/);
    expect(body).toMatch(
      /def __init__\(self, http: AsyncHttpClient\) -> None:\s*\n\s*self\._http = http/,
    );
    expect(body).toMatch(
      /async def documents\(self\) -> dict\[str, Any\]:\s*\n\s*return await self\._http\.request\("GET", "\/v1\/legal\/documents"\)/,
    );
    expect(body).toMatch(
      /async def required\(self\) -> dict\[str, Any\]:\s*\n\s*return await self\._http\.request\("GET", "\/v1\/legal\/required"\)/,
    );
    expect(body).toMatch(
      /async def accept\(self, body: dict\[str, Any\]\) -> dict\[str, Any\]:\s*\n\s*return await self\._http\.request\("POST", "\/v1\/legal\/accept", json_body=coerce_body\(body\)\)/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});

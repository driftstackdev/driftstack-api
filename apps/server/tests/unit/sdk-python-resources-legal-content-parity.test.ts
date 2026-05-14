// W580.A (W643-deepened) — drift guard for packages/sdk-python/src/driftstack/resources/legal.py.
// V-049/V-458 LegalResource Python parity.
//
// W643 splits the 5 it() blocks (where sync + async classes each
// bundled all 3 verbs into one) into 10 focused per-verb blocks +
// pins previously-implicit invariants:
//
//   • Content-vs-catalog architectural separation (mirrors sdk-go
//     W630 — legal-doc text stays on marketing-site, NEVER on the
//     API surface).
//   • 3-tuple acceptance integrity: (document_key, version,
//     content_hash). The hash is what binds an acceptance to a
//     specific snapshot of text.
//   • content_hash "<64-hex>" format invariant in the docstring
//     (SHA-256 hex digest of the document text).
//   • 201 status-code framing on accept (resource-creation, not
//     an idempotent ack).
//   • coerce_body wrapping on accept so the Python SDK's pydantic-
//     vs-dict polymorphism stays transparent.

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

  it('file exists at canonical path + module docstring V-049/V-458 framing + ToS/Privacy/DPA/AUP scope. CRITICAL architectural invariant pinned: "Document content is served separately on the marketing site; this resource handles the catalog + acceptance machinery." Drift to surfacing document TEXT through the API would put binary legal content on the JSON surface — the load-bearing separation that keeps legal-doc PDFs/MDX on Cloudflare Pages.', () => {
    expect(existsSync(LIB)).toBe(true);
    expect(body).toMatch(/^"""Legal resource — \/v1\/legal\/\* \(V-049 \/ V-458\)\.\n/);
    expect(body).toMatch(
      /Customer acceptance of legal documents \(ToS \/ Privacy \/ DPA \/ AUP\)\./,
    );
    expect(body).toMatch(/Document content is served separately on the marketing site; this/);
    expect(body).toMatch(/resource handles the catalog \+ acceptance machinery\./);
  });

  it('Imports — 4-line surface: __future__ annotations + Any + AsyncHttpClient/HttpClient + coerce_body from sibling _common helper. coerce_body is the load-bearing import; drift to direct json_body=body would break pydantic-vs-dict polymorphism.', () => {
    expect(body).toMatch(/^from __future__ import annotations$/m);
    expect(body).toMatch(/^from typing import Any$/m);
    expect(body).toMatch(/^from driftstack\.http import AsyncHttpClient, HttpClient$/m);
    expect(body).toMatch(/^from driftstack\.resources\._common import coerce_body$/m);
  });

  it('LegalResource sync class shell + HttpClient injection', () => {
    expect(body).toMatch(/^class LegalResource:$/m);
    expect(body).toMatch(/"""Synchronous legal-acceptance resource\."""/);
    expect(body).toMatch(
      /def __init__\(self, http: HttpClient\) -> None:\s*\n\s*self\._http = http/,
    );
  });

  it('documents (sync) — GET /v1/legal/documents lists the full catalog. No body, no query params, no per-account filtering (same catalog for every account). Drift to filtering would break the "this is the public catalog" invariant.', () => {
    expect(body).toMatch(
      /def documents\(self\) -> dict\[str, Any\]:\s*\n\s*"""List the legal-document catalog\."""\s*\n\s*return self\._http\.request\("GET", "\/v1\/legal\/documents"\)/,
    );
  });

  it('required (sync) — GET /v1/legal/required lists documents the calling account must accept OR RE-ACCEPT (the parenthetical "or re-accept" is load-bearing because it tells customers an existing acceptance can become stale when a new version with a different content_hash ships). Account-scoped via bearer.', () => {
    expect(body).toMatch(
      /def required\(self\) -> dict\[str, Any\]:\s*\n\s*"""List documents the calling account must accept \(or re-accept\)\."""\s*\n\s*return self\._http\.request\("GET", "\/v1\/legal\/required"\)/,
    );
  });

  it('accept (sync) — POST /v1/legal/accept records a 3-tuple acceptance: (document_key, version, content_hash). content_hash format pinned as "<64-hex>" — SHA-256 hex digest. CRITICAL: the hash binds the acceptance to a SPECIFIC SNAPSHOT of the document text. If a customer accepts "1.2" but the text changes (content_hash drifts), their acceptance is STALE and Required will re-list the doc. 201 status framing pinned. coerce_body wrapping on the body so pydantic-or-dict callers both work.', () => {
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

  it('AsyncLegalResource — class shell + AsyncHttpClient injection. Mirrors the sync class with identical docstring + __init__ pattern.', () => {
    expect(body).toMatch(/^class AsyncLegalResource:$/m);
    expect(body).toMatch(/"""Async legal-acceptance resource\."""/);
    expect(body).toMatch(
      /def __init__\(self, http: AsyncHttpClient\) -> None:\s*\n\s*self\._http = http/,
    );
  });

  it('async documents + required — awaited GET twins. Same wire paths, no body, returns bare dict[str, Any] just like sync. No docstrings on async twins (the sync class carries the doc-comments; async twins are pure delegations).', () => {
    expect(body).toMatch(
      /async def documents\(self\) -> dict\[str, Any\]:\s*\n\s*return await self\._http\.request\("GET", "\/v1\/legal\/documents"\)/,
    );
    expect(body).toMatch(
      /async def required\(self\) -> dict\[str, Any\]:\s*\n\s*return await self\._http\.request\("GET", "\/v1\/legal\/required"\)/,
    );
  });

  it('async accept — awaited POST /v1/legal/accept twin with same coerce_body wrapping. Same 3-tuple integrity contract (document_key + version + content_hash) preserved through the async path.', () => {
    expect(body).toMatch(
      /async def accept\(self, body: dict\[str, Any\]\) -> dict\[str, Any\]:\s*\n\s*return await self\._http\.request\("POST", "\/v1\/legal\/accept", json_body=coerce_body\(body\)\)/,
    );
  });

  it('Sync/async parallel-surface invariant: both classes have exactly 3 verbs with identical wire paths (/v1/legal/documents + /v1/legal/required + /v1/legal/accept). Drift to a 4th verb in one twin but not the other would silently fragment the SDK surface.', () => {
    expect(body).toMatch(/"\/v1\/legal\/documents"/);
    expect(body).toMatch(/"\/v1\/legal\/required"/);
    expect(body).toMatch(/"\/v1\/legal\/accept"/);
    // No other /v1/legal paths should exist.
    const legalPaths = [...body.matchAll(/"\/v1\/legal\/[a-z-]+"/g)].map((m) => m[0]);
    const unique = new Set(legalPaths);
    expect(unique.size, 'expected exactly 3 distinct /v1/legal paths').toBe(3);
  });
});

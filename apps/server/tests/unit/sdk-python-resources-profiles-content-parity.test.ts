// W582.C (W645-deepened) — drift guard for packages/sdk-python/src/driftstack/resources/profiles.py.
// V-081 ProfilesResource Python parity.
//
// W645 splits the 6 it() blocks (verb-bundles for sync + async) into
// 12 focused per-verb blocks + pins previously-implicit invariants:
//
//   • V-081 framing + dict[str, Any]-pending-regen + 3 incoming
//     pydantic models (Profile + CreateProfileRequest +
//     UpdateProfileRequest).
//   • Server-side tier-limit enforcement on create (NOT client-side;
//     drift would let the SDK silently bypass per-tier caps).
//   • V-313 clone auto-derived name fallback + tier-cap parity with
//     create (same error paths).
//   • _encode_query helper: skip-None + str(v)-coerce normalisation.
//   • Conditional `body or {}` substitution on clone for nil-body
//     ergonomic (callers pass None to defer name generation entirely
//     to the server).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/resources/profiles.py');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W582.C packages/sdk-python/src/driftstack/resources/profiles.py content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path + module docstring V-081 framing + 3-pending-pydantic-model regen invariant (Profile + CreateProfileRequest + UpdateProfileRequest will surface on next generate.sh pass). "Runtime path already returns the parsed JSON shape; type-strictness lands on the next regen" framing pinned because it tells customers the wire shape is stable today even though Python typing is dict[str, Any].', () => {
    expect(existsSync(LIB)).toBe(true);
    expect(body).toMatch(/^"""Profiles resource — \/v1\/profiles \(V-081\)\.\n/);
    expect(body).toMatch(/Type annotations on request\/response bodies use ``dict\[str, Any\]``/);
    expect(body).toMatch(/pending the next ``scripts\/generate\.sh`` regeneration pass that/);
    expect(body).toMatch(
      /will add ``Profile`` \/ ``CreateProfileRequest`` \/ ``UpdateProfileRequest``/,
    );
    expect(body).toMatch(/Pydantic models to ``_generated\/models\.py``\. The runtime path/);
    expect(body).toMatch(/already returns the parsed JSON shape; type-strictness lands on the/);
    expect(body).toMatch(/next regen\./);
  });

  it('Imports — 7-line surface: __future__ + collections.abc (AsyncIterator + Iterator) + Any + urllib.parse (quote + urlencode) + Async/Sync HttpClient + iterate_paginated/aiterate_paginated + coerce_body', () => {
    expect(body).toMatch(/^from __future__ import annotations$/m);
    expect(body).toMatch(/^from collections\.abc import AsyncIterator, Iterator$/m);
    expect(body).toMatch(/^from typing import Any$/m);
    expect(body).toMatch(/^from urllib\.parse import quote, urlencode$/m);
    expect(body).toMatch(/^from driftstack\.http import AsyncHttpClient, HttpClient$/m);
    expect(body).toMatch(
      /^from driftstack\.pagination import aiterate_paginated, iterate_paginated$/m,
    );
    expect(body).toMatch(/^from driftstack\.resources\._common import coerce_body$/m);
  });

  it('_encode_query helper — skip-None + str(v)-coerce + urlencode. Same shape across profiles + profile_snapshots + audit_log (each owns its own helper per file to avoid cross-resource coupling).', () => {
    expect(body).toMatch(/^def _encode_query\(query: dict\[str, Any\]\) -> str:$/m);
    expect(body).toMatch(
      /items: list\[tuple\[str, str\]\] = \[\]\s*\n\s*for key, value in query\.items\(\):\s*\n\s*if value is None:\s*\n\s*continue\s*\n\s*items\.append\(\(key, str\(value\)\)\)\s*\n\s*return urlencode\(items\)/,
    );
  });

  it('ProfilesResource sync class shell + HttpClient injection', () => {
    expect(body).toMatch(/^class ProfilesResource:$/m);
    expect(body).toMatch(/"""Synchronous profiles resource\."""/);
    expect(body).toMatch(
      /def __init__\(self, http: HttpClient\) -> None:\s*\n\s*self\._http = http/,
    );
  });

  it('create (sync) — POST /v1/profiles + "Tier-limit enforced server-side" framing pinned. Server-side enforcement is load-bearing because the SDK does NOT pre-check the tier; drift to client-side enforcement would race with subscription downgrades. coerce_body wrapping handles pydantic-or-dict polymorphism.', () => {
    expect(body).toMatch(
      /def create\(self, body: dict\[str, Any\]\) -> dict\[str, Any\]:\s*\n\s*"""Create a profile\. Tier-limit enforced server-side\."""\s*\n\s*return self\._http\.request\("POST", "\/v1\/profiles", json_body=coerce_body\(body\)\)/,
    );
  });

  it('list (sync) — GET /v1/profiles with kwarg-only (limit/cursor) + _encode_query + conditional "?qs" suffix. Same path-builder pattern as profile_snapshots.list / audit_log.list — cross-resource consistency.', () => {
    // V-1126 — signature and docstring asserted separately. The chained form
    // spanned both, so correcting the scope broke a pin about the def line —
    // the fifth time this arc.
    expect(body).toMatch(/def list\(self, \*, limit/);
    expect(body).toMatch(/for the EFFECTIVE account/);
    expect(body, 'the current-account claim must not return').not.toMatch(
      /for the current account/,
    );
  });

  it('iterate (sync) — lazy cursor-walking wrapper. Returns Iterator[dict[str, Any]]. Closure captures limit only (cursor managed internally by iterate_paginated). Delegates to driftstack.pagination.iterate_paginated.', () => {
    expect(body).toMatch(
      /def iterate\(self, \*, limit: int \| None = None\) -> Iterator\[dict\[str, Any\]\]:\s*\n\s*"""Lazily walk every profile, handling cursor handoff\."""\s*\n\s*def fetch_page\(cursor: str \| None\) -> dict\[str, Any\]:\s*\n\s*return self\.list\(limit=limit, cursor=cursor\)\s*\n\s*return iterate_paginated\(fetch_page\)/,
    );
  });

  it('get + update + delete (sync) — 3 per-id verbs, all URL-escape profile_id via quote(safe=""). update is PATCH (partial-update; drift to PUT would invite full-resource rewrites). delete returns None (Python 204-no-content idiom).', () => {
    expect(body).toMatch(
      /def get\(self, profile_id: str\) -> dict\[str, Any\]:\s*\n\s*return self\._http\.request\("GET", f"\/v1\/profiles\/\{quote\(profile_id, safe=''\)\}"\)/,
    );
    expect(body).toMatch(
      /def update\(self, profile_id: str, body: dict\[str, Any\]\) -> dict\[str, Any\]:\s*\n\s*return self\._http\.request\(\s*\n\s*"PATCH",\s*\n\s*f"\/v1\/profiles\/\{quote\(profile_id, safe=''\)\}",\s*\n\s*json_body=coerce_body\(body\),\s*\n\s*\)/,
    );
    expect(body).toMatch(
      /def delete\(self, profile_id: str\) -> None:\s*\n\s*self\._http\.request\("DELETE", f"\/v1\/profiles\/\{quote\(profile_id, safe=''\)\}"\)/,
    );
  });

  it('clone (sync) — V-313 POST /v1/profiles/{quote(id)}/clone with optional body. CRITICAL framing: "Server auto-derives \\"(copy)\\" / \\"(copy 2)\\" / ... name when body[\\"name\\"] is omitted. Tier-cap + name-conflict checked the same as create." Drift to client-side auto-naming would mean two SDK calls could race to "(copy)" and conflict — the server-side derivation guarantees serialization. `body or {}` nil-body fallback so callers can pass None to fully defer to server.', () => {
    expect(body).toMatch(
      /def clone\(self, profile_id: str, body: dict\[str, Any\] \| None = None\) -> dict\[str, Any\]:/,
    );
    expect(body).toMatch(
      /"""V-313 — duplicate a profile\. Server auto-derives "\(copy\)" \/ "\(copy 2\)" \//,
    );
    expect(body).toMatch(
      /\.\.\. name when ``body\["name"\]`` is omitted\. Tier-cap \+ name-conflict/,
    );
    expect(body).toMatch(/checked the same as ``create``\."""/);
    expect(body).toMatch(
      /return self\._http\.request\(\s*\n\s*"POST",\s*\n\s*f"\/v1\/profiles\/\{quote\(profile_id, safe=''\)\}\/clone",\s*\n\s*json_body=coerce_body\(body or \{\}\),\s*\n\s*\)/,
    );
  });

  it('AsyncProfilesResource — class shell + AsyncHttpClient injection. Mirrors sync class.', () => {
    expect(body).toMatch(/^class AsyncProfilesResource:$/m);
    expect(body).toMatch(/"""Async profiles resource\."""/);
    expect(body).toMatch(
      /def __init__\(self, http: AsyncHttpClient\) -> None:\s*\n\s*self\._http = http/,
    );
  });

  it('async create + list + get + update + delete + clone — awaited verb twins with same wire paths + same coerce_body + same quote-escape + same `body or {}` clone fallback. async delete returns None matching sync.', () => {
    expect(body).toMatch(
      /async def create\(self, body: dict\[str, Any\]\) -> dict\[str, Any\]:\s*\n\s*return await self\._http\.request\("POST", "\/v1\/profiles", json_body=coerce_body\(body\)\)/,
    );
    expect(body).toMatch(
      /async def get\(self, profile_id: str\) -> dict\[str, Any\]:\s*\n\s*return await self\._http\.request\("GET", f"\/v1\/profiles\/\{quote\(profile_id, safe=''\)\}"\)/,
    );
    expect(body).toMatch(
      /async def delete\(self, profile_id: str\) -> None:\s*\n\s*await self\._http\.request\("DELETE", f"\/v1\/profiles\/\{quote\(profile_id, safe=''\)\}"\)/,
    );
    // L4b recycle bin — async mirror of the sync list_trash/restore/purge.
    expect(body).toMatch(
      /async def list_trash\(self\) -> dict\[str, Any\]:[\s\S]*?await self\._http\.request\("GET", "\/v1\/profiles\/trash"\)/,
    );
    expect(body).toMatch(
      /async def restore\(self, profile_id: str\) -> dict\[str, Any\]:[\s\S]*?await self\._http\.request\(\s*\n\s*"POST", f"\/v1\/profiles\/\{quote\(profile_id, safe=''\)\}\/restore"\s*\n\s*\)/,
    );
    expect(body).toMatch(
      /async def purge\(self, profile_id: str\) -> None:[\s\S]*?await self\._http\.request\("DELETE", f"\/v1\/profiles\/\{quote\(profile_id, safe=''\)\}\/purge"\)/,
    );
    expect(body).toMatch(
      /async def clone\(self, profile_id: str, body: dict\[str, Any\] \| None = None\) -> dict\[str, Any\]:\s*\n\s*return await self\._http\.request\(\s*\n\s*"POST",\s*\n\s*f"\/v1\/profiles\/\{quote\(profile_id, safe=''\)\}\/clone",\s*\n\s*json_body=coerce_body\(body or \{\}\),\s*\n\s*\)/,
    );
  });

  it('async iterate — stays SYNC def returning AsyncIterator (Python idiom — `async for p in profiles.iterate()`). Short ":meth: cross-ref" docstring delegates to sync method. Delegates to aiterate_paginated.', () => {
    expect(body).toMatch(
      /def iterate\(self, \*, limit: int \| None = None\) -> AsyncIterator\[dict\[str, Any\]\]:\s*\n\s*"""Async variant of :meth:`ProfilesResource\.iterate`\."""\s*\n\s*async def fetch_page\(cursor: str \| None\) -> dict\[str, Any\]:\s*\n\s*return await self\.list\(limit=limit, cursor=cursor\)\s*\n\s*return aiterate_paginated\(fetch_page\)/,
    );
  });
});

// W584.C (W644-deepened) — drift guard for packages/sdk-python/src/driftstack/resources/profile_snapshots.py.
// V-312 ProfileSnapshotsResource Python parity.
//
// W644 splits the 6 it() blocks (where the 7-verb surface was crammed
// into 2 verbs-bundle blocks for sync + async) into 13 focused per-
// concept blocks + pins previously-implicit invariants:
//
//   • V-312 immutable-point-in-time contract (mirrors sdk-go W629).
//   • Two listing surfaces parity: list_for_profile narrows to one
//     parent (GET /v1/profiles/{id}/snapshots), list spans the whole
//     calling account (GET /v1/profile-snapshots).
//   • restore tier-cap + name-conflict parity with profiles.create
//     (same error paths).
//   • delete returns None (Python 204 idiom).
//   • quote(snapshot_id, safe='') on every per-id verb so a malformed
//     id cannot inject path traversal.
//   • _encode_query helper: skip-None + str(v)-coerce normalisation.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/resources/profile_snapshots.py');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W584.C packages/sdk-python/src/driftstack/resources/profile_snapshots.py content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path + module docstring V-312 framing + dual-endpoint scope (/v1/profiles/:id/snapshots + /v1/profile-snapshots) + immutable-point-in-time-copies invariant + ProfileSnapshot pydantic models pending regen', () => {
    expect(existsSync(LIB)).toBe(true);
    expect(body).toMatch(/^"""Profile snapshots resource — \/v1\/profiles\/:id\/snapshots \+/);
    expect(body).toMatch(/\/v1\/profile-snapshots \(V-312\)\. Immutable point-in-time copies of/);
    expect(body).toMatch(/saved profiles\./);
    expect(body).toMatch(/Type annotations on request\/response bodies use ``dict\[str, Any\]``/);
    expect(body).toMatch(/pending the next ``scripts\/generate\.sh`` regeneration pass that/);
    expect(body).toMatch(
      /will add ``ProfileSnapshot`` Pydantic models to ``_generated\/models\.py``\./,
    );
  });

  it('Imports — 7-line surface: __future__ + collections.abc (AsyncIterator + Iterator) + Any + urllib.parse (BOTH quote + urlencode — quote for path segments, urlencode for ?queries) + Async/Sync HttpClient + iterate_paginated/aiterate_paginated + coerce_body. Drift to importing only one of quote/urlencode would force hand-rolled escape on one path family.', () => {
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

  it('_encode_query helper — module-level query-string builder. Skip-None + str(value)-coerce + urlencode. Same shape as audit_log._qs but named differently (each resource module owns its own helper to avoid cross-resource coupling).', () => {
    expect(body).toMatch(
      /^def _encode_query\(query: dict\[str, Any\]\) -> str:\s*\n\s*items: list\[tuple\[str, str\]\] = \[\]\s*\n\s*for key, value in query\.items\(\):\s*\n\s*if value is None:\s*\n\s*continue\s*\n\s*items\.append\(\(key, str\(value\)\)\)\s*\n\s*return urlencode\(items\)/m,
    );
  });

  it('ProfileSnapshotsResource sync class shell + HttpClient injection', () => {
    expect(body).toMatch(/^class ProfileSnapshotsResource:$/m);
    expect(body).toMatch(/"""Synchronous profile snapshots resource\."""/);
    expect(body).toMatch(
      /def __init__\(self, http: HttpClient\) -> None:\s*\n\s*self\._http = http/,
    );
  });

  it('capture (sync) — POST /v1/profiles/{quote(profile_id)}/snapshots takes parent profile_id + body. Wire path embeds the PARENT profile id (not the snapshot id — capture mints a new one server-side). coerce_body wrapping. URL-escapes profile_id.', () => {
    expect(body).toMatch(
      /def capture\(self, profile_id: str, body: dict\[str, Any\]\) -> dict\[str, Any\]:\s*\n\s*"""Capture a snapshot of an existing profile\."""\s*\n\s*return self\._http\.request\(\s*\n\s*"POST",\s*\n\s*f"\/v1\/profiles\/\{quote\(profile_id, safe=''\)\}\/snapshots",\s*\n\s*json_body=coerce_body\(body\),\s*\n\s*\)/,
    );
  });

  it('list_for_profile (sync) vs list (sync) — TWO listing surfaces parity. list_for_profile narrows to ONE parent profile (GET /v1/profiles/{id}/snapshots, requires profile_id positional). list spans the WHOLE calling account (GET /v1/profile-snapshots, no positional). Both use _encode_query for the limit/cursor query; both have kwarg-only signatures. Drift to merging them would force callers to always pass a profile_id even for account-wide queries.', () => {
    expect(body).toMatch(
      /def list_for_profile\(\s*\n\s*self,\s*\n\s*profile_id: str,\s*\n\s*\*,\s*\n\s*limit: int \| None = None,\s*\n\s*cursor: str \| None = None,\s*\n\s*\) -> dict\[str, Any\]:\s*\n\s*"""List snapshots for one profile, newest-first\."""\s*\n\s*qs = _encode_query\(\{"limit": limit, "cursor": cursor\}\)\s*\n\s*path = f"\/v1\/profiles\/\{quote\(profile_id, safe=''\)\}\/snapshots"\s*\n\s*if qs:\s*\n\s*path = f"\{path\}\?\{qs\}"\s*\n\s*return self\._http\.request\("GET", path\)/,
    );
    // V-1121 — the signature and the docstring are asserted separately now.
    // The single chained regex this replaced ran from `def list(` through the
    // docstring text, so correcting the docstring broke a pin about the
    // SIGNATURE — the same coupling V-1092 had to split on the auth resource.
    expect(body).toMatch(
      /def list\(self, \*, limit: int \| None = None, cursor: str \| None = None\) -> dict\[str, Any\]:/,
    );
    expect(body).toMatch(/"""List every snapshot owned by the EFFECTIVE account\./);
    expect(body, 'the calling-account claim must not return').not.toMatch(
      /"""List every snapshot owned by the calling account\./,
    );
  });

  it('iterate (sync) — lazy cursor-walking wrapper returning Iterator[dict[str, Any]]. Wraps the account-wide list() (NOT list_for_profile) so customers walking iterate get every snapshot across all parent profiles. Closure captures `limit` only (no profile narrowing on iterate by design). Delegates to driftstack.pagination.iterate_paginated.', () => {
    expect(body).toMatch(
      /def iterate\(self, \*, limit: int \| None = None\) -> Iterator\[dict\[str, Any\]\]:\s*\n\s*"""Lazily walk every snapshot, handling cursor handoff\."""\s*\n\s*def fetch_page\(cursor: str \| None\) -> dict\[str, Any\]:\s*\n\s*return self\.list\(limit=limit, cursor=cursor\)\s*\n\s*return iterate_paginated\(fetch_page\)/,
    );
  });

  it('get (sync) — GET /v1/profile-snapshots/{quote(snapshot_id)}. No body, no docstring (the V-312 framing at module level covers it). URL-escapes snapshot_id with safe="" so even / gets encoded.', () => {
    expect(body).toMatch(
      /def get\(self, snapshot_id: str\) -> dict\[str, Any\]:\s*\n\s*return self\._http\.request\("GET", f"\/v1\/profile-snapshots\/\{quote\(snapshot_id, safe=''\)\}"\)/,
    );
  });

  it('restore (sync) — POST /v1/profile-snapshots/{quote(snapshot_id)}/restore mints a NEW profile from a frozen snapshot. CRITICAL framing: "Tier-cap + name-conflict checked" — same error paths as profiles.create, so customers reuse the same TierLimitError catch. Returns dict (NOT a snapshot — restore mints a fresh editable profile). coerce_body wrapping.', () => {
    expect(body).toMatch(
      /def restore\(self, snapshot_id: str, body: dict\[str, Any\]\) -> dict\[str, Any\]:\s*\n\s*"""Restore into a new profile\. Tier-cap \+ name-conflict checked\."""\s*\n\s*return self\._http\.request\(\s*\n\s*"POST",\s*\n\s*f"\/v1\/profile-snapshots\/\{quote\(snapshot_id, safe=''\)\}\/restore",\s*\n\s*json_body=coerce_body\(body\),\s*\n\s*\)/,
    );
  });

  it('delete (sync) — DELETE /v1/profile-snapshots/{quote(snapshot_id)} returns None (Python 204 idiom). No docstring — simple destructive verb. URL-escape on snapshot_id same as other per-id verbs.', () => {
    expect(body).toMatch(
      /def delete\(self, snapshot_id: str\) -> None:\s*\n\s*self\._http\.request\("DELETE", f"\/v1\/profile-snapshots\/\{quote\(snapshot_id, safe=''\)\}"\)/,
    );
  });

  it('AsyncProfileSnapshotsResource — class shell + AsyncHttpClient injection. Same 7-verb surface as sync.', () => {
    expect(body).toMatch(/^class AsyncProfileSnapshotsResource:$/m);
    expect(body).toMatch(/"""Async profile snapshots resource\."""/);
    expect(body).toMatch(
      /def __init__\(self, http: AsyncHttpClient\) -> None:\s*\n\s*self\._http = http/,
    );
  });

  it('async capture + list_for_profile + list + get + restore + delete — awaited verb twins. Same wire paths + same coerce_body wrapping + same quote-escape + same _encode_query helper. async delete returns None (matches sync).', () => {
    expect(body).toMatch(
      /async def capture\(self, profile_id: str, body: dict\[str, Any\]\) -> dict\[str, Any\]:\s*\n\s*return await self\._http\.request\(\s*\n\s*"POST",\s*\n\s*f"\/v1\/profiles\/\{quote\(profile_id, safe=''\)\}\/snapshots",\s*\n\s*json_body=coerce_body\(body\),\s*\n\s*\)/,
    );
    expect(body).toMatch(
      /async def get\(self, snapshot_id: str\) -> dict\[str, Any\]:\s*\n\s*return await self\._http\.request\(\s*\n\s*"GET", f"\/v1\/profile-snapshots\/\{quote\(snapshot_id, safe=''\)\}"\s*\n\s*\)/,
    );
    expect(body).toMatch(
      /async def restore\(self, snapshot_id: str, body: dict\[str, Any\]\) -> dict\[str, Any\]:\s*\n\s*return await self\._http\.request\(\s*\n\s*"POST",\s*\n\s*f"\/v1\/profile-snapshots\/\{quote\(snapshot_id, safe=''\)\}\/restore",\s*\n\s*json_body=coerce_body\(body\),\s*\n\s*\)/,
    );
    expect(body).toMatch(
      /async def delete\(self, snapshot_id: str\) -> None:\s*\n\s*await self\._http\.request\("DELETE", f"\/v1\/profile-snapshots\/\{quote\(snapshot_id, safe=''\)\}"\)/,
    );
  });

  it('async iterate — stays a SYNCHRONOUS def returning AsyncIterator (Python idiom: `async for x in snaps.iterate()`). Delegates to aiterate_paginated. Inner async fetch_page closure with `return await self.list(...)`. Drift to `async def iterate` would force callers to `await snaps.iterate()` then iterate, breaking the standard async-iteration pattern.', () => {
    expect(body).toMatch(
      /def iterate\(self, \*, limit: int \| None = None\) -> AsyncIterator\[dict\[str, Any\]\]:\s*\n\s*async def fetch_page\(cursor: str \| None\) -> dict\[str, Any\]:\s*\n\s*return await self\.list\(limit=limit, cursor=cursor\)\s*\n\s*return aiterate_paginated\(fetch_page\)/,
    );
  });
});

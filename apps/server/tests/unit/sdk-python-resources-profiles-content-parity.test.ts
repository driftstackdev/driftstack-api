// W582.C — drift guard for packages/sdk-python/src/resources/profiles.py.
// V-081 ProfilesResource Python parity. Drift here either drops the
// V-313 clone with auto-derived name fallback or breaks the iterate()
// lazy-pagination wrapper around list().
//
//   • 7 verbs each: create / list / iterate / get / update / delete /
//     clone.
//   • _encode_query helper skips None values + urlencodes.
//   • iterate() delegates to iterate_paginated/aiterate_paginated.
//   • clone() V-313: server auto-derives "(copy)" / "(copy 2)" name
//     when body["name"] omitted; tier-cap + name-conflict checked
//     same as create.
//   • dict[str, Any] pending generate.sh regen (Profile /
//     CreateProfileRequest / UpdateProfileRequest pydantic models
//     surface on next pass).

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

  it('Module docstring + V-081 framing + dict[str, Any]-pending-regen pinned (Profile / CreateProfileRequest / UpdateProfileRequest models incoming)', () => {
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

  it('Imports: __future__ + collections.abc Async/Iterator + urllib.parse quote+urlencode + AsyncHttpClient/HttpClient + pagination helpers + coerce_body pinned', () => {
    expect(body).toMatch(/^from __future__ import annotations$/m);
    expect(body).toMatch(/^from collections\.abc import AsyncIterator, Iterator$/m);
    expect(body).toMatch(/^from urllib\.parse import quote, urlencode$/m);
    expect(body).toMatch(/^from driftstack\.http import AsyncHttpClient, HttpClient$/m);
    expect(body).toMatch(
      /^from driftstack\.pagination import aiterate_paginated, iterate_paginated$/m,
    );
    expect(body).toMatch(/^from driftstack\.resources\._common import coerce_body$/m);
  });

  it('_encode_query helper: skips None values + (key, str(value)) tuples + urlencode normalisation', () => {
    expect(body).toMatch(/^def _encode_query\(query: dict\[str, Any\]\) -> str:$/m);
    expect(body).toMatch(
      /items: list\[tuple\[str, str\]\] = \[\]\s*\n\s*for key, value in query\.items\(\):\s*\n\s*if value is None:\s*\n\s*continue\s*\n\s*items\.append\(\(key, str\(value\)\)\)\s*\n\s*return urlencode\(items\)/,
    );
  });

  it('Sync ProfilesResource: 7 verbs — create (tier-cap enforced) + list (limit/cursor kwarg-only) + iterate (lazy walk) + get/update/delete (quote-escaped id) + clone V-313 auto-derived name + tier-cap', () => {
    expect(body).toMatch(/^class ProfilesResource:$/m);
    expect(body).toMatch(
      /def create\(self, body: dict\[str, Any\]\) -> dict\[str, Any\]:\s*\n\s*"""Create a profile\. Tier-limit enforced server-side\."""\s*\n\s*return self\._http\.request\("POST", "\/v1\/profiles", json_body=coerce_body\(body\)\)/,
    );
    expect(body).toMatch(
      /def list\(self, \*, limit: int \| None = None, cursor: str \| None = None\) -> dict\[str, Any\]:\s*\n\s*"""List profiles for the current account\."""\s*\n\s*qs = _encode_query\(\{"limit": limit, "cursor": cursor\}\)\s*\n\s*path = "\/v1\/profiles" \+ \(f"\?\{qs\}" if qs else ""\)\s*\n\s*return self\._http\.request\("GET", path\)/,
    );
    expect(body).toMatch(
      /def iterate\(self, \*, limit: int \| None = None\) -> Iterator\[dict\[str, Any\]\]:\s*\n\s*"""Lazily walk every profile, handling cursor handoff\."""/,
    );
    expect(body).toMatch(/return iterate_paginated\(fetch_page\)/);
    expect(body).toMatch(
      /def get\(self, profile_id: str\) -> dict\[str, Any\]:\s*\n\s*return self\._http\.request\("GET", f"\/v1\/profiles\/\{quote\(profile_id, safe=''\)\}"\)/,
    );
    expect(body).toMatch(
      /def update\(self, profile_id: str, body: dict\[str, Any\]\) -> dict\[str, Any\]:\s*\n\s*return self\._http\.request\(\s*\n\s*"PATCH",\s*\n\s*f"\/v1\/profiles\/\{quote\(profile_id, safe=''\)\}",\s*\n\s*json_body=coerce_body\(body\),\s*\n\s*\)/,
    );
    expect(body).toMatch(
      /def delete\(self, profile_id: str\) -> None:\s*\n\s*self\._http\.request\("DELETE", f"\/v1\/profiles\/\{quote\(profile_id, safe=''\)\}"\)/,
    );
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
      /f"\/v1\/profiles\/\{quote\(profile_id, safe=''\)\}\/clone",\s*\n\s*json_body=coerce_body\(body or \{\}\)/,
    );
  });

  it('Async AsyncProfilesResource: mirrored awaited 7-verb surface; iterate stays sync def that returns AsyncIterator + delegates to aiterate_paginated', () => {
    expect(body).toMatch(/^class AsyncProfilesResource:$/m);
    expect(body).toMatch(
      /def iterate\(self, \*, limit: int \| None = None\) -> AsyncIterator\[dict\[str, Any\]\]:/,
    );
    expect(body).toMatch(/"""Async variant of :meth:`ProfilesResource\.iterate`\."""/);
    expect(body).toMatch(
      /async def fetch_page\(cursor: str \| None\) -> dict\[str, Any\]:\s*\n\s*return await self\.list\(limit=limit, cursor=cursor\)/,
    );
    expect(body).toMatch(/return aiterate_paginated\(fetch_page\)/);
    expect(body).toMatch(
      /async def clone\(self, profile_id: str, body: dict\[str, Any\] \| None = None\) -> dict\[str, Any\]:/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});

// W584.C — drift guard for packages/sdk-python/src/resources/profile_snapshots.py.
// V-312 ProfileSnapshotsResource Python parity. Drift here either
// breaks the immutable-point-in-time-copy framing or drops the
// restore-with-tier-cap-and-name-conflict invariant.
//
//   • 7 verbs each: capture / list_for_profile / list / iterate /
//     get / restore / delete.
//   • list_for_profile narrows to one profile; list spans the
//     account; iterate lazy-walks via iterate_paginated.
//   • restore() into NEW profile; tier-cap + name-conflict checked.
//   • dict[str, Any] pending generate.sh regen pass (ProfileSnapshot
//     pydantic models incoming).

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

  it('Module docstring + /v1/profiles/:id/snapshots + /v1/profile-snapshots V-312 framing + immutable-point-in-time-copies + ProfileSnapshot-pending-regen pinned', () => {
    expect(body).toMatch(/^"""Profile snapshots resource — \/v1\/profiles\/:id\/snapshots \+/);
    expect(body).toMatch(/\/v1\/profile-snapshots \(V-312\)\. Immutable point-in-time copies of/);
    expect(body).toMatch(/saved profiles\./);
    expect(body).toMatch(/Type annotations on request\/response bodies use ``dict\[str, Any\]``/);
    expect(body).toMatch(/pending the next ``scripts\/generate\.sh`` regeneration pass that/);
    expect(body).toMatch(
      /will add ``ProfileSnapshot`` Pydantic models to ``_generated\/models\.py``\./,
    );
  });

  it('Imports: __future__ + collections.abc Async/Iterator + urllib.parse quote+urlencode + AsyncHttpClient/HttpClient + iterate_paginated/aiterate_paginated + coerce_body', () => {
    expect(body).toMatch(/^from collections\.abc import AsyncIterator, Iterator$/m);
    expect(body).toMatch(/^from urllib\.parse import quote, urlencode$/m);
    expect(body).toMatch(/^from driftstack\.http import AsyncHttpClient, HttpClient$/m);
    expect(body).toMatch(
      /^from driftstack\.pagination import aiterate_paginated, iterate_paginated$/m,
    );
    expect(body).toMatch(/^from driftstack\.resources\._common import coerce_body$/m);
  });

  it('_encode_query helper: skip-None + (key, str(value)) urlencode normalisation', () => {
    expect(body).toMatch(
      /^def _encode_query\(query: dict\[str, Any\]\) -> str:\s*\n\s*items: list\[tuple\[str, str\]\] = \[\]\s*\n\s*for key, value in query\.items\(\):\s*\n\s*if value is None:\s*\n\s*continue\s*\n\s*items\.append\(\(key, str\(value\)\)\)\s*\n\s*return urlencode\(items\)/m,
    );
  });

  it('Sync ProfileSnapshotsResource: 7 verbs — capture(profile_id, body) POST + list_for_profile(profile_id, limit/cursor) narrows-to-one + list(limit/cursor) account-wide + iterate lazy walk + get/restore/delete quote()-escaped snapshot_id', () => {
    expect(body).toMatch(/^class ProfileSnapshotsResource:$/m);
    expect(body).toMatch(
      /def capture\(self, profile_id: str, body: dict\[str, Any\]\) -> dict\[str, Any\]:\s*\n\s*"""Capture a snapshot of an existing profile\."""/,
    );
    expect(body).toMatch(/f"\/v1\/profiles\/\{quote\(profile_id, safe=''\)\}\/snapshots"/);
    expect(body).toMatch(
      /def list_for_profile\(\s*\n\s*self,\s*\n\s*profile_id: str,\s*\n\s*\*,\s*\n\s*limit: int \| None = None,\s*\n\s*cursor: str \| None = None,\s*\n\s*\) -> dict\[str, Any\]:\s*\n\s*"""List snapshots for one profile, newest-first\."""/,
    );
    expect(body).toMatch(
      /def list\(self, \*, limit: int \| None = None, cursor: str \| None = None\) -> dict\[str, Any\]:\s*\n\s*"""List every snapshot owned by the calling account\."""\s*\n\s*qs = _encode_query\(\{"limit": limit, "cursor": cursor\}\)\s*\n\s*path = "\/v1\/profile-snapshots" \+ \(f"\?\{qs\}" if qs else ""\)\s*\n\s*return self\._http\.request\("GET", path\)/,
    );
    expect(body).toMatch(
      /def iterate\(self, \*, limit: int \| None = None\) -> Iterator\[dict\[str, Any\]\]:\s*\n\s*"""Lazily walk every snapshot, handling cursor handoff\."""/,
    );
    expect(body).toMatch(/return iterate_paginated\(fetch_page\)/);
    expect(body).toMatch(/def get\(self, snapshot_id: str\) -> dict\[str, Any\]:/);
    expect(body).toMatch(/f"\/v1\/profile-snapshots\/\{quote\(snapshot_id, safe=''\)\}"/);
    expect(body).toMatch(
      /def restore\(self, snapshot_id: str, body: dict\[str, Any\]\) -> dict\[str, Any\]:\s*\n\s*"""Restore into a new profile\. Tier-cap \+ name-conflict checked\."""/,
    );
    expect(body).toMatch(/f"\/v1\/profile-snapshots\/\{quote\(snapshot_id, safe=''\)\}\/restore"/);
    expect(body).toMatch(
      /def delete\(self, snapshot_id: str\) -> None:\s*\n\s*self\._http\.request\("DELETE", f"\/v1\/profile-snapshots\/\{quote\(snapshot_id, safe=''\)\}"\)/,
    );
  });

  it('Async AsyncProfileSnapshotsResource: mirrored awaited 7-verb surface + iterate stays sync def returning AsyncIterator', () => {
    expect(body).toMatch(/^class AsyncProfileSnapshotsResource:$/m);
    expect(body).toMatch(
      /async def capture\(self, profile_id: str, body: dict\[str, Any\]\) -> dict\[str, Any\]:/,
    );
    expect(body).toMatch(
      /def iterate\(self, \*, limit: int \| None = None\) -> AsyncIterator\[dict\[str, Any\]\]:/,
    );
    expect(body).toMatch(/return aiterate_paginated\(fetch_page\)/);
    expect(body).toMatch(
      /async def restore\(self, snapshot_id: str, body: dict\[str, Any\]\) -> dict\[str, Any\]:/,
    );
    expect(body).toMatch(
      /async def delete\(self, snapshot_id: str\) -> None:\s*\n\s*await self\._http\.request\("DELETE", f"\/v1\/profile-snapshots\/\{quote\(snapshot_id, safe=''\)\}"\)/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});

// W581.B (W643-deepened) — drift guard for packages/sdk-python/src/driftstack/resources/audit_log.py.
// V-216/V-449/V-462/V-297 AuditLogResource Python parity.
//
// W643 splits the 5 it() blocks (where sync + async classes bundled
// all verbs each) into 11 focused per-concept blocks + pins
// previously-implicit invariants:
//
//   • V-216/V-449 append-only-ledger contract (mirrors sdk-go W636).
//   • V-462/V-297 GDPR Article 20 portability export 10k row cap +
//     truncated bool flag + CSV-out-of-band (only JSON via this SDK;
//     CSV requires direct bearer call).
//   • _qs() helper invariants: skips None values + urlencodes as
//     str(v) coercion. Drift would break the "absent kwarg →
//     defer to server" ergonomic across every verb that uses it.
//   • iterate() lazy-pagination wrapper delegates to
//     iterate_paginated / aiterate_paginated helpers from
//     driftstack.pagination — drift to hand-rolled cursor walking
//     would diverge from the cross-resource pagination pattern.
//   • Closure capture of (limit, action) into the per-page fetch
//     callback — kwarg filter persists across all pages.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/resources/audit_log.py');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W581.B packages/sdk-python/src/driftstack/resources/audit_log.py content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path + module docstring V-216/V-449 framing + append-only-event-ledger contract pinned. Drift to dropping the append-only framing would let a future "edit/delete" verb sneak in and silently break the compliance-audit story.', () => {
    expect(existsSync(LIB)).toBe(true);
    expect(body).toMatch(
      /^"""Audit log resource — \/v1\/account\/audit-log \(V-216 \/ V-449\)\.\n/,
    );
    expect(body).toMatch(/Append-only event ledger for compliance \/ monitoring\. Returns/);
    expect(body).toMatch(/``dict\[str, Any\]`` pending the next regen pass\./);
  });

  it('Imports — 6-line surface: __future__ + collections.abc (AsyncIterator + Iterator for typed-iter returns) + Any + urllib.parse.urlencode + Async/Sync HttpClient + iterate_paginated/aiterate_paginated from driftstack.pagination. The pagination-helper import is load-bearing — drift to hand-rolling cursor walking would diverge from the cross-resource pattern.', () => {
    expect(body).toMatch(/^from __future__ import annotations$/m);
    expect(body).toMatch(/^from collections\.abc import AsyncIterator, Iterator$/m);
    expect(body).toMatch(/^from typing import Any$/m);
    expect(body).toMatch(/^from urllib\.parse import urlencode$/m);
    expect(body).toMatch(/^from driftstack\.http import AsyncHttpClient, HttpClient$/m);
    expect(body).toMatch(
      /^from driftstack\.pagination import aiterate_paginated, iterate_paginated$/m,
    );
  });

  it('_qs helper — module-level query-string builder. Skips None values + str(v)-coerces remaining + urlencodes. Drift to including None would emit "?limit=None" silly strings that the server-side would reject. Drift to dropping str(v) would break int kwargs (urlencode wants str).', () => {
    expect(body).toMatch(/^def _qs\(query: dict\[str, Any\]\) -> str:$/m);
    expect(body).toMatch(
      /items: list\[tuple\[str, str\]\] = \[\]\s*\n\s*for k, v in query\.items\(\):\s*\n\s*if v is None:\s*\n\s*continue\s*\n\s*items\.append\(\(k, str\(v\)\)\)\s*\n\s*return urlencode\(items\)/,
    );
  });

  it('AuditLogResource sync class shell + HttpClient injection', () => {
    expect(body).toMatch(/^class AuditLogResource:$/m);
    expect(body).toMatch(/"""Synchronous audit-log resource\."""/);
    expect(body).toMatch(
      /def __init__\(self, http: HttpClient\) -> None:\s*\n\s*self\._http = http/,
    );
  });

  it('list (sync) — GET /v1/account/audit-log with 3 kwarg-only params (limit/cursor/action), all defaulting to None. Action filter scopes to one event type so dashboards can narrow without client-side filtering. Query-string built via _qs (skips None → defers to server defaults). Conditional `+ (f"?{qs}" if qs else "")` so empty-filter call emits clean /v1/account/audit-log without trailing "?".', () => {
    expect(body).toMatch(
      /def list\(\s*\n\s*self,\s*\n\s*\*,\s*\n\s*limit: int \| None = None,\s*\n\s*cursor: str \| None = None,\s*\n\s*action: str \| None = None,\s*\n\s*\) -> dict\[str, Any\]:/,
    );
    expect(body).toMatch(
      /"""List audit-log entries newest-first\. ``action`` filters to a single event type\."""/,
    );
    expect(body).toMatch(
      /qs = _qs\(\{"limit": limit, "cursor": cursor, "action": action\}\)\s*\n\s*path = "\/v1\/account\/audit-log" \+ \(f"\?\{qs\}" if qs else ""\)\s*\n\s*return self\._http\.request\("GET", path\)/,
    );
  });

  it('iterate (sync) — lazy cursor-walking wrapper. Returns Iterator[dict[str, Any]] (typed iter, not eager list). Closure captures (limit, action) into the fetch_page callback so the filter PERSISTS across pages — drift to dropping the kwargs from the closure would silently broaden the iteration mid-walk. Delegates to driftstack.pagination.iterate_paginated for the actual cursor handoff (cross-resource shared helper).', () => {
    expect(body).toMatch(
      /def iterate\(\s*\n\s*self,\s*\n\s*\*,\s*\n\s*limit: int \| None = None,\s*\n\s*action: str \| None = None,\s*\n\s*\) -> Iterator\[dict\[str, Any\]\]:/,
    );
    expect(body).toMatch(/"""Lazily walk every audit-log page\."""/);
    expect(body).toMatch(
      /def fetch_page\(cursor: str \| None\) -> dict\[str, Any\]:\s*\n\s*return self\.list\(limit=limit, cursor=cursor, action=action\)/,
    );
    expect(body).toMatch(/return iterate_paginated\(fetch_page\)/);
  });

  it('export (sync) — V-462/V-297 GET /v1/account/audit-log/export?format=json single-call JSON envelope for GDPR Article 20 portability. 10,000 rows max + truncated bool flag when older entries omitted. CSV BRANCH INTENTIONALLY NOT EXPOSED through the SDK — hardcoded ?format=json so the SDK never accidentally returns binary CSV. CSV path documented as "hit /v1/account/audit-log/export?format=csv directly with the bearer" — separation keeps SDK return type predictable.', () => {
    expect(body).toMatch(/def export\(self\) -> dict\[str, Any\]:/);
    expect(body).toMatch(/"""V-462 \/ V-297 — bulk-export the calling account's audit log as/);
    expect(body).toMatch(/a JSON envelope \(GDPR Article 20 portability\)\. Single call; up to/);
    expect(body).toMatch(/10,000 rows; ``truncated`` is True when older entries were/);
    expect(body).toMatch(/omitted\. The CSV branch is not exposed here — hit/);
    expect(body).toMatch(/``\/v1\/account\/audit-log\/export\?format=csv`` directly with the/);
    expect(body).toMatch(/bearer for browser-driven spreadsheet downloads\./);
    expect(body).toMatch(
      /return self\._http\.request\("GET", "\/v1\/account\/audit-log\/export\?format=json"\)/,
    );
  });

  it('AsyncAuditLogResource — class shell + AsyncHttpClient injection. Mirrors sync class with awaited list + export but iterate stays a SYNCHRONOUS def (Python idiom: a sync function returning an AsyncIterator is the right shape for `async for x in ...iterate()`).', () => {
    expect(body).toMatch(/^class AsyncAuditLogResource:$/m);
    expect(body).toMatch(/"""Async audit-log resource\."""/);
    expect(body).toMatch(
      /def __init__\(self, http: AsyncHttpClient\) -> None:\s*\n\s*self\._http = http/,
    );
  });

  it('async list — awaited GET twin with same _qs query-string semantics + same 3-kwarg signature + same conditional "?qs" suffix. Drift to a different qs computation in the async path would silently fragment query-param normalisation.', () => {
    expect(body).toMatch(
      /async def list\(\s*\n\s*self,\s*\n\s*\*,\s*\n\s*limit: int \| None = None,\s*\n\s*cursor: str \| None = None,\s*\n\s*action: str \| None = None,\s*\n\s*\) -> dict\[str, Any\]:\s*\n\s*qs = _qs\(\{"limit": limit, "cursor": cursor, "action": action\}\)\s*\n\s*path = "\/v1\/account\/audit-log" \+ \(f"\?\{qs\}" if qs else ""\)\s*\n\s*return await self\._http\.request\("GET", path\)/,
    );
  });

  it('async iterate + export — async iterate returns AsyncIterator[dict[str, Any]] (NOT awaited at the iterate call-site; `async for x in audit.iterate()` consumes it). Inner async fetch_page closure with `return await self.list(...)`. Delegates to aiterate_paginated (the async twin of iterate_paginated). async export short-docstring cross-refs the sync method.', () => {
    expect(body).toMatch(
      /def iterate\(\s*\n\s*self,\s*\n\s*\*,\s*\n\s*limit: int \| None = None,\s*\n\s*action: str \| None = None,\s*\n\s*\) -> AsyncIterator\[dict\[str, Any\]\]:\s*\n\s*async def fetch_page\(cursor: str \| None\) -> dict\[str, Any\]:\s*\n\s*return await self\.list\(limit=limit, cursor=cursor, action=action\)\s*\n\s*return aiterate_paginated\(fetch_page\)/,
    );
    expect(body).toMatch(
      /async def export\(self\) -> dict\[str, Any\]:\s*\n\s*"""V-462 \/ V-297 — async mirror of ``AuditLogResource\.export``\."""\s*\n\s*return await self\._http\.request\("GET", "\/v1\/account\/audit-log\/export\?format=json"\)/,
    );
  });
});

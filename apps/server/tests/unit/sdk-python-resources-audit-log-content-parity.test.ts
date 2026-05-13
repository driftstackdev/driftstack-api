// W581.B — drift guard for packages/sdk-python/src/resources/audit_log.py.
// V-216/V-449/V-462/V-297 AuditLogResource Python parity. Drift here
// either drops the V-462 GDPR Article 20 portability export (10k row
// cap + truncated flag) or breaks the iterate() lazy-pagination wrapper.
//
//   • Append-only event ledger framing pinned.
//   • Helper _qs(query) skips None values + urlencodes.
//   • Two paired classes: AuditLogResource (sync) + AsyncAuditLogResource.
//   • 3 verbs: list / iterate / export.
//   • iterate() delegates to iterate_paginated/aiterate_paginated helpers.
//   • export() pins JSON-envelope branch; CSV branch out-of-band (browser
//     hits /v1/account/audit-log/export?format=csv directly).

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

  it('Module docstring + V-216/V-449 framing + append-only-ledger + dict[str, Any]-pending-regen pinned', () => {
    expect(body).toMatch(
      /^"""Audit log resource — \/v1\/account\/audit-log \(V-216 \/ V-449\)\.\n/,
    );
    expect(body).toMatch(/Append-only event ledger for compliance \/ monitoring\. Returns/);
    expect(body).toMatch(/``dict\[str, Any\]`` pending the next regen pass\./);
  });

  it('Imports: __future__ + collections.abc Async/Iterator + urllib.parse urlencode + AsyncHttpClient/HttpClient + pagination helpers (aiterate_paginated + iterate_paginated)', () => {
    expect(body).toMatch(/^from __future__ import annotations$/m);
    expect(body).toMatch(/^from collections\.abc import AsyncIterator, Iterator$/m);
    expect(body).toMatch(/^from typing import Any$/m);
    expect(body).toMatch(/^from urllib\.parse import urlencode$/m);
    expect(body).toMatch(/^from driftstack\.http import AsyncHttpClient, HttpClient$/m);
    expect(body).toMatch(
      /^from driftstack\.pagination import aiterate_paginated, iterate_paginated$/m,
    );
  });

  it('_qs helper: skips None values + urlencodes (k, str(v)) tuples — driftstack convention for query-param normalisation', () => {
    expect(body).toMatch(/^def _qs\(query: dict\[str, Any\]\) -> str:$/m);
    expect(body).toMatch(
      /items: list\[tuple\[str, str\]\] = \[\]\s*\n\s*for k, v in query\.items\(\):\s*\n\s*if v is None:\s*\n\s*continue\s*\n\s*items\.append\(\(k, str\(v\)\)\)\s*\n\s*return urlencode\(items\)/,
    );
  });

  it('Sync AuditLogResource: 3 verbs — list(limit/cursor/action kwarg-only newest-first action-filter) + iterate(limit/action lazy walk every page) + export() V-462/V-297 GDPR-Art-20 JSON envelope', () => {
    expect(body).toMatch(/^class AuditLogResource:$/m);
    expect(body).toMatch(
      /def list\(\s*\n\s*self,\s*\n\s*\*,\s*\n\s*limit: int \| None = None,\s*\n\s*cursor: str \| None = None,\s*\n\s*action: str \| None = None,\s*\n\s*\) -> dict\[str, Any\]:/,
    );
    expect(body).toMatch(
      /"""List audit-log entries newest-first\. ``action`` filters to a single event type\."""/,
    );
    expect(body).toMatch(
      /qs = _qs\(\{"limit": limit, "cursor": cursor, "action": action\}\)\s*\n\s*path = "\/v1\/account\/audit-log" \+ \(f"\?\{qs\}" if qs else ""\)\s*\n\s*return self\._http\.request\("GET", path\)/,
    );
    expect(body).toMatch(
      /def iterate\(\s*\n\s*self,\s*\n\s*\*,\s*\n\s*limit: int \| None = None,\s*\n\s*action: str \| None = None,\s*\n\s*\) -> Iterator\[dict\[str, Any\]\]:/,
    );
    expect(body).toMatch(/"""Lazily walk every audit-log page\."""/);
    expect(body).toMatch(
      /def fetch_page\(cursor: str \| None\) -> dict\[str, Any\]:\s*\n\s*return self\.list\(limit=limit, cursor=cursor, action=action\)/,
    );
    expect(body).toMatch(/return iterate_paginated\(fetch_page\)/);
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

  it('Async AsyncAuditLogResource mirrors sync surface; iterate returns AsyncIterator + delegates to aiterate_paginated; export references back to sync via short docstring', () => {
    expect(body).toMatch(/^class AsyncAuditLogResource:$/m);
    expect(body).toMatch(/-> AsyncIterator\[dict\[str, Any\]\]:/);
    expect(body).toMatch(
      /async def fetch_page\(cursor: str \| None\) -> dict\[str, Any\]:\s*\n\s*return await self\.list\(limit=limit, cursor=cursor, action=action\)/,
    );
    expect(body).toMatch(/return aiterate_paginated\(fetch_page\)/);
    expect(body).toMatch(
      /async def export\(self\) -> dict\[str, Any\]:\s*\n\s*"""V-462 \/ V-297 — async mirror of ``AuditLogResource\.export``\."""/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});

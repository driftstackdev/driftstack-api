// W583.B — drift guard for packages/sdk-python/src/resources/sessions.py.
// SessionsResource Python parity — the workhorse surface (every
// /v1/sessions[/...] route). Drift here either drops a verb,
// breaks the pydantic-validated request/response symmetry with
// the generated models, or unsets the L-001-gated gui-input
// posture (gui-input is NOT in the SDK — server-side 🚫).
//
//   • 9 verbs each: create / list / iterate / get / navigate /
//     interact / wait / get_state / capture / destroy.
//   • SessionsListPage pagination envelope: data + has_more +
//     next_cursor.
//   • _session_path helper quotes session_id.
//   • Generated models cover 11 request/response types.
//   • iterate() lazy-walks via iterate_paginated/aiterate_paginated.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/resources/sessions.py');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W583.B packages/sdk-python/src/driftstack/resources/sessions.py content parity', () => {
  const body = read(LIB);

  it('Module docstring + /v1/sessions[/...] coverage + sync/async URL+param-shape-shared framing pinned', () => {
    expect(body).toMatch(/^"""Sessions resource\.\n/);
    expect(body).toMatch(
      /Wraps every ``\/v1\/sessions\[\/\.\.\.\]`` route\. Both sync and async variants/,
    );
    expect(body).toMatch(/share the URL\/parameter shapes; the only difference is which HTTP/);
    expect(body).toMatch(/client they call\./);
  });

  it('Imports: 11 generated models (CaptureRequest/Response + CreateSessionRequest/Response + InteractRequest/Response + NavigateRequest/Response + PaginationQuery + Session + SessionState + WaitRequest/Response) + pagination helpers + coerce_body/coerce_query', () => {
    expect(body).toMatch(/^from __future__ import annotations$/m);
    expect(body).toMatch(/^from collections\.abc import AsyncIterator, Iterator$/m);
    expect(body).toMatch(/^from urllib\.parse import quote$/m);
    expect(body).toMatch(/^from pydantic import BaseModel$/m);
    expect(body).toMatch(
      /^from driftstack\._generated\.models import \(\s*\n\s*CaptureRequest,\s*\n\s*CaptureResponse,\s*\n\s*CreateSessionRequest,\s*\n\s*CreateSessionResponse,\s*\n\s*InteractRequest,\s*\n\s*InteractResponse,\s*\n\s*NavigateRequest,\s*\n\s*NavigateResponse,\s*\n\s*PaginationQuery,\s*\n\s*Session,\s*\n\s*SessionState,\s*\n\s*WaitRequest,\s*\n\s*WaitResponse,\s*\n\)$/m,
    );
    expect(body).toMatch(
      /^from driftstack\.pagination import aiterate_paginated, iterate_paginated$/m,
    );
    expect(body).toMatch(/^from driftstack\.resources\._common import coerce_body, coerce_query$/m);
  });

  it('SessionsListPage envelope pinned: data: list[Session] + has_more: bool + next_cursor: str | None (paginated GET /v1/sessions response)', () => {
    expect(body).toMatch(
      /^class SessionsListPage\(BaseModel\):\s*\n\s*"""Paginated list of sessions returned by ``GET \/v1\/sessions``\."""\s*\n\s*data: list\[Session\]\s*\n\s*has_more: bool\s*\n\s*next_cursor: str \| None$/m,
    );
  });

  it('_session_path helper: URL-escapes session_id via quote(safe=empty-string) + appends optional suffix', () => {
    expect(body).toMatch(
      /^def _session_path\(session_id: str, suffix: str = ""\) -> str:\s*\n\s*return f"\/v1\/sessions\/\{quote\(session_id, safe=''\)\}\{suffix\}"$/m,
    );
  });

  it('Sync SessionsResource: 9 verbs — create POST + list GET (PaginationQuery → SessionsListPage) + iterate lazy walk + get/get_state GET + navigate/interact/wait/capture POST + destroy DELETE idempotent — all pydantic-validated', () => {
    expect(body).toMatch(/^class SessionsResource:$/m);
    expect(body).toMatch(
      /def create\(\s*\n\s*self, body: CreateSessionRequest \| dict\[str, Any\] \| None = None\s*\n\s*\) -> CreateSessionResponse:\s*\n\s*"""Create a new session\. Returns the new ``Session`` row\."""\s*\n\s*data = self\._http\.request\("POST", "\/v1\/sessions", json_body=coerce_body\(body\) or \{\}\)\s*\n\s*return CreateSessionResponse\.model_validate\(data\)/,
    );
    expect(body).toMatch(
      /def list\(self, query: PaginationQuery \| dict\[str, Any\] \| None = None\) -> SessionsListPage:\s*\n\s*"""List sessions for the current account, newest first\."""\s*\n\s*data = self\._http\.request\("GET", "\/v1\/sessions", params=coerce_query\(query\)\)\s*\n\s*return SessionsListPage\.model_validate\(data\)/,
    );
    expect(body).toMatch(
      /def iterate\(self, \*, limit: int \| None = None\) -> Iterator\[Session\]:/,
    );
    expect(body).toMatch(/"""Lazily walk every session for the calling account\./);
    expect(body).toMatch(/Wraps :meth:`list` with cursor handoff so callers can write::/);
    expect(body).toMatch(/for session in client\.sessions\.iterate\(limit=50\):/);
    expect(body).toMatch(
      /def get\(self, session_id: str\) -> Session:\s*\n\s*data = self\._http\.request\("GET", _session_path\(session_id\)\)\s*\n\s*return Session\.model_validate\(data\)/,
    );
    expect(body).toMatch(
      /def navigate\(self, session_id: str, body: NavigateRequest \| dict\[str, Any\]\) -> NavigateResponse:/,
    );
    expect(body).toMatch(
      /def interact\(self, session_id: str, body: InteractRequest \| dict\[str, Any\]\) -> InteractResponse:/,
    );
    expect(body).toMatch(
      /def wait\(self, session_id: str, body: WaitRequest \| dict\[str, Any\]\) -> WaitResponse:/,
    );
    expect(body).toMatch(
      /def get_state\(self, session_id: str\) -> SessionState:\s*\n\s*data = self\._http\.request\("GET", _session_path\(session_id, "\/state"\)\)\s*\n\s*return SessionState\.model_validate\(data\)/,
    );
    expect(body).toMatch(
      /def capture\(self, session_id: str, body: CaptureRequest \| dict\[str, Any\]\) -> CaptureResponse:/,
    );
    expect(body).toMatch(
      /def destroy\(self, session_id: str\) -> None:\s*\n\s*"""Destroy the session\. Idempotent \(safe to call twice\)\."""\s*\n\s*self\._http\.request\("DELETE", _session_path\(session_id\)\)/,
    );
  });

  it('Async AsyncSessionsResource: mirrored awaited 9-verb surface; iterate stays sync def returning AsyncIterator delegating to aiterate_paginated', () => {
    expect(body).toMatch(/^class AsyncSessionsResource:$/m);
    expect(body).toMatch(/"""Async sessions resource\. Mirrors :class:`SessionsResource`\."""/);
    expect(body).toMatch(
      /def iterate\(self, \*, limit: int \| None = None\) -> AsyncIterator\[Session\]:/,
    );
    expect(body).toMatch(/"""Async variant of :meth:`SessionsResource\.iterate`\./);
    expect(body).toMatch(/Returns an async iterator suitable for ``async for \.\.\. in \.\.\.``\./);
    expect(body).toMatch(
      /async def destroy\(self, session_id: str\) -> None:\s*\n\s*await self\._http\.request\("DELETE", _session_path\(session_id\)\)/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});

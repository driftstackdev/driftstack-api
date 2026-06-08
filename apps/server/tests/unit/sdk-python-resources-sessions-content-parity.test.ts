// W583.B (W652-deepened) — drift guard for packages/sdk-python/src/
// driftstack/resources/sessions.py. The workhorse surface (every
// /v1/sessions[/...] route).
//
// W652 splits the original 7 it() blocks into 17 focused per-concept
// blocks + pins previously-implicit invariants. Mirrors the W640
// sdk-go-sessions.go split (5→11):
//
//   • 11 generated-model import surface (sorted block) — every
//     verb's request/response shape comes from the Zod-derived
//     single-source-of-truth. Drift to hand-rolled types would
//     diverge from the cross-language wire contract.
//   • _session_path helper — quote(session_id, safe='') with NO
//     safe-chars. Drift to safe='/' would let "123/../456" traverse
//     into another session's namespace.
//   • Per-verb blocks for the 9-verb surface:
//       - create (POST /v1/sessions; body=None default → "{}" wire)
//       - list (GET /v1/sessions with PaginationQuery → cursor page)
//       - iterate (Iterator[Session] lazy walk; limit re-threaded
//         per page so the limit applies to EVERY fetched page, not
//         just the first)
//       - get (GET /v1/sessions/{quoted_id})
//       - navigate / interact / wait / capture (4 workhorse POST
//         action verbs — each takes a typed Request body and
//         returns a typed Response)
//       - get_state (GET /v1/sessions/{id}/state)
//       - destroy (DELETE /v1/sessions/{id}, IDEMPOTENT — drift to
//         non-idempotent would break the "safe to call twice"
//         contract that callers rely on for cleanup)
//   • Async iterate is NOT `async def` — it returns an AsyncIterator
//     generator; calling is sync, awaiting yielded items is async.
//   • 9-verb inventory drift guard via regex count (sync + async
//     both define exactly 10 method defs = 9 verbs + __init__).

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

  it('file exists at canonical path + module docstring covers all /v1/sessions[/...] routes + sync/async-share-URL-shapes framing', () => {
    expect(existsSync(LIB)).toBe(true);
    expect(body).toMatch(/^"""Sessions resource\.\n/);
    expect(body).toMatch(
      /Wraps every ``\/v1\/sessions\[\/\.\.\.\]`` route\. Both sync and async variants\s*\nshare the URL\/parameter shapes; the only difference is which HTTP\s*\nclient they call\./,
    );
  });

  it("Imports — 13 generated models (sorted alphabetical block) covering every verb's request/response shape. CRITICAL: drift to hand-rolled types in this file would diverge from @driftstack/api-types Zod single-source-of-truth and silently fragment the cross-language wire contract.", () => {
    expect(body).toMatch(/^from __future__ import annotations$/m);
    expect(body).toMatch(/^from collections\.abc import AsyncIterator, Iterator$/m);
    expect(body).toMatch(/^from typing import Any$/m);
    expect(body).toMatch(/^from urllib\.parse import quote$/m);
    expect(body).toMatch(/^from pydantic import BaseModel$/m);
    expect(body).toMatch(
      /^from driftstack\._generated\.models import \(\s*\n\s*CaptureRequest,\s*\n\s*CaptureResponse,\s*\n\s*CreateSessionRequest,\s*\n\s*CreateSessionResponse,\s*\n\s*ExtractRequest,\s*\n\s*ExtractResponse,\s*\n\s*InteractRequest,\s*\n\s*InteractResponse,\s*\n\s*NavigateRequest,\s*\n\s*NavigateResponse,\s*\n\s*PaginationQuery,\s*\n\s*Session,\s*\n\s*SessionState,\s*\n\s*WaitRequest,\s*\n\s*WaitResponse,\s*\n\)$/m,
    );
    expect(body).toMatch(
      /^from driftstack\.pagination import aiterate_paginated, iterate_paginated$/m,
    );
    expect(body).toMatch(/^from driftstack\.resources\._common import coerce_body, coerce_query$/m);
  });

  it('SessionsListPage envelope — 3-field cursor pagination (data: list[Session] + has_more: bool + next_cursor: str | None). Sessions are potentially unbounded per account so cursor pagination is load-bearing; drift to dropping has_more or making next_cursor non-nullable would break iterate() termination logic.', () => {
    expect(body).toMatch(
      /^class SessionsListPage\(BaseModel\):\s*\n\s*"""Paginated list of sessions returned by ``GET \/v1\/sessions``\."""\s*\n\s*data: list\[Session\]\s*\n\s*has_more: bool\s*\n\s*next_cursor: str \| None$/m,
    );
  });

  it("_session_path helper — f\"/v1/sessions/{quote(session_id, safe='')}{suffix}\" with NO safe-chars in quote(). Drift to safe='/' would let \"123/../456\" traverse into another session's namespace, widening the auth surface across the 7 per-id sub-routes (get, navigate, interact, wait, state, capture, destroy).", () => {
    expect(body).toMatch(
      /^def _session_path\(session_id: str, suffix: str = ""\) -> str:\s*\n\s*return f"\/v1\/sessions\/\{quote\(session_id, safe=''\)\}\{suffix\}"$/m,
    );
  });

  it('SessionsResource (sync) class declaration + __init__(http: HttpClient) — stateless wrapper; same pattern as every other Python sync resource.', () => {
    expect(body).toMatch(/^class SessionsResource:$/m);
    expect(body).toMatch(/^ {4}"""Synchronous sessions resource\."""$/m);
    expect(body).toMatch(
      /^ {4}def __init__\(self, http: HttpClient\) -> None:\s*\n\s*self\._http = http$/m,
    );
  });

  it('Sync create — POST /v1/sessions with `body=None` DEFAULT-OPTIONAL parameter + `coerce_body(body) or {}` substitution so the wire body is "{}" not "null" when callers write `client.sessions.create()` for the no-options case. Returns CreateSessionResponse.model_validate(data) — pydantic-validated.', () => {
    expect(body).toMatch(
      /def create\(\s*\n\s*self, body: CreateSessionRequest \| dict\[str, Any\] \| None = None\s*\n\s*\) -> CreateSessionResponse:\s*\n\s*"""Create a new session\. Returns the new ``Session`` row\."""\s*\n\s*data = self\._http\.request\("POST", "\/v1\/sessions", json_body=coerce_body\(body\) or \{\}\)\s*\n\s*return CreateSessionResponse\.model_validate\(data\)/,
    );
  });

  it('Sync list — GET /v1/sessions with PaginationQuery → SessionsListPage. "newest first" ordering pinned in docstring (drift to oldest-first would silently invert pagination semantics and confuse callers who rely on cursor-walking the recent end).', () => {
    expect(body).toMatch(
      /def list\(self, query: PaginationQuery \| dict\[str, Any\] \| None = None\) -> SessionsListPage:\s*\n\s*"""List sessions for the current account, newest first\."""\s*\n\s*data = self\._http\.request\("GET", "\/v1\/sessions", params=coerce_query\(query\)\)\s*\n\s*return SessionsListPage\.model_validate\(data\)/,
    );
  });

  it('Sync iterate — Iterator[Session] lazy walk + limit keyword-only re-threaded per page via fetch_page. CRITICAL: limit re-applied on EVERY page (not just the first), otherwise subsequent pages would default to server-side limit and the customer-requested batch size would silently grow mid-walk. Docstring example pinned: `for session in client.sessions.iterate(limit=50): ...`', () => {
    expect(body).toMatch(
      /def iterate\(self, \*, limit: int \| None = None\) -> Iterator\[Session\]:\s*\n\s*"""Lazily walk every session for the calling account\.\s*\n\s*\n\s*Wraps :meth:`list` with cursor handoff so callers can write::\s*\n\s*\n\s*for session in client\.sessions\.iterate\(limit=50\):\s*\n\s*\.\.\.\s*\n\s*"""/,
    );
    expect(body).toMatch(
      /def fetch_page\(cursor: str \| None\) -> SessionsListPage:\s*\n\s*params: dict\[str, Any\] = \{\}\s*\n\s*if limit is not None:\s*\n\s*params\["limit"\] = limit\s*\n\s*if cursor is not None:\s*\n\s*params\["cursor"\] = cursor\s*\n\s*return self\.list\(params\)/,
    );
    expect(body).toMatch(/return iterate_paginated\(fetch_page\)/);
  });

  it('Sync get — GET /v1/sessions/{quoted_id} returns single Session. Single-line implementation; URL-escape via _session_path is the only complexity.', () => {
    expect(body).toMatch(
      /def get\(self, session_id: str\) -> Session:\s*\n\s*data = self\._http\.request\("GET", _session_path\(session_id\)\)\s*\n\s*return Session\.model_validate\(data\)/,
    );
  });

  it('Sync navigate — POST /v1/sessions/{id}/navigate with NavigateRequest body. First of the 4 workhorse action verbs (navigate/interact/wait/capture) — each takes a typed Request body and returns a typed Response. NavigateRequest carries the URL to load + optional wait conditions.', () => {
    expect(body).toMatch(
      /def navigate\(self, session_id: str, body: NavigateRequest \| dict\[str, Any\]\) -> NavigateResponse:\s*\n\s*data = self\._http\.request\(\s*\n\s*"POST", _session_path\(session_id, "\/navigate"\), json_body=coerce_body\(body\)\s*\n\s*\)\s*\n\s*return NavigateResponse\.model_validate\(data\)/,
    );
  });

  it('Sync interact — POST /v1/sessions/{id}/interact with InteractRequest body. Click / type / scroll / hover semantics; InteractResponse carries post-action page state. Critical for any browser-automation flow — drift to dropping the typed body would lose static type-checking on the interaction kind discriminator.', () => {
    expect(body).toMatch(
      /def interact\(self, session_id: str, body: InteractRequest \| dict\[str, Any\]\) -> InteractResponse:\s*\n\s*data = self\._http\.request\(\s*\n\s*"POST", _session_path\(session_id, "\/interact"\), json_body=coerce_body\(body\)\s*\n\s*\)\s*\n\s*return InteractResponse\.model_validate\(data\)/,
    );
  });

  it('Sync wait — POST /v1/sessions/{id}/wait with WaitRequest body. Synchronizes against page-state predicates (selector visibility, network idle, timeout) before returning. Distinct from interact because wait observes without acting.', () => {
    expect(body).toMatch(
      /def wait\(self, session_id: str, body: WaitRequest \| dict\[str, Any\]\) -> WaitResponse:\s*\n\s*data = self\._http\.request\(\s*\n\s*"POST", _session_path\(session_id, "\/wait"\), json_body=coerce_body\(body\)\s*\n\s*\)\s*\n\s*return WaitResponse\.model_validate\(data\)/,
    );
  });

  it('Sync get_state — GET /v1/sessions/{id}/state returns SessionState (NOT Session). Distinct shape: SessionState carries live state (URL, viewport, cookies, DOM hash) whereas Session carries identity + lifecycle. Drift to returning Session would lose the live-state fields.', () => {
    expect(body).toMatch(
      /def get_state\(self, session_id: str\) -> SessionState:\s*\n\s*data = self\._http\.request\("GET", _session_path\(session_id, "\/state"\)\)\s*\n\s*return SessionState\.model_validate\(data\)/,
    );
  });

  it('Sync capture — POST /v1/sessions/{id}/capture with CaptureRequest body. Screenshot / DOM snapshot / PDF export; the 4th workhorse action verb. CaptureResponse carries the captured artifact reference.', () => {
    expect(body).toMatch(
      /def capture\(self, session_id: str, body: CaptureRequest \| dict\[str, Any\]\) -> CaptureResponse:\s*\n\s*data = self\._http\.request\(\s*\n\s*"POST", _session_path\(session_id, "\/capture"\), json_body=coerce_body\(body\)\s*\n\s*\)\s*\n\s*return CaptureResponse\.model_validate\(data\)/,
    );
  });

  it('Sync destroy — DELETE /v1/sessions/{id}. CRITICAL: "Idempotent (safe to call twice)" framing pinned. Drift to non-idempotent would break the standard cleanup pattern where callers destroy in a finally-block without checking whether the session was already destroyed. Returns None (no body) so callers can\'t mistakenly depend on the response shape.', () => {
    expect(body).toMatch(
      /def destroy\(self, session_id: str\) -> None:\s*\n\s*"""Destroy the session\. Idempotent \(safe to call twice\)\."""\s*\n\s*self\._http\.request\("DELETE", _session_path\(session_id\)\)/,
    );
  });

  it('AsyncSessionsResource — class declaration + __init__(http: AsyncHttpClient) + iterate stays SYNC def returning AsyncIterator[Session] (not `async def` — the function returns an async-generator; calling is sync, awaiting yielded items is async). Async destroy mirrors sync (no return value, idempotent).', () => {
    expect(body).toMatch(/^class AsyncSessionsResource:$/m);
    expect(body).toMatch(
      /^ {4}"""Async sessions resource\. Mirrors :class:`SessionsResource`\."""$/m,
    );
    expect(body).toMatch(
      /^ {4}def __init__\(self, http: AsyncHttpClient\) -> None:\s*\n\s*self\._http = http$/m,
    );
    expect(body).toMatch(
      /def iterate\(self, \*, limit: int \| None = None\) -> AsyncIterator\[Session\]:\s*\n\s*"""Async variant of :meth:`SessionsResource\.iterate`\.\s*\n\s*\n\s*Returns an async iterator suitable for ``async for \.\.\. in \.\.\.``\.\s*\n\s*"""/,
    );
    expect(body).toMatch(
      /async def destroy\(self, session_id: str\) -> None:\s*\n\s*await self\._http\.request\("DELETE", _session_path\(session_id\)\)/,
    );
  });

  it('11-verb inventory drift guard — sync defines exactly 12 method defs (11 verbs + __init__); async defines the same 12. Drift to a 12th verb (e.g. a "freeze" or "clone" action) without doubling test coverage would let an untested code path ship; drift to dropping a verb would silently break a documented workhorse flow.', () => {
    const syncStart = body.indexOf('class SessionsResource:');
    const asyncStart = body.indexOf('class AsyncSessionsResource:');
    expect(syncStart, 'expected sync class to come first').toBeGreaterThan(0);
    expect(asyncStart, 'expected async class to come after sync class').toBeGreaterThan(syncStart);
    const syncBody = body.slice(syncStart, asyncStart);
    const asyncBody = body.slice(asyncStart);
    const syncDefs = (syncBody.match(/^ {4}(?:async )?def [a-z_]+\(/gm) ?? []).length;
    expect(syncDefs, 'expected 12 sync method defs (11 verbs + __init__)').toBe(12);
    const asyncDefs = (asyncBody.match(/^ {4}(?:async )?def [a-z_]+\(/gm) ?? []).length;
    expect(asyncDefs, 'expected 12 async method defs (11 verbs + __init__)').toBe(12);
    // POST verb count: create + navigate + interact + wait + capture + extract = 6
    // POST per class × 2 classes = 12.
    const posts = (body.match(/"POST", /g) ?? []).length;
    expect(posts, 'expected 12 POSTs (6 verbs × sync+async)').toBe(12);
    // GET verb count: list + get + get_state = 3 GET per class × 2 = 6.
    const gets = (body.match(/"GET", /g) ?? []).length;
    expect(gets, 'expected 6 GETs (3 verbs × sync+async)').toBe(6);
    // DELETE: destroy only, 1 per class × 2 = 2.
    const deletes = (body.match(/"DELETE", /g) ?? []).length;
    expect(deletes, 'expected 2 DELETEs (destroy × sync+async)').toBe(2);
  });
});

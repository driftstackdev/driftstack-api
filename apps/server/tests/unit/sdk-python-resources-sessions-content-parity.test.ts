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

  it('Imports — generated models cover every verb; search/login retain canonical RootModels plus strict branch types for validated direct-attribute results.', () => {
    expect(body).toMatch(/^from __future__ import annotations$/m);
    expect(body).toMatch(/^from collections\.abc import AsyncIterator, Iterator$/m);
    expect(body).toMatch(/^from typing import Any$/m);
    expect(body).toMatch(/^from urllib\.parse import quote$/m);
    expect(body).toMatch(/^from pydantic import BaseModel$/m);
    expect(body).toMatch(
      /^from driftstack\._generated\.models import \(\s*\n\s*CaptureRequest,\s*\n\s*CaptureResponse,\s*\n\s*CreateSessionRequest,\s*\n\s*CreateSessionResponse,\s*\n\s*ExtractRequest,\s*\n\s*ExtractResponse,\s*\n\s*InteractRequest,\s*\n\s*InteractResponse,\s*\n\s*NavigateRequest,\s*\n\s*NavigateResponse,\s*\n\s*PaginationQuery,\s*\n\s*SearchRequest,\s*\n\s*SearchResponse1,\s*\n\s*SearchResponse2,\s*\n\s*Session,\s*\n\s*SessionLoginRequest,\s*\n\s*SessionLoginResponse1,\s*\n\s*SessionLoginResponse2,\s*\n\s*SessionState,\s*\n\s*WaitRequest,\s*\n\s*WaitResponse,\s*\n\)\s*\nfrom driftstack\._generated\.models import \(\s*\n\s*SearchResponse as GeneratedSearchResponse,\s*\n\)\s*\nfrom driftstack\._generated\.models import \(\s*\n\s*SessionLoginResponse as GeneratedSessionLoginResponse,\s*\n\)$/m,
    );
    expect(body).toMatch(
      /^from driftstack\.pagination import aiterate_paginated, iterate_paginated$/m,
    );
    expect(body).toMatch(/^from driftstack\.resources\._common import coerce_body, coerce_query$/m);
  });

  it('raw primitive strictness — booleans are identity-checked (bool is an int subclass, so lax pydantic would coerce JSON 1/0/"false" into a fabricated submitted/logged_in verdict) and duration is an exact int inside the 600,000 ms producer budget, under ONE fixed schema-mismatch message so a hostile body cannot shape the exception', () => {
    expect(body).toContain('from driftstack.errors import TransportError');
    expect(body).toMatch(/^_DURATION_MS_MAX = 600_000$/m);
    expect(body).toMatch(
      /^def _schema_error\(\) -> TransportError:[\s\S]*?return TransportError\("response did not match expected schema", status=None\)$/m,
    );
    expect(body).toMatch(
      /^def _exact_bool\(payload: dict\[str, Any\], key: str\) -> bool:[\s\S]*?value = payload\[key\]\s*\n\s*if type\(value\) is not bool:\s*\n\s*raise _schema_error\(\)\s*\n\s*return value$/m,
    );
    expect(body).toMatch(
      /^def _exact_duration_ms\(payload: dict\[str, Any\]\) -> None:[\s\S]*?value = payload\["duration_ms"\][\s\S]*?if type\(value\) is not int or not 0 <= value <= _DURATION_MS_MAX:\s*\n\s*raise _schema_error\(\)$/m,
    );
    // isinstance(True, int) is True — an isinstance-based bool check would be
    // silently unguarded, so the exact-type form is the load-bearing part.
    expect(body).not.toMatch(/isinstance\(value, bool\)/);
    expect(body).not.toMatch(/isinstance\(payload\[key\], bool\)/);
  });

  it('search validates raw primitives BEFORE the generated model can coerce them, pins the exact branch key sets, and keeps the refusal branch free of any results assessment', () => {
    expect(body).toMatch(/SearchResponse = SearchResponse1 \| SearchResponse2/);
    expect(body).toMatch(
      /^_SEARCH_REQUIRED_KEYS = frozenset\(\{"submitted", "query_truncated", "duration_ms"\}\)$/m,
    );
    expect(body).toMatch(
      /^def _validate_raw_search_response\(data: Any\) -> None:[\s\S]*?if not isinstance\(data, dict\) or not _SEARCH_REQUIRED_KEYS <= set\(data\):\s*\n\s*raise _schema_error\(\)\s*\n\s*submitted = _exact_bool\(data, "submitted"\)\s*\n\s*truncated = _exact_bool\(data, "query_truncated"\)\s*\n\s*_exact_duration_ms\(data\)/m,
    );
    expect(body).toMatch(
      /if truncated:[\s\S]*?if submitted or set\(data\) != _SEARCH_REQUIRED_KEYS:\s*\n\s*raise _schema_error\(\)\s*\n\s*return\s*\n\s*if set\(data\) - _SEARCH_REQUIRED_KEYS - \{"results_visible"\}:\s*\n\s*raise _schema_error\(\)/,
    );
    expect(body).toMatch(
      /if "results_visible" in data:\s*\n\s*_exact_bool\(data, "results_visible"\)/,
    );
    // Validation must run before parse_model, never after.
    expect(body).toMatch(
      /def _parse_session_search_response\(data: Any\) -> SearchResponse:[\s\S]*?_validate_raw_search_response\(data\)\s*\n\s*return parse_model\(GeneratedSearchResponse, data\)\.root/,
    );
    expect(body.match(/return _parse_session_search_response\(data\)/g)).toHaveLength(2);
  });

  it('login validates raw primitives before the generated RootModel, unwraps only its selected strict branch, keeps post_login_url absent-or-exact-string (never null), and keeps direct result attributes for sync and async callers', () => {
    expect(body).toMatch(/SessionLoginResponse = SessionLoginResponse1 \| SessionLoginResponse2/);
    expect(body).toMatch(
      /^_LOGIN_REQUIRED_KEYS = frozenset\(\{"submitted", "credentials_truncated", "logged_in", "duration_ms"\}\)$/m,
    );
    expect(body).toMatch(
      /^def _validate_raw_login_response\(data: Any\) -> None:[\s\S]*?if not isinstance\(data, dict\) or not _LOGIN_REQUIRED_KEYS <= set\(data\):\s*\n\s*raise _schema_error\(\)\s*\n\s*submitted = _exact_bool\(data, "submitted"\)\s*\n\s*truncated = _exact_bool\(data, "credentials_truncated"\)\s*\n\s*logged_in = _exact_bool\(data, "logged_in"\)\s*\n\s*_exact_duration_ms\(data\)/m,
    );
    expect(body).toMatch(
      /if truncated:[\s\S]*?if submitted or logged_in or set\(data\) != _LOGIN_REQUIRED_KEYS:\s*\n\s*raise _schema_error\(\)\s*\n\s*return\s*\n\s*if not submitted or set\(data\) - _LOGIN_REQUIRED_KEYS - \{"post_login_url"\}:\s*\n\s*raise _schema_error\(\)/,
    );
    expect(body).toMatch(
      /if "post_login_url" in data and type\(data\["post_login_url"\]\) is not str:\s*\n\s*raise _schema_error\(\)/,
    );
    expect(body).toMatch(
      /def _parse_session_login_response\(data: Any\) -> SessionLoginResponse:[\s\S]*?_validate_raw_login_response\(data\)\s*\n\s*return parse_model\(GeneratedSessionLoginResponse, data\)\.root/,
    );
    expect(body.match(/return _parse_session_login_response\(data\)/g)).toHaveLength(2);
    expect(body).not.toMatch(/return parse_model\(SessionLoginResponse, data\)/);
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
      /def create\(\s*\n\s*self, body: CreateSessionRequest \| dict\[str, Any\] \| None = None\s*\n\s*\) -> CreateSessionResponse:\s*\n\s*"""Create a new session\. Returns the new ``Session`` row\."""\s*\n\s*data = self\._http\.request\("POST", "\/v1\/sessions", json_body=coerce_body\(body\) or \{\}\)\s*\n\s*return parse_model\(CreateSessionResponse, data\)/,
    );
  });

  it('Sync list — GET /v1/sessions with PaginationQuery → SessionsListPage. "newest first" ordering pinned in docstring (drift to oldest-first would silently invert pagination semantics and confuse callers who rely on cursor-walking the recent end).', () => {
    expect(body).toMatch(
      /def list\(self, query: PaginationQuery \| dict\[str, Any\] \| None = None\) -> SessionsListPage:\s*\n\s*"""List sessions for the current account, newest first\."""\s*\n\s*data = self\._http\.request\("GET", "\/v1\/sessions", params=coerce_query\(query\)\)\s*\n\s*return parse_model\(SessionsListPage, data\)/,
    );
  });

  it('Sync iterate — Iterator[Session] lazy walk + limit keyword-only re-threaded per page via fetch_page. CRITICAL: limit re-applied on EVERY page (not just the first), otherwise subsequent pages would default to server-side limit and the customer-requested batch size would silently grow mid-walk. Docstring example pinned: `for session in client.sessions.iterate(limit=50): ...`', () => {
    expect(body).toMatch(
      /def iterate\(self, \*, limit: int \| None = None\) -> Iterator\[Session\]:\s*\n\s*"""Lazily walk every session for the EFFECTIVE account\.\s*\n\s*\n\s*Wraps :meth:`list` with cursor handoff so callers can write::\s*\n\s*\n\s*for session in client\.sessions\.iterate\(limit=50\):\s*\n\s*\.\.\.\s*\n\s*"""/,
    );
    expect(body).toMatch(
      /def fetch_page\(cursor: str \| None\) -> SessionsListPage:\s*\n\s*params: dict\[str, Any\] = \{\}\s*\n\s*if limit is not None:\s*\n\s*params\["limit"\] = limit\s*\n\s*if cursor is not None:\s*\n\s*params\["cursor"\] = cursor\s*\n\s*return self\.list\(params\)/,
    );
    expect(body).toMatch(/return iterate_paginated\(fetch_page\)/);
  });

  it('Sync get — GET /v1/sessions/{quoted_id} returns single Session. Single-line implementation; URL-escape via _session_path is the only complexity.', () => {
    expect(body).toMatch(
      /def get\(self, session_id: str\) -> Session:\s*\n\s*data = self\._http\.request\("GET", _session_path\(session_id\)\)\s*\n\s*return parse_model\(Session, data\)/,
    );
  });

  it('Sync navigate — POST /v1/sessions/{id}/navigate with NavigateRequest body. First of the 4 workhorse action verbs (navigate/interact/wait/capture) — each takes a typed Request body and returns a typed Response. NavigateRequest carries the URL to load + optional wait conditions.', () => {
    expect(body).toMatch(
      /def navigate\(self, session_id: str, body: NavigateRequest \| dict\[str, Any\]\) -> NavigateResponse:\s*\n\s*data = self\._http\.request\(\s*\n\s*"POST", _session_path\(session_id, "\/navigate"\), json_body=coerce_body\(body\)\s*\n\s*\)\s*\n\s*return parse_model\(NavigateResponse, data\)/,
    );
  });

  it('Sync interact — POST /v1/sessions/{id}/interact with InteractRequest body. Click / type / scroll / hover semantics; InteractResponse carries post-action page state. Critical for any browser-automation flow — drift to dropping the typed body would lose static type-checking on the interaction kind discriminator.', () => {
    expect(body).toMatch(
      /def interact\(self, session_id: str, body: InteractRequest \| dict\[str, Any\]\) -> InteractResponse:\s*\n\s*data = self\._http\.request\(\s*\n\s*"POST", _session_path\(session_id, "\/interact"\), json_body=coerce_body\(body\)\s*\n\s*\)\s*\n\s*return parse_model\(InteractResponse, data\)/,
    );
  });

  it('Sync wait — POST /v1/sessions/{id}/wait with WaitRequest body. Synchronizes against page-state predicates (selector visibility, network idle, timeout) before returning. Distinct from interact because wait observes without acting.', () => {
    expect(body).toMatch(
      /def wait\(self, session_id: str, body: WaitRequest \| dict\[str, Any\]\) -> WaitResponse:\s*\n\s*data = self\._http\.request\(\s*\n\s*"POST", _session_path\(session_id, "\/wait"\), json_body=coerce_body\(body\)\s*\n\s*\)\s*\n\s*return parse_model\(WaitResponse, data\)/,
    );
  });

  it('Sync get_state — GET /v1/sessions/{id}/state returns SessionState (NOT Session). Distinct shape: SessionState carries live state (URL, viewport, cookies, DOM hash) whereas Session carries identity + lifecycle. Drift to returning Session would lose the live-state fields.', () => {
    expect(body).toMatch(
      /def get_state\(self, session_id: str\) -> SessionState:\s*\n\s*data = self\._http\.request\("GET", _session_path\(session_id, "\/state"\)\)\s*\n\s*return parse_model\(SessionState, data\)/,
    );
  });

  it('Sync capture — POST /v1/sessions/{id}/capture with CaptureRequest body. Screenshot / DOM snapshot / PDF export; the 4th workhorse action verb. CaptureResponse carries the captured artifact reference.', () => {
    expect(body).toMatch(
      /def capture\(self, session_id: str, body: CaptureRequest \| dict\[str, Any\]\) -> CaptureResponse:\s*\n\s*data = self\._http\.request\(\s*\n\s*"POST", _session_path\(session_id, "\/capture"\), json_body=coerce_body\(body\)\s*\n\s*\)\s*\n\s*return parse_model\(CaptureResponse, data\)/,
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

  it('13-verb inventory drift guard — sync defines exactly 14 method defs (13 verbs + __init__); async defines the same 14. Drift to a 14th verb (e.g. a "freeze" or "clone" action) without doubling test coverage would let an untested code path ship; drift to dropping a verb would silently break a documented workhorse flow.', () => {
    const syncStart = body.indexOf('class SessionsResource:');
    const asyncStart = body.indexOf('class AsyncSessionsResource:');
    expect(syncStart, 'expected sync class to come first').toBeGreaterThan(0);
    expect(asyncStart, 'expected async class to come after sync class').toBeGreaterThan(syncStart);
    const syncBody = body.slice(syncStart, asyncStart);
    const asyncBody = body.slice(asyncStart);
    const syncDefs = (syncBody.match(/^ {4}(?:async )?def [a-z_]+\(/gm) ?? []).length;
    expect(syncDefs, 'expected 14 sync method defs (13 verbs + __init__)').toBe(14);
    const asyncDefs = (asyncBody.match(/^ {4}(?:async )?def [a-z_]+\(/gm) ?? []).length;
    expect(asyncDefs, 'expected 14 async method defs (13 verbs + __init__)').toBe(14);
    // POST verb count: create + navigate + interact + wait + capture + extract + search + login = 8
    // POST per class × 2 classes = 16.
    const posts = (body.match(/"POST", /g) ?? []).length;
    expect(posts, 'expected 16 POSTs (8 verbs × sync+async)').toBe(16);
    // GET verb count: list + get + get_state = 3 GET per class × 2 = 6.
    const gets = (body.match(/"GET", /g) ?? []).length;
    expect(gets, 'expected 6 GETs (3 verbs × sync+async)').toBe(6);
    // DELETE: destroy only, 1 per class × 2 = 2.
    const deletes = (body.match(/"DELETE", /g) ?? []).length;
    expect(deletes, 'expected 2 DELETEs (destroy × sync+async)').toBe(2);
  });
});

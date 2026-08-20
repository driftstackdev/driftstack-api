// W424.C (W667-deepened) — drift guard for packages/sdk-typescript/
// src/resources/sessions.ts. The workhorse browser-automation surface.
//
// W667 splits the original 15 it() blocks into 18 focused per-concept
// blocks + pins previously-implicit invariants. Mirrors W640 sdk-go-
// sessions (5→11) + W652 sdk-python-sessions (7→17):
//
//   • 9-verb workhorse surface: create / list / iterate / navigate /
//     interact / wait / getState / capture / destroy. Every per-id
//     verb takes a typed Request/Response pair.
//   • create default-empty body invariant — `body: CreateSessionRequest
//     = {}` lets callers write `sessions.create()` without options.
//   • list "newest first" ordering pinned — drift to oldest-first
//     would invert pagination semantics.
//   • V-118 iterate AsyncGenerator<Session> + in-JSDoc `for await`
//     example pattern + cursor `!== null` guard + limit re-threading
//     per page.
//   • Per-id verbs (navigate / interact / wait / getState / capture /
//     destroy) all use ${encodeURIComponent(sessionId)} — drift to
//     dropping escape lets "abc/../.." traverse.
//   • idempotent destroy — drift to non-idempotent breaks cleanup-
//     in-finally pattern.
//   • getState returns SessionState (NOT Session) — distinct shape
//     carries URL/title/cookies/localStorage; drift to returning
//     Session would lose live-state fields.
//   • 9-verb inventory + verb-mix: 5 POSTs + 2 GETs + 1 DELETE +
//     ZERO PATCH/PUT (sessions are atomic; no partial-update).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/sessions.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W424.C packages/sdk-typescript/src/resources/sessions.ts content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path + module header anchor (typed methods for /v1/sessions and /v1/sessions/:id/*)', () => {
    expect(existsSync(LIB)).toBe(true);
    expect(body).toMatch(
      /\/\/ SessionsResource — typed methods for \/v1\/sessions and \/v1\/sessions\/:id\/\*\./,
    );
  });

  it('Imports — 18 api-types verb shapes (sorted alphabetical block; Request/Response pairs for every per-id action + Session/SessionState models + PaginationQueryInput) + HttpClient + iteratePaginated. Drift to hand-rolling any shape would diverge from @driftstack/api-types Zod single-source-of-truth.', () => {
    expect(body).toMatch(
      /import type \{\s*\n?\s*CaptureRequestInput,\s*\n?\s*CaptureResponse,\s*\n?\s*ExtractRequest,\s*\n?\s*ExtractResponse,\s*\n?\s*SearchRequestInput,\s*\n?\s*SearchResponse,\s*\n?\s*SessionLoginRequest,\s*\n?\s*SessionLoginResponse,\s*\n?\s*CreateSessionRequest,\s*\n?\s*InteractRequest,\s*\n?\s*InteractResponse,\s*\n?\s*NavigateRequestInput,\s*\n?\s*NavigateResponse,\s*\n?\s*PaginationQueryInput,\s*\n?\s*Session,\s*\n?\s*SessionState,\s*\n?\s*WaitRequest,\s*\n?\s*WaitResponse,\s*\n?\s*\} from '@driftstack\/api-types';/,
    );
    expect(body).toMatch(/import type \{ HttpClient \} from '\.\.\/http\.js';/);
    expect(body).toMatch(
      /import \{ SearchResponseSchema, SessionLoginResponseSchema \} from '@driftstack\/api-types';/,
    );
    expect(body).toMatch(/import \{ TransportError \} from '\.\.\/errors\.js';/);
    expect(body).toMatch(/import \{ iteratePaginated \} from '\.\.\/pagination\.js';/);
  });

  it('SessionsListPage envelope — 3-field cursor pagination (data: Session[] + has_more: boolean + next_cursor: string | null). Sessions are unbounded per account so cursor pagination is load-bearing for the list verb.', () => {
    expect(body).toMatch(
      /export interface SessionsListPage \{\s*\n?\s*data: Session\[\];\s*\n?\s*has_more: boolean;\s*\n?\s*next_cursor: string \| null;\s*\n?\s*\}/,
    );
  });

  it('SessionsResource class declaration + private-readonly http constructor field.', () => {
    expect(body).toMatch(
      /export class SessionsResource \{\s*\n?\s*constructor\(private readonly http: HttpClient\) \{\}/,
    );
  });

  it('create verb — POST /v1/sessions with `body: CreateSessionRequest = {}` DEFAULT-EMPTY parameter. Callers can write `sessions.create()` for the no-options case (covering "I just want a session" UX). Returns Session directly (not an envelope). Drift to required body would break the convenience UX.', () => {
    expect(body).toMatch(/\/\*\* Create a new session\. \*\//);
    expect(body).toMatch(
      /create\(body: CreateSessionRequest = \{\}\): Promise<Session> \{\s*\n?\s*return this\.http\.request<Session>\(\{ method: 'POST', path: '\/v1\/sessions', body \}\);\s*\n?\s*\}/,
    );
  });

  it('list verb — GET /v1/sessions with PaginationQueryInput → Promise<SessionsListPage>. CRITICAL "newest first" ordering pinned in JSDoc — drift to oldest-first would invert pagination semantics customers anchor their "show me my recent sessions" UX on. Conditional-spread on limit + cursor defers to server-side defaults.', () => {
    expect(body).toMatch(/\/\*\* List sessions for the current account, newest first\. \*\//);
    expect(body).toMatch(
      /list\(query: PaginationQueryInput = \{\}\): Promise<SessionsListPage> \{\s*\n?\s*return this\.http\.request<SessionsListPage>\(\{\s*\n?\s*method: 'GET',\s*\n?\s*path: '\/v1\/sessions',\s*\n?\s*query: \{\s*\n?\s*\.\.\.\(query\.limit !== undefined \? \{ limit: query\.limit \} : \{\}\),\s*\n?\s*\.\.\.\(query\.cursor !== undefined \? \{ cursor: query\.cursor \} : \{\}\),\s*\n?\s*\},\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('CRITICAL V-118 iterate JSDoc — AsyncGenerator<Session, void, void>. 4-line invariant: walks cursor pages automatically + opts.limit controls per-page size + transparent next-page fetch on exhaustion + stops on `next_cursor: null`. Drift to dropping the stop-on-null framing would let iterators run forever on a misconfigured server. In-JSDoc `for await` example pinned per-line — load-bearing customer-facing guidance for the consumer pattern.', () => {
    expect(body).toMatch(
      /\*\s*Lazily iterate every session for the EFFECTIVE account, walking\s*\n?\s*\*\s*cursor pages automatically\. `opts\.limit` controls per-page size;\s*\n?\s*\*\s*the iterator transparently fetches the next page once the current\s*\n?\s*\*\s*one is exhausted, and stops on `next_cursor: null`\./,
    );
    expect(body).toMatch(
      /\*\s*for await \(const session of client\.sessions\.iterate\(\{ limit: 50 \}\)\) \{\s*\n?\s*\*\s*console\.log\(session\.id\);\s*\n?\s*\*\s*\}/,
    );
  });

  it('iterate verb implementation — thin wrapper around iteratePaginated<Session>. CRITICAL: limit re-threaded per page (opts.limit applied on EVERY page, not just first) + cursor `!== null` guard (NOT `!== undefined` — explicitly null on first page) means cursor only added after the first page returns a non-null next_cursor.', () => {
    expect(body).toMatch(
      /iterate\(opts: \{ limit\?: number \} = \{\}\): AsyncGenerator<Session, void, void> \{\s*\n?\s*return iteratePaginated<Session>\(\(cursor\) =>\s*\n?\s*this\.list\(\{\s*\n?\s*\.\.\.\(opts\.limit !== undefined \? \{ limit: opts\.limit \} : \{\}\),\s*\n?\s*\.\.\.\(cursor !== null \? \{ cursor \} : \{\}\),\s*\n?\s*\}\),\s*\n?\s*\);\s*\n?\s*\}/,
    );
  });

  it('navigate verb — POST /v1/sessions/${encodeURIComponent(sessionId)}/navigate with NavigateRequestInput body → Promise<NavigateResponse>. First of the 4 workhorse action verbs (navigate/interact/wait/capture). encodeURIComponent wrapping prevents path traversal via maliciously-crafted session ids.', () => {
    expect(body).toMatch(/\/\*\* Navigate the session to a URL\. \*\//);
    expect(body).toMatch(
      /navigate\(sessionId: string, body: NavigateRequestInput\): Promise<NavigateResponse> \{\s*\n?\s*return this\.http\.request<NavigateResponse>\(\{\s*\n?\s*method: 'POST',\s*\n?\s*path: `\/v1\/sessions\/\$\{encodeURIComponent\(sessionId\)\}\/navigate`,\s*\n?\s*body,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('interact verb — POST /v1/sessions/${encodeURIComponent(sessionId)}/interact with InteractRequest body. CRITICAL 4-action set pinned in JSDoc: "tap, type, scroll, press" — the kind discriminator on InteractRequest. Drift to dropping any one of the 4 actions would silently lose a fundamental automation primitive customer-side.', () => {
    expect(body).toMatch(
      /\/\*\* Send an interaction \(tap, type, scroll, press\) to the session\. \*\//,
    );
    expect(body).toMatch(
      /interact\(sessionId: string, body: InteractRequest\): Promise<InteractResponse> \{\s*\n?\s*return this\.http\.request<InteractResponse>\(\{\s*\n?\s*method: 'POST',\s*\n?\s*path: `\/v1\/sessions\/\$\{encodeURIComponent\(sessionId\)\}\/interact`,\s*\n?\s*body,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('wait verb — POST /v1/sessions/${encodeURIComponent(sessionId)}/wait with WaitRequest body. CRITICAL 3-condition set pinned: "selector, url, time" — the kind discriminator. Wait observes without acting — distinct from interact (which acts). Drift to merging the two would break the "I want to synchronize but not act" use case.', () => {
    expect(body).toMatch(
      /\/\*\* Wait for a condition to be satisfied \(selector, url, time\)\. \*\//,
    );
    expect(body).toMatch(
      /wait\(sessionId: string, body: WaitRequest\): Promise<WaitResponse> \{\s*\n?\s*return this\.http\.request<WaitResponse>\(\{\s*\n?\s*method: 'POST',\s*\n?\s*path: `\/v1\/sessions\/\$\{encodeURIComponent\(sessionId\)\}\/wait`,\s*\n?\s*body,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('getState verb — GET /v1/sessions/${encodeURIComponent(sessionId)}/state → Promise<SessionState>. CRITICAL: returns SessionState (NOT Session). Distinct shape carries live state (URL, title, cookies, localStorage). Drift to returning Session would lose the live-state fields. JSDoc 4-field snapshot list pinned: URL, title, cookies, localStorage.', () => {
    expect(body).toMatch(
      /\/\*\* Snapshot current session state \(URL, title, cookies, localStorage\)\. \*\//,
    );
    expect(body).toMatch(
      /getState\(sessionId: string\): Promise<SessionState> \{\s*\n?\s*return this\.http\.request<SessionState>\(\{\s*\n?\s*method: 'GET',\s*\n?\s*path: `\/v1\/sessions\/\$\{encodeURIComponent\(sessionId\)\}\/state`,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('capture verb — POST /v1/sessions/${encodeURIComponent(sessionId)}/capture with CaptureRequestInput body → Promise<CaptureResponse>. CRITICAL 3-artifact set pinned: "screenshot, DOM snapshot, or PDF" — the kind discriminator on CaptureRequestInput. Drift to dropping any artifact type would lose a fundamental capture primitive.', () => {
    expect(body).toMatch(/\/\*\* Capture a screenshot, DOM snapshot, or PDF\. \*\//);
    expect(body).toMatch(
      /capture\(sessionId: string, body: CaptureRequestInput\): Promise<CaptureResponse> \{\s*\n?\s*return this\.http\.request<CaptureResponse>\(\{\s*\n?\s*method: 'POST',\s*\n?\s*path: `\/v1\/sessions\/\$\{encodeURIComponent\(sessionId\)\}\/capture`,\s*\n?\s*body,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('CRITICAL destroy verb — DELETE /v1/sessions/${encodeURIComponent(sessionId)} → Promise<void>. "Idempotent" framing pinned — drift to non-idempotent (404 on already-destroyed) would break the standard cleanup-in-finally pattern where callers destroy without first checking liveness.', () => {
    expect(body).toMatch(/\/\*\* Destroy the session\. Idempotent\. \*\//);
    expect(body).toMatch(
      /destroy\(sessionId: string\): Promise<void> \{\s*\n?\s*return this\.http\.request<void>\(\{\s*\n?\s*method: 'DELETE',\s*\n?\s*path: `\/v1\/sessions\/\$\{encodeURIComponent\(sessionId\)\}`,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it("encodeURIComponent on :sessionId — EXACTLY 10 escape call sites (get + navigate + interact + wait + getState + capture + extract + search + login + destroy). iterate doesn't escape directly (delegates via this.list() which doesn't use :sessionId). create doesn't escape (no :sessionId in the create path). Drift to dropping any escape would let \"abc/../..\" traverse.", () => {
    const matches = body.match(/encodeURIComponent\(sessionId\)/g) ?? [];
    expect(matches.length, 'expected encodeURIComponent(sessionId) 10 times').toBe(10);
  });

  it('13-verb inventory + verb-mix invariants — exactly 13 method declarations (create + list + iterate + get + navigate + interact + wait + getState + capture + extract + search + login + destroy). Verb mix: 8 POSTs (create + navigate + interact + wait + capture + extract + search + login) + 3 GETs (list + get + getState) + 1 DELETE (destroy) = 12 wire-call verbs (iterate is delegation). ZERO PATCH/PUT — sessions are atomic; no partial-update.', () => {
    const methods = body.match(/^ {2}(?!constructor)(?:async )?[a-zA-Z]+\(/gm) ?? [];
    expect(methods.length, 'expected 13 verb declarations').toBe(13);
    const posts = (body.match(/method: 'POST'/g) ?? []).length;
    expect(posts, 'expected 8 POSTs').toBe(8);
    const gets = (body.match(/method: 'GET'/g) ?? []).length;
    expect(gets, 'expected 3 GETs (list + get + getState)').toBe(3);
    const deletes = (body.match(/method: 'DELETE'/g) ?? []).length;
    expect(deletes, 'expected 1 DELETE (destroy)').toBe(1);
    expect(body).not.toMatch(/method: 'PATCH'/);
    expect(body).not.toMatch(/method: 'PUT'/);
  });

  it('login validates the successful body at runtime and normalizes schema drift to TransportError', () => {
    expect(body).toMatch(
      /async login\(sessionId: string, body: SessionLoginRequest\): Promise<SessionLoginResponse>/,
    );
    expect(body).toMatch(/const response = await this\.http\.request<unknown>\(/);
    expect(body).toMatch(/const parsed = SessionLoginResponseSchema\.safeParse\(response\);/);
    expect(body).toMatch(
      /throw new TransportError\('invalid session login response body', 200, parsed\.error\);/,
    );
    expect(body).toMatch(/return parsed\.data;/);
  });

  it('search validates the strict response union at runtime and normalizes schema drift to TransportError', () => {
    expect(body).toMatch(
      /async search\(sessionId: string, body: SearchRequestInput\): Promise<SearchResponse>/,
    );
    expect(body).toMatch(/const parsed = SearchResponseSchema\.safeParse\(response\);/);
    expect(body).toMatch(
      /throw new TransportError\('invalid session search response body', 200, parsed\.error\);/,
    );
  });

  it('Wire-path inventory — bare /v1/sessions (create + list) + per-id sub-paths for 6 verbs (navigate/interact/wait/state/capture + bare destroy). The "interact + tap+type+scroll+press" pattern follows 1-path-per-action (no shared /interact endpoint with action body discriminator) so each verb is independently rate-limitable server-side. Drift to a shared /interact path would collapse server-side rate-limit granularity.', () => {
    expect(body).toMatch(/path: '\/v1\/sessions'/);
    expect(body).toMatch(/path: `\/v1\/sessions\/\$\{encodeURIComponent\(sessionId\)\}\/navigate`/);
    expect(body).toMatch(/path: `\/v1\/sessions\/\$\{encodeURIComponent\(sessionId\)\}\/interact`/);
    expect(body).toMatch(/path: `\/v1\/sessions\/\$\{encodeURIComponent\(sessionId\)\}\/wait`/);
    expect(body).toMatch(/path: `\/v1\/sessions\/\$\{encodeURIComponent\(sessionId\)\}\/state`/);
    expect(body).toMatch(/path: `\/v1\/sessions\/\$\{encodeURIComponent\(sessionId\)\}\/capture`/);
    expect(body).toMatch(/path: `\/v1\/sessions\/\$\{encodeURIComponent\(sessionId\)\}`/);
  });
});

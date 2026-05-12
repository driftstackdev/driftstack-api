// W424.C — drift guard for packages/sdk-typescript/src/resources/sessions.ts.
// SessionsResource — the workhorse browser-automation surface. Drift
// here either breaks a verb (consumers can't tap/type/wait/capture)
// or strips the V-118 iterate wrapper (async-iterator pagination
// breaks for consumers of `for await (const s of client.sessions.iterate())`).
//
//   • Framing pinned: typed methods for /v1/sessions and
//     /v1/sessions/:id/*.
//   • SessionsListPage envelope: data[] + has_more + next_cursor.
//   • Verb surface: create + list + iterate + navigate + interact +
//     wait + getState + capture + destroy (9 methods).
//   • destroy is idempotent.
//   • All :id path segments encodeURIComponent-wrapped.
//   • iterate(opts) thin wrapper around iteratePaginated<Session>.

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

  it('Framing pinned: typed methods for /v1/sessions and /v1/sessions/:id/*', () => {
    expect(body).toMatch(
      /\/\/ SessionsResource — typed methods for \/v1\/sessions and \/v1\/sessions\/:id\/\*\./,
    );
  });

  it('imports: api-types verb shapes + HttpClient + iteratePaginated (V-118)', () => {
    expect(body).toMatch(
      /import type \{\s*\n?\s*CaptureRequestInput,\s*\n?\s*CaptureResponse,\s*\n?\s*CreateSessionRequest,\s*\n?\s*InteractRequest,\s*\n?\s*InteractResponse,\s*\n?\s*NavigateRequestInput,\s*\n?\s*NavigateResponse,\s*\n?\s*PaginationQueryInput,\s*\n?\s*Session,\s*\n?\s*SessionState,\s*\n?\s*WaitRequest,\s*\n?\s*WaitResponse,\s*\n?\s*\} from '@driftstack\/api-types';/,
    );
    expect(body).toMatch(/import type \{ HttpClient \} from '\.\.\/http\.js';/);
    expect(body).toMatch(/import \{ iteratePaginated \} from '\.\.\/pagination\.js';/);
  });

  it('SessionsListPage envelope pinned: data Session[] + has_more boolean + next_cursor string|null', () => {
    expect(body).toMatch(
      /export interface SessionsListPage \{\s*\n?\s*data: Session\[\];\s*\n?\s*has_more: boolean;\s*\n?\s*next_cursor: string \| null;\s*\n?\s*\}/,
    );
  });

  it('SessionsResource constructor: private readonly http: HttpClient', () => {
    expect(body).toMatch(
      /export class SessionsResource \{\s*\n?\s*constructor\(private readonly http: HttpClient\) \{\}/,
    );
  });

  it('create(body={}): POST /v1/sessions; returns Session; defaults CreateSessionRequest to {}', () => {
    expect(body).toMatch(/\/\*\* Create a new session\. \*\//);
    expect(body).toMatch(
      /create\(body: CreateSessionRequest = \{\}\): Promise<Session> \{\s*\n?\s*return this\.http\.request<Session>\(\{ method: 'POST', path: '\/v1\/sessions', body \}\);\s*\n?\s*\}/,
    );
  });

  it('list(query={}): GET /v1/sessions; PaginationQueryInput pass-through (limit/cursor conditional-spread); returns SessionsListPage', () => {
    expect(body).toMatch(/\/\*\* List sessions for the current account, newest first\. \*\//);
    expect(body).toMatch(
      /list\(query: PaginationQueryInput = \{\}\): Promise<SessionsListPage> \{\s*\n?\s*return this\.http\.request<SessionsListPage>\(\{\s*\n?\s*method: 'GET',\s*\n?\s*path: '\/v1\/sessions',\s*\n?\s*query: \{\s*\n?\s*\.\.\.\(query\.limit !== undefined \? \{ limit: query\.limit \} : \{\}\),\s*\n?\s*\.\.\.\(query\.cursor !== undefined \? \{ cursor: query\.cursor \} : \{\}\),\s*\n?\s*\},\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('iterate(opts={}): AsyncGenerator<Session, void, void> thin wrapper around iteratePaginated<Session>; passes opts.limit + cursor !== null guard', () => {
    expect(body).toMatch(
      /\*\s*Lazily iterate every session for the calling account, walking\s*\n?\s*\*\s*cursor pages automatically\. `opts\.limit` controls per-page size;\s*\n?\s*\*\s*the iterator transparently fetches the next page once the current\s*\n?\s*\*\s*one is exhausted, and stops on `next_cursor: null`\./,
    );
    expect(body).toMatch(
      /\*\s*for await \(const session of client\.sessions\.iterate\(\{ limit: 50 \}\)\) \{\s*\n?\s*\*\s*console\.log\(session\.id\);\s*\n?\s*\*\s*\}/,
    );
    expect(body).toMatch(
      /iterate\(opts: \{ limit\?: number \} = \{\}\): AsyncGenerator<Session, void, void> \{\s*\n?\s*return iteratePaginated<Session>\(\(cursor\) =>\s*\n?\s*this\.list\(\{\s*\n?\s*\.\.\.\(opts\.limit !== undefined \? \{ limit: opts\.limit \} : \{\}\),\s*\n?\s*\.\.\.\(cursor !== null \? \{ cursor \} : \{\}\),\s*\n?\s*\}\),\s*\n?\s*\);\s*\n?\s*\}/,
    );
  });

  it('navigate(sessionId, body): POST /v1/sessions/:id/navigate with encodeURIComponent on :id', () => {
    expect(body).toMatch(/\/\*\* Navigate the session to a URL\. \*\//);
    expect(body).toMatch(
      /navigate\(sessionId: string, body: NavigateRequestInput\): Promise<NavigateResponse> \{\s*\n?\s*return this\.http\.request<NavigateResponse>\(\{\s*\n?\s*method: 'POST',\s*\n?\s*path: `\/v1\/sessions\/\$\{encodeURIComponent\(sessionId\)\}\/navigate`,\s*\n?\s*body,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('interact(sessionId, body): POST /v1/sessions/:id/interact (tap/type/scroll/press) with encodeURIComponent', () => {
    expect(body).toMatch(
      /\/\*\* Send an interaction \(tap, type, scroll, press\) to the session\. \*\//,
    );
    expect(body).toMatch(
      /interact\(sessionId: string, body: InteractRequest\): Promise<InteractResponse> \{\s*\n?\s*return this\.http\.request<InteractResponse>\(\{\s*\n?\s*method: 'POST',\s*\n?\s*path: `\/v1\/sessions\/\$\{encodeURIComponent\(sessionId\)\}\/interact`,\s*\n?\s*body,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('wait(sessionId, body): POST /v1/sessions/:id/wait (selector/url/time) with encodeURIComponent', () => {
    expect(body).toMatch(
      /\/\*\* Wait for a condition to be satisfied \(selector, url, time\)\. \*\//,
    );
    expect(body).toMatch(
      /wait\(sessionId: string, body: WaitRequest\): Promise<WaitResponse> \{\s*\n?\s*return this\.http\.request<WaitResponse>\(\{\s*\n?\s*method: 'POST',\s*\n?\s*path: `\/v1\/sessions\/\$\{encodeURIComponent\(sessionId\)\}\/wait`,\s*\n?\s*body,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('getState(sessionId): GET /v1/sessions/:id/state with encodeURIComponent; returns SessionState', () => {
    expect(body).toMatch(
      /\/\*\* Snapshot current session state \(URL, title, cookies, localStorage\)\. \*\//,
    );
    expect(body).toMatch(
      /getState\(sessionId: string\): Promise<SessionState> \{\s*\n?\s*return this\.http\.request<SessionState>\(\{\s*\n?\s*method: 'GET',\s*\n?\s*path: `\/v1\/sessions\/\$\{encodeURIComponent\(sessionId\)\}\/state`,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('capture(sessionId, body): POST /v1/sessions/:id/capture (screenshot/DOM/PDF) with encodeURIComponent', () => {
    expect(body).toMatch(/\/\*\* Capture a screenshot, DOM snapshot, or PDF\. \*\//);
    expect(body).toMatch(
      /capture\(sessionId: string, body: CaptureRequestInput\): Promise<CaptureResponse> \{\s*\n?\s*return this\.http\.request<CaptureResponse>\(\{\s*\n?\s*method: 'POST',\s*\n?\s*path: `\/v1\/sessions\/\$\{encodeURIComponent\(sessionId\)\}\/capture`,\s*\n?\s*body,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('destroy(sessionId): DELETE /v1/sessions/:id with encodeURIComponent; idempotent; returns void', () => {
    expect(body).toMatch(/\/\*\* Destroy the session\. Idempotent\. \*\//);
    expect(body).toMatch(
      /destroy\(sessionId: string\): Promise<void> \{\s*\n?\s*return this\.http\.request<void>\(\{\s*\n?\s*method: 'DELETE',\s*\n?\s*path: `\/v1\/sessions\/\$\{encodeURIComponent\(sessionId\)\}`,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('All :id path segments wrapped with encodeURIComponent (6 occurrences: navigate/interact/wait/getState/capture/destroy)', () => {
    const matches = body.match(/encodeURIComponent\(sessionId\)/g);
    expect(matches).not.toBeNull();
    expect((matches ?? []).length).toBe(6);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});

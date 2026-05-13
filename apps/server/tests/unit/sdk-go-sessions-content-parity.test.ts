// W589.B — drift guard for packages/sdk-go/sessions.go.
// SessionsResource Go parity — workhorse 9-verb surface.
//
//   • 9 verbs: Create / List / Get / Navigate / Interact / Wait /
//     GetState / Capture / Destroy.
//   • Create nil-body default; List builds query via url.Values
//     with limit + cursor (strconv.Itoa); per-session paths via
//     url.PathEscape.
//   • Destroy is idempotent (DELETE; no body).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-go/sessions.go');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W589.B packages/sdk-go/sessions.go content parity', () => {
  const body = read(LIB);

  it('SessionsResource struct + imports (context + net/url + strconv) pinned', () => {
    expect(body).toMatch(/^package driftstack$/m);
    expect(body).toMatch(/^import \(\s*\n\s*"context"\s*\n\s*"net\/url"\s*\n\s*"strconv"\s*\n\)$/m);
    expect(body).toMatch(/\/\/ SessionsResource handles \/v1\/sessions\[\/\.\.\.\] endpoints\./);
    expect(body).toMatch(/^type SessionsResource struct \{\s*\n\s*client \*Client\s*\n\}/m);
  });

  it('Create nil-body default + List builds url.Values with limit (strconv.Itoa) + cursor; both POST/GET /v1/sessions', () => {
    expect(body).toMatch(
      /func \(r \*SessionsResource\) Create\(ctx context\.Context, body \*CreateSessionRequest\) \(\*Session, error\) \{/,
    );
    expect(body).toMatch(/if body == nil \{\s*\n\s*body = &CreateSessionRequest\{\}\s*\n\s*\}/);
    expect(body).toMatch(/path:\s+"\/v1\/sessions",/);
    expect(body).toMatch(
      /func \(r \*SessionsResource\) List\(ctx context\.Context, query \*ListSessionsQuery\) \(\*SessionsListPage, error\) \{/,
    );
    expect(body).toMatch(/q := url\.Values\{\}/);
    expect(body).toMatch(
      /if query != nil \{\s*\n\s*if query\.Limit > 0 \{\s*\n\s*q\.Set\("limit", strconv\.Itoa\(query\.Limit\)\)\s*\n\s*\}\s*\n\s*if query\.Cursor != "" \{\s*\n\s*q\.Set\("cursor", query\.Cursor\)\s*\n\s*\}\s*\n\s*\}/,
    );
    expect(body).toMatch(/query:\s+q,/);
  });

  it('Get + Navigate + Interact + Wait + GetState + Capture: all use "/v1/sessions/" + url.PathEscape(sessionID) and POST sub-paths for navigate/interact/wait/capture, GET for get/state', () => {
    expect(body).toMatch(
      /func \(r \*SessionsResource\) Get\(ctx context\.Context, sessionID string\) \(\*Session, error\) \{/,
    );
    expect(body).toMatch(/path:\s+"\/v1\/sessions\/" \+ url\.PathEscape\(sessionID\),/);
    expect(body).toMatch(
      /func \(r \*SessionsResource\) Navigate\(ctx context\.Context, sessionID string, body \*NavigateRequest\) \(\*NavigateResponse, error\) \{/,
    );
    expect(body).toMatch(
      /path:\s+"\/v1\/sessions\/" \+ url\.PathEscape\(sessionID\) \+ "\/navigate",/,
    );
    expect(body).toMatch(
      /func \(r \*SessionsResource\) Interact\(ctx context\.Context, sessionID string, body \*InteractRequest\) \(\*InteractResponse, error\) \{/,
    );
    expect(body).toMatch(
      /path:\s+"\/v1\/sessions\/" \+ url\.PathEscape\(sessionID\) \+ "\/interact",/,
    );
    expect(body).toMatch(
      /func \(r \*SessionsResource\) Wait\(ctx context\.Context, sessionID string, body \*WaitRequest\) \(\*WaitResponse, error\) \{/,
    );
    expect(body).toMatch(/path:\s+"\/v1\/sessions\/" \+ url\.PathEscape\(sessionID\) \+ "\/wait",/);
    expect(body).toMatch(
      /func \(r \*SessionsResource\) GetState\(ctx context\.Context, sessionID string\) \(\*SessionState, error\) \{/,
    );
    expect(body).toMatch(
      /path:\s+"\/v1\/sessions\/" \+ url\.PathEscape\(sessionID\) \+ "\/state",/,
    );
    expect(body).toMatch(
      /func \(r \*SessionsResource\) Capture\(ctx context\.Context, sessionID string, body \*CaptureRequest\) \(\*CaptureResponse, error\) \{/,
    );
    expect(body).toMatch(
      /path:\s+"\/v1\/sessions\/" \+ url\.PathEscape\(sessionID\) \+ "\/capture",/,
    );
  });

  it('Destroy: DELETE /v1/sessions/{id}; idempotent (return r.client.do directly + no out); framing pinned', () => {
    expect(body).toMatch(/\/\/ Destroy ends the session\. Idempotent — calling it twice is safe\./);
    expect(body).toMatch(
      /func \(r \*SessionsResource\) Destroy\(ctx context\.Context, sessionID string\) error \{\s*\n\s*return r\.client\.do\(ctx, requestOptions\{\s*\n\s*method: "DELETE",\s*\n\s*path:\s+"\/v1\/sessions\/" \+ url\.PathEscape\(sessionID\),\s*\n\s*\}\)\s*\n\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});

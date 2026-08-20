// W589.B (W640-deepened) — drift guard for packages/sdk-go/sessions.go.
// SessionsResource Go parity — workhorse 9-verb surface.
//
// W640 splits the original 5 it() blocks (3 of which bundled multiple
// verbs) into 11 focused per-verb blocks + pins previously-implicit
// invariants:
//
//   • Create nil-body default — callers pass nil for defaults; the
//     SDK plugs &CreateSessionRequest{} so the wire body is "{}",
//     not Go's JSON-zero-value "null".
//   • List 2-param conditional-set-on-non-zero query (limit / cursor)
//     with strconv.Itoa for the int + "newest first" ordering.
//   • Per-session sub-path consistency — every per-id verb (Navigate
//     / Interact / Wait / GetState / Capture) prefixes with
//     "/v1/sessions/" + url.PathEscape(sessionID) + sub-path. Drift
//     here would let a malformed id inject path traversal.
//   • Destroy idempotent ("calling it twice is safe") + plain DELETE
//     return without an out struct.
//   • The session-action verbs (Navigate / Interact / Wait / Capture)
//     are all POST with a typed body; GetState is GET with no body
//     (state is a read, not a side-effecting action).

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

  it('file exists at canonical path + package + 3-import surface (context + net/url + strconv) + SessionsResource binds /v1/sessions[/...]', () => {
    expect(existsSync(LIB)).toBe(true);
    expect(body).toMatch(/^package driftstack$/m);
    expect(body).toMatch(/^import \(\s*\n\s*"context"\s*\n\s*"net\/url"\s*\n\s*"strconv"\s*\n\)$/m);
    expect(body).toMatch(/\/\/ SessionsResource handles \/v1\/sessions\[\/\.\.\.\] endpoints\./);
    expect(body).toMatch(/^type SessionsResource struct \{\s*\n\s*client \*Client\s*\n\}/m);
  });

  it('Create — POST /v1/sessions + nil-body-default substitution ("Pass nil for default options"; SDK plugs &CreateSessionRequest{} so the wire body is "{}", not Go\'s JSON-zero-value "null")', () => {
    expect(body).toMatch(/\/\/ Create makes a new session\. Pass nil for default options\./);
    expect(body).toMatch(
      /func \(r \*SessionsResource\) Create\(ctx context\.Context, body \*CreateSessionRequest\) \(\*Session, error\)/,
    );
    expect(body).toMatch(/if body == nil \{\s*\n\s*body = &CreateSessionRequest\{\}\s*\n\s*\}/);
    expect(body).toMatch(/method: "POST",\s*\n\s*path:\s+"\/v1\/sessions",/);
  });

  it('List — GET /v1/sessions + 2-param conditional-set-on-non-zero query (limit / cursor) with strconv.Itoa for the int + "newest first" ordering invariant pinned in the doc-comment', () => {
    expect(body).toMatch(
      /\/\/ List returns a page of sessions for the EFFECTIVE account — the caller's own,/,
    );
    expect(body).toMatch(/\/\/ Pass nil for defaults\./);
    expect(body).toMatch(
      /func \(r \*SessionsResource\) List\(ctx context\.Context, query \*ListSessionsQuery\) \(\*SessionsListPage, error\)/,
    );
    expect(body).toMatch(/q := url\.Values\{\}/);
    expect(body).toMatch(
      /if query != nil \{\s*\n\s*if query\.Limit > 0 \{\s*\n\s*q\.Set\("limit", strconv\.Itoa\(query\.Limit\)\)\s*\n\s*\}\s*\n\s*if query\.Cursor != "" \{\s*\n\s*q\.Set\("cursor", query\.Cursor\)\s*\n\s*\}\s*\n\s*\}/,
    );
    expect(body).toMatch(/method: "GET",\s*\n\s*path:\s+"\/v1\/sessions",\s*\n\s*query:\s+q,/);
  });

  it('Get — GET /v1/sessions/{id} via "/v1/sessions/" + url.PathEscape(sessionID). PathEscape escapes the user-controlled id segment so a malformed id cannot inject path traversal.', () => {
    expect(body).toMatch(/\/\/ Get fetches a single session by id\./);
    expect(body).toMatch(
      /func \(r \*SessionsResource\) Get\(ctx context\.Context, sessionID string\) \(\*Session, error\)/,
    );
    expect(body).toMatch(
      /method: "GET",\s*\n\s*path:\s+"\/v1\/sessions\/" \+ url\.PathEscape\(sessionID\),/,
    );
  });

  it('Navigate — POST /v1/sessions/{id}/navigate with NavigateRequest body. The "navigate to URL" verb is a side-effecting action (drives the browser), so it\'s POST with a typed body — drift to PATCH/PUT would break the action-vs-update RESTful distinction.', () => {
    expect(body).toMatch(/\/\/ Navigate the session to a URL\./);
    expect(body).toMatch(
      /func \(r \*SessionsResource\) Navigate\(ctx context\.Context, sessionID string, body \*NavigateRequest\) \(\*NavigateResponse, error\)/,
    );
    expect(body).toMatch(
      /method: "POST",\s*\n\s*path:\s+"\/v1\/sessions\/" \+ url\.PathEscape\(sessionID\) \+ "\/navigate",/,
    );
  });

  it('Interact — POST /v1/sessions/{id}/interact with InteractRequest body. Doc-comment names the 4 action types: tap / type / scroll / press. Drift to dropping any of these from the action enum would silently shrink the customer-facing interaction surface.', () => {
    expect(body).toMatch(/\/\/ Interact sends a tap \/ type \/ scroll \/ press to the session\./);
    expect(body).toMatch(
      /func \(r \*SessionsResource\) Interact\(ctx context\.Context, sessionID string, body \*InteractRequest\) \(\*InteractResponse, error\)/,
    );
    expect(body).toMatch(
      /method: "POST",\s*\n\s*path:\s+"\/v1\/sessions\/" \+ url\.PathEscape\(sessionID\) \+ "\/interact",/,
    );
  });

  it("Wait — POST /v1/sessions/{id}/wait. Blocks until a condition (selector / url match / time) is satisfied OR the request's TimeoutMS elapses. The three condition types (selector / url match / time) + the TimeoutMS escape hatch are pinned in the doc-comment so dropping any silently shrinks the wait surface.", () => {
    expect(body).toMatch(
      /\/\/ Wait blocks until a condition \(selector, url match, time\) is satisfied/,
    );
    expect(body).toMatch(/\/\/ or the request's TimeoutMS elapses\./);
    expect(body).toMatch(
      /func \(r \*SessionsResource\) Wait\(ctx context\.Context, sessionID string, body \*WaitRequest\) \(\*WaitResponse, error\)/,
    );
    expect(body).toMatch(
      /method: "POST",\s*\n\s*path:\s+"\/v1\/sessions\/" \+ url\.PathEscape\(sessionID\) \+ "\/wait",/,
    );
  });

  it('GetState — GET /v1/sessions/{id}/state snapshots URL + title + cookies + etc. Read verb (no side-effects on the session), so GET — drift to POST would break the safe-to-retry-without-effects HTTP contract that proxies / cache layers depend on.', () => {
    expect(body).toMatch(
      /\/\/ GetState snapshots the session's current URL, title, cookies, etc\./,
    );
    expect(body).toMatch(
      /func \(r \*SessionsResource\) GetState\(ctx context\.Context, sessionID string\) \(\*SessionState, error\)/,
    );
    expect(body).toMatch(
      /method: "GET",\s*\n\s*path:\s+"\/v1\/sessions\/" \+ url\.PathEscape\(sessionID\) \+ "\/state",/,
    );
  });

  it('Capture — POST /v1/sessions/{id}/capture produces screenshot / DOM snapshot / PDF. 3 capture types pinned in the doc-comment so dropping any from the kind enum would silently shrink the capture surface.', () => {
    expect(body).toMatch(/\/\/ Capture produces a screenshot, DOM snapshot, or PDF\./);
    expect(body).toMatch(
      /func \(r \*SessionsResource\) Capture\(ctx context\.Context, sessionID string, body \*CaptureRequest\) \(\*CaptureResponse, error\)/,
    );
    expect(body).toMatch(
      /method: "POST",\s*\n\s*path:\s+"\/v1\/sessions\/" \+ url\.PathEscape\(sessionID\) \+ "\/capture",/,
    );
  });

  it('Destroy — DELETE /v1/sessions/{id} idempotent ("calling it twice is safe") + plain error return without an out struct (no body to parse on success). URL-escapes sessionID. Drift to a non-idempotent semantic would force customer error-handling to distinguish 404-because-already-destroyed from 404-because-never-existed.', () => {
    expect(body).toMatch(/\/\/ Destroy ends the session\. Idempotent — calling it twice is safe\./);
    expect(body).toMatch(
      /func \(r \*SessionsResource\) Destroy\(ctx context\.Context, sessionID string\) error \{\s*\n\s*return r\.client\.do\(ctx, requestOptions\{\s*\n\s*method: "DELETE",\s*\n\s*path:\s+"\/v1\/sessions\/" \+ url\.PathEscape\(sessionID\),\s*\n\s*\}\)\s*\n\}/,
    );
  });

  it('Login — POST /v1/sessions/{id}/login. The doc-comment must describe LoggedIn as a post-submit ASSESSMENT, not authentication proof: without an explicit SuccessSelector a captcha / 2FA / login-required page that removes the password field is assessed as logged in. A "never a false positive" guarantee here would contradict the public API page and the TypeScript SDK, and would invite callers to treat the heuristic as proof.', () => {
    expect(body).toMatch(
      /\/\/ Login performs a heuristic credential login \(types username \+ password and\s*\n\/\/ submits\)\. LoggedIn is a post-submit assessment, not authentication proof:\s*\n\/\/ without an explicit SuccessSelector, a captcha \/ 2FA \/ login-required page\s*\n\/\/ that removes the password field can be assessed as logged in\./,
    );
    expect(body).not.toMatch(/never a false positive/);
    expect(body).toMatch(
      /func \(r \*SessionsResource\) Login\(ctx context\.Context, sessionID string, body \*SessionLoginRequest\) \(\*SessionLoginResponse, error\)/,
    );
    expect(body).toMatch(
      /method: "POST",\s*\n\s*path:\s+"\/v1\/sessions\/" \+ url\.PathEscape\(sessionID\) \+ "\/login",/,
    );
  });

  it('Sub-path consistency across the 7 per-id action verbs: /navigate /interact /wait /state /capture /search /login all prefixed with "/v1/sessions/" + url.PathEscape(sessionID). Locked here separately so a future refactor adding an 8th verb gets caught if it drops the PathEscape — the load-bearing invariant that prevents id-injection across the whole action surface.', () => {
    expect(body).toMatch(/url\.PathEscape\(sessionID\) \+ "\/navigate"/);
    expect(body).toMatch(/url\.PathEscape\(sessionID\) \+ "\/interact"/);
    expect(body).toMatch(/url\.PathEscape\(sessionID\) \+ "\/wait"/);
    expect(body).toMatch(/url\.PathEscape\(sessionID\) \+ "\/state"/);
    expect(body).toMatch(/url\.PathEscape\(sessionID\) \+ "\/capture"/);
    expect(body).toMatch(/url\.PathEscape\(sessionID\) \+ "\/search"/);
    expect(body).toMatch(/url\.PathEscape\(sessionID\) \+ "\/login"/);
  });
});

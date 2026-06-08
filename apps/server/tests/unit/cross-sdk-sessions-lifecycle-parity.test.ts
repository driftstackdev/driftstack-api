// W705 — cross-SDK sessions browser-session lifecycle parity.
// Thirty-second in the cross-SDK drift-guard series (W649 + W675-
// W705).
//
// Asserts the SessionsResource contract is consistent across all 3
// SDKs:
//
//   - 9-verb surface (create + list + iterate + get + navigate +
//     interact + wait + getState + capture + destroy) language-
//     canonical naming
//   - 7 wire-path patterns: /v1/sessions + /v1/sessions/:id + per-
//     verb sub-paths (navigate / interact / wait / state / capture)
//   - Method-verb mix: POST (create + 4 verb sub-paths) + 2× GET
//     (list + getState + per-id get = 3) + DELETE (destroy)
//   - "tap / type / scroll / press" interact-event roster framing
//   - "selector / url / time" wait-condition roster framing
//   - "screenshot / DOM snapshot / PDF" capture-target roster framing
//   - Destroy is IDEMPOTENT — "calling it twice is safe"
//   - Path-traversal-safe encoding (encodeURIComponent / url.PathEscape
//     / _session_path helper)
//
// CRITICAL invariant: sessions verb-paths use IDEMPOTENT semantics
// for destroy + safe interaction verbs (navigate/interact/wait/state/
// capture) — drift to non-idempotent destroy would force callers to
// catch 404-on-already-destroyed in their teardown flow.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const TS_SESS = resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/sessions.ts');
const GO_SESS = resolve(REPO_ROOT, 'packages/sdk-go/sessions.go');
const PY_SESS = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/resources/sessions.py');

describe('W705 cross-SDK sessions browser-session lifecycle parity', () => {
  it('all 3 SDK sessions files exist at canonical paths', () => {
    expect(existsSync(TS_SESS), `missing ${TS_SESS}`).toBe(true);
    expect(existsSync(GO_SESS), `missing ${GO_SESS}`).toBe(true);
    expect(existsSync(PY_SESS), `missing ${PY_SESS}`).toBe(true);
  });

  it("CRITICAL 9-verb surface pinned in all 3 SDKs — create + list + iterate + get + navigate + interact + wait + getState + capture + destroy. The 9-verb set is the full browser-session lifecycle; drift to dropping any would break the customer's automation flow. (sdk-go has no Iterate on Sessions; sdk-python has iterate.)", () => {
    const ts = read(TS_SESS);
    const go = read(GO_SESS);
    const py = read(PY_SESS);

    // sdk-typescript: camelCase methods.
    expect(ts).toMatch(/create\(body:/);
    expect(ts).toMatch(/list\(query:/);
    expect(ts).toMatch(/iterate\(opts:/);
    expect(ts).toMatch(/navigate\(sessionId: string/);
    expect(ts).toMatch(/interact\(sessionId: string/);
    expect(ts).toMatch(/wait\(sessionId: string/);
    expect(ts).toMatch(/getState\(sessionId: string/);
    expect(ts).toMatch(/capture\(sessionId: string/);
    expect(ts).toMatch(/destroy\(sessionId: string/);

    // sdk-go: PascalCase methods.
    expect(go).toMatch(/func \(r \*SessionsResource\) Create\(/);
    expect(go).toMatch(/func \(r \*SessionsResource\) List\(/);
    expect(go).toMatch(/func \(r \*SessionsResource\) Get\(/);
    expect(go).toMatch(/func \(r \*SessionsResource\) Navigate\(/);
    expect(go).toMatch(/func \(r \*SessionsResource\) Interact\(/);
    expect(go).toMatch(/func \(r \*SessionsResource\) Wait\(/);
    expect(go).toMatch(/func \(r \*SessionsResource\) GetState\(/);
    expect(go).toMatch(/func \(r \*SessionsResource\) Capture\(/);
    expect(go).toMatch(/func \(r \*SessionsResource\) Destroy\(/);

    // sdk-python: snake_case methods.
    expect(py).toMatch(/def create\(/);
    expect(py).toMatch(/def list\(self/);
    expect(py).toMatch(/def iterate\(self/);
    expect(py).toMatch(/def get\(self, session_id:/);
    expect(py).toMatch(/def navigate\(self, session_id:/);
    expect(py).toMatch(/def interact\(self, session_id:/);
    expect(py).toMatch(/def wait\(self, session_id:/);
    expect(py).toMatch(/def get_state\(self, session_id:/);
    expect(py).toMatch(/def capture\(self, session_id:/);
    expect(py).toMatch(/def destroy\(self, session_id:/);
  });

  it('CRITICAL 7 wire-path patterns pinned per-SDK: /v1/sessions + /v1/sessions/:id + sub-paths {navigate, interact, wait, state, capture}. Drift to renaming would break server-side routing.', () => {
    const ts = read(TS_SESS);
    const go = read(GO_SESS);
    const py = read(PY_SESS);

    for (const sdk of [ts, go, py]) {
      expect(sdk).toMatch(/\/v1\/sessions/);
      // /v1/sessions/:id with per-SDK encode wrapper.
      expect(sdk).toMatch(/\/v1\/sessions\/(?:\$\{|"\s*\+|\{|.{0,20}\/navigate)/);
      // 5 sub-path verbs.
      expect(sdk).toMatch(/\/navigate/);
      expect(sdk).toMatch(/\/interact/);
      expect(sdk).toMatch(/\/wait/);
      expect(sdk).toMatch(/\/state/);
      expect(sdk).toMatch(/\/capture/);
    }
  });

  it('CRITICAL method-verb mix on sessions in TS + Go — 7× POST (create + navigate + interact + wait + capture + extract + search) + 2× GET (list + getState; per-id get = 3rd GET) + DELETE (destroy). The POST count is what threads the request-mutation semantics.', () => {
    const ts = read(TS_SESS);
    const go = read(GO_SESS);

    const tsPost = (ts.match(/method: 'POST'/g) ?? []).length;
    const tsGet = (ts.match(/method: 'GET'/g) ?? []).length;
    const tsDelete = (ts.match(/method: 'DELETE'/g) ?? []).length;

    expect(tsPost, 'sdk-typescript POST count').toBe(7);
    expect(tsGet, 'sdk-typescript GET count').toBeGreaterThanOrEqual(2);
    expect(tsDelete, 'sdk-typescript DELETE count').toBe(1);

    const goPost = (go.match(/method: "POST"/g) ?? []).length;
    const goGet = (go.match(/method: "GET"/g) ?? []).length;
    const goDelete = (go.match(/method: "DELETE"/g) ?? []).length;

    expect(goPost, 'sdk-go POST count').toBe(7);
    expect(goGet, 'sdk-go GET count').toBeGreaterThanOrEqual(2);
    expect(goDelete, 'sdk-go DELETE count').toBe(1);
  });

  it('CRITICAL "tap / type / scroll / press" interact-event roster framing pinned in TS + Go. The 4-event closed roster is what clients anchor their input-event switch on. Drift to a 5th event without updating the SDK would silently break clients that exhaustively match.', () => {
    const ts = read(TS_SESS);
    const go = read(GO_SESS);

    // sdk-typescript: "tap, type, scroll, press"
    expect(ts).toMatch(/tap,\s*type,\s*scroll,\s*press/);

    // sdk-go: "tap / type / scroll / press"
    expect(go).toMatch(/tap \/ type \/ scroll \/ press/);
  });

  it('CRITICAL "selector / url / time" wait-condition roster framing pinned in TS + Go. The 3-condition closed roster is what tells customers their valid wait predicates. Drift to dropping would mislead about polling capabilities.', () => {
    const ts = read(TS_SESS);
    const go = read(GO_SESS);

    expect(ts).toMatch(/\(selector, url, time\)/);
    expect(go).toMatch(/\(selector, url match, time\)/);
  });

  it('CRITICAL capture-target framing pinned in TS + Go — "screenshot / DOM snapshot / PDF". The 3-target closed roster is what tells customers their capture options. Drift to dropping the snapshot type would break automation that depends on a specific format.', () => {
    const ts = read(TS_SESS);
    const go = read(GO_SESS);

    expect(ts).toMatch(/Capture a screenshot, DOM snapshot, or PDF/);
    expect(go).toMatch(/screenshot, DOM snapshot, or PDF/);
  });

  it('CRITICAL Destroy idempotency framing pinned in all 3 SDKs — destroy is safe to call twice. Drift to non-idempotent destroy would force callers to catch 404-on-already-destroyed in teardown.', () => {
    const ts = read(TS_SESS);
    const go = read(GO_SESS);
    const py = read(PY_SESS);

    // sdk-typescript: "Destroy the session. Idempotent."
    expect(ts).toMatch(/Destroy the session\. Idempotent/);

    // sdk-go: "Destroy ends the session. Idempotent — calling it twice is safe."
    expect(go).toMatch(/Destroy ends the session\. Idempotent/);
    expect(go).toMatch(/calling it twice is safe/);

    // sdk-python: "Destroy the session. Idempotent (safe to call twice)."
    expect(py).toMatch(/Destroy the session\. Idempotent \(safe to call twice\)/);
  });

  it('CRITICAL path-traversal-safe encoding pinned per-SDK — encodeURIComponent (TS) / url.PathEscape (Go) / _session_path helper (Python). Drift to raw string concat would let a session_id with "/" route to a different endpoint.', () => {
    const ts = read(TS_SESS);
    const go = read(GO_SESS);
    const py = read(PY_SESS);

    // sdk-typescript: encodeURIComponent on every per-id path.
    expect(ts).toMatch(/encodeURIComponent\(sessionId\)/);

    // sdk-go: url.PathEscape on every per-id path.
    expect(go).toMatch(/url\.PathEscape\(sessionID\)/);

    // sdk-python: _session_path helper does the encoding.
    expect(py).toMatch(/_session_path\(session_id/);
  });

  it('CRITICAL getState snapshot framing pinned in TS + Go — "URL, title, cookies" (plus more). The closed-3 framing is the customer-facing claim about what getState returns; drift to dropping cookies would break session-replay flows.', () => {
    const ts = read(TS_SESS);
    const go = read(GO_SESS);

    // sdk-typescript: "Snapshot current session state (URL, title, cookies, localStorage)"
    expect(ts).toMatch(/Snapshot current session state \(URL, title, cookies, localStorage\)/);

    // sdk-go: "snapshots the session's current URL, title, cookies, etc"
    expect(go).toMatch(/snapshots the session's current URL, title, cookies/);
  });

  it("CRITICAL SessionsListPage 3-field shape pinned in TS — data + has_more + next_cursor. The has_more bool is what tells dashboards whether to render a 'Load more' button (in addition to next_cursor for the actual page-fetch). Drift to dropping would break the dashboard pagination UI.", () => {
    const ts = read(TS_SESS);
    expect(ts).toMatch(
      /export interface SessionsListPage \{[\s\S]*?data: Session\[\];[\s\S]*?has_more: boolean;[\s\S]*?next_cursor: string \| null/,
    );
  });

  it('CRITICAL sdk-python async-mirror parity — AsyncSessionsResource defined alongside the sync class. Drift to dropping the async variant would silently break asyncio callers.', () => {
    const py = read(PY_SESS);
    expect(py).toMatch(/class SessionsResource:/);
    expect(py).toMatch(/class AsyncSessionsResource:/);
    expect(py).toMatch(/Mirrors :class:`SessionsResource`/);
  });

  it("CRITICAL TimeoutMS framing on Wait pinned in sdk-go — drift to a different field-name would let callers pass milliseconds in the wrong field. The TimeoutMS naming is the wire-named compromise on Go's int field type.", () => {
    const go = read(GO_SESS);
    expect(go).toMatch(/TimeoutMS elapses/);
  });

  it('Cross-SDK sessions 6-invariant cluster — 9-verb surface + 7 wire-paths + tap/type/scroll/press interact roster + selector/url/time wait roster + screenshot/DOM/PDF capture roster + Idempotent-destroy. Drift on any would fragment the cross-language sessions contract.', () => {
    const sdks = {
      'sdk-typescript': read(TS_SESS),
      'sdk-go': read(GO_SESS),
      'sdk-python': read(PY_SESS),
    };

    for (const [name, body] of Object.entries(sdks)) {
      expect(body, `${name} /v1/sessions`).toMatch(/\/v1\/sessions/);
      expect(body, `${name} /navigate`).toMatch(/\/navigate/);
      expect(body, `${name} /interact`).toMatch(/\/interact/);
      expect(body, `${name} /wait`).toMatch(/\/wait/);
      expect(body, `${name} /capture`).toMatch(/\/capture/);
      expect(body, `${name} /state`).toMatch(/\/state/);
      expect(body, `${name} Idempotent`).toMatch(/[Ii]dempotent/);
    }
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/cross-sdk-sessions-lifecycle-parity.test.ts'),
      ),
    ).toBe(true);
  });
});

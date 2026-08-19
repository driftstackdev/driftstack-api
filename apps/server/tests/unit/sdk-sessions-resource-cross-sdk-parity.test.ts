// W822 — cross-SDK SessionsResource methods parity. One-hundred-
// forty-eighth in the drift-guard series. Pins the SessionsResource
// method set across all 3 SDKs. Sessions is the most-used resource
// (every customer interacts with it); drift in method names or
// signatures would break the most-trafficked customer code.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const TS = resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/sessions.ts');
const PY = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/resources/sessions.py');
const GO = resolve(REPO_ROOT, 'packages/sdk-go/sessions.go');

// 8 required method names across all 3 SDKs. Each language uses its
// idiomatic naming convention (TS camelCase, Python snake_case, Go
// PascalCase) but the conceptual method must exist in all 3.
//
// Note: Python + Go expose a `get(sessionId)` method returning the
// full Session; TS deliberately omits it — customers use `getState`
// instead (returns SessionState which includes the underlying
// Session). Pinned separately below.
const REQUIRED_METHODS: Array<[string, string, string]> = [
  ['create', 'create', 'Create'],
  ['list', 'list', 'List'],
  ['navigate', 'navigate', 'Navigate'],
  ['interact', 'interact', 'Interact'],
  ['wait', 'wait', 'Wait'],
  ['getState', 'get_state', 'GetState'],
  ['capture', 'capture', 'Capture'],
  ['destroy', 'destroy', 'Destroy'],
];

describe('W822 cross-SDK SessionsResource methods parity', () => {
  it('all 3 SessionsResource files exist at canonical paths', () => {
    expect(existsSync(TS)).toBe(true);
    expect(existsSync(PY)).toBe(true);
    expect(existsSync(GO)).toBe(true);
  });

  // ─── 9-required-method set ────────────────────────────────────

  it("CRITICAL all 8 shared SessionsResource methods exist in all 3 SDKs — create + list + navigate + interact + wait + getState/get_state + capture + destroy. Drift to dropping any would break the most-trafficked customer code (every customer calls these). The 'get(id) → Session' divergence (Py+Go have it, TS deliberately uses getState) is pinned separately.", () => {
    const ts = read(TS);
    const py = read(PY);
    const go = read(GO);

    for (const [tsName, pyName, goName] of REQUIRED_METHODS) {
      // TS uses camelCase methods.
      expect(ts, `TS missing '${tsName}('`).toMatch(new RegExp(`\\b${tsName}\\s*\\(`));
      // Python uses snake_case `def name(` or `async def name(`.
      expect(py, `Python missing 'def ${pyName}('`).toMatch(new RegExp(`def ${pyName}\\(`));
      // Go uses PascalCase method receiver pattern.
      expect(go, `Go missing 'func (r *SessionsResource) ${goName}('`).toMatch(
        new RegExp(`func \\(r \\*SessionsResource\\) ${goName}\\(`),
      );
    }
  });

  // ─── Documented get(id) divergence ────────────────────────────

  it('CRITICAL get(sessionId) parity pinned — 2026-05-20 cross-SDK audit closed the prior TS-omission divergence; TS now mirrors Python + Go. All 3 SDKs expose `get` returning the full Session. Drift to re-omitting from any SDK would silently break customer expectations across the tier.', () => {
    expect(read(PY)).toMatch(/def get\(self, session_id: str\) -> Session:/);
    expect(read(GO)).toMatch(
      /func \(r \*SessionsResource\) Get\(ctx context\.Context, sessionID string\) \(\*Session, error\)/,
    );
    // TS now ALSO exposes get(sessionId) — parity closed.
    expect(read(TS)).toMatch(/^\s+get\(sessionId: string\):/m);
  });

  // ─── Python sync + async dual ─────────────────────────────────

  it('CRITICAL Python provides BOTH SessionsResource (sync) AND AsyncSessionsResource (async) — every sync method has an async counterpart. Drift to dropping the async tree would break AsyncDriftstack customers.', () => {
    const p = read(PY);
    // V-921: this filter listed the same eight names as REQUIRED_METHODS, so it
    // was always true and every method was checked — but only by coincidence.
    // Its comment describes excluding sync-only helpers like `iterate`, which is
    // not in REQUIRED_METHODS at all, so adding a genuinely sync-only method
    // here would have silently skipped it rather than flagging the mismatch.
    // The set is now derived, and the count is asserted so a rename is loud.
    const DUAL = new Set(REQUIRED_METHODS.map(([, pyName]) => pyName));
    let checked = 0;
    for (const [, pyName] of REQUIRED_METHODS) {
      if (!DUAL.has(pyName)) continue;
      checked += 1;
      expect(p, `Python AsyncSessionsResource missing 'async def ${pyName}'`).toMatch(
        new RegExp(`async def ${pyName}\\(`),
      );
    }
    expect(checked, 'every required method was checked for an async counterpart').toBe(
      REQUIRED_METHODS.length,
    );
  });

  // ─── iterate() helper exists ──────────────────────────────────

  it('CRITICAL all 3 SDKs expose an iterate() helper for cursor-walking. TS: returns AsyncGenerator<Session>. Python: dual sync Iterator[Session] + async AsyncIterator[Session]. Go: function-callback pattern (no generators pre-1.23). Matches W798 + W818 pagination cross-SDK parity.', () => {
    expect(read(TS)).toMatch(
      /iterate\(opts: \{ limit\?: number \} = \{\}\): AsyncGenerator<Session, void, void>/,
    );
    expect(read(PY)).toMatch(
      /def iterate\(self, \*, limit: int \| None = None\) -> Iterator\[Session\]:/,
    );
    expect(read(PY)).toMatch(
      /def iterate\(self, \*, limit: int \| None = None\) -> AsyncIterator\[Session\]:/,
    );
  });

  // ─── Go ctx-as-first-arg convention ───────────────────────────

  it("CRITICAL Go SessionsResource methods follow ctx-as-first-arg convention. Every method takes ctx context.Context as first param. Drift to omitting ctx would break the W797 + W796 cross-SDK 'Go context-aware throughout' contract.", () => {
    const p = read(GO);
    for (const [, , goName] of REQUIRED_METHODS) {
      expect(p, `Go ${goName} must take ctx context.Context as first arg`).toMatch(
        new RegExp(`func \\(r \\*SessionsResource\\) ${goName}\\(ctx context\\.Context`),
      );
    }
  });

  // ─── Go returns (T, error) pattern ────────────────────────────

  it('CRITICAL Go SessionsResource methods follow (T, error) return convention. Drift to a panic-based or single-return style would break W797 errors.As + W815 retry-policy integration.', () => {
    const p = read(GO);
    expect(p).toMatch(
      /func \(r \*SessionsResource\) Create\(ctx context\.Context, body \*CreateSessionRequest\) \(\*Session, error\)/,
    );
    expect(p).toMatch(
      /func \(r \*SessionsResource\) Get\(ctx context\.Context, sessionID string\) \(\*Session, error\)/,
    );
    expect(p).toMatch(
      /func \(r \*SessionsResource\) Destroy\(ctx context\.Context, sessionID string\) error/,
    );
  });

  // ─── Python type hints with union types ───────────────────────

  it("CRITICAL Python SessionsResource methods accept 'NavigateRequest | dict[str, Any]' duck-typed body parameter. The dict-fallback lets customers either build a typed request or pass a raw dict — matching the Python SDK's pragmatic 'we accept both' design.", () => {
    expect(read(PY)).toMatch(
      /def navigate\(self, session_id: str, body: NavigateRequest \| dict\[str, Any\]\) -> NavigateResponse:/,
    );
    expect(read(PY)).toMatch(
      /def interact\(self, session_id: str, body: InteractRequest \| dict\[str, Any\]\) -> InteractResponse:/,
    );
    expect(read(PY)).toMatch(
      /def wait\(self, session_id: str, body: WaitRequest \| dict\[str, Any\]\) -> WaitResponse:/,
    );
    expect(read(PY)).toMatch(
      /def capture\(self, session_id: str, body: CaptureRequest \| dict\[str, Any\]\) -> CaptureResponse:/,
    );
  });

  // ─── destroy returns void ────────────────────────────────────

  it("CRITICAL destroy() returns void/None/error-only cross-SDK — no return value when successful (HTTP 204 No Content per the API). TS: Promise<void>. Python: -> None. Go: error (no T return). Drift to returning Session or {ok: true} would break customer code that doesn't check the result.", () => {
    expect(read(TS)).toMatch(/destroy\(sessionId: string\): Promise<void>/);
    expect(read(PY)).toMatch(/def destroy\(self, session_id: str\) -> None:/);
    expect(read(GO)).toMatch(
      /func \(r \*SessionsResource\) Destroy\(ctx context\.Context, sessionID string\) error/,
    );
  });

  // ─── create() takes optional CreateSessionRequest ─────────────

  it('CRITICAL create() accepts an optional CreateSessionRequest body cross-SDK. TS: `create(body?: CreateSessionRequestInput)`. Python: typed kwargs or `dict | None`. Go: `*CreateSessionRequest` (nil OK). Drift to making body required would break W796 cross-SDK quickstart (which calls sessions.create with label-only or nil).', () => {
    expect(read(TS)).toMatch(/create\(/);
    expect(read(PY)).toMatch(/def create\(/);
    expect(read(GO)).toMatch(/Create\(ctx context\.Context, body \*CreateSessionRequest\)/);
  });

  // ─── Python __init__ constructor takes http client ────────────

  it('CRITICAL Python SessionsResource + AsyncSessionsResource constructors take http client (HttpClient or AsyncHttpClient). Drift would break the W819 client → resource wiring pattern.', () => {
    const p = read(PY);
    expect(p).toMatch(/def __init__\(self, http: HttpClient\) -> None:/);
    expect(p).toMatch(/def __init__\(self, http: AsyncHttpClient\) -> None:/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/sdk-sessions-resource-cross-sdk-parity.test.ts'),
      ),
    ).toBe(true);
  });
});

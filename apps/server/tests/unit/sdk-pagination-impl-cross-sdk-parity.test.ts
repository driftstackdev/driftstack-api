// W818 — cross-SDK pagination implementation parity. One-hundred-
// forty-fourth in the drift-guard series. Pins TS V-118 + Python
// V-126 iterator helpers (Go has no helper — manual cursor loop per
// W798 since Go pre-1.23 lacks generators). Drift would let one SDK
// silently mis-handle cursor handoff (double-fetch on first page,
// missed-break on null cursor, etc).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const TS = resolve(REPO_ROOT, 'packages/sdk-typescript/src/pagination.ts');
const PY = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/pagination.py');

describe('W818 cross-SDK pagination implementation parity', () => {
  it('both pagination helpers exist at canonical paths', () => {
    expect(existsSync(TS)).toBe(true);
    expect(existsSync(PY)).toBe(true);
  });

  // ─── V-anchor framing ─────────────────────────────────────────

  it('CRITICAL TS keeps its internal V-118 provenance anchor in a `//` comment (stripped from the published `dist`), while the Python module docstring — which ships inside the wheel and surfaces in `help()` — must stay free of internal rollout markers per `3b9b8731b`.', () => {
    expect(read(TS)).toMatch(/\/\/ V-118: cursor-pagination async-iterator helper\./);
    const pyDocstring = /^""".*?"""/s.exec(read(PY))?.[0] ?? '';
    expect(pyDocstring).not.toBe('');
    expect(pyDocstring).toMatch(/^"""Cursor-pagination iterator helpers\./);
    expect(pyDocstring).not.toMatch(/\bV-\d+|\bW\d{3,}/);
  });

  // ─── Envelope shape: { data, next_cursor } ────────────────────

  it('CRITICAL both helpers document the canonical envelope shape — { data: T[], next_cursor: string | null }. Drift to a different envelope (e.g. {items, cursor}) would break every list endpoint simultaneously.', () => {
    expect(read(TS)).toMatch(
      /Every Driftstack list endpoint returns the same envelope shape:\s*\n\/\/\s+\{ data: T\[\], next_cursor: string \| null \}/,
    );
    expect(read(PY)).toMatch(
      /Driftstack list endpoints return\s*\n``\{ data: \[\.\.\.\], next_cursor: str \| None \}``\./,
    );
  });

  // ─── CursorPage<T> interface (TS) ─────────────────────────────

  it('CRITICAL TS CursorPage<T> interface pinned — data: readonly T[] + next_cursor: string | null. The readonly modifier on data prevents consumer mutation; drift to writable would let buggy consumer code corrupt the page.', () => {
    const p = read(TS);
    expect(p).toMatch(/export interface CursorPage<T> \{/);
    expect(p).toMatch(/data: readonly T\[\];/);
    expect(p).toMatch(/next_cursor: string \| null;/);
  });

  // ─── iteratePaginated generator shape ─────────────────────────

  it("CRITICAL TS iteratePaginated signature pinned — `async function* iteratePaginated<T>(fetchPage: (cursor: string | null) => Promise<CursorPage<T>>): AsyncGenerator<T, void, void>`. Drift to a different fetchPage signature would break every resource's .iterate() wiring.", () => {
    const p = read(TS);
    expect(p).toMatch(
      /export async function\* iteratePaginated<T>\(\s*\n\s+fetchPage: \(cursor: string \| null\) => Promise<CursorPage<T>>,\s*\n\): AsyncGenerator<T, void, void>/,
    );
  });

  // ─── First-page call with null cursor ─────────────────────────

  it("CRITICAL TS first-page call pattern pinned — `let cursor: string | null = null; while (true) { ... }`. The null-first + loop-with-break-on-null pattern is the canonical 'pre-V-118 hand-rolled bug class' the helper exists to abstract away.", () => {
    const p = read(TS);
    expect(p).toMatch(/let cursor: string \| null = null;/);
    expect(p).toMatch(/while \(true\) \{/);
  });

  // ─── Bug-class motivation framing ─────────────────────────────

  it("CRITICAL TS bug-class motivation framing pinned. The 'Hand-rolled while-loops over next_cursor are easy to write but easy to bug-on (off-by-one cursor handoff, forgetting to break on null, double-fetch on first page)' wording is the load-bearing 'why this helper exists' anchor.", () => {
    expect(read(TS)).toMatch(
      /Hand-rolled while-loops over `next_cursor` are easy to write but easy\s*\n\/\/ to bug-on \(off-by-one cursor handoff, forgetting to break on null,\s*\n\/\/ double-fetch on first page\)\./,
    );
    expect(read(PY)).toMatch(
      /Hand-\s*\nrolled while-loops over ``next_cursor`` are easy to bug on \(cursor\s*\nhandoff, forgetting to break on null\)/,
    );
  });

  // ─── Python sync + async dual ─────────────────────────────────

  it("CRITICAL Python pagination provides BOTH sync + async iterators. The 'sync version returns a regular generator; async version returns an async generator' framing matches the Python SDK's Driftstack + AsyncDriftstack dual-client design (W814).", () => {
    expect(read(PY)).toMatch(
      /sync version returns a regular generator; async version returns an\s*\nasync generator\./,
    );
  });

  it('CRITICAL Python pagination imports AsyncIterator + Iterator + Callable + Awaitable from collections.abc. The 4-type-import set is what makes the dual sync/async helper signatures typeable.', () => {
    expect(read(PY)).toMatch(
      /from collections\.abc import AsyncIterator, Awaitable, Callable, Iterator/,
    );
  });

  // ─── Python duck-typing framing ───────────────────────────────

  it("CRITICAL Python pagination duck-types the page object — 'any pydantic BaseModel with .data / .next_cursor attributes works, as does a raw dict with the same keys'. The duck-typing lets untyped ProfilesResource (raw dict) coexist with typed resources without forking the helper.", () => {
    expect(read(PY)).toMatch(
      /The helpers duck-type the page object — any pydantic ``BaseModel`` with\s*\n``\.data`` \/ ``\.next_cursor`` attributes works, as does a raw ``dict``/,
    );
    // Same guarantee, stated without naming an internal resource: raw-dict
    // pages stay forward-compatible with new response fields.
    expect(read(PY)).toMatch(
      /Resources that return raw dictionaries intentionally\s*\nretain forward compatibility with additional response fields\./,
    );
  });

  it('CRITICAL Python _extract_data + _extract_next_cursor private helpers pinned. The dict-fallback-after-attribute-check pattern (isinstance dict → .get; else → attribute) is the load-bearing duck-typing implementation.', () => {
    const p = read(PY);
    expect(p).toMatch(
      /def _extract_data\(page: Any\) -> list\[Any\]:\s*\n\s+if isinstance\(page, dict\):\s*\n\s+return list\(page\.get\("data", \[\]\)\)\s*\n\s+return list\(page\.data\)/,
    );
    expect(p).toMatch(
      /def _extract_next_cursor\(page: Any\) -> str \| None:\s*\n\s+if isinstance\(page, dict\):\s*\n\s+return page\.get\("next_cursor"\)/,
    );
  });

  // ─── Resource.iterate() integration ───────────────────────────

  it("CRITICAL TS docstring documents that resources expose a thin `.iterate(opts)` method that calls `iteratePaginated` with the resource's own `list` as `fetchPage`. This pattern is what makes `client.sessions.iterate()` work at the consumer site (W796 quickstart).", () => {
    expect(read(TS)).toMatch(
      /Resources expose a thin `\.iterate\(opts\)` method that calls\s*\n\/\/ `iteratePaginated` with the resource's own `list` as `fetchPage`\./,
    );
  });

  // ─── Python usage example ─────────────────────────────────────

  it('CRITICAL Python pagination docstring includes copy-pasteable usage example — both sync `for session in client.sessions.iterate(limit=50)` and async `async for session in aclient.sessions.iterate(limit=50)`. Matches W798 cross-SDK pagination example.', () => {
    const p = read(PY);
    expect(p).toMatch(/for session in client\.sessions\.iterate\(limit=50\):/);
    expect(p).toMatch(/async for session in aclient\.sessions\.iterate\(limit=50\):/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/sdk-pagination-impl-cross-sdk-parity.test.ts'),
      ),
    ).toBe(true);
  });
});

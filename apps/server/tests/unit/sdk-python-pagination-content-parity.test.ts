// W586.B — drift guard for packages/sdk-python/src/driftstack/pagination.py.
// V-126 cursor-pagination iterator helpers. Drift here either flips
// the duck-typing across pydantic BaseModel + raw dict pages, or
// breaks the break-on-None-next_cursor invariant.
//
//   • V-126 Python parity with TS SDK V-118/V-119.
//   • Envelope contract: { data: [...], next_cursor: str | None }.
//   • _extract_data + _extract_next_cursor duck-type page object:
//     dict → .get(), pydantic BaseModel → attribute access.
//   • iterate_paginated (sync Iterator) + aiterate_paginated (async).
//   • Stops on next_cursor=None; errors propagate.
//   • __all__ public surface: iterate_paginated, aiterate_paginated.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/pagination.py');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W586.B packages/sdk-python/src/driftstack/pagination.py content parity', () => {
  const body = read(LIB);

  it('Module docstring + envelope { data, next_cursor } + duck-typing pydantic-or-dict + forward-compatible raw dictionaries + usage example sync+async pinned', () => {
    expect(body).toMatch(/^"""Cursor-pagination iterator helpers\.\n/);
    expect(body).toMatch(/Driftstack list endpoints return/);
    expect(body).toMatch(/``\{ data: \[\.\.\.\], next_cursor: str \| None \}``\. Hand-/);
    expect(body).toMatch(/rolled while-loops over ``next_cursor`` are easy to bug on \(cursor/);
    expect(body).toMatch(
      /handoff, forgetting to break on null\)\. These helpers wrap the pattern:/,
    );
    expect(body).toMatch(/sync version returns a regular generator; async version returns an/);
    expect(body).toMatch(/async generator\./);
    expect(body).toMatch(/The helpers duck-type the page object — any pydantic ``BaseModel`` with/);
    expect(body).toMatch(
      /``\.data`` \/ ``\.next_cursor`` attributes works, as does a raw ``dict``/,
    );
    expect(body).toMatch(
      /with the same keys\. Resources that return raw dictionaries intentionally/,
    );
    expect(body).toMatch(/retain forward compatibility with additional response fields\./);
    expect(body).not.toMatch(/pending a future codegen pass/);
    expect(body).toMatch(/for session in client\.sessions\.iterate\(limit=50\):/);
    expect(body).toMatch(/async for session in aclient\.sessions\.iterate\(limit=50\):/);
  });

  it('Duck-typing helpers: _extract_data dict→.get("data",[]) + BaseModel→.data; _extract_next_cursor dict→.get("next_cursor") + BaseModel→.next_cursor (no-any-return type-ignore)', () => {
    expect(body).toMatch(
      /^def _extract_data\(page: Any\) -> list\[Any\]:\s*\n\s*if isinstance\(page, dict\):\s*\n\s*return list\(page\.get\("data", \[\]\)\)\s*\n\s*return list\(page\.data\)/m,
    );
    expect(body).toMatch(
      /^def _extract_next_cursor\(page: Any\) -> str \| None:\s*\n\s*if isinstance\(page, dict\):\s*\n\s*return page\.get\("next_cursor"\)\s*\n\s*return page\.next_cursor {2}# type: ignore\[no-any-return\]/m,
    );
  });

  it('iterate_paginated sync: while True loop + fetch_page(None) first + yield from _extract_data + break on _extract_next_cursor None + threads cursor to next call', () => {
    expect(body).toMatch(
      /^def iterate_paginated\(\s*\n\s*fetch_page: Callable\[\[str \| None\], Any\],\s*\n\) -> Iterator\[T\]:/m,
    );
    expect(body).toMatch(/"""Walk every page of a cursor-paginated list endpoint\./);
    expect(body).toMatch(/``fetch_page\(None\)`` is called for the first page; subsequent calls/);
    expect(body).toMatch(/pass the previous page's ``next_cursor``\. Stops as soon as/);
    expect(body).toMatch(/``next_cursor`` is None\. Errors from ``fetch_page`` propagate\./);
    // An empty cursor also ends the walk — see the sdk-typescript sibling for
    // why treating it as a cursor loops forever. Both walkers carry it.
    expect(
      (body.match(/next_cursor is None or next_cursor == ""/g) ?? []).length,
      'the sync and async walkers must not drift apart on the empty-cursor stop',
    ).toBe(2);
    expect(body).toMatch(/Page object can be a pydantic ``BaseModel`` \(attributes\) or a raw/);
    expect(body).toMatch(/``dict`` \(keys\); both are duck-typed\./);
    expect(body).toMatch(
      /cursor: str \| None = None\s*\n\s*while True:\s*\n\s*page = fetch_page\(cursor\)\s*\n\s*yield from _extract_data\(page\)\s*\n\s*next_cursor = _extract_next_cursor\(page\)\s*\n[\s\S]{0,500}?if next_cursor is None or next_cursor == "":\s*\n\s*return/,
    );
    // Non-advance guard then advance (a repeated cursor would otherwise hang).
    expect(body).toMatch(
      /if next_cursor == cursor:\s*\n\s*raise TransportError\(_CURSOR_STALL_MSG, status=0\)\s*\n\s*cursor = next_cursor/,
    );
  });

  it('aiterate_paginated async: same surface; awaits fetch_page + per-item yield (cannot yield from in async generator) + same break invariant', () => {
    expect(body).toMatch(
      /^async def aiterate_paginated\(\s*\n\s*fetch_page: Callable\[\[str \| None\], Awaitable\[Any\]\],\s*\n\) -> AsyncIterator\[T\]:\s*\n\s*"""Async variant of :func:`iterate_paginated`\. Same semantics\."""/m,
    );
    expect(body).toMatch(
      /cursor: str \| None = None\s*\n\s*while True:\s*\n\s*page = await fetch_page\(cursor\)\s*\n\s*for item in _extract_data\(page\):\s*\n\s*yield item\s*\n\s*next_cursor = _extract_next_cursor\(page\)\s*\n[\s\S]{0,500}?if next_cursor is None or next_cursor == "":\s*\n\s*return/,
    );
    // Async path has the same non-advance guard before the cursor advance.
    expect(body).toMatch(
      /if next_cursor == cursor:\s*\n\s*raise TransportError\(_CURSOR_STALL_MSG, status=0\)\s*\n\s*cursor = next_cursor/,
    );
  });

  it('__all__ public surface: iterate_paginated + aiterate_paginated', () => {
    expect(body).toMatch(/^__all__ = \["iterate_paginated", "aiterate_paginated"\]$/m);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});

// W587.D — drift guard for packages/sdk-python/src/driftstack/_version.py.
// Single source-of-truth for the SDK package version. Drift here is
// almost always intentional (publishing a new version), but a parity
// guard catches accidental edits + keeps the docstring rationale
// (small module → __init__ can import without pulling httpx/pydantic)
// from drifting away from its purpose.
//
//   • Module is intentionally tiny (no other imports beyond
//     __future__).
//   • __version__ = "0.1.5" — bump in lockstep with package.json /
//     pyproject.toml when releasing.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/_version.py');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W587.D packages/sdk-python/src/driftstack/_version.py content parity', () => {
  const body = read(LIB);

  it('Module docstring + small-module-no-heavy-deps + scrape-without-install rationale pinned', () => {
    expect(body).toMatch(/^"""Single source of truth for the SDK's package version\.\n/);
    expect(body).toMatch(/Kept in a tiny module so `__init__\.py` can import it without pulling/);
    expect(body).toMatch(/in the full dependency graph \(httpx, pydantic\) before the version is/);
    expect(body).toMatch(/needed — useful for tools that scrape the version without installing\./);
  });

  it('__version__ = "0.1.5" pinned (drift here = unintentional version bump; expected to change only via lockstep release)', () => {
    expect(body).toMatch(/^from __future__ import annotations$/m);
    expect(body).toMatch(/^__version__ = "0\.1\.5"$/m);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});

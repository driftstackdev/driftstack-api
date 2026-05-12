// W332.A — drift guard for /sdk/python-quickstart. Pins:
//   • dist name driftstack-sdk + canonical install commands (pip / uv / poetry)
//   • import name `driftstack` (Driftstack + AsyncDriftstack)
//   • DRIFTSTACK_API_KEY env var
//   • Real pyproject.toml carries the same name + import

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/sdk/python-quickstart.md');
const PY_TOML = resolve(REPO_ROOT, 'packages/sdk-python/pyproject.toml');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W332.A /sdk/python-quickstart baseline', () => {
  const body = read(PAGE);
  const toml = read(PY_TOML);

  it('pyproject.toml carries the canonical driftstack-sdk dist name', () => {
    expect(toml).toMatch(/name\s*=\s*['"]driftstack-sdk['"]/);
  });

  it('page documents the canonical install commands (pip / uv / poetry)', () => {
    expect(body).toMatch(/pip install driftstack-sdk/);
    expect(body).toMatch(/uv add driftstack-sdk/);
    expect(body).toMatch(/poetry add driftstack-sdk/);
  });

  it('imports both sync (Driftstack) and async (AsyncDriftstack) clients', () => {
    expect(body).toMatch(/from driftstack import Driftstack/);
    expect(body).toMatch(/from driftstack import AsyncDriftstack/);
  });

  it('cites DRIFTSTACK_API_KEY env var', () => {
    expect(body).toContain('DRIFTSTACK_API_KEY');
  });

  it('shows the with-block context-manager pattern for pool cleanup', () => {
    expect(body).toMatch(/with Driftstack\([^)]+\) as client/);
  });
});

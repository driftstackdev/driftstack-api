// W307.C — drift guard for /sdk/installation page version pins.
// The page documents minimum runtime versions for TS, Python, and Go.
// Each must match the canonical pin:
//   • TS  → engines.node in packages/sdk-typescript/package.json
//   • Py  → requires-python in packages/sdk-python/pyproject.toml
//   • Go  → go directive in packages/sdk-go/go.mod
// The installation page is the user's primary install-time touchpoint,
// so version drift here is high-blast-radius.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/sdk/installation.md');
const TS_PKG = resolve(REPO_ROOT, 'packages/sdk-typescript/package.json');
const PY_TOML = resolve(REPO_ROOT, 'packages/sdk-python/pyproject.toml');
const GO_MOD = resolve(REPO_ROOT, 'packages/sdk-go/go.mod');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W307.C /sdk/installation ↔ SDK pin parity', () => {
  const page = read(PAGE);

  it('TypeScript: page Node floor matches sdk-typescript engines.node', () => {
    const pkg = JSON.parse(read(TS_PKG)) as { engines?: { node?: string } };
    const ge = pkg.engines?.node?.match(/(\d+)/)?.[1];
    expect(ge).toBeDefined();
    // Page promises Node.js ≥ <floor> or "Node.js <floor>+"
    const re = new RegExp(`Node\\.js\\s*(?:≥|>=|)\\s*${ge}\\+?`);
    expect(page).toMatch(re);
  });

  it('Python: page Python floor matches sdk-python requires-python', () => {
    const toml = read(PY_TOML);
    const m = toml.match(/requires-python\s*=\s*['"]>=\s*(\d+\.\d+)['"]/);
    expect(m).not.toBeNull();
    const floor = m![1]!;
    const re = new RegExp(`Python\\s*${floor.replace(/\./g, '\\.')}\\+?`);
    expect(page).toMatch(re);
  });

  it('Go: page Go floor matches sdk-go go.mod directive', () => {
    const mod = read(GO_MOD);
    const m = mod.match(/^go\s+(\d+\.\d+)/m);
    expect(m).not.toBeNull();
    const floor = m![1]!;
    const re = new RegExp(`Go\\s*${floor.replace(/\./g, '\\.')}\\+?`);
    expect(page).toMatch(re);
  });

  it('page documents the canonical TS package name @driftstack/sdk', () => {
    expect(page).toContain('@driftstack/sdk');
  });

  it('page documents the canonical Python dist name driftstack-sdk', () => {
    expect(page).toContain('driftstack-sdk');
  });

  it('page documents the canonical Go module path', () => {
    expect(page).toContain('github.com/driftstackdev/driftstack-api/packages/sdk-go');
  });
});

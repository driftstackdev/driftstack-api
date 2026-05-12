// W300.A — drift guard for SDK package metadata. The TS SDK
// package.json must export the canonical name, declare Node 18+,
// and ship .d.ts types. The Python package must require Python
// 3.10+. Catches drift where a refactor accidentally narrows
// engine support or drops type declarations.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const TS_PKG = resolve(REPO_ROOT, 'packages/sdk-typescript/package.json');
const PY_PYP = resolve(REPO_ROOT, 'packages/sdk-python/pyproject.toml');
const GO_MOD = resolve(REPO_ROOT, 'packages/sdk-go/go.mod');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W300.A SDK package metadata baseline', () => {
  it('TS package.json declares @driftstack/sdk', () => {
    const pkg = JSON.parse(read(TS_PKG));
    expect(pkg.name).toBe('@driftstack/sdk');
  });

  it('TS package.json requires Node >= 18', () => {
    const pkg = JSON.parse(read(TS_PKG));
    expect(pkg.engines?.node).toMatch(/>=\s*18|\^18|\^?\s*18(?:\.|\s|$)|>=\s*1[8-9]|>=\s*20/);
  });

  it('TS package.json publishes types', () => {
    const pkg = JSON.parse(read(TS_PKG));
    expect(pkg.types || pkg.exports?.['.']?.types).toBeTruthy();
  });

  it('Python pyproject.toml declares driftstack-sdk', () => {
    const body = read(PY_PYP);
    expect(body).toMatch(/^name\s*=\s*["']driftstack-sdk["']/m);
  });

  it('Python pyproject.toml requires Python >= 3.10', () => {
    const body = read(PY_PYP);
    expect(body).toMatch(/requires-python\s*=\s*["']>=\s*3\.10["']/);
  });

  it('Go module declares the canonical path', () => {
    const body = read(GO_MOD);
    expect(body).toMatch(/^module github\.com\/driftstackdev\/driftstack-api\/packages\/sdk-go$/m);
  });

  it('Go module requires Go >= 1.22', () => {
    const body = read(GO_MOD);
    expect(body).toMatch(/^go 1\.(?:2[2-9]|[3-9]\d)/m);
  });
});

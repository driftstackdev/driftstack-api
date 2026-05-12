// W286.A — drift guard for SDK READMEs. Each package's README must
// cite the canonical install command. Catches drift where a README
// is regenerated with a fictional package name.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W286.A SDK README install-command parity', () => {
  it('TS README cites npm install @driftstack/sdk', () => {
    const body = read(resolve(REPO_ROOT, 'packages/sdk-typescript/README.md'));
    expect(body).toMatch(/npm install @driftstack\/sdk\b/);
  });

  it('Python README cites pip install driftstack-sdk', () => {
    const body = read(resolve(REPO_ROOT, 'packages/sdk-python/README.md'));
    expect(body).toMatch(/pip install driftstack-sdk\b/);
  });

  it('Go README cites the canonical module path', () => {
    const body = read(resolve(REPO_ROOT, 'packages/sdk-go/README.md'));
    expect(body).toMatch(/go get github\.com\/driftstackdev\/driftstack-api\/packages\/sdk-go/);
  });
});

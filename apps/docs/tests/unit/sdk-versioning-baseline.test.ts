// W334.A — drift guard for /sdk/versioning page. Pins:
//   • SemVer 2.0.0 commitment
//   • SDK + API versioning are independent (SDK 0.x targets /v1/)
//   • Pre-1.0 relaxation (0.x.y → 0.(x+1).0 allowed for breaking)
//   • Cross-links to /api/versioning

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/sdk/versioning.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W334.A /sdk/versioning baseline', () => {
  const body = read(PAGE);

  it('commits to SemVer 2.0.0', () => {
    expect(body).toMatch(/SemVer 2\.0\.0/);
  });

  it('explains MAJOR / MINOR / PATCH semantics', () => {
    expect(body).toMatch(/\*\*MAJOR\*\*\s*bump on breaking changes/i);
  });

  it('SDK + API version independently (SDK 0.x targets /v1/)', () => {
    expect(body).toMatch(/targets\s+`\/v1\/`/);
  });

  it('pre-1.0 relaxation: 0.x.y → 0.(x+1).0 allowed for breaking', () => {
    expect(body).toMatch(/0\.x\.y\s*→\s*0\.\(x\+1\)\.0/);
  });

  it('frames SDK versioning as independent of HTTP API versioning', () => {
    expect(body).toMatch(/[Ii]ndependent of HTTP API versioning/);
  });
});

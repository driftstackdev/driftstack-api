// W333.A — drift guard for /sdk/go-quickstart. Pins:
//   • module path github.com/driftstackdev/driftstack-api/packages/sdk-go
//   • go get install command
//   • driftstack.New(...) constructor + Sessions.Create/Destroy/Navigate/Capture
//   • DRIFTSTACK_API_KEY env var
//   • Real go.mod carries the same module path

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/sdk/go-quickstart.md');
const GO_MOD = resolve(REPO_ROOT, 'packages/sdk-go/go.mod');

const CANON_MODULE = 'github.com/driftstackdev/driftstack-api/packages/sdk-go';

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W333.A /sdk/go-quickstart baseline', () => {
  const body = read(PAGE);
  const mod = read(GO_MOD);

  it('go.mod declares the canonical module path', () => {
    expect(mod).toMatch(new RegExp(`module\\s+${CANON_MODULE.replace(/\./g, '\\.')}`));
  });

  it('page documents go get with the canonical module path', () => {
    expect(body).toMatch(new RegExp(`go get\\s+${CANON_MODULE.replace(/\./g, '\\.')}`));
  });

  it('page imports driftstack with the canonical module path', () => {
    expect(body).toContain(`driftstack "${CANON_MODULE}"`);
  });

  it('cites DRIFTSTACK_API_KEY env var (canonical)', () => {
    expect(body).toContain('DRIFTSTACK_API_KEY');
  });

  it('shows driftstack.New + Sessions.Create / .Destroy / .Navigate lifecycle', () => {
    expect(body).toMatch(/driftstack\.New/);
    expect(body).toMatch(/client\.Sessions\.Create/);
    expect(body).toMatch(/client\.Sessions\.Destroy/);
    expect(body).toMatch(/client\.Sessions\.Navigate/);
  });

  it('does NOT reference a fictional github.com/driftstack/driftstack-go path', () => {
    expect(body).not.toMatch(/github\.com\/driftstack\/driftstack-go\b/);
  });
});

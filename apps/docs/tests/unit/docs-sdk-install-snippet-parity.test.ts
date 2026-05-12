// W295.C — drift guard for docs SDK install snippets. Every
// install command in apps/docs/src/pages/sdk/installation.md must
// match the canonical package handle for its language. Catches
// drift where the install doc invents an alternative package name.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const INSTALL = resolve(REPO_ROOT, 'apps/docs/src/pages/sdk/installation.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W295.C docs SDK install-snippet parity', () => {
  const body = read(INSTALL);

  it('TypeScript install uses @driftstack/sdk (npm/pnpm/yarn/bun any of them)', () => {
    expect(body).toMatch(/(?:npm|pnpm|yarn|bun) (?:install|add) (?:[^@\s]+\s+)?@driftstack\/sdk\b/);
  });

  it('Python install uses driftstack-sdk', () => {
    expect(body).toMatch(/pip install driftstack-sdk\b/);
  });

  it('Go install uses the canonical module path', () => {
    expect(body).toMatch(/go get github\.com\/driftstackdev\/driftstack-api\/packages\/sdk-go/);
  });
});

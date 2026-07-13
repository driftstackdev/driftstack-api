// W305.A — drift guard for /docs/cli-quickstart endpoint citations.
// The page documents the CLI auth flow: initiate → bind (dashboard)
// → exchange. Every cited /v1/auth/cli-authorize/* endpoint must
// match a live registration in auth-cli.ts.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/cli-quickstart.astro');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/auth-cli.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W305.A /docs/cli-quickstart ↔ auth-cli route parity', () => {
  const page = read(PAGE);
  const route = read(ROUTE);

  // CLI-side endpoints (initiate + exchange). The bind endpoint is
  // hit from the dashboard /cli/authorize page, not by the CLI, so
  // the quickstart doesn't cite it directly.
  const CLI_REQUIRED = ['/v1/auth/cli-authorize/initiate', '/v1/auth/cli-authorize/exchange'];

  for (const path of CLI_REQUIRED) {
    it(`page cites ${path}`, () => {
      expect(page).toContain(path);
    });

    it(`server registers ${path}`, () => {
      expect(route).toContain(`'${path}'`);
    });
  }

  it('server still registers the bind endpoint for the dashboard /cli/authorize flow', () => {
    expect(route).toContain(`'/v1/auth/cli-authorize/bind-device-code'`);
  });

  it('page references the DRIFTSTACK_API_KEY env var (canonical CI env-var name)', () => {
    expect(page).toMatch(/DRIFTSTACK_API_KEY/);
  });
});

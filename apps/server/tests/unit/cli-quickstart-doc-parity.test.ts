// W223.A — drift-guard between /docs/cli-quickstart and the CLI
// authorize routes registered under /v1/auth/cli-authorize/*. The
// previous revision claimed paths under /v1/cli/authorize/* which
// don't exist; users following the doc would build the wrong URLs
// when scripting the flow.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = join(__dirname, '..', '..', '..', '..');
const DOC_PATH = join(
  REPO,
  'apps',
  'marketing-site',
  'src',
  'pages',
  'docs',
  'cli-quickstart.astro',
);
const ROUTE_PATH = join(REPO, 'apps', 'server', 'src', 'routes', 'auth-cli.ts');
const SVC_PATH = join(REPO, 'apps', 'server', 'src', 'services', 'cli-authorize.ts');

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('W223.A cli-quickstart doc parity', () => {
  const doc = read(DOC_PATH);
  const route = read(ROUTE_PATH);

  it('CLI authorize endpoints in doc match the route registrations', () => {
    for (const path of ['/v1/auth/cli-authorize/initiate', '/v1/auth/cli-authorize/exchange']) {
      expect(route, `route should be registered at ${path}`).toContain(`'${path}'`);
      expect(doc, `doc must reference ${path}`).toContain(path);
    }
    // The stale path the previous revision used:
    expect(doc).not.toMatch(/\/v1\/cli\/authorize\//);
  });

  it('activation-code TTL claim matches the service constant', () => {
    const m = read(SVC_PATH).match(/TTL_SECONDS\s*=\s*(\d+)\s*\*\s*(\d+)/);
    expect(m).not.toBeNull();
    const seconds = Number(m![1]) * Number(m![2]);
    expect(seconds).toBe(300);
    // Doc must reflect the 5-minute claim.
    expect(doc).toMatch(/5 minutes/);
  });
});

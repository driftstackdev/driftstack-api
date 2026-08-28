// W324.C-security — drift guard for /security page route citations.
// The page is a compound view that hits multiple endpoints:
//   GET       /v1/account/me                 — accountEmail capture
//   GET       /v1/account/audit-log          — recent events
//   GET       /v1/account/web-sessions       — list signed-in devices
//   DELETE    /v1/account/web-sessions/:id   — revoke a session
//   DELETE    /v1/account/web-sessions?keep=current — revoke all others
// All must be registered server-side. These routes lived on /settings
// until the 2026-07-03 design-system v2 split moved the security
// surfaces to /security.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/security.astro');
const ROUTES = resolve(REPO_ROOT, 'apps/server/src/routes');

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir))
    throw new Error(
      `walk root is missing: ${dir} — a sweep over a missing tree reports nothing to sweep, which reads as clean; if the tree moved, update the root`,
    );
  for (const e of readdirSync(dir)) {
    const full = resolve(dir, e);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const REQUIRED_PATHS = [
  '/v1/account/me',
  '/v1/account/audit-log',
  '/v1/account/web-sessions',
  '/v1/account/web-sessions/:id',
];

describe('W324.C-security /security ↔ route parity', () => {
  const page = read(PAGE);
  const allRouteBodies = walk(ROUTES)
    .filter((f) => /\.ts$/.test(f))
    .map(read)
    .join('\n');

  for (const path of REQUIRED_PATHS) {
    const display = path.replace(/:id/, '<id>');
    it(`page references ${display}`, () => {
      // The page builds paths with concatenation, so look for the
      // base form; the :id portion comes from concat with id var.
      const probe = path.replace(/:id/, '');
      expect(page).toContain(probe);
    });

    it(`server registers ${path}`, () => {
      expect(allRouteBodies).toContain(`'${path}'`);
    });
  }
});

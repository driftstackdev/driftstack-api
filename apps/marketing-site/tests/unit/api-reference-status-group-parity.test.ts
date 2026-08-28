// W324.B — drift guard for the Status group on /api-reference.
// The marketing page advertises six /v1/status* endpoints (incl.
// SSE stream + rolling SLA + double-opt-in subscribe flow). Each
// must resolve to a live registration. The server-side registration
// files live across multiple route modules (status, status-stream,
// status-subscribe, admin-incidents) — this test walks all of them.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/api-reference.astro');
const ROUTES = resolve(REPO_ROOT, 'apps/server/src/routes');

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) throw new Error(`missing ${dir}`);
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

const REQUIRED_STATUS_PATHS = [
  '/v1/status',
  '/v1/status/stream',
  '/v1/status/sla',
  '/v1/status/subscribe',
  '/v1/status/subscribe/confirm',
  '/v1/status/subscribe/unsubscribe',
];

describe('W324.B /api-reference Status group ↔ live route parity', () => {
  const page = read(PAGE);
  const allRouteBodies = walk(ROUTES)
    .filter((f) => /\.ts$/.test(f))
    .map(read)
    .join('\n');

  for (const path of REQUIRED_STATUS_PATHS) {
    it(`page advertises ${path}`, () => {
      expect(page).toContain(path);
    });

    it(`server registers ${path}`, () => {
      // The path may appear in a route file as the first arg to app.get/post
      // — accept the literal string form.
      expect(allRouteBodies).toContain(`'${path}'`);
    });
  }
});

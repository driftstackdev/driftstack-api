// W316.C — drift guard for /billing page route citations. The
// page hits /v1/billing (state) + /v1/billing/portal-session. Both
// must be registered on the server. (The one-time trial-pack
// endpoint was deleted 2026-05-27 alongside the move to a
// perpetual free entry tier.)

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/billing.astro');
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

describe('W316.C /billing page ↔ billing route parity', () => {
  const page = read(PAGE);
  const allRouteBodies = walk(ROUTES)
    .filter((f) => /billing.*\.ts$/.test(f))
    .map(read)
    .join('\n');

  it('page calls GET /v1/billing (state)', () => {
    expect(page).toMatch(/'\/v1\/billing'/);
  });

  it('page calls POST /v1/billing/portal-session', () => {
    expect(page).toContain('/v1/billing/portal-session');
  });

  it('page does not call the removed POST /v1/billing/trial-pack', () => {
    expect(page).not.toContain('/v1/billing/trial-pack');
  });

  it('server registers GET /v1/billing', () => {
    expect(allRouteBodies).toMatch(/'\/v1\/billing'/);
  });

  it('server registers POST /v1/billing/portal-session', () => {
    expect(allRouteBodies).toContain("'/v1/billing/portal-session'");
  });

  it('server registers GET /v1/billing and POST /v1/billing/portal-session', () => {
    expect(allRouteBodies).toMatch(/'\/v1\/billing'/);
    expect(allRouteBodies).toContain("'/v1/billing/portal-session'");
  });
});

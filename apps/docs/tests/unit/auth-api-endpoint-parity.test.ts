// W313.A — drift guard for /api/auth endpoint citations. Every
// /v1/auth/... path cited in a backtick-fenced heading must resolve
// to a registration in apps/server/src/routes/auth*.ts.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/api/auth.md');
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

describe('W313.A /api/auth ↔ auth route parity', () => {
  const page = read(PAGE);
  const allRoutes = walk(ROUTES)
    .filter((f) => /auth.*\.ts$/.test(f))
    .map(read)
    .join('\n');

  const liveAuthRoutes = new Set<string>();
  for (const m of allRoutes.matchAll(/['"`](\/v1\/auth\/[a-z0-9/_-]+)['"`]/g)) {
    liveAuthRoutes.add(m[1]!);
  }

  it('captures at least 10 live auth routes (sanity)', () => {
    expect(liveAuthRoutes.size).toBeGreaterThanOrEqual(10);
  });

  it('every backtick-fenced /v1/auth/... endpoint in the doc resolves to a live registration', () => {
    const cited = [...page.matchAll(/`POST\s+(\/v1\/auth\/[a-z0-9/_-]+)/g)].map((m) => m[1]!);

    expect(cited.length).toBeGreaterThan(5);

    const offenders: string[] = [];
    for (const p of cited) {
      if (!liveAuthRoutes.has(p)) offenders.push(p);
    }
    expect(offenders).toEqual([]);
  });

  it('page covers the three CLI authorize endpoints (initiate/bind/exchange)', () => {
    expect(page).toContain('/v1/auth/cli-authorize/initiate');
    expect(page).toContain('/v1/auth/cli-authorize/bind-device-code');
    expect(page).toContain('/v1/auth/cli-authorize/exchange');
  });

  it('page covers MFA challenge + step-up endpoints', () => {
    expect(page).toContain('/v1/auth/mfa/challenge');
    expect(page).toContain('/v1/auth/mfa/step-up');
  });
});

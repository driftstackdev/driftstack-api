// W320.A — drift guard for /api/mfa endpoint citations. Both
// /v1/account/mfa* and /v1/auth/mfa* endpoints cited in headings
// must resolve to live route registrations.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/api/mfa.md');
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

describe('W320.A /api/mfa ↔ route parity', () => {
  const page = read(PAGE);
  const allRouteBodies = walk(ROUTES)
    .filter((f) => /(account-mfa|auth)\.ts$/.test(f))
    .map(read)
    .join('\n');

  const liveRoutes = new Set<string>();
  for (const m of allRouteBodies.matchAll(/['"`](\/v1\/(?:account|auth)\/mfa[a-z0-9/_-]*)['"`]/g)) {
    liveRoutes.add(m[1]!);
  }

  it('captures at least 6 live MFA routes (sanity)', () => {
    expect(liveRoutes.size).toBeGreaterThanOrEqual(6);
  });

  it('covers enroll + verify + status + disable + recovery-codes regenerate', () => {
    expect(page).toContain('/v1/account/mfa/enroll');
    expect(page).toContain('/v1/account/mfa/verify');
    expect(page).toContain('/v1/account/mfa');
    expect(page).toContain('/v1/account/mfa/disable');
    expect(page).toContain('/v1/account/mfa/recovery-codes/regenerate');
  });

  it('covers /v1/auth/mfa/challenge and /v1/auth/mfa/step-up', () => {
    expect(page).toContain('/v1/auth/mfa/challenge');
    expect(page).toContain('/v1/auth/mfa/step-up');
  });

  it('every cited /v1/.../mfa endpoint resolves to a live registration', () => {
    const cited = [
      ...page.matchAll(/`(?:[A-Z]+\s+)?(\/v1\/(?:account|auth)\/mfa[a-z0-9/_-]*)/g),
    ].map((m) => m[1]!);

    expect(cited.length).toBeGreaterThanOrEqual(6);

    const offenders: string[] = [];
    for (const p of cited) {
      if (!liveRoutes.has(p)) offenders.push(p);
    }
    expect(offenders).toEqual([]);
  });
});

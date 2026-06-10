// W490 — every /v1/admin/* route must carry an admin-or-owner authorization
// gate in its preHandler.
//
// A /v1/admin route registered without `app.requireScope('driftstack_internal_
// admin')` (staff) or `app.requireOwner` (project-owner-only, stricter) is a
// privilege-escalation hole: a regular customer API key could hit an internal
// admin endpoint. Nothing automated enforced this before (the prior sweeps were
// manual). This scans EVERY route file (not just admin-*.ts — an admin route
// can live anywhere) and asserts each /v1/admin registration is gated.
//
// Verified W490: 55 admin routes — 52 driftstack_internal_admin + 3
// /v1/admin/owner/* requireOwner (owner cockpit). Zero ungated.

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTES = resolve(HERE, '..', '..', 'src', 'routes');

describe('W490 /v1/admin route authorization invariant', () => {
  const files = readdirSync(ROUTES).filter((f) => /\.ts$/.test(f) && !/\.test\.ts$/.test(f));

  // Capture each app.METHOD('/v1/admin/...', { ...preHandler: [...] }) block.
  const re =
    /app\.(get|post|patch|put|delete)<?[^(]*\(\s*\n?\s*['"`](\/v1\/admin\/[^'"`]+)['"`],\s*\n?\s*\{([\s\S]*?preHandler:\s*\[[\s\S]*?\])/g;

  const routes: Array<{ method: string; path: string; opts: string; file: string }> = [];
  for (const f of files) {
    const src = readFileSync(join(ROUTES, f), 'utf8');
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(src))) {
      routes.push({ method: m[1]!, path: m[2]!, opts: m[3]!, file: f });
    }
  }

  it('finds the admin route surface (>=50 routes)', () => {
    expect(routes.length).toBeGreaterThanOrEqual(50);
  });

  it('every /v1/admin route is gated by driftstack_internal_admin scope OR requireOwner', () => {
    const ungated = routes
      .filter((r) => !/driftstack_internal_admin/.test(r.opts) && !/requireOwner/.test(r.opts))
      .map((r) => `${r.method.toUpperCase()} ${r.path} (${r.file})`)
      .sort();
    expect(
      ungated,
      `ungated /v1/admin routes — privilege-escalation risk; add app.requireScope('driftstack_internal_admin') or app.requireOwner:\n${ungated.join('\n')}`,
    ).toEqual([]);
  });
});

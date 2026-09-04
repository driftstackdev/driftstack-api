// W468 — regression guard for the W467 broken-link class.
//
// The marketing site (driftstack.io) and the customer dashboard
// (app.driftstack.io) are SEPARATE origins. A relative href to a dashboard-
// only route — href="/signup", href="/login", href="/settings" — resolves to
// driftstack.io/signup, which 404s (there is no such marketing page). W467
// found exactly this: pricing-tier CTAs used a bare '/signup' and every
// "Get started" button was dead. Auth/account routes MUST be absolute to the
// dashboard origin.
//
// This test scans the marketing source for bare hrefs to those routes so the
// regression can't silently return (the gate catches it, not a user).

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', '..', 'src');

// Dashboard-only routes that 404 on the marketing origin if linked relatively.
const DASHBOARD_ROUTES = ['signup', 'login', 'settings', 'account', 'billing', 'api-keys'];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(astro|md|mdx|ts|tsx|js)$/.test(name)) out.push(p);
  }
  return out;
}

describe('W468 marketing source: no bare dashboard-route hrefs (W467 regression guard)', () => {
  const files = walk(SRC);

  it('finds source files to scan', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('has no relative href to a dashboard-only route (must be absolute https://app.driftstack.io/...)', () => {
    // Matches href="/signup" / href='/login' / href="/settings/..." etc. but
    // NOT https://app.driftstack.io/signup (no leading quote-slash there).
    const pattern = new RegExp(`href=["']/(?:${DASHBOARD_ROUTES.join('|')})(?:[/"'?]|$)`);
    const offenders: string[] = [];
    for (const f of files) {
      const body = readFileSync(f, 'utf8');
      if (pattern.test(body)) offenders.push(f.replace(SRC, 'src'));
    }
    expect(
      offenders,
      `bare dashboard-route hrefs 404 on driftstack.io — make them absolute to app.driftstack.io:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});

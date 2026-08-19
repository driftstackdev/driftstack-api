// Cross-page invariant: every admin-panel page must read the operator session
// token from the SAME localStorage key the AdminLayout SSO bridge WRITES
// (`ds_web_session_token`).
//
// Regression guard for a real bug: apps/admin-panel/src/pages/cost.astro once
// read a never-set key `driftstack:admin_token`, so the admin Cost page always
// showed "No admin token found" and never loaded any cost data for a signed-in
// operator. The drift was invisible because each page's behavioural test set
// (and asserted against) whatever key that page happened to read. This guard
// asserts the bridge-written key + that no page reads a different token key.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LAYOUT = resolve(REPO_ROOT, 'apps/admin-panel/src/layouts/AdminLayout.astro');
const PAGES_DIR = resolve(REPO_ROOT, 'apps/admin-panel/src/pages');
const CANONICAL_KEY = 'ds_web_session_token';

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('admin-panel token-key consistency', () => {
  it('AdminLayout SSO bridge WRITES the canonical token key', () => {
    expect(read(LAYOUT)).toMatch(/setItem\(\s*['"]ds_web_session_token['"]/);
  });

  it('no admin page reads a token-shaped localStorage key OTHER than the canonical one', () => {
    const files = readdirSync(PAGES_DIR).filter((f) => f.endsWith('.astro'));
    expect(
      files.length,
      'admin-panel files walked — V-1028 ratchet: this was > 0 against a real 12',
    ).toBeGreaterThanOrEqual(12);
    for (const f of files) {
      const body = read(resolve(PAGES_DIR, f));
      const keys = [...body.matchAll(/getItem\(\s*['"]([^'"]+)['"]\s*\)/g)]
        .map((m) => m[1])
        .filter((k): k is string => typeof k === 'string');
      for (const k of keys) {
        // Only token/session-shaped keys must match; unrelated localStorage
        // reads (preferences, dismissed banners, …) are exempt.
        if (/token|session/i.test(k)) {
          expect(
            k,
            `${f} reads token key '${k}' — must be '${CANONICAL_KEY}' (the AdminLayout SSO bridge-written key); a never-set key silently breaks the page's live data`,
          ).toBe(CANONICAL_KEY);
        }
      }
    }
  });
});

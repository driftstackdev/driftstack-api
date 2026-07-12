// W340.B — drift guard for the /api-keys page SCOPE_LABEL maps.
// The page renders API keys only after its client script loads, so the
// inline script owns the single SCOPE_LABEL map. Three constraints hold:
//
//   1. Exactly one map exists (otherwise dead frontmatter can drift).
//   2. Every key is a valid ApiKeyScope (otherwise a typo silently
//      breaks the rendering for that scope).
//   3. Granular V-481 scopes (`read:sessions`, etc) fall through
//      to a `?? scope` / `|| s` fallback — both code paths must
//      stay defensive against unknown values.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApiKeyScopeSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/api-keys.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W340.B /api-keys SCOPE_LABEL parity', () => {
  const page = read(PAGE);
  const validScopes = new Set<string>(
    (ApiKeyScopeSchema._def as { values: readonly string[] }).values,
  );

  // The client-side <script is:inline> owns the only rendered map.
  const blocks = [...page.matchAll(/SCOPE_LABEL[^={]*=\s*\{([^}]*)\}/g)].map((m) => m[1]!);

  it('exactly one client-owned SCOPE_LABEL block exists', () => {
    expect(blocks.length).toBe(1);
  });

  function keysOf(block: string): string[] {
    return [...block.matchAll(/^\s*([a-z_]+):\s*'[^']+',/gm)].map((m) => m[1]!).sort();
  }

  it('the sole SCOPE_LABEL map is inside the client script', () => {
    expect(page.indexOf('SCOPE_LABEL')).toBeGreaterThan(page.indexOf('<script is:inline>'));
  });

  it('every SCOPE_LABEL key is a valid ApiKeyScope', () => {
    const keys = new Set(blocks.flatMap(keysOf));
    const offenders = [...keys].filter((k) => !validScopes.has(k));
    expect(offenders).toEqual([]);
  });

  it('SCOPE_LABEL covers the 4 broad scopes (read/write/admin/account_owner)', () => {
    // Sanity: the broad-scope set must be there. Granular V-481
    // scopes are intentionally NOT listed — they fall through to
    // a `?? scope` fallback (validated separately below).
    const keys = new Set(blocks.flatMap(keysOf));
    for (const expected of ['read', 'write', 'admin', 'account_owner']) {
      expect(keys.has(expected)).toBe(true);
    }
  });

  it('inline-script rendering uses `|| s` fallback for unknown scopes. 2026-05-21 — Astro frontmatter no longer renders scope chips (skeleton-only pre-hydration; 12566e61). The defensive fallback survives in the JS side, which is now the only render path.', () => {
    expect(page).toMatch(/SCOPE_LABEL\[s\]\s*\|\|\s*s/);
  });

  it('header copy pins the "plaintext shown ONCE" posture (key-creation guarantee)', () => {
    // This is the most important customer-safety claim on the
    // page; keep it explicit so a copy revamp can't tone it down.
    expect(page).toMatch(/Plaintext is\s+shown ONCE on creation/);
    expect(page).toMatch(/we can't recover it later/);
  });

  it('header copy pins the "Revocation is immediate" guarantee', () => {
    expect(page).toMatch(/Revocation is\s+immediate/);
  });
});

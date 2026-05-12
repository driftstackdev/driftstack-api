// W340.B — drift guard for the /api-keys page SCOPE_LABEL maps.
// The page renders two identical SCOPE_LABEL maps (frontmatter +
// inline script). Three constraints must hold:
//
//   1. Both maps share exactly the same keys (otherwise SSR + CSR
//      paint inconsistently).
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

  // The page has two SCOPE_LABEL blocks — one in the .astro
  // frontmatter (typed Record<string,string>) and one inside the
  // client-side <script is:inline>. Grab the keys of each.
  const blocks = [...page.matchAll(/SCOPE_LABEL[^={]*=\s*\{([^}]*)\}/g)].map((m) => m[1]!);

  it('frontmatter and inline SCOPE_LABEL blocks both exist', () => {
    expect(blocks.length).toBe(2);
  });

  function keysOf(block: string): string[] {
    return [...block.matchAll(/^\s*([a-z_]+):\s*'[^']+',/gm)].map((m) => m[1]!).sort();
  }

  it('frontmatter and inline SCOPE_LABEL maps have identical key sets', () => {
    const [fmKeys, csrKeys] = blocks.map(keysOf);
    expect(fmKeys).toEqual(csrKeys);
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

  it('frontmatter rendering uses `?? scope` fallback for unknown scopes', () => {
    // Catches accidental removal of the defensive fallback when
    // somebody refactors to a stricter type. The page uses Astro
    // expression `{SCOPE_LABEL[scope] ?? scope}`.
    expect(page).toMatch(/SCOPE_LABEL\[scope\]\s*\?\?\s*scope/);
  });

  it('inline-script rendering uses `|| s` fallback for unknown scopes', () => {
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
